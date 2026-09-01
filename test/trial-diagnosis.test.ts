import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateProbeShapes,
  decodeTrialDiagnosis,
  diagnoseTrial,
  encodeTrialDiagnosis,
  extractProbeShape,
  extractScenarioProbeShape,
  lookupRequiredProbeShape,
  PRIVATE_REQUIRED_PROBE_SHAPES,
  type SqlTestScenario
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
    const observed = extractScenarioProbeShape(sqlStatements);
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

  const observed = extractScenarioProbeShape(sqlStatements);
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
    const observed = extractScenarioProbeShape(sqlStatements);
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

  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
  assert.equal(observed.statementSequenceLength, 1);
});

test("extractProbeShape: partialUpdate is true when an UPDATE sets fewer columns than the table declares", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE t (x INTEGER, y TEXT)"),
    record("statement ok", "INSERT INTO t (x, y) VALUES (1, 'a')"),
    record("statement ok", "UPDATE t SET x = 2 WHERE x = 1")
  ];
  const observed = extractScenarioProbeShape(sqlStatements);
  assert.equal(observed.partialUpdate, true);
});

test("extractProbeShape: multiObjectInteraction is true once 2+ distinct tables are touched", () => {
  const sqlStatements = [
    record("statement ok", "CREATE TABLE a (id INTEGER)"),
    record("statement ok", "CREATE TABLE b (id INTEGER)"),
    record("statement ok", "INSERT INTO a (id) VALUES (1)"),
    record("statement ok", "INSERT INTO b (id) VALUES (1)")
  ];
  const observed = extractScenarioProbeShape(sqlStatements);
  assert.equal(observed.multiObjectInteraction, true);
});

test("diagnoseTrial: an empty required shape never raises a gap", () => {
  const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "no-requirements", outcome: "passed", feature: "none" }, []);
  assert.deepEqual(diagnosis.capabilityGaps, []);
});

// --- review fix: parenthesized boolean groups must not false-positive ------

test("extractProbeShape: CHECK ((a > 10 AND b > 10)) is still per-column decomposable despite the extra wrapping parens", () => {
  const sqlStatements = [record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK ((a > 10 AND b > 10)))")];
  const observed = extractScenarioProbeShape(sqlStatements);
  assert.equal(observed.crossColumnDependency, false);
});

test("extractProbeShape: CHECK ((a > b)) is still recognized as a genuine cross-column predicate despite the extra wrapping parens", () => {
  const sqlStatements = [record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK ((a > b)))")];
  const observed = extractScenarioProbeShape(sqlStatements);
  assert.equal(observed.crossColumnDependency, true);
});

test("extractProbeShape: an OR of two parenthesized per-column groups stays per-column - no single atomic clause needs both columns", () => {
  const sqlStatements = [record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, c INTEGER, CHECK ((a > 5 AND b > 5) OR (c > 5)))")];
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const { shape, evidence } = lookupRequiredProbeShape("unknown-operator-id");
  const diagnosis = diagnoseTrial(observed, shape, { trialId: "t1", outcome: "passed", feature: "unknown-operator-id" }, evidence);
  assert.deepEqual(diagnosis.capabilityGaps, []);
  assert.ok(diagnosis.evidence.some((e) => e.kind === "required-shape-unavailable"));
});

// --- review fix: on-disk snake_case schema must round-trip through the report ---

test("encodeTrialDiagnosis/decodeTrialDiagnosis: round-trips through a real JSON.stringify/parse cycle", () => {
  const observed = extractScenarioProbeShape([
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
  const observed = extractScenarioProbeShape([
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
  const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape(sqlStatements);
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
  const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "t1", outcome: "passed", feature: "none" }, []);
  assert.equal(diagnosis.diagnosisStatus, "complete");
});

test("diagnoseTrial: diagnosisStatus is 'required_shape_unavailable' when lookupRequiredProbeShape found no registry entry", () => {
  const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const { shape, evidence } = lookupRequiredProbeShape("nobody-configured-this-one");
  const diagnosis = diagnoseTrial(observed, shape, { trialId: "t2", outcome: "passed", feature: "x" }, evidence);
  assert.equal(diagnosis.diagnosisStatus, "required_shape_unavailable");
});

for (const outcome of ["blocked", "invalidated", "driver_error"] as const) {
  test(`diagnoseTrial: diagnosisStatus is 'ineligible' for outcome "${outcome}" - its observed shape is not trustworthy evidence`, () => {
    const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
    const diagnosis = diagnoseTrial(observed, { crossColumnDependency: true }, { trialId: "t3", outcome, feature: "x" }, []);
    assert.equal(diagnosis.diagnosisStatus, "ineligible");
  });
}

test("encodeTrialDiagnosis/decodeTrialDiagnosis: diagnosisStatus round-trips as snake_case diagnosis_status", () => {
  const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "rt2", outcome: "passed", feature: "x" }, []);
  const onDisk = JSON.parse(JSON.stringify(encodeTrialDiagnosis(diagnosis)));
  assert.equal(onDisk.diagnosis_status, "complete");
  assert.equal(onDisk.diagnosisStatus, undefined);
  const decoded = decodeTrialDiagnosis(onDisk);
  assert.deepEqual(decoded, diagnosis);
});

test("decodeTrialDiagnosis: rejects a payload with a malformed diagnosis_status", () => {
  const observed = extractScenarioProbeShape([record("statement ok", "CREATE TABLE t (a INTEGER)")]);
  const diagnosis = diagnoseTrial(observed, {}, { trialId: "rt3", outcome: "passed", feature: "x" }, []);
  const onDisk = { ...JSON.parse(JSON.stringify(encodeTrialDiagnosis(diagnosis))), diagnosis_status: "not-a-real-status" };
  assert.equal(decodeTrialDiagnosis(onDisk), null);
});

// --- review round 3: extractProbeShape() must preserve .test scenario
// boundaries - run_sql_tests.py gives every .test file its own fresh
// Database(); there is no schema/row/FK/transaction state shared between
// two .test files. A prior version flattened every scenario's records into
// one shared BuildCtx, fabricating cross-file interaction. ------------------

function scenario(path: string, records: string[]): SqlTestScenario {
  return { path, records };
}

// --- A: FK multiplicity must not compose across files -----------------------

test("extractProbeShape: FK multiplicity must not compose across separate .test scenarios", () => {
  const scenarioA = scenario("a.test", [
    record("statement ok", "CREATE TABLE p1 (id INTEGER)"),
    record("statement ok", "CREATE TABLE c (id INTEGER, p1_id INTEGER, FOREIGN KEY (p1_id) REFERENCES p1 (id))")
  ]);
  const scenarioB = scenario("b.test", [
    record("statement ok", "CREATE TABLE p2 (id INTEGER)"),
    record("statement ok", "CREATE TABLE c (id INTEGER, p2_id INTEGER, FOREIGN KEY (p2_id) REFERENCES p2 (id))")
  ]);

  const observed = extractProbeShape(NO_TRANSCRIPT, [scenarioA, scenarioB]);
  assert.equal(observed.maxFkPerTable, 1, "each scenario's own `c` table has exactly 1 FK - must not sum to 2 just because both files reuse the name");
  assert.equal(observed.nonLastFkViolationTested, false);
});

// --- B: multi-object interaction must not compose across files -------------

test("extractProbeShape: multiObjectInteraction must not compose across separate .test scenarios", () => {
  const scenarioA = scenario("a.test", [record("statement ok", "CREATE TABLE a (id INTEGER)"), record("statement ok", "INSERT INTO a VALUES (1)")]);
  const scenarioB = scenario("b.test", [record("statement ok", "CREATE TABLE b (id INTEGER)"), record("statement ok", "INSERT INTO b VALUES (1)")]);

  const observed = extractProbeShape(NO_TRANSCRIPT, [scenarioA, scenarioB]);
  assert.equal(observed.multiObjectInteraction, false, "neither scenario itself touches two objects - a.test only ever sees `a`, b.test only ever sees `b`");
});

test("extractProbeShape: multiObjectInteraction positive control - one scenario touching both objects is still true", () => {
  const both = scenario("ab.test", [
    record("statement ok", "CREATE TABLE a (id INTEGER)"),
    record("statement ok", "CREATE TABLE b (id INTEGER)"),
    record("statement ok", "INSERT INTO a VALUES (1)"),
    record("statement ok", "INSERT INTO b VALUES (1)")
  ]);
  const observed = extractProbeShape(NO_TRANSCRIPT, [both]);
  assert.equal(observed.multiObjectInteraction, true);
});

// --- C: expected-error INSERT must not populate the FK reference ledger ----

test("extractProbeShape: an expected-error INSERT must not populate insertedValuesByTableColumn for a later FK-satisfaction probe", () => {
  const withPhantomValue = scenario("fk-ledger.test", [
    record("statement ok", "CREATE TABLE dept (id INTEGER)"),
    record("statement ok", "CREATE TABLE dept2 (id INTEGER)"),
    record(
      "statement ok",
      "CREATE TABLE emp (id INTEGER, dept_id INTEGER, dept2_id INTEGER, FOREIGN KEY (dept_id) REFERENCES dept (id), FOREIGN KEY (dept2_id) REFERENCES dept2 (id))"
    ),
    // dept2.id=1 only ever appears in a FAILED insert - must not register as
    // an existing referenced value.
    record("statement error", "INSERT INTO dept2 (id) VALUES (1)"),
    record("statement ok", "INSERT INTO dept (id) VALUES (1)"),
    // Attempts to satisfy the LAST FK (dept2_id=1) using that phantom value
    // while violating the EARLIER one (dept_id=999). If the ledger were
    // incorrectly populated by the failed insert above, this would look
    // like a discriminating workload (last satisfied, earlier violated); it
    // must not, since dept2.id=1 never actually existed.
    record("statement error", "INSERT INTO emp (id, dept_id, dept2_id) VALUES (1, 999, 1)")
  ]);
  const observed = extractProbeShape(NO_TRANSCRIPT, [withPhantomValue]);
  assert.equal(observed.nonLastFkViolationTested, false, "dept2.id=1 was never really inserted (its only INSERT was a statement error) - the last FK must read as violated, not satisfied");
});

test("extractScenarioProbeShape: a statement-error CREATE TABLE must not register a phantom schema for a later statement in the same scenario", () => {
  // The table `t` is never actually created (its own CREATE TABLE is
  // expected to fail) - a later CHECK-relevant lookup against `t` must find
  // nothing, not a phantom column set.
  const observed = extractScenarioProbeShape([
    record("statement error", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10 OR b > 10))"),
    record("statement error", "INSERT INTO t VALUES (5, 5)")
  ]);
  assert.equal(observed.multiColumnCheck, false);
  assert.equal(observed.checkTested, false);
});

// --- D: aggregateProbeShapes' three aggregation rules, directly -------------

test("aggregateProbeShapes: presence fields OR across scenarios", () => {
  const shapeA = extractScenarioProbeShape([record("statement ok", "CREATE TABLE a (id INTEGER)")]);
  const shapeB = extractScenarioProbeShape([record("statement ok", "INSERT INTO a VALUES (1)")]);
  const aggregated = aggregateProbeShapes([shapeA, shapeB]);
  assert.equal(aggregated.ddlPresent, true);
  assert.equal(aggregated.insertPresent, true);
});

test("aggregateProbeShapes: complexity fields take the MAX across scenarios, never a sum", () => {
  const small = extractScenarioProbeShape([record("statement ok", "CREATE TABLE a (id INTEGER)")]);
  const big = extractScenarioProbeShape([
    record("statement ok", "CREATE TABLE x (id INTEGER)"),
    record("statement ok", "CREATE TABLE y (id INTEGER)"),
    record("statement ok", "CREATE TABLE z (id INTEGER)")
  ]);
  const aggregated = aggregateProbeShapes([small, big]);
  assert.equal(aggregated.tableCount, 3, "the richest single scenario has 3 tables - must not sum to 4 across both scenarios");
});

test("aggregateProbeShapes: an empty scenario list returns an all-zero/all-false shape, not NaN/-Infinity", () => {
  const aggregated = aggregateProbeShapes([]);
  assert.equal(aggregated.tableCount, 0);
  assert.equal(aggregated.maxFkPerTable, 0);
  assert.equal(aggregated.checkTested, false);
});

// --- existing CHECK/FK discriminating-workload acceptance tests must stay
// green through the trial-level orchestrator too, not just the per-scenario
// extractor. ------------------------------------------------------------

test("extractProbeShape (trial level): the real check-on-update killing workload still satisfies the operator's required shape through a single scenario", () => {
  const killing = scenario("update_check_merged_row.test", [
    record("statement ok", "CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10 OR b > 10))"),
    record("statement ok", "INSERT INTO t VALUES (5, 20)"),
    record("statement error", "UPDATE t SET b = 5 WHERE a = 5")
  ]);
  const observed = extractProbeShape(NO_TRANSCRIPT, [killing]);
  const diagnosis = diagnoseTrial(
    observed,
    CHECK_ON_UPDATE_REQUIRED,
    { trialId: "trial-level-check-kill", outcome: "task_failed", feature: "check-on-update-sees-only-assigned-columns" },
    []
  );
  assert.deepEqual(diagnosis.capabilityGaps, []);
});

test("extractProbeShape (trial level): the FK discriminating workload still satisfies the operator's required shape through a single scenario", () => {
  const discriminating = scenario("fk.test", [
    record("statement ok", "CREATE TABLE dept (id INTEGER)"),
    record("statement ok", "CREATE TABLE dept2 (id INTEGER)"),
    record(
      "statement ok",
      "CREATE TABLE emp (id INTEGER, dept_id INTEGER, dept2_id INTEGER, FOREIGN KEY (dept_id) REFERENCES dept (id), FOREIGN KEY (dept2_id) REFERENCES dept2 (id))"
    ),
    record("statement ok", "INSERT INTO dept (id) VALUES (1)"),
    record("statement ok", "INSERT INTO dept2 (id) VALUES (1)"),
    record("statement error", "INSERT INTO emp (id, dept_id, dept2_id) VALUES (1, 999, 1)")
  ]);
  const observed = extractProbeShape(NO_TRANSCRIPT, [discriminating]);
  const diagnosis = diagnoseTrial(
    observed,
    FK_ONLY_LAST_REQUIRED,
    { trialId: "trial-level-fk-kill", outcome: "task_failed", feature: "fk-only-last-declared-constraint-registered" },
    []
  );
  assert.deepEqual(diagnosis.capabilityGaps, []);
});
