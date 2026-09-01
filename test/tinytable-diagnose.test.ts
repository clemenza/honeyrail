import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveTrialOutcome, type StateFileTrial } from "../scripts/tinytable-diagnose.js";
import type { TranscriptAuditHit } from "../server/evals/transcript-audit.js";

// Review fix (P0): tinytable-diagnose.ts used to reclassify a trial's
// outcome from score.json alone, hard-coding integrityOk: true, an empty
// transcriptAuditHits, and no blockedReason - so an invalidated or blocked
// trial could silently reappear as passed/task_failed/verify_failed and get
// presented as evidence of a genuine capability gap. resolveTrialOutcome is
// the fix: when a state.json trial record is available, its own canonical
// fields are used as-is; the fallback (path-only) branch is exercised
// separately below with the same three cases.

function trialRecord(overrides: Partial<StateFileTrial>): StateFileTrial {
  return {
    trialId: "m01-baseline-1",
    artifactsDir: "/tmp/cells/m01-baseline-1",
    killed: true,
    falseAlarms: 0,
    contractOk: true,
    integrityOk: true,
    transcriptAuditHits: [],
    ...overrides
  };
}

const HIGH_CONFIDENCE_HIT: TranscriptAuditHit = { pattern: "mutant", excerpt: "mutants/m03", confidence: "high" };

test("resolveTrialOutcome (trial-id path): integrityOk=false -> invalidated, not the raw killed/contractOk verdict", () => {
  const trial = trialRecord({ integrityOk: false, killed: true, falseAlarms: 0, contractOk: true });
  assert.equal(resolveTrialOutcome(trial, null), "invalidated");
});

test("resolveTrialOutcome (trial-id path): a high-confidence transcript audit hit -> invalidated", () => {
  const trial = trialRecord({ transcriptAuditHits: [HIGH_CONFIDENCE_HIT], killed: true, falseAlarms: 0, contractOk: true });
  assert.equal(resolveTrialOutcome(trial, null), "invalidated");
});

test("resolveTrialOutcome (trial-id path): blockedReason -> blocked", () => {
  const trial = trialRecord({ blockedReason: "agent printed BLOCKED: needs clarification", killed: null, contractOk: null });
  assert.equal(resolveTrialOutcome(trial, null), "blocked");
});

test("resolveTrialOutcome (trial-id path): a clean trial still classifies as passed", () => {
  const trial = trialRecord({});
  assert.equal(resolveTrialOutcome(trial, null), "passed");
});

// --- same three cases via the path-only (no state.json) fallback branch ---

test("resolveTrialOutcome (path-only fallback): reconstructed integrityOk=false -> invalidated", () => {
  const outcome = resolveTrialOutcome(null, {
    integrityOk: false,
    transcriptAuditHits: [],
    killed: true,
    falseAlarms: 0,
    contractOk: true
  });
  assert.equal(outcome, "invalidated");
});

test("resolveTrialOutcome (path-only fallback): a reconstructed high-confidence transcript audit hit -> invalidated", () => {
  const outcome = resolveTrialOutcome(null, {
    integrityOk: true,
    transcriptAuditHits: [HIGH_CONFIDENCE_HIT],
    killed: true,
    falseAlarms: 0,
    contractOk: true
  });
  assert.equal(outcome, "invalidated");
});

test("resolveTrialOutcome (path-only fallback): a reconstructed blockedReason -> blocked", () => {
  const outcome = resolveTrialOutcome(null, {
    integrityOk: true,
    transcriptAuditHits: [],
    blockedReason: "agent printed BLOCKED: needs clarification",
    killed: null,
    falseAlarms: null,
    contractOk: null
  });
  assert.equal(outcome, "blocked");
});

test("resolveTrialOutcome: neither a trial record nor a fallback -> driver_error, not a fabricated pass", () => {
  assert.equal(resolveTrialOutcome(null, null), "driver_error");
});
