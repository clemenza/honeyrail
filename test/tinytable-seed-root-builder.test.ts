import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

import { buildOracleAgentRoot, buildSeedRoot, copyBackAgentArtifacts } from "../scripts/tinytable-seed-root-builder.js";
import { runInExamRoom, DEFAULT_IMAGE } from "../scripts/tinytable-exam-room.js";
import { runCommandSafe, type SafeCommandOutput } from "../server/utils.js";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

const execFileAsync = promisify(execFile);

/**
 * Review fix (P0/CI): `buildSeedRoot({ engineAccess: "bytecode" })` compiles
 * `.pyc` *inside* `DEFAULT_IMAGE` (see `applyBlackBoxTransform`,
 * scripts/tinytable-seed-root-builder.ts) - every `--black-box` test below
 * depends on it, not just the one that also calls `runInExamRoom` directly.
 * GitHub Actions doesn't build this image, so all three failed unguarded.
 * Same skip-when-unbuilt pattern test/tinytable-exam-room.test.ts's own
 * `examRoomImageAvailable` already uses.
 */
async function examRoomImageAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", DEFAULT_IMAGE]);
    return true;
  } catch {
    return false;
  }
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
    "tinytable",
    "trajectory.py"
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

// #158: black-box mode - a first, cheap probe (see that issue's own
// scoping writeup for why this is deliberately not believed to be robust).

test("buildSeedRoot --black-box hides tinytable/{core,sql}.py, leaves __init__.py, and the seed-root still runs the official suite inside the same exam-room image", async (t) => {
  if (!(await examRoomImageAvailable())) {
    t.skip(`${DEFAULT_IMAGE} not built locally - see docker/tinytable-exam-room/Dockerfile`);
    return;
  }
  const outDir = await freshOutDir(t, "honeyrail-seed-root-blackbox-");
  const manifest = await buildSeedRoot({ seed: 10, outDir, engineAccess: "bytecode" });

  const paths = manifest.files.map((f) => f.path);
  assert.ok(!paths.includes("tinytable/core.py"), "core.py should be hidden");
  assert.ok(!paths.includes("tinytable/sql.py"), "sql.py should be hidden");
  assert.ok(paths.includes("tinytable/core.pyc"), "core.pyc should replace it");
  assert.ok(paths.includes("tinytable/sql.pyc"), "sql.pyc should replace it");
  assert.ok(paths.includes("tinytable/__init__.py"), "__init__.py is never mutated by any operator - stays visible");

  // Verified through the same exam-room image the transform compiled
  // against, not the host's own python3 - a real trial found this exact
  // gap (clemenza/honeyrail#158: host was 3.10.13, the image is 3.11.2,
  // "ImportError: bad magic number" on the very first import). The host
  // and the image are expected to disagree on Python version - that's
  // the whole point of compiling inside the image.
  const result = await runInExamRoom({ seedRootDir: outDir, command: ["python3", "run_sql_tests.py", "--root", ".", "sql-tests/official"] });
  assert.equal(result.exitCode, 0, `official suite should still pass against the compiled-only engine, inside the image: ${result.stdout}${result.stderr}`);
});

test("buildSeedRoot --black-box: both core.py and sql.py are always hidden together, even for an operator that only mutates one of them", async (t) => {
  if (!(await examRoomImageAvailable())) {
    t.skip(`${DEFAULT_IMAGE} not built locally - see docker/tinytable-exam-room/Dockerfile`);
    return;
  }
  // Presence/absence alone must not leak which file holds the seeded
  // defect - see BuildSeedRootOptions.engineAccess's own docstring.
  const outDir = await freshOutDir(t, "honeyrail-seed-root-blackbox-");
  const manifest = await buildSeedRoot({ seed: 10, outDir, engineAccess: "bytecode" }); // seed 10 mutates sql.py only
  const paths = manifest.files.map((f) => f.path);
  assert.ok(!paths.includes("tinytable/core.py") && !paths.includes("tinytable/sql.py"));
});

test("buildSeedRoot --black-box wipes .git so the hidden .py content isn't recoverable from build_seed_root.py's own pre-transform commit", async (t) => {
  // Real finding from a real trial (clemenza/honeyrail#158): build_seed_root.py
  // git-inits and commits the seed-root *with the readable .py present*,
  // before this transform ever runs - deleting the working-tree file alone
  // leaves the original blob fully recoverable via `git show
  // HEAD:tinytable/sql.py` or a raw `.git/objects` read. Simulates
  // scripts/dsh-evals-demo.ts's own unconditional post-buildSeedRoot
  // gitInitCommit() call, since that's what actually re-seeds history for
  // a real trial.
  if (!(await examRoomImageAvailable())) {
    t.skip(`${DEFAULT_IMAGE} not built locally - see docker/tinytable-exam-room/Dockerfile`);
    return;
  }
  const outDir = await freshOutDir(t, "honeyrail-seed-root-blackbox-");
  await buildSeedRoot({ seed: 10, outDir, engineAccess: "bytecode" });

  await runCommandSafe("git", ["init", "-q", "-b", "main"], { cwd: outDir });
  await runCommandSafe("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: outDir });
  await runCommandSafe("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: outDir });

  const show = await runCommandSafe("git", ["show", "HEAD:tinytable/sql.py"], { cwd: outDir });
  assert.ok(!show.ok, "tinytable/sql.py must not exist at HEAD in the fresh history");

  const logCount = await runCommandSafe("git", ["rev-list", "--count", "HEAD"], { cwd: outDir });
  assert.equal(logCount.stdout.trim(), "1", "history must be exactly one commit - no earlier, pre-transform commit to recover a blob from");
});

// #168: engineAccess=oracle's privateRoot/agentRoot split.

test("buildOracleAgentRoot: agentRoot has no tinytable/ or direct-execution siblings, and oracle_run_sql_tests.py in place of run_sql_tests.py", async (t) => {
  const privateRoot = await freshOutDir(t, "honeyrail-oracle-private-");
  await buildSeedRoot({ seed: 10, outDir: privateRoot });
  const agentRoot = await tempDir(t, "honeyrail-oracle-agent-");

  const result = await buildOracleAgentRoot(privateRoot, agentRoot);

  const paths = result.agentFiles.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith("tinytable/")), "no tinytable/ file should exist in agentRoot");
  for (const sibling of ["admissibility.py", "scheduler.py", "substrate.py", "trajectory.py"]) {
    assert.ok(!paths.includes(sibling), `${sibling} should not exist in agentRoot`);
  }
  assert.ok(paths.includes("run_sql_tests.py"), "run_sql_tests.py should still exist (as the oracle client)");
  const runSqlTests = await readFile(join(agentRoot, "run_sql_tests.py"), "utf8");
  assert.match(runSqlTests, /oracle_run_sql_tests/, "run_sql_tests.py's content should be the oracle client, not the direct-execution runner");
  assert.ok(paths.includes("SPEC.md"), "sanctioned material (SPEC.md) should still be present");
});

test("buildOracleAgentRoot: agentRoot has no import path to tinytable at all", async (t) => {
  const privateRoot = await freshOutDir(t, "honeyrail-oracle-private-");
  await buildSeedRoot({ seed: 10, outDir: privateRoot });
  const agentRoot = await tempDir(t, "honeyrail-oracle-agent-");
  await buildOracleAgentRoot(privateRoot, agentRoot);

  // No docker needed - this is the same host-python3 sanity check #170's
  // manual trial used to confirm the boundary structurally, not just by
  // convention.
  const attempt = await runCommandSafe("python3", ["-c", "import tinytable"], { cwd: agentRoot });
  assert.ok(!attempt.ok, "import tinytable must fail from agentRoot");
  assert.match(attempt.stderr, /ModuleNotFoundError/);
});

test("buildOracleAgentRoot: throws if a stray artifact survives into agentRoot (defense in depth against tinytable-evals#70's leak class)", async (t) => {
  // A synthetic fixture, not a real buildSeedRoot() output - proves the
  // check itself works without needing docker/a real mutant, mirroring
  // the existing operator-id-leak test's fakeRun style above.
  const privateRoot = await tempDir(t, "honeyrail-oracle-private-poisoned-");
  await mkdir(join(privateRoot, "tinytable"), { recursive: true });
  await writeFile(join(privateRoot, "tinytable", "__init__.py"), "");
  await mkdir(join(privateRoot, "sql-tests", "agent"), { recursive: true });
  await writeFile(join(privateRoot, "SPEC.md"), "spec\n");
  await writeFile(join(privateRoot, "run_sql_tests.py"), "# real runner\n");
  // Stray content OUTSIDE tinytable/ (which buildOracleAgentRoot always
  // deletes wholesale) and not one of the named direct-execution siblings -
  // simulates a leak that survives the rest of the transform.
  await mkdir(join(privateRoot, "some_dir", "__pycache__"), { recursive: true });
  await writeFile(join(privateRoot, "some_dir", "__pycache__", "mod.cpython-311.pyc"), "fake bytecode");

  const agentRoot = await tempDir(t, "honeyrail-oracle-agent-poisoned-");
  await assert.rejects(() => buildOracleAgentRoot(privateRoot, agentRoot), /engineAccess=oracle agentRoot leak/);
});

test("copyBackAgentArtifacts: touches only sql-tests/agent/** and findings.json, never tinytable/ or sql-tests/official/", async (t) => {
  const privateRoot = await freshOutDir(t, "honeyrail-oracle-copyback-private-");
  await buildSeedRoot({ seed: 10, outDir: privateRoot });
  await runCommandSafe("git", ["init", "-q", "-b", "main"], { cwd: privateRoot });
  await runCommandSafe("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: privateRoot });
  await runCommandSafe("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"], { cwd: privateRoot });

  const agentRoot = await tempDir(t, "honeyrail-oracle-copyback-agent-");
  await buildOracleAgentRoot(privateRoot, agentRoot);
  await writeFile(join(agentRoot, "sql-tests", "agent", "my_probe.test"), "statement ok\nSELECT 1\n");
  await writeFile(join(agentRoot, "findings.json"), "[]\n");

  await copyBackAgentArtifacts(agentRoot, privateRoot);

  const status = await runCommandSafe("git", ["status", "--porcelain"], { cwd: privateRoot });
  const changedPaths = status.stdout.trim().split("\n").filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ""));
  for (const path of changedPaths) {
    assert.ok(
      path.startsWith("sql-tests/agent/") || path === "findings.json",
      `copy-back touched an unexpected path: ${path} - grade.py's protected-path check would spuriously fail on this`
    );
  }
  assert.ok(changedPaths.includes("sql-tests/agent/my_probe.test"));
  assert.ok(changedPaths.includes("findings.json"));

  const protectedCheck = await runCommandSafe("git", ["status", "--porcelain", "--", "tinytable/", "sql-tests/official/"], { cwd: privateRoot });
  assert.equal(protectedCheck.stdout.trim(), "", "tinytable/ and sql-tests/official/ must show zero git changes after copy-back");
});
