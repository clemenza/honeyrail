import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { buildSeedRoot } from "../scripts/tinytable-seed-root-builder.js";
import type { SafeCommandOutput } from "../server/utils.js";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * build_seed_root.py's own contract is `if out.exists(): raise
 * FileExistsError` - --out must not exist at all, not merely be empty (a
 * stricter requirement than the old in-repo builder's). Returns a path
 * under a fresh temp parent that mkdtemp itself never created, so
 * buildSeedRoot() can create it.
 */
async function freshOutDir(t: TestContext, prefix: string): Promise<string> {
  const parent = await tempDir(t, prefix);
  return join(parent, "out");
}

// #126: this builder is now a thin wrapper around vendor/tinytable-evals's
// own build_seed_root.py - these tests exercise it against the real,
// pinned checkout (python3 + the submodule must be present, same as any
// other test that shells out to a real tool - see e.g.
// test/tinytable-exam-room.test.ts's own docker dependency).

test("buildSeedRoot materializes a git-initialized worktree with the expected top-level entries for a seed", async (t) => {
  const outDir = await freshOutDir(t, "honeyrail-seed-root-");
  const manifest = await buildSeedRoot({ seed: 2, outDir });

  const topLevel = (await readdir(outDir)).sort();
  assert.deepEqual(topLevel, [
    ".git",
    ".gitignore",
    "SPEC.md",
    "admissibility.py",
    "findings.schema.json",
    "run_sql_tests.py",
    "scheduler.py",
    "sql-tests",
    "substrate.py",
    "task-prompt.md",
    "tinytable"
  ]);
  assert.equal(manifest.seed, 2);
  assert.ok(manifest.operatorId.length > 0);
  // .git is real VCS bookkeeping build_seed_root.py itself created - never
  // part of the manifest #106's preflight/integrity check hashes.
  assert.ok(!manifest.files.some((f) => f.path.startsWith(".git/") || f.path === ".git"));
  assert.ok(manifest.files.some((f) => f.path === "tinytable/core.py"));
  assert.ok(manifest.files.some((f) => f.path === "sql-tests/official/aggregates.test"));
});

test("buildSeedRoot's manifest carries valid sha256 hashes and rejects a malformed --seed", async (t) => {
  const outDir = await freshOutDir(t, "honeyrail-seed-root-");
  const manifest = await buildSeedRoot({ seed: 5, outDir });

  assert.ok(manifest.seedRootSha256.match(/^[0-9a-f]{64}$/));
  for (const file of manifest.files) {
    assert.ok(file.sha256.match(/^[0-9a-f]{64}$/), `${file.path} has a malformed sha256`);
  }

  const badOutDir = await freshOutDir(t, "honeyrail-seed-root-");
  await assert.rejects(() => buildSeedRoot({ seed: -1, outDir: badOutDir }), /non-negative integer/);
});

test("buildSeedRoot is reproducible: same seed produces byte-identical files and manifest", async (t) => {
  const outDirA = await freshOutDir(t, "honeyrail-seed-root-a-");
  const outDirB = await freshOutDir(t, "honeyrail-seed-root-b-");

  const manifestA = await buildSeedRoot({ seed: 7, outDir: outDirA });
  const manifestB = await buildSeedRoot({ seed: 7, outDir: outDirB });

  assert.equal(manifestA.operatorId, manifestB.operatorId);
  assert.equal(manifestA.seedRootSha256, manifestB.seedRootSha256);
  assert.deepEqual(manifestA.files, manifestB.files);
});

test("buildSeedRoot refuses an --out directory that already exists", async (t) => {
  const outDir = await freshOutDir(t, "honeyrail-seed-root-");
  await buildSeedRoot({ seed: 1, outDir });
  await assert.rejects(() => buildSeedRoot({ seed: 1, outDir }), /already exists/);
});

// A different seed can (and, per mutate.select_operator, usually does) pick
// a different operator - not asserted deterministically here since that
// mapping is upstream's to define, but two different seeds' seed-roots
// must never collide on seedRootSha256 for the operators this suite
// actually exercises.
test("buildSeedRoot: different seeds materialize different content", async (t) => {
  const outDirA = await freshOutDir(t, "honeyrail-seed-root-a-");
  const outDirB = await freshOutDir(t, "honeyrail-seed-root-b-");

  const manifestA = await buildSeedRoot({ seed: 0, outDir: outDirA });
  const manifestB = await buildSeedRoot({ seed: 1, outDir: outDirB });

  assert.notEqual(manifestA.seedRootSha256, manifestB.seedRootSha256);
});

// Defense in depth: build_seed_root.py's own contract is that the chosen
// operator id is only ever printed to stdout as SEED_ROOT_JSON, never
// written into DIR - this proves buildSeedRoot() would actually catch a
// regression of that contract, without needing to break the real upstream
// tool to exercise it.
test("buildSeedRoot rejects a seed-root that leaks its own operator id or SEED_ROOT_JSON marker into file contents", async (t) => {
  const outDir = await tempDir(t, "honeyrail-seed-root-leak-");
  await writeFile(join(outDir, "leaky.txt"), "this file mentions leaky-operator-id by name");

  const fakeRun = async (): Promise<SafeCommandOutput> => ({
    ok: true,
    stdout: `SEED_ROOT_JSON: ${JSON.stringify({ seed: 0, out: outDir, operator_id: "leaky-operator-id", created_utc: "2026-01-01T00:00:00Z" })}`,
    stderr: "",
    code: 0
  });

  await assert.rejects(() => buildSeedRoot({ seed: 0, outDir }, fakeRun), /seed-root leak/);
});

test("buildSeedRoot surfaces build_seed_root.py's own stderr on failure", async (t) => {
  const fakeRun = async (): Promise<SafeCommandOutput> => ({ ok: false, stdout: "", stderr: "boom: something went wrong", code: 1 });
  await assert.rejects(() => buildSeedRoot({ seed: 0, outDir: "/nonexistent" }, fakeRun), /boom: something went wrong/);
});
