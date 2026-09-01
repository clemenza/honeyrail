import assert from "node:assert/strict";
import { test } from "node:test";

import { diagnoseTrial, extractProbeShape } from "../server/evals/trial-diagnosis.js";
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
