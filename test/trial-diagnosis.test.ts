import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeTrialDiagnosis,
  diagnoseTrial,
  encodeTrialDiagnosis,
  extractProbeShape,
  lookupRequiredProbeShape,
  PRIVATE_REQUIRED_PROBE_SHAPES
} from "../server/evals/trial-diagnosis.js";
import { buildDshComparisonReport, type DshComparisonReportInput, type DshTrialRecord } from "../server/evals/dsh-report.js";
import type { TranscriptLine } from "../server/evals/dsh-transcript.js";

const NO_TRANSCRIPT: TranscriptLine[] = [];

function record(header: string, sql: string): string {
  return `${header}\n${sql}`;
}

// --- golden case A: cross-column dependency (CHECK + UPDATE) ---------------

test("golden case A: every CHECK is per-column decomposable -> crossColumnDependency false, gap raised", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10), CHECK (b > 10))"),
    record("statement ok", "INSERT INTO t (a, b) VALUES (11, 11)"),
    record("statement ok", "UPDATE t SET a = 12 WHERE a = 11")
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
    assert.equal(observed.checkTested, true);
    assert.equal(observed.updateTested, true);
    assert.equal(observed.crossColumnDependency, false);

    const diagnosis = diagnoseTrial(
      observed,
      { crossColumnDependency: true },
      { trialId: "case-a", outcome: "task_failed", feature: "check_constraint" },
      []
    );
    assert.deepEqual(diagnosis.capabilityGaps, ["cross-column-dependency"]);
  }
});

test("golden case A negative control: a real cross-column CHECK satisfies the required shape - no gap", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > b))"),
    record("statement ok", "INSERT INTO t (a, b) VALUES (11, 5)"),
    record("statement ok", "UPDATE t SET a = 12 WHERE a = 11")
  ];

  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.crossColumnDependency, true);

  const diagnosis = diagnoseTrial(
    observed,
    { crossColumnDependency: true },
    { trialId: "case-a-neg", outcome: "passed", feature: "check_constraint" },
    []
  );
  assert.deepEqual(diagnosis.capabilityGaps, []);
});

// --- golden case B: multiple FK (same-kind multiplicity) -------------------

test("golden case B: every table has at most one FK -> gap raised against min_fk_per_table >= 2", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE dept (id INTEGER)"),
    record("statement ok", "CREATE TABLE emp (id INTEGER, dept_id INTEGER, FOREIGN KEY (dept_id) REFERENCES dept (id))"),
    record("statement ok", "INSERT INTO dept (id) VALUES (1)"),
    record("statement ok", "INSERT INTO emp (id, dept_id) VALUES (1, 1)"),
    record("statement error", "INSERT INTO emp (id, dept_id) VALUES (2, 999)")
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
    assert.equal(observed.fkTested, true);
    assert.equal(observed.negativeFkTested, true);
    assert.equal(observed.maxFkPerTable, 1);

    const diagnosis = diagnoseTrial(
      observed,
      { minFkPerTable: 2 },
      { trialId: "case-b", outcome: "task_failed", feature: "foreign_key" },
      []
    );
    assert.deepEqual(diagnosis.capabilityGaps, ["same-kind-multiplicity"]);
  }
});

test("golden case B negative control: a table with 2 FKs satisfies min_fk_per_table >= 2 - no gap", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE a (id INTEGER)"),
    record("statement ok", "CREATE TABLE b (id INTEGER)"),
    record(
      "statement ok",
      "CREATE TABLE c (id INTEGER, a_id INTEGER, b_id INTEGER, FOREIGN KEY (a_id) REFERENCES a (id), FOREIGN KEY (b_id) REFERENCES b (id))"
    )
  ];

  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.maxFkPerTable, 2);

  const diagnosis = diagnoseTrial(
    observed,
    { minFkPerTable: 2 },
    { trialId: "case-b-neg", outcome: "passed", feature: "foreign_key" },
    []
  );
  assert.deepEqual(diagnosis.capabilityGaps, []);
});

// --- extractProbeShape: supporting behavior ---------------------------------

test("extractProbeShape: a bare 'query' record is skipped, not counted as a statement", () => {
  const sqlStatements = [record("statement ok", "CREATE TABLE t (a INTEGER)"), "query I rowsort\nSELECT a FROM t\n----\n"];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.statementSequenceLength, 1);
});

test("extractProbeShape: partialUpdate is true when an UPDATE sets fewer columns than the table declares", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (x INTEGER, y TEXT)"),
    record("statement ok", "INSERT INTO t (x, y) VALUES (1, 'a')"),
    record("statement ok", "UPDATE t SET x = 2 WHERE x = 1")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.partialUpdate, true);
});

test("extractProbeShape: multiObjectInteraction is true once 2+ distinct tables are touched", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE a (id INTEGER)"),
    record("statement ok", "CREATE TABLE b (id INTEGER)"),
    record("statement ok", "INSERT INTO a (id) VALUES (1)"),
    record("statement ok", "INSERT INTO b (id) VALUES (1)")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.multiObjectInteraction, true);
});

test("diagnoseTrial: an empty required shape never raises a gap", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "no-requirements", outcome: "passed", feature: "none" }, []);
  assert.deepEqual(diagnosis.capabilityGaps, []);
});

// --- review fix: parenthesized boolean groups must not false-positive ------

test("extractProbeShape: CHECK ((a > 10 AND b > 10)) is still per-column decomposable despite the extra wrapping parens", () => {
  const sqlStatements = [record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK ((a > 10 AND b > 10)))")];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.crossColumnDependency, false);
});

test("extractProbeShape: CHECK ((a > b)) is still recognized as a genuine cross-column predicate despite the extra wrapping parens", () => {
  const sqlStatements = [record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK ((a > b)))")];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.crossColumnDependency, true);
});

test("extractProbeShape: an OR of two parenthesized per-column groups stays per-column - no single atomic clause needs both columns", () => {
  const sqlStatements = [record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, c INTEGER, CHECK ((a > 5 AND b > 5) OR (c > 5)))")];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.crossColumnDependency, false);
});

// --- review fix: PRIVATE_REQUIRED_PROBE_SHAPES must never silently mean "no gap" ---

test("lookupRequiredProbeShape: a known operator returns its configured shape with no evidence", () => {
  const { shape, evidence } = lookupRequiredProbeShape("fk-only-last-declared-constraint-registered");
  assert.deepEqual(shape, { minFkPerTable: 2, nonLastFkViolationTested: true });
  assert.deepEqual(evidence, []);
});

test("lookupRequiredProbeShape: an unconfigured operator returns an empty shape PLUS explicit required-shape-unavailable evidence, not a silent {}", () => {
  const { shape, evidence } = lookupRequiredProbeShape("some-operator-nobody-configured-yet");
  assert.deepEqual(shape, {});
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "required-shape-unavailable");
});

test("PRIVATE_REQUIRED_PROBE_SHAPES: seeded with the two real operators that motivated #174, review round 2's richer shapes", () => {
  assert.deepEqual(PRIVATE_REQUIRED_PROBE_SHAPES["fk-only-last-declared-constraint-registered"], {
    minFkPerTable: 2,
    nonLastFkViolationTested: true
  });
  assert.deepEqual(PRIVATE_REQUIRED_PROBE_SHAPES["check-on-update-sees-only-assigned-columns"], {
    multiColumnCheck: true,
    orComposition: true,
    checkReferencesUnassignedColumn: true,
    partialUpdate: true
  });
});

test("diagnoseTrial: an unconfigured operator's diagnosis never claims a clean pass - capabilityGaps is empty but evidence flags it as unchecked", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const { shape, evidence } = lookupRequiredProbeShape("unknown-operator-id");
  const diagnosis = diagnoseTrial(observed, shape, { trialId: "t1", outcome: "passed", feature: "unknown-operator-id" }, evidence);
  assert.deepEqual(diagnosis.capabilityGaps, []);
  assert.ok(diagnosis.evidence.some((e) => e.kind === "required-shape-unavailable"));
});

// --- review fix: on-disk snake_case schema must round-trip through the report ---

test("encodeTrialDiagnosis/decodeTrialDiagnosis: round-trips through a real JSON.stringify/parse cycle", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10), CHECK (b > 10))")
  ]);
  const diagnosis = diagnoseTrial(observed, { crossColumnDependency: true }, { trialId: "round-trip", outcome: "task_failed", feature: "check_constraint" }, []);

  const onDisk = JSON.parse(JSON.stringify(encodeTrialDiagnosis(diagnosis)));
  // The actual on-disk keys are snake_case (#174 §7) - assert that shape
  // directly, since a prior version of the report reader assumed camelCase
  // and silently read `undefined` for every field.
  assert.equal(onDisk.trial_id, "round-trip");
  assert.ok(Array.isArray(onDisk.capability_gaps));
  assert.equal(onDisk.trialId, undefined);
  assert.equal(onDisk.capabilityGaps, undefined);

  const decoded = decodeTrialDiagnosis(onDisk);
  assert.deepEqual(decoded, diagnosis);
});

test("decodeTrialDiagnosis: rejects malformed/foreign JSON rather than returning a half-populated TrialDiagnosis", () => {
  assert.equal(decodeTrialDiagnosis(null), null);
  assert.equal(decodeTrialDiagnosis({}), null);
  assert.equal(decodeTrialDiagnosis({ trialId: "camelCase-not-the-real-schema" }), null);
});

test("round trip: a serialized trial-diagnosis.json, decoded and attached to a trial, renders its capability gaps in the report", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10), CHECK (b > 10))")
  ]);
  const diagnosis = diagnoseTrial(
    observed,
    { crossColumnDependency: true },
    { trialId: "m10-baseline-1", outcome: "task_failed", feature: "check-on-update-sees-only-assigned-columns" },
    []
  );
  const onDiskText = JSON.stringify(encodeTrialDiagnosis(diagnosis));
  const decoded = decodeTrialDiagnosis(JSON.parse(onDiskText));
  assert.notEqual(decoded, null);

  const trial: DshTrialRecord = {
    fixture: "m10",
    profile: "baseline",
    trial: 1,
    trialId: "m10-baseline-1",
    artifactsDir: "/tmp/cells/m10-baseline-1",
    killed: false,
    falseAlarms: null,
    contractOk: null,
    integrityOk: true,
    transcriptAuditHits: [],
    killRate: null,
    killedByKind: null,
    diagnosis: decoded
  };
  const input: DshComparisonReportInput = {
    generatedAt: "2026-09-01T00:00:00.000Z",
    dshVersion: "test",
    image: "test",
    smoke: false,
    profiles: [{ label: "baseline", path: "baseline.cordis.patch.yml", sha256: "abc" }],
    fixtures: ["m10"],
    trials: [trial]
  };

  const report = buildDshComparisonReport(input);
  assert.match(report, /## Trial diagnoses/);
  assert.match(report, /`cross-column-dependency`/);
});

test("round trip: an unconfigured operator's diagnosis renders as unknown, not as a clean pass, in the report", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const { shape, evidence } = lookupRequiredProbeShape("unconfigured-operator-for-render-test");
  const diagnosis = diagnoseTrial(observed, shape, { trialId: "m11-baseline-1", outcome: "passed", feature: "unconfigured-operator-for-render-test" }, evidence);
  const decoded = decodeTrialDiagnosis(JSON.parse(JSON.stringify(encodeTrialDiagnosis(diagnosis))));
  assert.notEqual(decoded, null);

  const trial: DshTrialRecord = {
    fixture: "m11",
    profile: "baseline",
    trial: 1,
    trialId: "m11-baseline-1",
    artifactsDir: "/tmp/cells/m11-baseline-1",
    killed: true,
    falseAlarms: 0,
    contractOk: true,
    integrityOk: true,
    transcriptAuditHits: [],
    killRate: null,
    killedByKind: null,
    diagnosis: decoded
  };
  const report = buildDshComparisonReport({
    generatedAt: "2026-09-01T00:00:00.000Z",
    dshVersion: "test",
    image: "test",
    smoke: false,
    profiles: [{ label: "baseline", path: "baseline.cordis.patch.yml", sha256: "abc" }],
    fixtures: ["m11"],
    trials: [trial]
  });
  assert.match(report, /unknown - no required probe shape configured/);
  assert.doesNotMatch(report, /Capability gaps: none/);
});

// --- review round 2: RequiredProbeShape must describe a genuinely
// discriminating test shape, not just "the feature absent in one historical
// miss". Acceptance principle for every configured operator: a known
// killing workload -> extractProbeShape() satisfies that operator's
// RequiredProbeShape -> no capability gap; a known non-killing/historical
// miss workload still produces the gap. -----------------------------------

const CHECK_ON_UPDATE_REQUIRED = PRIVATE_REQUIRED_PROBE_SHAPES["check-on-update-sees-only-assigned-columns"];
const FK_ONLY_LAST_REQUIRED = PRIVATE_REQUIRED_PROBE_SHAPES["fk-only-last-declared-constraint-registered"];

test("extractProbeShape: an OR-CHECK across 2 columns plus a partial UPDATE leaving one referenced column unassigned sets all three composed signals", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10 OR b > 10))"),
    record("statement ok", "INSERT INTO t VALUES (5, 20)"),
    record("statement error", "UPDATE t SET b = 5 WHERE a = 5")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.multiColumnCheck, true);
  assert.equal(observed.orComposition, true);
  assert.equal(observed.checkReferencesUnassignedColumn, true);
  assert.equal(observed.partialUpdate, true);
});

test("check-on-update-sees-only-assigned-columns: the real killing workload from mutate.py's own notes satisfies the operator's required shape - no capability gap", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10 OR b > 10))"),
    record("statement ok", "INSERT INTO t VALUES (5, 20)"),
    record("statement error", "UPDATE t SET b = 5 WHERE a = 5")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  const diagnosis = diagnoseTrial(
    observed,
    CHECK_ON_UPDATE_REQUIRED,
    { trialId: "check-on-update-kill", outcome: "task_failed", feature: "check-on-update-sees-only-assigned-columns" },
    []
  );
  assert.deepEqual(diagnosis.capabilityGaps, []);
});

test("check-on-update-sees-only-assigned-columns: the historical golden-case-A-shaped non-killing workload still produces a gap against the real operator's required shape", () => {
  // Every CHECK is a separate, single-column constraint (not an OR-composed
  // multi-column one) - the #170-shaped miss this operator was filed over.
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10), CHECK (b > 10))"),
    record("statement ok", "INSERT INTO t (a, b) VALUES (11, 11)"),
    record("statement ok", "UPDATE t SET a = 12 WHERE a = 11")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  const diagnosis = diagnoseTrial(
    observed,
    CHECK_ON_UPDATE_REQUIRED,
    { trialId: "check-on-update-miss", outcome: "task_failed", feature: "check-on-update-sees-only-assigned-columns" },
    []
  );
  assert.ok(diagnosis.capabilityGaps.includes("cross-column-dependency"));
});

test("extractProbeShape: an AND-only multi-column CHECK plus a partial UPDATE does NOT set orComposition - AND short-circuits correctly even under the mutant", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10 AND b > 10))"),
    record("statement ok", "INSERT INTO t VALUES (20, 20)"),
    record("statement error", "UPDATE t SET a = 5 WHERE a = 20")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.multiColumnCheck, true);
  assert.equal(observed.orComposition, false);
});

test("extractProbeShape: nonLastFkViolationTested stays false when only the last declared FK is violated (2 FKs, non-discriminating workload)", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE dept (id INTEGER)"),
    record("statement ok", "CREATE TABLE dept2 (id INTEGER)"),
    record(
      "statement ok",
      "CREATE TABLE emp (id INTEGER, dept_id INTEGER, dept2_id INTEGER, FOREIGN KEY (dept_id) REFERENCES dept (id), FOREIGN KEY (dept2_id) REFERENCES dept2 (id))"
    ),
    record("statement ok", "INSERT INTO dept (id) VALUES (1)"),
    record("statement ok", "INSERT INTO dept2 (id) VALUES (1)"),
    // Violates only the LAST FK (dept2_id) - dept_id (earlier) is satisfied.
    record("statement error", "INSERT INTO emp (id, dept_id, dept2_id) VALUES (1, 1, 999)")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.maxFkPerTable, 2);
  assert.equal(observed.nonLastFkViolationTested, false);
});

test("extractProbeShape: nonLastFkViolationTested is true when an earlier FK is violated while the last is satisfied (discriminating workload)", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE dept (id INTEGER)"),
    record("statement ok", "CREATE TABLE dept2 (id INTEGER)"),
    record(
      "statement ok",
      "CREATE TABLE emp (id INTEGER, dept_id INTEGER, dept2_id INTEGER, FOREIGN KEY (dept_id) REFERENCES dept (id), FOREIGN KEY (dept2_id) REFERENCES dept2 (id))"
    ),
    record("statement ok", "INSERT INTO dept (id) VALUES (1)"),
    record("statement ok", "INSERT INTO dept2 (id) VALUES (1)"),
    // Violates the EARLIER FK (dept_id) while satisfying the LAST (dept2_id).
    record("statement error", "INSERT INTO emp (id, dept_id, dept2_id) VALUES (1, 999, 1)")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  assert.equal(observed.maxFkPerTable, 2);
  assert.equal(observed.nonLastFkViolationTested, true);
});

test("fk-only-last-declared-constraint-registered: a two-FK workload that only violates the last FK still produces a gap - minFkPerTable alone is not sufficient", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE dept (id INTEGER)"),
    record("statement ok", "CREATE TABLE dept2 (id INTEGER)"),
    record(
      "statement ok",
      "CREATE TABLE emp (id INTEGER, dept_id INTEGER, dept2_id INTEGER, FOREIGN KEY (dept_id) REFERENCES dept (id), FOREIGN KEY (dept2_id) REFERENCES dept2 (id))"
    ),
    record("statement ok", "INSERT INTO dept (id) VALUES (1)"),
    record("statement ok", "INSERT INTO dept2 (id) VALUES (1)"),
    record("statement error", "INSERT INTO emp (id, dept_id, dept2_id) VALUES (1, 1, 999)")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  const diagnosis = diagnoseTrial(
    observed,
    FK_ONLY_LAST_REQUIRED,
    { trialId: "fk-non-discriminating", outcome: "task_failed", feature: "fk-only-last-declared-constraint-registered" },
    []
  );
  assert.deepEqual(diagnosis.capabilityGaps, ["same-kind-multiplicity"]);
});

test("fk-only-last-declared-constraint-registered: a discriminating workload (violate an earlier FK, satisfy the last) satisfies the required shape - no gap", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE dept (id INTEGER)"),
    record("statement ok", "CREATE TABLE dept2 (id INTEGER)"),
    record(
      "statement ok",
      "CREATE TABLE emp (id INTEGER, dept_id INTEGER, dept2_id INTEGER, FOREIGN KEY (dept_id) REFERENCES dept (id), FOREIGN KEY (dept2_id) REFERENCES dept2 (id))"
    ),
    record("statement ok", "INSERT INTO dept (id) VALUES (1)"),
    record("statement ok", "INSERT INTO dept2 (id) VALUES (1)"),
    record("statement error", "INSERT INTO emp (id, dept_id, dept2_id) VALUES (1, 999, 1)")
  ];
  const observed = extractProbeShape(NO_TRANSCRIPT, sqlStatements);
  const diagnosis = diagnoseTrial(
    observed,
    FK_ONLY_LAST_REQUIRED,
    { trialId: "fk-discriminating", outcome: "task_failed", feature: "fk-only-last-declared-constraint-registered" },
    []
  );
  assert.deepEqual(diagnosis.capabilityGaps, []);
});

// --- review round 2: diagnosisStatus is a first-class validity signal ------

test("diagnoseTrial: diagnosisStatus is 'complete' for a normal, configured, trustworthy diagnosis", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "t1", outcome: "passed", feature: "none" }, []);
  assert.equal(diagnosis.diagnosisStatus, "complete");
});

test("diagnoseTrial: diagnosisStatus is 'required_shape_unavailable' when lookupRequiredProbeShape found no registry entry", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const { shape, evidence } = lookupRequiredProbeShape("nobody-configured-this-one");
  const diagnosis = diagnoseTrial(observed, shape, { trialId: "t2", outcome: "passed", feature: "x" }, evidence);
  assert.equal(diagnosis.diagnosisStatus, "required_shape_unavailable");
});

for (const outcome of ["blocked", "invalidated", "driver_error"] as const) {
  test(`diagnoseTrial: diagnosisStatus is 'ineligible' for outcome "${outcome}" - its observed shape is not trustworthy evidence`, () => {
    const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
    const diagnosis = diagnoseTrial(observed, { crossColumnDependency: true }, { trialId: "t3", outcome, feature: "x" }, []);
    assert.equal(diagnosis.diagnosisStatus, "ineligible");
  });
}

test("encodeTrialDiagnosis/decodeTrialDiagnosis: diagnosisStatus round-trips as snake_case diagnosis_status", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "rt2", outcome: "passed", feature: "x" }, []);
  const onDisk = JSON.parse(JSON.stringify(encodeTrialDiagnosis(diagnosis)));
  assert.equal(onDisk.diagnosis_status, "complete");
  assert.equal(onDisk.diagnosisStatus, undefined);
  const decoded = decodeTrialDiagnosis(onDisk);
  assert.deepEqual(decoded, diagnosis);
});

test("decodeTrialDiagnosis: rejects a payload with a malformed diagnosis_status", () => {
  const observed = extractProbeShape(NO_TRANSCRIPT, [record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "rt3", outcome: "passed", feature: "x" }, []);
  const onDisk = { ...JSON.parse(JSON.stringify(encodeTrialDiagnosis(diagnosis))), diagnosis_status: "not-a-real-status" };
  assert.equal(decodeTrialDiagnosis(onDisk), null);
});
