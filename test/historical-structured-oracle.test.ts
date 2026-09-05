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
import { SYNTHETIC_ORACLE } from "./helpers/synthetic-oracle-fixture.js";

const VALID = { valid: true } as const;

// ---------------------------------------------------------------------------
// parseTuplesOnlyOutput
// ---------------------------------------------------------------------------

test("parseTuplesOnlyOutput: single row, three fields", () => {
  assert.deepEqual(parseTuplesOnlyOutput("alpha|x|y\n"), [["alpha", "x", "y"]]);
});

test("parseTuplesOnlyOutput: two rows", () => {
  assert.deepEqual(parseTuplesOnlyOutput("row1col1|row1col2\nrow2col1|row2col2\n"), [
    ["row1col1", "row1col2"],
    ["row2col1", "row2col2"]
  ]);
});

test("parseTuplesOnlyOutput: truly empty stdout (no bytes) returns empty array", () => {
  assert.deepEqual(parseTuplesOnlyOutput(""), []);
});

test("parseTuplesOnlyOutput: bare \\n (psql trailing terminator only) returns one empty-field row, not empty array", () => {
  // Problem A fix: only the single final trailing empty line is removed.
  // "\n" splits to ["", ""], we pop "" -> [""], which is one line of empty
  // string -> one row [""] (one field, value empty string).
  // Zero-row psql output with -t -A emits nothing (""), not "\n".
  assert.deepEqual(parseTuplesOnlyOutput("\n"), [[""]]);
});

test("parseTuplesOnlyOutput: one row with a single empty-string field is preserved", () => {
  // A row whose only field is '' must not be lost to interior-line filtering.
  assert.deepEqual(parseTuplesOnlyOutput("\n"), [[""]]);
});

test("parseTuplesOnlyOutput: multiple rows where one has an empty field in the middle", () => {
  assert.deepEqual(parseTuplesOnlyOutput("a||b\n"), [["a", "", "b"]]);
  assert.deepEqual(parseTuplesOnlyOutput("a||b\nx|y|z\n"), [["a", "", "b"], ["x", "y", "z"]]);
});

test("parseTuplesOnlyOutput: throws on non-string input", () => {
  assert.throws(() => parseTuplesOnlyOutput(undefined as unknown as string), /expected a string/);
});

// ---------------------------------------------------------------------------
// evaluateStructuredOracle — basic satisfaction
// ---------------------------------------------------------------------------

test("evaluateStructuredOracle: exact historical match satisfies (ordered)", () => {
  const result = evaluateStructuredOracle(
    [["alpha", "x", "y"]],
    { rows: [["alpha", "x", "y"]] }
  );
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.diagnostics, []);
});

test("evaluateStructuredOracle: exact reference match satisfies", () => {
  const result = evaluateStructuredOracle(
    [["beta", "m", "n"]],
    { rows: [["beta", "m", "n"]] }
  );
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.diagnostics, []);
});

test("evaluateStructuredOracle: wrong field value is unsatisfied with diagnostic", () => {
  const result = evaluateStructuredOracle(
    [["alpha", "x", "y"]],
    { rows: [["beta", "m", "n"]] }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes('"beta"') && d.includes('"alpha"')));
});

test("evaluateStructuredOracle: missing field (fewer fields in a row) is unsatisfied", () => {
  // Only 2 fields, expected 3
  const result = evaluateStructuredOracle(
    [["beta", "m"]],
    { rows: [["beta", "m", "n"]] }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("field")));
});

test("evaluateStructuredOracle: extra field (more fields in a row) is unsatisfied", () => {
  // 4 fields, expected 3
  const result = evaluateStructuredOracle(
    [["beta", "m", "n", "extra"]],
    { rows: [["beta", "m", "n"]] }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("field")));
});

test("evaluateStructuredOracle: missing row (fewer rows) is unsatisfied", () => {
  const result = evaluateStructuredOracle([], { rows: [["beta", "m", "n"]] });
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("Expected exactly 1 row(s), got 0")));
});

test("evaluateStructuredOracle: extra row (more rows than expected) is unsatisfied", () => {
  const result = evaluateStructuredOracle(
    [["beta", "m", "n"], ["extra", "row", "here"]],
    { rows: [["beta", "m", "n"]] }
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

// SYNTHETIC_ORACLE is imported from test/helpers/synthetic-oracle-fixture.ts.
// It uses domain-neutral placeholder tokens:
//   historical: [["alpha", "x", "y"]]
//   reference:  [["beta",  "m", "n"]]

test("evaluateStructuredOracleAttribution: attributes 'historical' when only the historical expectation matches", () => {
  const result = evaluateStructuredOracleAttribution("alpha|x|y\n", SYNTHETIC_ORACLE, VALID);
  assert.equal(result.attributedTo, "historical");
  assert.equal(result.historicalMatch.satisfied, true);
  assert.equal(result.referenceMatch.satisfied, false);
  assert.equal(result.validity.valid, true);
});

test("evaluateStructuredOracleAttribution: attributes 'reference' when only the reference expectation matches", () => {
  const result = evaluateStructuredOracleAttribution("beta|m|n\n", SYNTHETIC_ORACLE, VALID);
  assert.equal(result.attributedTo, "reference");
  assert.equal(result.historicalMatch.satisfied, false);
  assert.equal(result.referenceMatch.satisfied, true);
});

test("evaluateStructuredOracleAttribution: unrelated but valid output is unattributed", () => {
  const result = evaluateStructuredOracleAttribution("gamma|p|q\n", SYNTHETIC_ORACLE, VALID);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.historicalMatch.satisfied, false);
  assert.equal(result.referenceMatch.satisfied, false);
});

test("evaluateStructuredOracleAttribution: infrastructure-invalid execution is always unattributed", () => {
  const invalid = { valid: false, reason: "test-injected transport failure" } as const;
  // Even output that would otherwise satisfy the historical expectation must
  // not be attributed when the execution itself was not valid/interpretable.
  const result = evaluateStructuredOracleAttribution("alpha|x|y\n", SYNTHETIC_ORACLE, invalid);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.validity.valid, false);
  // Rows are not parsed when execution is invalid
  assert.deepEqual(result.historicalMatch.rows, []);
  assert.deepEqual(result.referenceMatch.rows, []);
});

test("evaluateStructuredOracleAttribution: empty stdout on a valid execution is unattributed", () => {
  const result = evaluateStructuredOracleAttribution("", SYNTHETIC_ORACLE, VALID);
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
      structuredOracle: SYNTHETIC_ORACLE
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
        stdout: "alpha|x|y\n",
        stderr: "",
        exitCode: 0,
        durationMs: 10
      },
      attribution: evaluateStructuredOracleAttribution("alpha|x|y\n", SYNTHETIC_ORACLE, VALID)
    })
  });
  assert.equal(grade.status, "invalid_submission", JSON.stringify(grade, null, 2));
});

// ---------------------------------------------------------------------------
// Problem B — delimiter ambiguity: expected fields containing separator/CR/LF
// ---------------------------------------------------------------------------

test("evaluateStructuredOracle: expected field containing field separator throws loudly", () => {
  assert.throws(
    () => evaluateStructuredOracle([["a"]], { rows: [["a|b"]] }),
    /field separator/i
  );
});

test("evaluateStructuredOracle: expected field containing CR throws loudly", () => {
  assert.throws(
    () => evaluateStructuredOracle([["a"]], { rows: [["a\rb"]] }),
    /CR character/i
  );
});

test("evaluateStructuredOracle: expected field containing LF throws loudly", () => {
  assert.throws(
    () => evaluateStructuredOracle([["a"]], { rows: [["a\nb"]] }),
    /LF character/i
  );
});

// ---------------------------------------------------------------------------
// Problem C — deterministic multiset comparison (ordered: false)
// ---------------------------------------------------------------------------

test("evaluateStructuredOracle: ordered: false — same rows in different order match", () => {
  const result = evaluateStructuredOracle(
    [["b", "2"], ["a", "1"]],
    { rows: [["a", "1"], ["b", "2"]], ordered: false }
  );
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.diagnostics, []);
});

test("evaluateStructuredOracle: ordered: false — duplicate rows require matching multiplicity", () => {
  // Two identical rows expected; one actual — mismatch
  const result = evaluateStructuredOracle(
    [["a", "1"]],
    { rows: [["a", "1"], ["a", "1"]], ordered: false }
  );
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((d) => d.includes("time(s)")));
});

test("evaluateStructuredOracle: ordered: false — different multiplicities mismatch", () => {
  // Two of ["a"] expected, only one actual
  const result = evaluateStructuredOracle(
    [["a"], ["b"]],
    { rows: [["a"], ["a"]], ordered: false }
  );
  assert.equal(result.satisfied, false);
});

test("evaluateStructuredOracle: ordered: false — fields that would collide with join('') are correctly distinguished", () => {
  // ["a","bc"] and ["ab","c"] both join to "abc" — old code would treat them as equal.
  // The frequency map uses JSON.stringify, so they remain distinct.
  const result = evaluateStructuredOracle(
    [["a", "bc"]],
    { rows: [["ab", "c"]], ordered: false }
  );
  assert.equal(result.satisfied, false);
});
