import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDshComparisonReport,
  classifyDshOutcome,
  summarizeFixtureCells,
  summarizeProfiles,
  type DshComparisonReportInput,
  type DshTrialRecord
} from "../server/evals/dsh-report.js";

// Aggregation for scripts/dsh-evals-demo.ts (#93): every summary number must
// be an exact function of the per-trial records, "invalidated" (#103's
// tampered-fixture failure mode) must always win regardless of what
// score.py itself reported, and blocked/invalidated/driver_error trials
// must never drag down the pass-rate or kill-rate denominators.

function trial(overrides: Partial<DshTrialRecord>): DshTrialRecord {
  return {
    fixture: "m01",
    profile: "baseline",
    trial: 1,
    trialId: "m01-baseline-1",
    artifactsDir: "/tmp/cells/m01-baseline-1",
    killed: true,
    falseAlarms: 0,
    contractOk: true,
    integrityOk: true,
    wallTimeMs: 60_000,
    ...overrides
  };
}

function reportInput(trials: DshTrialRecord[]): DshComparisonReportInput {
  return {
    generatedAt: "2026-08-20T00:00:00.000Z",
    dshVersion: "0.1.0-rc.7",
    image: "tinytable-exam-room:latest",
    smoke: false,
    profiles: [
      { label: "baseline", path: "examples/tinytable-eval/profiles/baseline.cordis.patch.yml", sha256: "a".repeat(64) },
      { label: "candidate", path: "examples/tinytable-eval/profiles/candidate.cordis.patch.yml", sha256: "b".repeat(64) }
    ],
    fixtures: ["m01", "m02"],
    trials
  };
}

test("classifyDshOutcome: clean pass requires killed, no false alarms, contract ok, and integrity ok", () => {
  assert.equal(classifyDshOutcome({ integrityOk: true, killed: true, falseAlarms: 0, contractOk: true }), "passed");
});

test("classifyDshOutcome: killed==false is task_failed - the agent never caught the seeded defect", () => {
  assert.equal(classifyDshOutcome({ integrityOk: true, killed: false, falseAlarms: 0, contractOk: true }), "task_failed");
});

test("classifyDshOutcome: killed but with false alarms or a broken contract is verify_failed", () => {
  assert.equal(classifyDshOutcome({ integrityOk: true, killed: true, falseAlarms: 1, contractOk: true }), "verify_failed");
  assert.equal(classifyDshOutcome({ integrityOk: true, killed: true, falseAlarms: 0, contractOk: false }), "verify_failed");
});

test("classifyDshOutcome: a BLOCKED: agent is its own bucket, distinct from a real failure", () => {
  assert.equal(
    classifyDshOutcome({ integrityOk: true, blockedReason: "SPEC.md is missing", killed: null, falseAlarms: null, contractOk: null }),
    "blocked"
  );
});

// #103/#93 core fix: a run that tampered with protected fixture content
// must never be counted as a legitimate pass, no matter what score.py says.
test("classifyDshOutcome: integrityOk=false always wins as 'invalidated', even over a clean score.py pass", () => {
  assert.equal(
    classifyDshOutcome({ integrityOk: false, killed: true, falseAlarms: 0, contractOk: true }),
    "invalidated"
  );
  assert.equal(
    classifyDshOutcome({ integrityOk: false, blockedReason: "whatever", killed: null, falseAlarms: null, contractOk: null }),
    "invalidated"
  );
});

test("classifyDshOutcome: a driver-side error (builder/container/score.py crash) is its own bucket", () => {
  assert.equal(
    classifyDshOutcome({ integrityOk: true, killed: null, falseAlarms: null, contractOk: null, error: "docker not found" }),
    "driver_error"
  );
});

test("summarizeProfiles excludes blocked/invalidated/driver_error from the pass-rate denominator", () => {
  const summaries = summarizeProfiles([
    trial({ profile: "baseline", trial: 1, killed: true, falseAlarms: 0, contractOk: true }),
    trial({ profile: "baseline", trial: 2, integrityOk: false }),
    trial({ profile: "baseline", trial: 3, blockedReason: "missing fixture", killed: null, falseAlarms: null, contractOk: null }),
    trial({ profile: "baseline", trial: 4, error: "docker error", killed: null, falseAlarms: null, contractOk: null })
  ]);
  const baseline = summaries.find((s) => s.profile === "baseline")!;
  assert.equal(baseline.trials, 4);
  assert.equal(baseline.passed, 1);
  assert.equal(baseline.invalidated, 1);
  assert.equal(baseline.blocked, 1);
  assert.equal(baseline.driverError, 1);
  // 1 pass out of (4 - 1 invalidated - 1 blocked - 1 driver_error) = 1 scored trial.
  assert.equal(baseline.passRate, 1);
});

test("summarizeFixtureCells computes kill rate, false-alarm rate, contract compliance, and median wall time per (fixture, profile)", () => {
  const cells = summarizeFixtureCells([
    trial({ fixture: "m01", profile: "baseline", trial: 1, killed: true, falseAlarms: 0, contractOk: true, wallTimeMs: 10_000 }),
    trial({ fixture: "m01", profile: "baseline", trial: 2, killed: false, falseAlarms: 0, contractOk: true, wallTimeMs: 30_000 }),
    trial({ fixture: "m01", profile: "baseline", trial: 3, killed: true, falseAlarms: 2, contractOk: false, wallTimeMs: 20_000 })
  ]);
  const cell = cells.find((c) => c.fixture === "m01" && c.profile === "baseline")!;
  assert.equal(cell.trials, 3);
  assert.equal(cell.killRate, 2 / 3);
  assert.equal(cell.falseAlarmRate, 1 / 3);
  assert.equal(cell.contractComplianceRate, 2 / 3);
  assert.equal(cell.medianWallTimeMs, 20_000);
});

test("summarizeFixtureCells excludes unscorable (blocked/driver_error) trials from kill/false-alarm/contract rates", () => {
  const cells = summarizeFixtureCells([
    trial({ fixture: "m01", profile: "baseline", trial: 1, killed: true, falseAlarms: 0, contractOk: true }),
    trial({ fixture: "m01", profile: "baseline", trial: 2, blockedReason: "x", killed: null, falseAlarms: null, contractOk: null })
  ]);
  const cell = cells.find((c) => c.fixture === "m01" && c.profile === "baseline")!;
  assert.equal(cell.trials, 2);
  // Only 1 of the 2 trials produced a real verdict.
  assert.equal(cell.killRate, 1);
});

test("buildDshComparisonReport's summary table breaks counts out by every bucket and computes the per-fixture columns the #93 scope asked for", () => {
  const report = buildDshComparisonReport(
    reportInput([
      trial({ fixture: "m01", profile: "baseline", trial: 1, killed: true, falseAlarms: 0, contractOk: true, wallTimeMs: 10_000 }),
      trial({ fixture: "m01", profile: "baseline", trial: 2, killed: false, falseAlarms: 0, contractOk: true, wallTimeMs: 20_000 }),
      trial({ fixture: "m02", profile: "baseline", trial: 1, integrityOk: false, wallTimeMs: 5_000 }),
      trial({ fixture: "m01", profile: "candidate", trial: 1, killed: true, falseAlarms: 0, contractOk: true, wallTimeMs: 8_000 }),
      trial({ fixture: "m02", profile: "candidate", trial: 1, killed: true, falseAlarms: 0, contractOk: true, wallTimeMs: 12_000 })
    ])
  );

  // baseline: 3 trials, 1 passed, 1 task_failed, 1 invalidated; pass rate excludes the invalidated one: 1/(3-1)=50%.
  assert.match(report, /\| `baseline` \| 3 \| 1 \| 1 \| 0 \| 1 \| 0 \| 0 \| 50% \|/);
  // candidate: 2 trials, both clean passes.
  assert.match(report, /\| `candidate` \| 2 \| 2 \| 0 \| 0 \| 0 \| 0 \| 0 \| 100% \|/);
  // Per-fixture: m01/baseline kill rate is 1/2 (one killed, one not).
  assert.match(report, /\| `m01` \| `baseline` \| 2 \| 50% \|/);
  // m02/baseline has no scorable trial at all (invalidated) - kill rate n\/a.
  assert.match(report, /\| `m02` \| `baseline` \| 1 \| n\/a \|/);
  assert.match(report, /invalidated.*means the post-run manifest re-check/s);
});

test("buildDshComparisonReport's paired delta table states a per-fixture kill-rate delta with no significance claim", () => {
  const report = buildDshComparisonReport(
    reportInput([
      trial({ fixture: "m01", profile: "baseline", trial: 1, killed: false, falseAlarms: 0, contractOk: true }),
      trial({ fixture: "m01", profile: "candidate", trial: 1, killed: true, falseAlarms: 0, contractOk: true })
    ])
  );
  assert.match(report, /No significance testing is applied/);
  assert.match(report, /\| `m01` \| 0% \| 100% \| -100pp \|/);
});

test("buildDshComparisonReport's per-trial evidence table names every field and links to the trial's local artifacts directory, not a HoneyRail run", () => {
  const report = buildDshComparisonReport(
    reportInput([
      trial({
        fixture: "m01",
        profile: "baseline",
        trial: 1,
        artifactsDir: "/tmp/dsh-evals-report/cells/m01-baseline-1",
        killed: true,
        falseAlarms: 0,
        contractOk: true,
        integrityOk: true
      })
    ])
  );
  assert.match(report, /\/tmp\/dsh-evals-report\/cells\/m01-baseline-1/);
  assert.doesNotMatch(report, /api\/runs/);
});
