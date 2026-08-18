import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildComparisonReport,
  classifyTrialOutcome,
  summarizeTaskCells,
  summarizeVariants,
  type ComparisonReportInput,
  type TrialRecord
} from "../server/evals/ab-report.js";

// Aggregation for the #25 A/B eval demo: the comparison report's numbers
// must be exact functions of the per-trial records, and the noise statement
// must honestly distinguish "delta exceeds trial-to-trial noise" from
// "indistinguishable at this N".

function trial(overrides: Partial<TrialRecord>): TrialRecord {
  return {
    variant: "baseline",
    taskId: "fizzbuzz",
    trial: 1,
    runId: "run_x",
    runStatus: "succeeded",
    gatePassed: true,
    wallTimeMs: 60_000,
    evidence: [],
    ...overrides
  };
}

function reportInput(trials: TrialRecord[]): ComparisonReportInput {
  return {
    generatedAt: "2026-08-17T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:4178",
    recipeId: "eval-instruction-ab-trial",
    projectId: "proj_1",
    agent: "codex",
    smoke: false,
    variants: [
      { label: "baseline", path: "AGENTS.md", sha256: "a".repeat(64) },
      { label: "improved", path: "AGENTS.md", sha256: "b".repeat(64) }
    ],
    trials
  };
}

test("summarizeVariants computes pass rate and mean wall time per variant", () => {
  const summaries = summarizeVariants([
    trial({ variant: "baseline", trial: 1, gatePassed: true, wallTimeMs: 60_000 }),
    trial({ variant: "baseline", trial: 2, gatePassed: false, wallTimeMs: 120_000 }),
    trial({ variant: "improved", trial: 1, gatePassed: true, wallTimeMs: undefined })
  ]);
  const baseline = summaries.find((summary) => summary.variant === "baseline")!;
  assert.deepEqual(baseline, {
    variant: "baseline",
    trials: 2,
    passes: 1,
    taskFailed: 0,
    verifyFailed: 1,
    blocked: 0,
    passRate: 0.5,
    meanWallTimeMs: 90_000
  });
  const improved = summaries.find((summary) => summary.variant === "improved")!;
  assert.deepEqual(improved, {
    variant: "improved",
    trials: 1,
    passes: 1,
    taskFailed: 0,
    verifyFailed: 0,
    blocked: 0,
    passRate: 1,
    meanWallTimeMs: null
  });
});

// #69: a blocked trial carries no pass/fail signal, so it must not be
// counted as a failure - it's excluded from the pass-rate denominator and
// reported as its own bucket instead.
test("summarizeVariants excludes blocked trials from the pass-rate denominator", () => {
  const summaries = summarizeVariants([
    trial({ variant: "baseline", trial: 1, gatePassed: true }),
    trial({ variant: "baseline", trial: 2, runStatus: "blocked", gatePassed: false }),
    trial({ variant: "baseline", trial: 3, runStatus: "cancelled", gatePassed: false })
  ]);
  const baseline = summaries.find((summary) => summary.variant === "baseline")!;
  assert.equal(baseline.trials, 3);
  assert.equal(baseline.passes, 1);
  assert.equal(baseline.blocked, 2);
  // 1 pass out of (3 - 2 blocked) = 1 scored trial, not 1/3.
  assert.equal(baseline.passRate, 1);
});

test("classifyTrialOutcome splits failed runs into task_failed vs verify_failed by step failureKind", () => {
  assert.equal(classifyTrialOutcome({ runStatus: "succeeded", gatePassed: true }), "passed");
  // A run that "succeeded" but whose gate never cleanly passed (e.g. an
  // operator overrode a failing gate) never passed verification unaided.
  assert.equal(classifyTrialOutcome({ runStatus: "succeeded", gatePassed: false }), "verify_failed");
  assert.equal(
    classifyTrialOutcome({ runStatus: "failed", gatePassed: false, steps: [{ status: "failed", failureKind: "execution_failed" }] }),
    "task_failed"
  );
  assert.equal(
    classifyTrialOutcome({ runStatus: "failed", gatePassed: false, steps: [{ status: "failed", failureKind: "verification_failed" }] }),
    "verify_failed"
  );
  assert.equal(
    classifyTrialOutcome({ runStatus: "failed", gatePassed: false, steps: [{ status: "failed", failureKind: "contract_violation" }] }),
    "verify_failed"
  );
  // Replaying PR #68's rate-limited Codex runs: the backend now terminates
  // these as "blocked", never "failed" (#69).
  assert.equal(classifyTrialOutcome({ runStatus: "blocked", gatePassed: false }), "blocked");
  assert.equal(classifyTrialOutcome({ runStatus: "cancelled", gatePassed: false }), "blocked");
  assert.equal(classifyTrialOutcome({ runStatus: "timeout", gatePassed: false }), "blocked");
  assert.equal(classifyTrialOutcome({ runStatus: "driver_error", gatePassed: false }), "blocked");
});

test("summarizeTaskCells flags mixed cells - the report's unit of trial-to-trial noise", () => {
  const cells = summarizeTaskCells([
    trial({ variant: "baseline", taskId: "fizzbuzz", trial: 1, gatePassed: true }),
    trial({ variant: "baseline", taskId: "fizzbuzz", trial: 2, gatePassed: false }),
    trial({ variant: "improved", taskId: "fizzbuzz", trial: 1, gatePassed: true }),
    trial({ variant: "improved", taskId: "fizzbuzz", trial: 2, gatePassed: true })
  ]);
  const mixed = cells.find((cell) => cell.variant === "baseline")!;
  assert.equal(mixed.mixed, true);
  const stable = cells.find((cell) => cell.variant === "improved")!;
  assert.deepEqual(
    { taskId: stable.taskId, passes: stable.passes, blocked: stable.blocked, mixed: stable.mixed },
    { taskId: "fizzbuzz", passes: 2, blocked: 0, mixed: false }
  );
});

test("summarizeTaskCells excludes a blocked trial from the mixed-cell noise check (#69)", () => {
  const cells = summarizeTaskCells([
    trial({ variant: "baseline", taskId: "fizzbuzz", trial: 1, gatePassed: true }),
    trial({ variant: "baseline", taskId: "fizzbuzz", trial: 2, gatePassed: true }),
    // A blocked trial alongside two agreeing passes must not itself read as
    // "mixed" - it carries no pass/fail signal to disagree with.
    trial({ variant: "baseline", taskId: "fizzbuzz", trial: 3, runStatus: "blocked", gatePassed: false })
  ]);
  const cell = cells.find((item) => item.variant === "baseline")!;
  assert.deepEqual(
    { trials: cell.trials, passes: cell.passes, blocked: cell.blocked, mixed: cell.mixed },
    { trials: 3, passes: 2, blocked: 1, mixed: false }
  );
});

test("buildComparisonReport links every trial to its run and states a delta-exceeds-noise conclusion for stable cells", () => {
  const report = buildComparisonReport(
    reportInput([
      trial({ variant: "baseline", taskId: "fizzbuzz", trial: 1, runId: "run_a1", gatePassed: false }),
      trial({ variant: "baseline", taskId: "fizzbuzz", trial: 2, runId: "run_a2", gatePassed: false }),
      trial({ variant: "improved", taskId: "fizzbuzz", trial: 1, runId: "run_b1", gatePassed: true, evidence: [{ id: "ev_1", kind: "agent.diff" }] }),
      trial({ variant: "improved", taskId: "fizzbuzz", trial: 2, runId: "run_b2", gatePassed: true })
    ])
  );

  assert.match(report, /\| `baseline` \| 2 \| 0 \| 0 \| 2 \| 0 \| 0% \|/);
  assert.match(report, /\| `improved` \| 2 \| 2 \| 0 \| 0 \| 0 \| 100% \|/);
  // Every trial's run is linked so each aggregate is auditable.
  for (const runId of ["run_a1", "run_a2", "run_b1", "run_b2"]) {
    assert.match(report, new RegExp(`\\[${runId}\\]\\(http://127\\.0\\.0\\.1:4178/api/runs/${runId}\\)`));
  }
  assert.match(report, /1 items \(\[list\]\(http:\/\/127\.0\.0\.1:4178\/api\/runs\/run_b1\/evidence\)\)/);
  assert.match(report, /measured delta exceeded observed trial-to-trial noise/);
});

test("buildComparisonReport treats a delta within cell instability as indistinguishable and calls for a larger N", () => {
  const report = buildComparisonReport(
    reportInput([
      trial({ variant: "baseline", taskId: "fizzbuzz", trial: 1, gatePassed: true }),
      trial({ variant: "baseline", taskId: "fizzbuzz", trial: 2, gatePassed: false }),
      trial({ variant: "baseline", taskId: "roman", trial: 1, gatePassed: true }),
      trial({ variant: "baseline", taskId: "roman", trial: 2, gatePassed: false }),
      trial({ variant: "improved", taskId: "fizzbuzz", trial: 1, gatePassed: true }),
      trial({ variant: "improved", taskId: "fizzbuzz", trial: 2, gatePassed: false }),
      trial({ variant: "improved", taskId: "roman", trial: 1, gatePassed: true }),
      trial({ variant: "improved", taskId: "roman", trial: 2, gatePassed: true })
    ])
  );
  assert.match(report, /within the observed trial-to-trial instability/);
  assert.match(report, /\(mixed\)/);
});

test("buildComparisonReport flags a single-trial matrix as unvalidated", () => {
  const report = buildComparisonReport(
    reportInput([
      trial({ variant: "baseline", taskId: "fizzbuzz", trial: 1, gatePassed: false }),
      trial({ variant: "improved", taskId: "fizzbuzz", trial: 1, gatePassed: true })
    ])
  );
  assert.match(report, /no within-cell noise can be observed/);
});

// #69 acceptance: "The comparison report breaks counts out by all four
// states" and "Pass rate denominators exclude blocked runs."
test("buildComparisonReport's Summary table breaks counts out by all four #69 states and excludes blocked from pass rate", () => {
  const report = buildComparisonReport(
    reportInput([
      trial({ variant: "baseline", taskId: "fizzbuzz", trial: 1, runId: "run_pass", runStatus: "succeeded", gatePassed: true }),
      trial({
        variant: "baseline",
        taskId: "slugify",
        trial: 1,
        runId: "run_task_fail",
        runStatus: "failed",
        gatePassed: false,
        steps: [{ status: "failed", failureKind: "execution_failed" }]
      }),
      trial({
        variant: "baseline",
        taskId: "roman",
        trial: 1,
        runId: "run_verify_fail",
        runStatus: "failed",
        gatePassed: false,
        steps: [{ status: "failed", failureKind: "verification_failed" }]
      }),
      // Replays PR #68's rate-limited Codex trials: terminates "blocked",
      // not "failed", and must not drag pass rate down.
      trial({ variant: "baseline", taskId: "fizzbuzz", trial: 2, runId: "run_blocked", runStatus: "blocked", gatePassed: false })
    ])
  );

  // Trials=4, Passed=1, Task failed=1, Verify failed=1, Blocked=1, pass rate
  // is 1/(4-1)=33.3%, not 1/4=25%.
  assert.match(report, /\| `baseline` \| 4 \| 1 \| 1 \| 1 \| 1 \| 33\.3% \|/);
  assert.match(report, /\[run_blocked\]\([^)]*\) \| blocked \| blocked \|/);
  assert.match(report, /\[run_task_fail\]\([^)]*\) \| failed \| task_failed \|/);
  assert.match(report, /\[run_verify_fail\]\([^)]*\) \| failed \| verify_failed \|/);
});
