/**
 * evals: seed-root builder (#104, migrated to the vendored `tinytable-evals`
 * builder by #126). Builder zone of the three-zone eval isolation design
 * described in #104/#105/#106/#109 (a response to the #103 postmortem: an
 * agent escaped its sandbox and read `examples/tinytable-eval`'s answer key
 * - mutants, golden tests, score.py - straight off the shared filesystem).
 *
 * Before #126, this file *was* the builder: it copied an allowlist of files
 * out of a static `examples/tinytable-eval/mutants/mNN` directory and
 * scrubbed known answer-key leaks out of their text. `vendor/tinytable-evals`
 * (pinned per #126 - see docs/dsh-evals-demo.md's "Pinned upstream commit"
 * section) replaced that static pool with a *generative* one: given a
 * `--seed`, its own `build_seed_root.py` deterministically picks a mutation
 * operator, applies it to a fresh copy of its `clean/tinytable`, and
 * assembles a self-contained, git-initialized worktree - answer-free by
 * construction, since no specific mutant instance is ever committed
 * anywhere and the chosen operator id is only ever printed to stdout for a
 * calling driver to record privately.
 *
 * This file is now a thin honeyrail-side wrapper around that CLI: it shells
 * out to `python3 <source>/build_seed_root.py --seed N --out DIR`, parses
 * its `SEED_ROOT_JSON:` stdout line, and builds a separate, caller-chosen
 * manifest (a per-file SHA-256 listing) for #106's preflight/integrity
 * check - which must sit outside the seed-root, so the answer never enters
 * the exam room.
 *
 * This is builder-zone-only: it does not launch an agent, does not enforce
 * container isolation - see #105 (exam room) and #106 (preflight) for the
 * rest of the three-zone design, and #93 for the driver that chains all of
 * it together.
 *
 * Usage:
 *   node --import tsx scripts/tinytable-seed-root-builder.ts \
 *     --seed 3 --out ./seed-root --manifest-out ./manifests/3.json
 *
 * Options:
 *   --seed <n>              Seed selecting which mutation operator
 *                            build_seed_root.py applies (deterministic -
 *                            same seed, same upstream commit -> same
 *                            operator, always)
 *   --out <dir>              Seed-root destination (must not exist)
 *   --manifest-out <path>    Manifest JSON destination - must not be inside
 *                            --out (the manifest carries the answer:
 *                            build_seed_root.py's chosen operator id)
 *   --source <dir>           Override the tinytable-evals checkout (default:
 *                            vendor/tinytable-evals next to this repo)
 *   --black-box              #158: hides tinytable/{core,sql}.py (compiled
 *                            to .pyc, source deleted) - see
 *                            BuildSeedRootOptions.blackBox's own docstring
 *                            for what this does and doesn't defend against
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandSafe, type SafeCommandOutput } from "../server/utils.js";
import { runInExamRoom, DEFAULT_IMAGE } from "./tinytable-exam-room.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_ROOT = resolve(__dirname, "..", "vendor", "tinytable-evals");

const BUILDER_VERSION = "2";

/** Directories never worth including in the manifest - VCS bookkeeping the builder itself created, not fixture content. */
const SKIP_DIR_NAMES = new Set([".git"]);

function toPosixPath(relPath: string): string {
  return relPath.split(sep).join("/");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Recursively lists every file under `dir`, returning posix-relative paths sorted lexically. */
async function listFilesRecursive(dir: string, relBase = ""): Promise<string[]> {
  const entries = await readdir(join(dir, relBase), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = relBase ? join(relBase, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      files.push(...(await listFilesRecursive(dir, rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

export type SeedRootManifest = {
  builderVersion: string;
  /** The seed passed to build_seed_root.py. */
  seed: number;
  /** THE ANSWER - build_seed_root.py's own operator id for this seed. Grader-side only; never written into the seed-root. */
  operatorId: string;
  files: Array<{ path: string; sha256: string }>;
  /** Hash over the sorted files[] listing - a single fixture-identity/integrity hash for #106's preflight check. */
  seedRootSha256: string;
};

export type BuildSeedRootOptions = {
  seed: number;
  outDir: string;
  sourceRoot?: string;
  /**
   * #158 (a first, cheap probe, not the real fix - see that issue's own
   * scoping writeup): compiles `tinytable/core.py` and `tinytable/sql.py`
   * to `.pyc` and deletes the `.py` sources, so a `read`/`grep`/`cat` of
   * either file finds nothing. Both files are always hidden together
   * (never just the one an operator actually mutated) so presence/absence
   * alone can't leak which file holds the seeded defect.
   *
   * This does NOT block introspection of the *live, imported* module -
   * `import tinytable.sql, dis; dis.dis(tinytable.sql)` from the same
   * container's own Python (which the agent needs anyway, to run
   * `sql-tests/agent/*.test` via `run_sql_tests.py`) reproduces fully
   * readable disassembly, complete with original variable names and
   * source line numbers, in one stdlib call - confirmed empirically before
   * this option was added. A real black-box mode needs the mutated engine
   * behind a process boundary the agent's own container can't
   * `import`/`dis.dis()` into at all (see #158's design writeup) - this
   * flag exists to get a cheap, real first read on whether even *this*
   * weak a barrier changes discovery-channel behavior, not because it's
   * believed to be robust.
   */
  blackBox?: boolean;
  /**
   * The exam-room image to compile black-box `.pyc`s with (default
   * DEFAULT_IMAGE) - MUST match the image the trial itself later runs in.
   * A `.pyc`'s magic number is tied to the exact CPython minor version
   * that compiled it; compiling with the *host's* python3 instead (this
   * option's reason for existing) produced a real trial's `ImportError:
   * bad magic number in 'tinytable.core'` on the very first import - a
   * silently-broken seed-root, not a real black-box probe, confirmed
   * against clemenza/honeyrail#158's own first real run (host was Python
   * 3.10.13, the exam-room image is 3.11.2).
   */
  image?: string;
};

/** Files #158's black-box mode hides - the only two files any mutation operator (Gen1 or Gen2) ever touches. Always both, regardless of which one a given seed actually mutated - see BuildSeedRootOptions.blackBox's own docstring for why. */
const BLACK_BOX_HIDDEN_FILES = ["tinytable/core.py", "tinytable/sql.py"];

/**
 * Compiles each of BLACK_BOX_HIDDEN_FILES to a same-directory, sourceless
 * `.pyc` (still importable - Python resolves a bare `<module>.pyc` with no
 * matching `.py` just fine), deletes the `.py`, and wipes `.git` -
 * `build_seed_root.py` already `git init`/`add`/`commit`s the seed-root
 * *with the readable `.py` present* before this ever runs, so the original
 * blob stays fully recoverable from `.git/objects/` (`git show
 * HEAD:tinytable/sql.py`, or a bare zlib-inflate of the object file - both
 * confirmed against a real trial that tried exactly this) even after the
 * working-tree file is deleted. Deleting `.py`s without also wiping `.git`
 * doesn't hide anything - it just moves the leak from "one read call" to
 * "one git command." The caller (scripts/dsh-evals-demo.ts's
 * `gitInitCommit`, already run unconditionally as defense in depth after
 * every `buildSeedRoot()` call) re-initializes a fresh single-commit
 * history over the now-transformed tree, so no earlier commit - and no
 * earlier blob - survives for `git` (or a raw `.git/objects` read) to
 * recover.
 *
 * Compiles *inside a throwaway run of the exam-room image itself*
 * (scripts/tinytable-exam-room.ts's own runInExamRoom, network disabled -
 * this is a builder-zone step, no agent involved yet), not the host's own
 * python3 - see BuildSeedRootOptions.image's own docstring for why that
 * distinction is load-bearing, not stylistic.
 */
async function applyBlackBoxTransform(outDir: string, image: string): Promise<void> {
  const compileScript = BLACK_BOX_HIDDEN_FILES
    .map((f) => `py_compile.compile(${JSON.stringify(f)}, cfile=${JSON.stringify(f.replace(/\.py$/, ".pyc"))}, doraise=True)`)
    .join("; ");
  const result = await runInExamRoom({
    seedRootDir: outDir,
    image,
    network: "none",
    command: ["python3", "-c", `import py_compile; ${compileScript}`]
  });
  if (result.exitCode !== 0) {
    throw new Error(`#158 black-box transform: failed to compile ${BLACK_BOX_HIDDEN_FILES.join(", ")} inside ${image}: ${result.stderr || result.stdout}`);
  }
  for (const relFile of BLACK_BOX_HIDDEN_FILES) {
    await rm(join(outDir, relFile));
  }
  await rm(join(outDir, ".git"), { recursive: true, force: true });
}

type SeedRootJson = { seed: number; out: string; operator_id: string; created_utc: string };

function parseSeedRootJson(stdout: string): SeedRootJson {
  const line = stdout.split("\n").find((l) => l.startsWith("SEED_ROOT_JSON: "));
  if (!line) {
    throw new Error(`build_seed_root.py did not print a SEED_ROOT_JSON line; stdout was:\n${stdout}`);
  }
  return JSON.parse(line.slice("SEED_ROOT_JSON: ".length)) as SeedRootJson;
}

export async function buildSeedRoot(
  options: BuildSeedRootOptions,
  run: typeof runCommandSafe = runCommandSafe
): Promise<SeedRootManifest> {
  if (!Number.isInteger(options.seed) || options.seed < 0) {
    throw new Error(`--seed must be a non-negative integer, got ${options.seed}`);
  }
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const outDir = resolve(options.outDir);

  const result: SafeCommandOutput = await run("python3", [
    join(sourceRoot, "build_seed_root.py"),
    "--seed", String(options.seed),
    "--out", outDir
  ]);
  if (!result.ok) {
    throw new Error(`build_seed_root.py failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
  const seedRootJson = parseSeedRootJson(result.stdout);

  if (options.blackBox) {
    await applyBlackBoxTransform(outDir, options.image ?? DEFAULT_IMAGE);
  }

  const relFiles = await listFilesRecursive(outDir);
  const files = await Promise.all(
    relFiles.map(async (relFile) => {
      const content = await readFile(join(outDir, relFile));
      const path = toPosixPath(relFile);
      // Defense in depth - build_seed_root.py already guarantees the
      // operator id is only ever printed to stdout, never written into
      // DIR, but a future upstream regression here would otherwise leak
      // the answer straight into the exam room silently.
      if (content.includes(seedRootJson.operator_id) || content.includes("SEED_ROOT_JSON")) {
        throw new Error(
          `seed-root leak: ${path} contains the seed's operator id or "SEED_ROOT_JSON" - this would leak the answer into ` +
            "the exam room; check vendor/tinytable-evals's build_seed_root.py before this can ship"
        );
      }
      return { path, sha256: sha256(content) };
    })
  );
  files.sort((a, b) => a.path.localeCompare(b.path));

  const seedRootSha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");

  return {
    builderVersion: BUILDER_VERSION,
    seed: options.seed,
    operatorId: seedRootJson.operator_id,
    files,
    seedRootSha256
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type CliOptions = { seed: number; outDir: string; manifestOut: string; sourceRoot?: string; blackBox: boolean };

function parseArgs(argv: string[]): CliOptions {
  let seed: number | undefined;
  let outDir: string | undefined;
  let manifestOut: string | undefined;
  let sourceRoot: string | undefined;
  let blackBox = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--seed": seed = Number(next()); break;
      case "--out": outDir = next(); break;
      case "--manifest-out": manifestOut = next(); break;
      case "--source": sourceRoot = next(); break;
      case "--black-box": blackBox = true; break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/tinytable-seed-root-builder.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (seed === undefined || !Number.isInteger(seed)) throw new Error("--seed <n> is required and must be an integer");
  if (!outDir) throw new Error("--out <dir> is required");
  if (!manifestOut) throw new Error("--manifest-out <path> is required");

  const resolvedOut = resolve(outDir);
  const resolvedManifest = resolve(manifestOut);
  if (resolvedManifest === resolvedOut || resolvedManifest.startsWith(resolvedOut + sep)) {
    // The manifest carries operatorId - the answer - and must never end up
    // inside the seed-root an agent will see.
    throw new Error(`--manifest-out ${resolvedManifest} must not be inside --out ${resolvedOut}`);
  }

  return { seed, outDir, manifestOut, sourceRoot, blackBox };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await buildSeedRoot(options);
  const manifestPath = resolve(options.manifestOut);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Seed-root for seed ${manifest.seed} materialized at ${resolve(options.outDir)} (${manifest.files.length} files).`);
  console.log(`Manifest written to ${manifestPath} (seedRootSha256=${manifest.seedRootSha256.slice(0, 12)}...).`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
