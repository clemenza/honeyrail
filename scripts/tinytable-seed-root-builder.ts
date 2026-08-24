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
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommandSafe, type SafeCommandOutput } from "../server/utils.js";

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
};

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

type CliOptions = { seed: number; outDir: string; manifestOut: string; sourceRoot?: string };

function parseArgs(argv: string[]): CliOptions {
  let seed: number | undefined;
  let outDir: string | undefined;
  let manifestOut: string | undefined;
  let sourceRoot: string | undefined;
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

  return { seed, outDir, manifestOut, sourceRoot };
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
