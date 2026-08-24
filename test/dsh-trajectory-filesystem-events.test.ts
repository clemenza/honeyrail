import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { gitDiff, logAgentSnapshot, logFileDiff, snapshotManifest } from "../server/evals/dsh-trajectory-filesystem-events.js";
import { runCommandSafe } from "../server/utils.js";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function gitInitCommit(repoPath: string): Promise<void> {
  await runCommandSafe("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
  await runCommandSafe("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A"], { cwd: repoPath });
  await runCommandSafe("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed"], { cwd: repoPath });
}

test("gitDiff: empty diff/files_changed against a pristine commit with no changes", async (t) => {
  const dir = await tempDir(t, "honeyrail-file-diff-");
  await writeFile(join(dir, "a.txt"), "hello\n");
  await gitInitCommit(dir);

  const result = await gitDiff(dir);
  assert.equal(result.diff, "");
  assert.deepEqual(result.filesChanged, []);
});

test("gitDiff: reports a modified and a newly-added file against the baseline commit", async (t) => {
  const dir = await tempDir(t, "honeyrail-file-diff-");
  await writeFile(join(dir, "a.txt"), "hello\n");
  await gitInitCommit(dir);

  await writeFile(join(dir, "a.txt"), "hello world\n");
  await mkdir(join(dir, "sql-tests", "agent"), { recursive: true });
  await writeFile(join(dir, "sql-tests", "agent", "new.test"), "statement ok\nSELECT 1\n");

  const result = await gitDiff(dir);
  assert.ok(result.diff.includes("hello world"), `expected diff to mention the new content, got: ${result.diff}`);
  const statuses = result.filesChanged.map(([status, path]) => `${status} ${path}`);
  assert.ok(statuses.includes("M a.txt"), `expected 'M a.txt' in ${JSON.stringify(statuses)}`);
  assert.ok(statuses.some((s) => s.startsWith("A") && s.includes("new.test")), `expected an added new.test in ${JSON.stringify(statuses)}`);
});

test("gitDiff: not a git repo at all returns empty rather than throwing", async (t) => {
  const dir = await tempDir(t, "honeyrail-file-diff-not-git-");
  const result = await gitDiff(dir);
  assert.deepEqual(result, { diff: "", filesChanged: [] });
});

test("snapshotManifest: hashes every file under subdir, path relative to seedRootDir, skips a missing subdir", async (t) => {
  const dir = await tempDir(t, "honeyrail-agent-snapshot-");
  assert.deepEqual(await snapshotManifest(dir), [], "no sql-tests/agent/ at all");

  const agentDir = join(dir, "sql-tests", "agent");
  await mkdir(join(agentDir, "nested"), { recursive: true });
  await writeFile(join(agentDir, "a.test"), "AAAA");
  await writeFile(join(agentDir, "nested", "b.test"), "BB");

  const files = await snapshotManifest(dir);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(files.length, 2);
  assert.deepEqual(byPath["sql-tests/agent/a.test"], {
    path: "sql-tests/agent/a.test",
    sha256: createHash("sha256").update("AAAA").digest("hex"),
    size: 4
  });
  assert.deepEqual(byPath["sql-tests/agent/nested/b.test"], {
    path: "sql-tests/agent/nested/b.test",
    sha256: createHash("sha256").update("BB").digest("hex"),
    size: 2
  });
});

test("logFileDiff and logAgentSnapshot append schema-shaped events to trajectory.jsonl without clobbering it", async (t) => {
  const dir = await tempDir(t, "honeyrail-trajectory-fs-events-");
  await writeFile(join(dir, "a.txt"), "hello\n");
  await mkdir(join(dir, "sql-tests", "agent"), { recursive: true });
  await gitInitCommit(dir);
  await writeFile(join(dir, "sql-tests", "agent", "smoke.test"), "statement ok\nSELECT 1\n");

  // A pre-existing trajectory.jsonl (as grade.py --trajectory-log or dsh-trajectory-bridge.ts would have already written) must be appended to.
  await writeFile(join(dir, "trajectory.jsonl"), `${JSON.stringify({ seq: 1, ts: "2026-08-24T00:00:00.000Z", kind: "test_run" })}\n`);

  await logFileDiff(dir);
  await logAgentSnapshot(dir);

  const lines = (await readFile(join(dir, "trajectory.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].kind, "test_run");

  const fileDiff = lines.find((e) => e.kind === "file_diff");
  assert.ok(fileDiff);
  assert.equal(fileDiff.baseline_ref, "HEAD");
  assert.equal(fileDiff.root, dir);
  assert.ok(Array.isArray(fileDiff.files_changed));
  assert.equal(typeof fileDiff.diff, "string");

  const snapshot = lines.find((e) => e.kind === "agent_snapshot");
  assert.ok(snapshot);
  assert.equal(snapshot.subdir, "sql-tests/agent");
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, "sql-tests/agent/smoke.test");
});
