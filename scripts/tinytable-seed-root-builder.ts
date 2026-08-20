/**
 * evals: seed-root builder with answer-free materialization and grader-side
 * manifest (#104). Builder zone of the three-zone eval isolation design
 * described in #104/#105/#106/#109 (a response to the #103 postmortem: an
 * agent escaped its sandbox and read `examples/tinytable-eval`'s answer key -
 * mutants, golden tests, score.py - straight off the shared filesystem).
 *
 * Given a chosen mutant, this materializes a "seed-root": a plain directory
 * containing only what a test-engineering agent should ever see (the buggy
 * `tinytable/` package, the official SQL test suite, SPEC.md, the test
 * runner, and the findings schema) with every trace of which mutant it is,
 * that mutants/golden tests/score.py exist at all, or that any of this came
 * from `examples/tinytable-eval` scrubbed out of file contents. It also
 * writes a manifest - the fixture id plus a per-file SHA-256 listing - to a
 * separate, caller-chosen location that must sit outside the seed-root, so
 * the answer never enters the exam room.
 *
 * This is builder-zone-only: it does not launch an agent, does not git-init
 * the seed-root, and does not enforce container isolation - see #105 (exam
 * room) and #106 (preflight) for the rest of the three-zone design, and #93
 * for the driver that chains all of it together.
 *
 * Usage:
 *   node --import tsx scripts/tinytable-seed-root-builder.ts \
 *     --mutant m03 --out ./seed-root --manifest-out ./manifests/m03.json
 *
 * Options:
 *   --mutant <id>         Mutant to materialize (m01..m08, per what exists
 *                          under <source>/mutants/)
 *   --out <dir>            Seed-root destination (must not exist, or must be
 *                          empty)
 *   --manifest-out <path>  Manifest JSON destination - must not be inside
 *                          --out (the manifest carries the answer)
 *   --source <dir>         Override the tinytable-eval source tree (default:
 *                          examples/tinytable-eval next to this repo)
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_ROOT = resolve(__dirname, "..", "examples", "tinytable-eval");

const BUILDER_VERSION = "1";

/**
 * Files/dirs an agent is allowed to see, and where each lands in the
 * seed-root. Deliberately an allowlist, not a directory walk of
 * `examples/tinytable-eval` - a new file added there later (another mutant,
 * a new answer-key artifact) is excluded by default instead of leaking in.
 */
const STATIC_ALLOWLIST: Array<{ src: string; dest: string }> = [
  { src: "SPEC.md", dest: "SPEC.md" },
  { src: "run_sql_tests.py", dest: "run_sql_tests.py" },
  { src: "findings.schema.json", dest: "findings.schema.json" }
];

function mutantAllowlist(mutantId: string): Array<{ src: string; dest: string }> {
  return [
    { src: `mutants/${mutantId}/tinytable`, dest: "tinytable" },
    { src: `mutants/${mutantId}/sql-tests/official`, dest: "sql-tests/official" }
  ];
}

/**
 * Known metadata leaks in the source fixture's own text - usage examples
 * and prose that name a specific mutant id, mention `golden/` tests, the
 * `score.py` grader, or the `clean/` reference dir by name. Every rule here
 * is a literal, order-independent substring replacement so scrubbing stays
 * fully deterministic; `assertNoLeaks` below is the actual safety net in
 * case source wording drifts and a rule stops matching.
 */
const SCRUB_RULES: Array<{ search: string; replace: string }> = [
  {
    search: "    python3 run_sql_tests.py --root path/to/mutant path/to/golden/m03.test\n",
    replace: ""
  },
  {
    search: "mirrors score.py's own external,",
    replace: "mirrors the eval harness's own external,"
  },
  {
    search:
      'This document is the **sole arbiter of correct behavior**. `clean/` is a\n' +
      'reference implementation of everything below; a "defect" is any observable\n' +
      "deviation from this spec, nothing more and nothing less. Every SQL example\n" +
      "in this document is a literal, verified statement sequence, true of\n" +
      '`clean/tinytable` today - see "Test Script Format" below for how tests\n' +
      "(official and, later, golden) pin these down as runnable `.test` files.",
    replace:
      'This document is the **sole arbiter of correct behavior**; a "defect" is any\n' +
      "observable deviation from this spec, nothing more and nothing less. Every SQL\n" +
      "example in this document is a literal, verified statement sequence, true of a\n" +
      'SPEC-compliant `tinytable` today - see "Test Script Format" below for how\n' +
      "tests pin these down as runnable `.test` files."
  },
  {
    search: "Official and (later) golden tests are `.test` files: a small,",
    replace: "Tests are `.test` files: a small,"
  },
  { search: "the seeded defect (see golden/ once it exists).", replace: "the seeded defect." },
  { search: "the two seeded defects (see golden/ once it exists).", replace: "the two seeded defects." },
  { search: "the one seeded defect - see golden/ once it\n# exists).", replace: "the one seeded defect)." },
  {
    search: '"$id": "https://github.com/clemenza/honeyrail/examples/tinytable-eval/findings.schema.json",',
    replace: '"$id": "https://example.invalid/tinytable/findings.schema.json",'
  },
  { search: '"title": "tinytable-eval findings.json",', replace: '"title": "tinytable findings.json",' },
  {
    search:
      '"description": "Output contract for the tinytable-eval task-prompt.md: a JSON array of defects found in tinytable relative to SPEC.md, or an empty array if none were found.",',
    replace:
      '"description": "Output contract for the tinytable test-engineering task: a JSON array of defects found in tinytable relative to SPEC.md, or an empty array if none were found.",'
  }
];

function scrubText(text: string): string {
  let result = text;
  for (const rule of SCRUB_RULES) {
    result = result.split(rule.search).join(rule.replace);
  }
  return result;
}

/** Case-insensitive patterns that must not survive into the seed-root. */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /golden/i,
  /\bmutants?\b/i,
  /score\.py/i,
  /selfcheck/i,
  /tinytable-eval/i,
  /\bm0[1-8]\b/i
];

function assertNoLeaks(relPath: string, content: string): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(content) || pattern.test(relPath)) {
      throw new Error(
        `seed-root leak: ${relPath} matches forbidden pattern ${pattern} after scrubbing - ` +
          "update SCRUB_RULES in scripts/tinytable-seed-root-builder.ts before this can ship"
      );
    }
  }
}

function toPosixPath(relPath: string): string {
  return relPath.split(sep).join("/");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

/** Recursively reads every file under `dir`, returning posix-relative paths sorted lexically. */
async function listFilesRecursive(dir: string, relBase = ""): Promise<string[]> {
  const entries = await readdir(join(dir, relBase), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relBase ? join(relBase, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(dir, rel)));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

/**
 * Copies one allowlist entry (a file or a directory) from `sourceRoot` into
 * `destRoot`, scrubbing every text file's contents on the way. Returns the
 * scrubbed content of each file written, keyed by its posix path relative to
 * `destRoot`, so the caller can hash it without re-reading from disk.
 */
async function copyAllowlistEntry(
  sourceRoot: string,
  destRoot: string,
  entry: { src: string; dest: string }
): Promise<Map<string, string>> {
  const written = new Map<string, string>();
  const srcPath = join(sourceRoot, entry.src);
  const stat = await lstat(srcPath).catch(() => {
    throw new Error(`seed-root builder: missing expected source path ${srcPath}`);
  });

  if (stat.isDirectory()) {
    const files = await listFilesRecursive(srcPath);
    for (const relFile of files) {
      const raw = await readFile(join(srcPath, relFile), "utf8");
      const scrubbed = scrubText(raw);
      const destRel = toPosixPath(join(entry.dest, relFile));
      const destPath = join(destRoot, destRel);
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, scrubbed);
      written.set(destRel, scrubbed);
    }
    return written;
  }

  const raw = await readFile(srcPath, "utf8");
  const scrubbed = scrubText(raw);
  const destPath = join(destRoot, entry.dest);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, scrubbed);
  written.set(toPosixPath(entry.dest), scrubbed);
  return written;
}

export type SeedRootManifest = {
  builderVersion: string;
  /** THE ANSWER - which mutant this seed-root came from. Grader-side only; never write this into the seed-root. */
  fixtureId: string;
  /** Hash of the pre-scrub source bytes for this mutant's allowlisted files - ties the manifest to an exact upstream fixture revision without embedding a filesystem path. */
  sourceContentSha256: string;
  files: Array<{ path: string; sha256: string }>;
  /** Hash over the sorted files[] listing - a single fixture-identity/integrity hash for #106's preflight check. */
  seedRootSha256: string;
};

export type BuildSeedRootOptions = {
  mutantId: string;
  outDir: string;
  sourceRoot?: string;
};

export async function buildSeedRoot(options: BuildSeedRootOptions): Promise<SeedRootManifest> {
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT);
  const outDir = resolve(options.outDir);

  const mutantsDir = join(sourceRoot, "mutants");
  const knownMutants = (await readdir(mutantsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!knownMutants.includes(options.mutantId)) {
    throw new Error(
      `unknown --mutant "${options.mutantId}" - expected one of: ${knownMutants.join(", ") || "(none found under " + mutantsDir + ")"}`
    );
  }

  if (await pathExists(outDir)) {
    const existing = await readdir(outDir);
    if (existing.length > 0) {
      throw new Error(`--out ${outDir} already exists and is not empty`);
    }
  }
  await mkdir(outDir, { recursive: true });

  const allowlist = [...STATIC_ALLOWLIST, ...mutantAllowlist(options.mutantId)];

  const sourceHash = createHash("sha256");
  const allContent = new Map<string, string>();
  for (const entry of allowlist) {
    const written = await copyAllowlistEntry(sourceRoot, outDir, entry);
    for (const [path, content] of written) {
      allContent.set(path, content);
    }
  }
  // Pre-scrub source bytes, hashed in a fixed (sorted-by-dest-path) order so
  // sourceContentSha256 is reproducible regardless of directory-listing order.
  for (const entry of allowlist) {
    const srcPath = join(sourceRoot, entry.src);
    const stat = await lstat(srcPath);
    if (stat.isDirectory()) {
      const files = await listFilesRecursive(srcPath);
      for (const relFile of files) {
        sourceHash.update(toPosixPath(join(entry.dest, relFile)));
        sourceHash.update(await readFile(join(srcPath, relFile), "utf8"));
      }
    } else {
      sourceHash.update(toPosixPath(entry.dest));
      sourceHash.update(await readFile(srcPath, "utf8"));
    }
  }

  const files = [...allContent.entries()]
    .map(([path, content]) => ({ path, sha256: sha256(content) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const { path } of files) {
    assertNoLeaks(path, allContent.get(path) ?? "");
  }

  const seedRootSha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");

  return {
    builderVersion: BUILDER_VERSION,
    fixtureId: options.mutantId,
    sourceContentSha256: sourceHash.digest("hex"),
    files,
    seedRootSha256
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type CliOptions = { mutantId: string; outDir: string; manifestOut: string; sourceRoot?: string };

function parseArgs(argv: string[]): CliOptions {
  let mutantId: string | undefined;
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
      case "--mutant": mutantId = next(); break;
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
  if (!mutantId) throw new Error("--mutant <id> is required");
  if (!outDir) throw new Error("--out <dir> is required");
  if (!manifestOut) throw new Error("--manifest-out <path> is required");

  const resolvedOut = resolve(outDir);
  const resolvedManifest = resolve(manifestOut);
  if (resolvedManifest === resolvedOut || resolvedManifest.startsWith(resolvedOut + sep)) {
    // The manifest carries fixtureId - the answer - and must never end up
    // inside the seed-root an agent will see.
    throw new Error(`--manifest-out ${resolvedManifest} must not be inside --out ${resolvedOut}`);
  }

  return { mutantId, outDir, manifestOut, sourceRoot };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await buildSeedRoot(options);
  const manifestPath = resolve(options.manifestOut);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Seed-root for ${manifest.fixtureId} materialized at ${resolve(options.outDir)} (${manifest.files.length} files).`);
  console.log(`Manifest written to ${manifestPath} (seedRootSha256=${manifest.seedRootSha256.slice(0, 12)}...).`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
