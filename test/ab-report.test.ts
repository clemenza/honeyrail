import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildComparisonReport,
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
  assert.deepEqual(baseline, { variant: "baseline", trials: 2, passes: 1, passRate: 0.5, meanWallTimeMs: 90_000 });
  const improved = summaries.find((summary) => summary.variant === "improved")!;
  assert.deepEqual(improved, { variant: "improved", trials: 1, passes: 1, passRate: 1, meanWallTimeMs: null });
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
  assert.deepEqual({ taskId: stable.taskId, passes: stable.passes, mixed: stable.mixed }, { taskId: "fizzbuzz", passes: 2, mixed: false });
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

  assert.match(report, /\| `baseline` \| 2 \| 0 \| 0% \|/);
  assert.match(report, /\| `improved` \| 2 \| 2 \| 100% \|/);
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
