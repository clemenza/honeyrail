import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

/**
 * Regression coverage for the false-green defect a real GitHub Actions run
 * exposed in `.github/workflows/pg-research-integration.yml` (#197 round 2
 * review): `test/postgres-research-live-e2e.test.ts` reported `fail 1` with a
 * concrete `.Variant` template error, yet both the step and the whole
 * workflow concluded `success`.
 *
 * Root cause: every required step piped `node --test ... | tee some.log`
 * without `set -o pipefail`. GitHub's default `bash` invocation for a `run:`
 * step does NOT set `-o pipefail` on its own - a pipeline's exit status is
 * its *last* command's, which here is always `tee`, and `tee` succeeds
 * regardless of what the left-hand process wrote into the log. The later
 * "Fail if any required test skipped" step only ever checked `skipped == 0`,
 * so a suite with `fail > 0` and `skipped == 0` sailed through both gates.
 *
 * Two things have to be demonstrated, and this file demonstrates both
 * without needing a real GitHub Actions run:
 *
 * 1. The exact shell pattern the workflow now uses (`set -euo pipefail`
 *    before a `... | tee ...` pipeline) really does propagate a failing left-
 *    hand command's exit status - and, for contrast, that the pattern it
 *    replaces (no `pipefail`) really does not, which is the concrete
 *    mechanism of the bug this file guards against regressing to.
 * 2. `scripts/pg-research-gate-check.sh` - the script both this workflow and
 *    this test now share - still rejects a log reporting `skipped > 0` even
 *    when `fail == 0`, so a suite that quietly skipped its required test
 *    cannot pass either.
 */

const GATE_SCRIPT = join(process.cwd(), "scripts", "pg-research-gate-check.sh");

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // This whole file runs under `node --test` itself, which sets
  // NODE_TEST_CONTEXT in its own process.env; a spawned child that inherits
  // it and also runs `node --test` hits node's own nested-run guard ("run()
  // is being called recursively within a test file") and silently skips
  // running anything instead of actually executing the nested suite. Strip
  // it so the child `node --test` invocations this file spawns on purpose
  // (to reproduce the workflow's own failure mode) actually run.
  const { NODE_TEST_CONTEXT: _unused, ...env } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// --- the root-cause mechanism itself ---------------------------------------

test("without pipefail, a failing command piped into tee reports success - the exact defect this workflow had", async () => {
  // This is deliberately the *old*, broken shape every required step in
  // pg-research-integration.yml used to have: no `set -o pipefail` before a
  // `... | tee ...` pipeline.
  const { code } = await run("bash", ["-c", "( exit 7 ) 2>&1 | tee /dev/null"]);
  assert.equal(code, 0, "a bash pipeline's exit status is its last command's (tee, which always succeeds) without pipefail - this is the bug");
});

test("with set -o pipefail, the same failing command piped into tee now correctly fails - the exact fix applied to every required step", async () => {
  const { code } = await run("bash", ["-c", "set -euo pipefail; ( exit 7 ) 2>&1 | tee /dev/null"]);
  assert.notEqual(code, 0, "pipefail must make the pipeline's exit status the failing left-hand command's, not tee's");
});

test("a real failing node --test suite piped into tee, under pipefail, fails the shell - not just an exit(7) stand-in", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-gate-selftest-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const failingTestFile = join(dir, "always-fails.test.mjs");
  await writeFile(
    failingTestFile,
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('deliberately fails', () => assert.equal(1, 2));\n"
  );

  const withoutPipefail = await run("bash", ["-c", `node --test '${failingTestFile}' 2>&1 | tee '${join(dir, "out.log")}'`]);
  assert.equal(withoutPipefail.code, 0, "reproduces the exact false-green shape: the step-level exit code is 0 despite the suite failing");
  assert.match(withoutPipefail.stdout, /fail 1/);

  const withPipefail = await run("bash", ["-c", `set -euo pipefail; node --test '${failingTestFile}' 2>&1 | tee '${join(dir, "out2.log")}'`]);
  assert.notEqual(withPipefail.code, 0, "with pipefail, the same failing suite now correctly fails the step");
  assert.match(withPipefail.stdout, /fail 1/);
});

// --- scripts/pg-research-gate-check.sh, shared with the real workflow -----

async function writeLog(dir: string, name: string, summary: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `node --test summary\n${summary}\n`);
  return path;
}

test("pg-research-gate-check.sh passes a log reporting fail 0, skipped 0", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-gate-check-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const log = await writeLog(dir, "ok.log", "# tests 3\n# pass 3\n# fail 0\n# skipped 0");

  const result = await run("bash", [GATE_SCRIPT, log]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /skipped=0/);
});

test("pg-research-gate-check.sh rejects a log with skipped > 0, even when fail is 0 - the existing skip gate, unweakened", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-gate-check-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const log = await writeLog(dir, "skipped.log", "# tests 5\n# pass 4\n# fail 0\n# skipped 1");

  const result = await run("bash", [GATE_SCRIPT, log]);
  assert.notEqual(result.code, 0, "a skipped required test must fail the gate even with zero failures");
  assert.match(result.stdout, /skipped=1/);
  assert.match(result.stdout, /a required PostgreSQL research test skipped/);
});

test("pg-research-gate-check.sh rejects an unparseable log rather than treating it as zero", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-gate-check-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const log = await writeLog(dir, "garbage.log", "the process crashed before printing a summary at all");

  const result = await run("bash", [GATE_SCRIPT, log]);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /skipped=unparseable/);
});

test("pg-research-gate-check.sh checks every given log, not just the first", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-gate-check-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const good = await writeLog(dir, "good.log", "# tests 1\n# pass 1\n# fail 0\n# skipped 0");
  const bad = await writeLog(dir, "bad.log", "# tests 1\n# pass 0\n# fail 0\n# skipped 1");

  const result = await run("bash", [GATE_SCRIPT, good, bad]);
  assert.notEqual(result.code, 0, "one bad log among several must still fail the gate");
  assert.match(result.stdout, /good\.log: skipped=0/);
  assert.match(result.stdout, /bad\.log: skipped=1/);
});
