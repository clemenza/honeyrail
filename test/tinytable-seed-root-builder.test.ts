import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { buildSeedRoot } from "../scripts/tinytable-seed-root-builder.js";

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
