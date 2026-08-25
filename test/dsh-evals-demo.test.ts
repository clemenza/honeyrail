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

// #114 regression: grade.py's own JSON output always has a literal "error"
// key (null on success) - runScorePy must not mistake that for its own
// driver-level failure sentinel.
test("runScorePy returns the real score when grade.py wrote a passing result, despite its own 'error: null' field", async () => {
  await withTempDir(async (dir) => {
    const realisticGradePyOutput = {
      artifacts: dir,
      clean: "/fake/tinytable-evals/clean",
      runs: 1,
      kill_rate: 1,
      kill_rate_threshold: 1,
      killed: true,
      killed_tests: ["sql-tests/agent/null_eq.test:17"],
      killed_by_kind: { assertion: 1, invariant: 0 },
      false_alarms: 0,
      contract_ok: true,
      contract_errors: [],
      f_mutant: ["sql-tests/agent/null_eq.test:17"],
      f_clean: [],
      per_run: [{ seed: 0, killed: true, killed_tests: ["sql-tests/agent/null_eq.test:17"], killed_by_kind: { assertion: 1, invariant: 0 }, false_alarms: 0, f_mutant: ["sql-tests/agent/null_eq.test:17"], f_clean: [] }],
      error: null,
      passed: true
    };
    await writeFile(join(dir, "score.json"), JSON.stringify(realisticGradePyOutput));

    const noopRun = async (): Promise<SafeCommandOutput> => ({ ok: true, stdout: "", stderr: "", code: 0 });
    const result = await runScorePy(dir, noopRun);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.score.killed, true);
      assert.equal(result.score.kill_rate, 1);
      assert.equal(result.score.false_alarms, 0);
      assert.equal(result.score.contract_ok, true);
      assert.equal(result.score.passed, true);
    }
  });
});

test("runScorePy returns the real score for a genuine failure too (killed: false), not just the happy path", async () => {
  await withTempDir(async (dir) => {
    const failingGradePyOutput = {
      artifacts: dir,
      clean: "/fake/tinytable-evals/clean",
      runs: 1,
      kill_rate: 0,
      kill_rate_threshold: 1,
      killed: false,
      killed_tests: [],
      killed_by_kind: { assertion: 0, invariant: 0 },
      false_alarms: 2,
      contract_ok: true,
      contract_errors: [],
      f_mutant: [],
      f_clean: ["sql-tests/agent/foo.test:1", "sql-tests/agent/foo.test:2"],
      per_run: [{ seed: 0, killed: false, killed_tests: [], killed_by_kind: { assertion: 0, invariant: 0 }, false_alarms: 2, f_mutant: [], f_clean: ["sql-tests/agent/foo.test:1", "sql-tests/agent/foo.test:2"] }],
      error: null,
      passed: false
    };
    await writeFile(join(dir, "score.json"), JSON.stringify(failingGradePyOutput));

    const noopRun = async (): Promise<SafeCommandOutput> => ({ ok: true, stdout: "", stderr: "", code: 0 });
    const result = await runScorePy(dir, noopRun);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.score.killed, false);
      assert.equal(result.score.false_alarms, 2);
    }
  });
});

// #126: grade.py's --runs/--kill-rate-threshold (upstream issue #21's
// probabilistic multi-seed scoring) replace the old score.py's single-run
// --kill-matrix-pool/--agent-blocked-reason flags, which have no upstream
// equivalent - see docs/dsh-evals-demo.md.
test("runScorePy passes --runs and --kill-rate-threshold through to grade.py when non-default", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "score.json"), JSON.stringify({ killed: true, kill_rate: 0.8, false_alarms: 0, contract_ok: true, passed: true }));

    let receivedArgs: string[] = [];
    const capturingRun = async (_cmd: string, args: string[] = []): Promise<SafeCommandOutput> => {
      receivedArgs = args;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    const result = await runScorePy(dir, capturingRun, { runs: 5, killRateThreshold: 0.8 });

    const runsIndex = receivedArgs.indexOf("--runs");
    assert.ok(runsIndex >= 0, `expected --runs in args, got ${JSON.stringify(receivedArgs)}`);
    assert.equal(receivedArgs[runsIndex + 1], "5");
    const thresholdIndex = receivedArgs.indexOf("--kill-rate-threshold");
    assert.ok(thresholdIndex >= 0, `expected --kill-rate-threshold in args, got ${JSON.stringify(receivedArgs)}`);
    assert.equal(receivedArgs[thresholdIndex + 1], "0.8");

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.score.kill_rate, 0.8);
    }
  });
});

test("runScorePy omits --runs and --kill-rate-threshold when they're the defaults (matches original single-run behavior)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "score.json"), JSON.stringify({ killed: true, false_alarms: 0, contract_ok: true, passed: true }));

    let receivedArgs: string[] = [];
    const capturingRun = async (_cmd: string, args: string[] = []): Promise<SafeCommandOutput> => {
      receivedArgs = args;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    await runScorePy(dir, capturingRun, { runs: 1, killRateThreshold: 1 });

    assert.ok(!receivedArgs.includes("--runs"), `expected no --runs, got ${JSON.stringify(receivedArgs)}`);
    assert.ok(!receivedArgs.includes("--kill-rate-threshold"), `expected no --kill-rate-threshold, got ${JSON.stringify(receivedArgs)}`);
  });
});

// clemenza/tinytable-evals#51: grade.py's own step-1 run_sql_tests.py
// invocations are the one remaining #40 gap this driver could close
// without deriving anything - grade.py just needed the flag threaded
// through, same as --runs/--kill-rate-threshold above.
test("runScorePy passes --trajectory-log through to grade.py when given, omits it when not", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "score.json"), JSON.stringify({ killed: true, false_alarms: 0, contract_ok: true, passed: true }));

    let receivedArgs: string[] = [];
    const capturingRun = async (_cmd: string, args: string[] = []): Promise<SafeCommandOutput> => {
      receivedArgs = args;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    await runScorePy(dir, capturingRun, { trajectoryLog: "trajectory.jsonl" });
    const index = receivedArgs.indexOf("--trajectory-log");
    assert.ok(index >= 0, `expected --trajectory-log in args, got ${JSON.stringify(receivedArgs)}`);
    assert.equal(receivedArgs[index + 1], "trajectory.jsonl");

    receivedArgs = [];
    await runScorePy(dir, capturingRun, {});
    assert.ok(!receivedArgs.includes("--trajectory-log"), `expected no --trajectory-log, got ${JSON.stringify(receivedArgs)}`);
  });
});

// #57 (clemenza/tinytable-evals#59), opt-in: --pg-adjudicate is a plain
// boolean flag (no value), unlike --runs/--kill-rate-threshold/
// --trajectory-log above - just present or absent.
test("runScorePy passes --pg-adjudicate through to grade.py when requested, omits it when not", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "score.json"), JSON.stringify({ killed: true, false_alarms: 0, contract_ok: true, passed: true }));

    let receivedArgs: string[] = [];
    const capturingRun = async (_cmd: string, args: string[] = []): Promise<SafeCommandOutput> => {
      receivedArgs = args;
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    await runScorePy(dir, capturingRun, { pgAdjudicate: true });
    assert.ok(receivedArgs.includes("--pg-adjudicate"), `expected --pg-adjudicate in args, got ${JSON.stringify(receivedArgs)}`);

    receivedArgs = [];
    await runScorePy(dir, capturingRun, { pgAdjudicate: false });
    assert.ok(!receivedArgs.includes("--pg-adjudicate"), `expected no --pg-adjudicate, got ${JSON.stringify(receivedArgs)}`);

    receivedArgs = [];
    await runScorePy(dir, capturingRun, {});
    assert.ok(!receivedArgs.includes("--pg-adjudicate"), `expected no --pg-adjudicate when omitted, got ${JSON.stringify(receivedArgs)}`);
  });
});

test("runScorePy reports a driver-level error when grade.py produced no score.json at all", async () => {
  await withTempDir(async (dir) => {
    const failedRun = async (): Promise<SafeCommandOutput> => ({ ok: false, stdout: "", stderr: "Traceback: boom", code: 1 });
    const result = await runScorePy(dir, failedRun);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /grade\.py produced no score\.json/);
      assert.match(result.error, /boom/);
    }
  });
});
