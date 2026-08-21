import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runScorePy } from "../scripts/dsh-evals-demo.js";
import type { SafeCommandOutput } from "../server/utils.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dsh-evals-demo-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// #114 regression: score.py's own JSON output always has a literal "error"
// key (null on success) - runScorePy must not mistake that for its own
// driver-level failure sentinel.
test("runScorePy returns the real score when score.py wrote a passing result, despite its own 'error: null' field", async () => {
  await withTempDir(async (dir) => {
    const realisticScorePyOutput = {
      worktree: dir,
      clean: "/fake/tinytable-eval/clean",
      killed: true,
      killed_tests: ["sql-tests/agent/null_eq.test:17"],
      false_alarms: 0,
      contract_ok: true,
      contract_errors: [],
      f_mutant: ["sql-tests/agent/null_eq.test:17"],
      f_clean: [],
      error: null,
      passed: true
    };
    await writeFile(join(dir, "score.json"), JSON.stringify(realisticScorePyOutput));

    const noopRun = async (): Promise<SafeCommandOutput> => ({ ok: true, stdout: "", stderr: "", code: 0 });
    const result = await runScorePy(dir, noopRun);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.score.killed, true);
      assert.equal(result.score.false_alarms, 0);
      assert.equal(result.score.contract_ok, true);
      assert.equal(result.score.passed, true);
    }
  });
});

test("runScorePy returns the real score for a genuine failure too (killed: false), not just the happy path", async () => {
  await withTempDir(async (dir) => {
    const failingScorePyOutput = {
      worktree: dir,
      clean: "/fake/tinytable-eval/clean",
      killed: false,
      killed_tests: [],
      false_alarms: 2,
      contract_ok: true,
      contract_errors: [],
      f_mutant: [],
      f_clean: ["sql-tests/agent/foo.test:1", "sql-tests/agent/foo.test:2"],
      error: null,
      passed: false
    };
    await writeFile(join(dir, "score.json"), JSON.stringify(failingScorePyOutput));

    const noopRun = async (): Promise<SafeCommandOutput> => ({ ok: true, stdout: "", stderr: "", code: 0 });
    const result = await runScorePy(dir, noopRun);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.score.killed, false);
      assert.equal(result.score.false_alarms, 2);
    }
  });
});

// #108: a BLOCKED reason the driver detected must reach score.py as
// --agent-blocked-reason, so a correctly-BLOCKED trial gets contract_ok
// credit for an empty submission instead of being scored like a lazy one.
test("runScorePy passes an agentBlockedReason through to score.py as --agent-blocked-reason", async () => {
  await withTempDir(async (dir) => {
    const blockedScorePyOutput = {
      worktree: dir,
      clean: "/fake/tinytable-eval/clean",
      killed: false,
      killed_tests: [],
      false_alarms: 0,
      contract_ok: true,
      contract_errors: [],
      f_mutant: [],
      f_clean: [],
      kill_matrix: null,
      agent_blocked: true,
      agent_blocked_reason: "target database is unreachable from this sandbox",
      error: null,
      passed: false
    };
    await writeFile(join(dir, "score.json"), JSON.stringify(blockedScorePyOutput));

    let receivedArgs: string[] = [];
    const capturingRun = async (_cmd: string, args: string[] = []): Promise<SafeCommandOutput> => {
      receivedArgs = args;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    const result = await runScorePy(dir, capturingRun, "target database is unreachable from this sandbox");

    const flagIndex = receivedArgs.indexOf("--agent-blocked-reason");
    assert.ok(flagIndex >= 0, `expected --agent-blocked-reason in args, got ${JSON.stringify(receivedArgs)}`);
    assert.equal(receivedArgs[flagIndex + 1], "target database is unreachable from this sandbox");

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.score.contract_ok, true);
      assert.equal(result.score.agent_blocked, true);
      assert.equal(result.score.passed, false);
    }
  });
});

test("runScorePy omits --agent-blocked-reason when no blocked reason was detected", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "score.json"), JSON.stringify({ killed: true, false_alarms: 0, contract_ok: true, passed: true }));

    let receivedArgs: string[] = [];
    const capturingRun = async (_cmd: string, args: string[] = []): Promise<SafeCommandOutput> => {
      receivedArgs = args;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    await runScorePy(dir, capturingRun);

    assert.ok(!receivedArgs.includes("--agent-blocked-reason"), `expected no --agent-blocked-reason, got ${JSON.stringify(receivedArgs)}`);
  });
});

test("runScorePy reports a driver-level error when score.py produced no score.json at all", async () => {
  await withTempDir(async (dir) => {
    const failedRun = async (): Promise<SafeCommandOutput> => ({ ok: false, stdout: "", stderr: "Traceback: boom", code: 1 });
    const result = await runScorePy(dir, failedRun);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /score\.py produced no score\.json/);
      assert.match(result.error, /boom/);
    }
  });
});
