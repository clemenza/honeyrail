import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateStructuredOracle,
  evaluateStructuredOracleAttribution,
  parseTuplesOnlyOutput,
  type HistoricalPostgresStructuredOracle
} from "../server/postgres/historical-structured-oracle.js";
import {
  gradeHistoricalPostgresSubmission,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

const VALID = { valid: true } as const;

// ---------------------------------------------------------------------------
// parseTuplesOnlyOutput
// ---------------------------------------------------------------------------

test("parseTuplesOnlyOutput: single row, three fields", () => {
  assert.deepEqual(parseTuplesOnlyOutput("serializable|on|on\n"), [["serializable", "on", "on"]]);
});

test("parseTuplesOnlyOutput: two rows", () => {
  assert.deepEqual(parseTuplesOnlyOutput("row1col1|row1col2\nrow2col1|row2col2\n"), [
    ["row1col1", "row1col2"],
    ["row2col1", "row2col2"]
  ]);
});

test("parseTuplesOnlyOutput: empty stdout returns empty array", () => {
  assert.deepEqual(parseTuplesOnlyOutput(""), []);
  assert.deepEqual(parseTuplesOnlyOutput("\n"), []);
});

test("parseTuplesOnlyOutput: throws on non-string input", () => {
  assert.throws(() => parseTuplesOnlyOutput(undefined as unknown as string), /expected a string/);
});

// ---------------------------------------------------------------------------
// evaluateStructuredOracle — basic satisfaction
// ---------------------------------------------------------------------------

test("evaluateStructuredOracle: exact historical match satisfies (ordered)", () => {
  const result = evaluateStructuredOracle(
    [["read committed", "off", "off"]],
    { rows: [["read committed", "off", "off"]] }
  );
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.diagnostics, []);
});

test("evaluateStructuredOracle: exact reference match satisfies", () => {
  const result = evaluateStructuredOracle(
    [["serializable", "on", "on"]],
    { rows: [["serializable", "on", "on"]] }
  );
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.diagnostics, []);
});

test("evaluateStructuredOracle: wrong field value is unsatisfied with diagnostic", () => {
  const result = evaluateStructuredOracle(
    [["read committed", "off", "off"]],
    { rows: [["serializable", "on", "on"]] }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes('"serializable"') && d.includes('"read committed"')));
});

test("evaluateStructuredOracle: missing field (fewer fields in a row) is unsatisfied", () => {
  // Only 2 fields, expected 3
  const result = evaluateStructuredOracle(
    [["serializable", "on"]],
    { rows: [["serializable", "on", "on"]] }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("field")));
});

test("evaluateStructuredOracle: extra field (more fields in a row) is unsatisfied", () => {
  // 4 fields, expected 3
  const result = evaluateStructuredOracle(
    [["serializable", "on", "on", "extra"]],
    { rows: [["serializable", "on", "on"]] }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("field")));
});

test("evaluateStructuredOracle: missing row (fewer rows) is unsatisfied", () => {
  const result = evaluateStructuredOracle([], { rows: [["serializable", "on", "on"]] });
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("Expected exactly 1 row(s), got 0")));
});

test("evaluateStructuredOracle: extra row (more rows than expected) is unsatisfied", () => {
  const result = evaluateStructuredOracle(
    [["serializable", "on", "on"], ["extra", "row", "here"]],
    { rows: [["serializable", "on", "on"]] }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("Expected exactly 1 row(s), got 2")));
});

test("evaluateStructuredOracle: wrong row order with ordered: true (default) is unsatisfied", () => {
  const result = evaluateStructuredOracle(
    [["b", "2"], ["a", "1"]],
    { rows: [["a", "1"], ["b", "2"]] } // ordered true by default
  );
  assert.equal(result.satisfied, false);
});

test("evaluateStructuredOracle: wrong row order with ordered: false is satisfied (multiset)", () => {
  const result = evaluateStructuredOracle(
    [["b", "2"], ["a", "1"]],
    { rows: [["a", "1"], ["b", "2"]], ordered: false }
  );
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.diagnostics, []);
});

test("evaluateStructuredOracle: malformed truth (non-array rows) throws", () => {
  assert.throws(
    () => evaluateStructuredOracle([["row"]], { rows: "bad" as unknown as string[][] }),
    /expected rows must be an array/
  );
});

test("evaluateStructuredOracle: malformed truth (empty rows array) throws", () => {
  assert.throws(
    () => evaluateStructuredOracle([["row"]], { rows: [] }),
    /expected rows must be non-empty/
  );
});

// ---------------------------------------------------------------------------
// evaluateStructuredOracleAttribution
// ---------------------------------------------------------------------------

const ORACLE: HistoricalPostgresStructuredOracle = {
  historical: { rows: [["read committed", "off", "off"]] },
  reference: { rows: [["serializable", "on", "on"]] }
};

test("evaluateStructuredOracleAttribution: attributes 'historical' when only the historical expectation matches", () => {
  const result = evaluateStructuredOracleAttribution("read committed|off|off\n", ORACLE, VALID);
  assert.equal(result.attributedTo, "historical");
  assert.equal(result.historicalMatch.satisfied, true);
  assert.equal(result.referenceMatch.satisfied, false);
  assert.equal(result.validity.valid, true);
});

test("evaluateStructuredOracleAttribution: attributes 'reference' when only the reference expectation matches", () => {
  const result = evaluateStructuredOracleAttribution("serializable|on|on\n", ORACLE, VALID);
  assert.equal(result.attributedTo, "reference");
  assert.equal(result.historicalMatch.satisfied, false);
  assert.equal(result.referenceMatch.satisfied, true);
});

test("evaluateStructuredOracleAttribution: unrelated but valid output is unattributed", () => {
  const result = evaluateStructuredOracleAttribution("repeatable read|on|off\n", ORACLE, VALID);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.historicalMatch.satisfied, false);
  assert.equal(result.referenceMatch.satisfied, false);
});

test("evaluateStructuredOracleAttribution: infrastructure-invalid execution is always unattributed", () => {
  const invalid = { valid: false, reason: "test-injected transport failure" } as const;
  // Even output that would otherwise satisfy the historical expectation must
  // not be attributed when the execution itself was not valid/interpretable.
  const result = evaluateStructuredOracleAttribution("read committed|off|off\n", ORACLE, invalid);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.validity.valid, false);
  // Rows are not parsed when execution is invalid
  assert.deepEqual(result.historicalMatch.rows, []);
  assert.deepEqual(result.referenceMatch.rows, []);
});

test("evaluateStructuredOracleAttribution: empty stdout on a valid execution is unattributed", () => {
  const result = evaluateStructuredOracleAttribution("", ORACLE, VALID);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.validity.valid, true);
});

// ---------------------------------------------------------------------------
// correct-output-but-broken-self-assertion: exercised at
// gradeHistoricalPostgresSubmission level, not at the pure evaluator level
// ---------------------------------------------------------------------------

test("gradeHistoricalPostgresSubmission: structured oracle — correct captured output but self-assertion exit-status contract violated is invalid_submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-structured-self-assert-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "structured oracle self-assertion test", reproducer: "repro.sql" }));
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");

  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-structured-self-assert",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: {
      upstreamBug: "Synthetic upstream #99901",
      structuredOracle: ORACLE
    },
    build: { mode: "host" },
    prompt: "Structured oracle self-assertion test."
  };

  // The submitted reproducer's exit status does not follow the self-asserting
  // contract (historical must exit 0, reference must exit non-zero). Here we
  // inject both revisions returning the historically correct output but with
  // reference also exiting 0 — which violates the contract and must be
  // invalid_submission.
  const grade = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts"),
    gradeRevision: async ({ revision }) => ({
      reproduced: true,
      execution: {
        ok: true, // BOTH sides exit 0 — violates the self-assertion contract
        stdout: "read committed|off|off\n",
        stderr: "",
        exitCode: 0,
        durationMs: 10
      },
      attribution: evaluateStructuredOracleAttribution("read committed|off|off\n", ORACLE, VALID)
    })
  });
  assert.equal(grade.status, "invalid_submission", JSON.stringify(grade, null, 2));
});
