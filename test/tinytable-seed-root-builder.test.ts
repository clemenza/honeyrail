import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { buildSeedRoot } from "../scripts/tinytable-seed-root-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_SOURCE_ROOT = join(__dirname, "..", "examples", "tinytable-eval");

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listAllFiles(root: string, relBase = ""): Promise<string[]> {
  const entries = await readdir(join(root, relBase), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listAllFiles(root, rel)));
    } else {
      files.push(rel);
    }
  }
  return files.sort();
}

const FORBIDDEN = [/golden/i, /\bmutants?\b/i, /score\.py/i, /selfcheck/i, /tinytable-eval/i];

test("buildSeedRoot materializes only the allowlisted paths for a mutant", async (t) => {
  const outDir = await tempDir(t, "honeyrail-seed-root-");

  const manifest = await buildSeedRoot({ mutantId: "m02", outDir });

  const files = await listAllFiles(outDir);
  assert.deepEqual(files, [
    "SPEC.md",
    "findings.schema.json",
    "run_sql_tests.py",
    "sql-tests/official/aggregates.test",
    "sql-tests/official/index.test",
    "sql-tests/official/insert_update_delete.test",
    "sql-tests/official/limit_offset.test",
    "sql-tests/official/order_by.test",
    "sql-tests/official/transactions.test",
    "sql-tests/official/types.test",
    "sql-tests/official/unique.test",
    "sql-tests/official/where_comparisons.test",
    "sql-tests/official/where_logic.test",
    "tinytable/__init__.py",
    "tinytable/core.py",
    "tinytable/sql.py"
  ]);
  assert.equal(manifest.fixtureId, "m02");
  assert.equal(manifest.files.length, files.length);
});

test("buildSeedRoot scrubs known answer-key metadata out of file contents", async (t) => {
  const outDir = await tempDir(t, "honeyrail-seed-root-");
  await buildSeedRoot({ mutantId: "m02", outDir });

  const files = await listAllFiles(outDir);
  for (const relPath of files) {
    const content = await readFile(join(outDir, relPath), "utf8");
    for (const pattern of FORBIDDEN) {
      assert.equal(pattern.test(content), false, `${relPath} still matches ${pattern} after scrubbing`);
    }
  }
});

test("buildSeedRoot's manifest never contains a raw fixture path that names the mutant, and rejects an unknown mutant id", async (t) => {
  const outDir = await tempDir(t, "honeyrail-seed-root-");
  const manifest = await buildSeedRoot({ mutantId: "m05", outDir });

  assert.equal(manifest.fixtureId, "m05");
  assert.ok(manifest.seedRootSha256.match(/^[0-9a-f]{64}$/));
  assert.ok(manifest.sourceContentSha256.match(/^[0-9a-f]{64}$/));
  for (const file of manifest.files) {
    assert.ok(file.sha256.match(/^[0-9a-f]{64}$/));
  }

  const badOutDir = await tempDir(t, "honeyrail-seed-root-");
  await assert.rejects(() => buildSeedRoot({ mutantId: "m99", outDir: badOutDir }), /unknown --mutant/);
});

test("buildSeedRoot is reproducible: same mutant id produces byte-identical files and manifest", async (t) => {
  const outDirA = await tempDir(t, "honeyrail-seed-root-a-");
  const outDirB = await tempDir(t, "honeyrail-seed-root-b-");

  const manifestA = await buildSeedRoot({ mutantId: "m07", outDir: outDirA });
  const manifestB = await buildSeedRoot({ mutantId: "m07", outDir: outDirB });

  assert.equal(manifestA.seedRootSha256, manifestB.seedRootSha256);
  assert.equal(manifestA.sourceContentSha256, manifestB.sourceContentSha256);
  assert.deepEqual(manifestA.files, manifestB.files);

  const filesA = await listAllFiles(outDirA);
  const filesB = await listAllFiles(outDirB);
  assert.deepEqual(filesA, filesB);
  for (const relPath of filesA) {
    const contentA = await readFile(join(outDirA, relPath), "utf8");
    const contentB = await readFile(join(outDirB, relPath), "utf8");
    assert.equal(contentA, contentB, `${relPath} differs between two builds of the same mutant`);
  }
});

test("buildSeedRoot refuses a non-empty --out directory", async (t) => {
  const outDir = await tempDir(t, "honeyrail-seed-root-");
  await buildSeedRoot({ mutantId: "m01", outDir });
  await assert.rejects(() => buildSeedRoot({ mutantId: "m01", outDir }), /already exists and is not empty/);
});

// Regression: a compiled __pycache__/*.pyc left behind by an earlier local
// `python3 selfcheck.py`/`score.py` run embeds its source file's literal
// path - "mutants/m04/tinytable/__init__.py" - in its bytecode (co_filename),
// which is exactly the kind of answer-key metadata this builder exists to
// keep out of the seed-root, and it isn't caught by the text-content scrub
// rules since it's a binary file. Exercised against a scratch copy of the
// source tree so the test doesn't depend on (or leave behind) a real
// __pycache__ under examples/tinytable-eval.
test("buildSeedRoot excludes __pycache__ (and other non-fixture files) left behind by local test runs", async (t) => {
  const scratchSource = await tempDir(t, "honeyrail-seed-root-source-");
  await cp(REAL_SOURCE_ROOT, scratchSource, { recursive: true });

  const pycacheDir = join(scratchSource, "mutants", "m04", "tinytable", "__pycache__");
  await mkdir(pycacheDir, { recursive: true });
  await writeFile(
    join(pycacheDir, "__init__.cpython-311.pyc"),
    Buffer.from(`fake bytecode embedding ${join(scratchSource, "mutants", "m04", "tinytable", "__init__.py")}`)
  );

  const outDir = await tempDir(t, "honeyrail-seed-root-");
  const manifest = await buildSeedRoot({ mutantId: "m04", outDir, sourceRoot: scratchSource });

  const files = await listAllFiles(outDir);
  assert.ok(!files.some((f) => f.includes("__pycache__")), `__pycache__ leaked into seed-root: ${files.join(", ")}`);
  assert.ok(!manifest.files.some((f) => f.path.includes("__pycache__")));
});
