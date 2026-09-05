/**
 * Deterministic exact structured-output (tuple) comparison oracle for
 * Historical PostgreSQL tasks (Task 003 / issue #199, corpus slot
 * `pg-hist-xact-chain-savepoint-003` — admin reference only, never
 * agent-visible).
 *
 * Complements the exit-status oracle (case 001) and the behavioral/regex
 * oracle (`historical-behavioral-oracle.ts`, case 002) as a third oracle
 * family. The executor (`psqlArgs()` in server/postgres/runtime.ts) already
 * bakes in `-X -t -A` (no psqlrc, tuples-only, unaligned) into every psql
 * invocation, so machine-stable query output is already captured in
 * `execution.stdout` with no new runtime changes needed.
 *
 * This module is deliberately pure and PostgreSQL-agnostic beyond "psql's
 * tuples-only stdout shape": no filesystem, no Docker, no bug-specific
 * branching. A task without a declared `structuredOracle` (cases 001 and 002,
 * and any synthetic/unit-test spec) behaves exactly as before.
 */

import {
  type HistoricalPostgresExecutionValidity
} from "./historical-behavioral-oracle.js";

export type { HistoricalPostgresExecutionValidity } from "./historical-behavioral-oracle.js";

/**
 * Exact expected rows for one revision side of a structured oracle. Each row
 * is an exact ordered array of field values (as strings), as they appear in
 * psql's tuples-only, unaligned output (field separator is `|` by default,
 * psql's own default with `-A`).
 */
export type HistoricalPostgresStructuredExpectation = {
  rows: string[][];
  /**
   * When `true` (the default), row order is part of the contract: row `i`
   * must exactly match `expected.rows[i]`. When `false`, comparison is a
   * multiset: rows are sorted by a canonical key before comparison so a query
   * that returns the same set of tuples in a non-deterministic order still
   * satisfies the expectation. Use `false` only when the query intentionally
   * has no deterministic ORDER BY.
   */
  ordered?: boolean;
};

/**
 * Grader-private declarative oracle for a task whose deterministic grading
 * signal is captured query output (exact tuples), rather than exit-status
 * differential or error-message patterns. Both sides are required; they must
 * be mutually exclusive by construction (the bug causes a behavioral
 * difference in what the query returns).
 */
export type HistoricalPostgresStructuredOracle = {
  historical: HistoricalPostgresStructuredExpectation;
  reference: HistoricalPostgresStructuredExpectation;
};

/**
 * Parallel to `HistoricalPostgresOracleResult` for the behavioral oracle:
 * the structured evaluator's own match result for one side of the declared
 * oracle. `satisfied` is the grading signal; `diagnostics` are human-readable
 * strings that surface in `HistoricalPostgresGrade.diagnostics` when the
 * grade is not `rediscovered`.
 */
export type HistoricalPostgresStructuredOracleResult = {
  rows: string[][];
  expected: string[][];
  satisfied: boolean;
  diagnostics: string[];
};

/**
 * Parallel to `HistoricalPostgresOracleAttribution` for the behavioral
 * oracle, and duck-type-compatible with the 4-step classifier in
 * `gradeHistoricalPostgresSubmission()`: the classifier consumes
 * `.validity`, `.attributedTo`, and `.historicalMatch.diagnostics`
 * structurally — never the behavioral oracle's `.observations`/`.expected`
 * types — so no changes to that classifier logic are needed beyond widening
 * the `oracleDriven` boolean.
 */
export type HistoricalPostgresStructuredOracleAttribution = {
  /**
   * Execution-validity decision, computed before any structured matching —
   * see `classifyExecutionValidity()` in `historical-behavioral-oracle.ts`.
   * When `valid: false`, `attributedTo` is always `"unattributed"` regardless
   * of what (if anything) was captured in stdout.
   */
  validity: HistoricalPostgresExecutionValidity;
  /** Captured rows matched against the oracle's `historical` expectation. */
  historicalMatch: HistoricalPostgresStructuredOracleResult;
  /** Captured rows matched against the oracle's `reference` expectation. */
  referenceMatch: HistoricalPostgresStructuredOracleResult;
  /**
   * Structural attribution. `"unattributed"` covers: an invalid execution;
   * "matched neither declared expectation"; and the pathological case where
   * both matched (a task-authoring bug — `historical` and `reference`
   * expectations should be mutually exclusive by construction, so this fails
   * closed rather than picking one arbitrarily).
   */
  attributedTo: "historical" | "reference" | "unattributed";
};

/**
 * Parses psql's tuples-only, unaligned output (`-t -A`, already baked into
 * every psql invocation via `psqlArgs()` in server/postgres/runtime.ts) into
 * a row/field matrix.
 *
 * - Splits on `\r?\n`.
 * - Drops exactly one trailing empty line (psql always appends a final `\n`).
 * - Splits each line on `fieldSeparator` (default `|`, psql's own default
 *   with `-A`).
 * - Returns `[]` for empty or whitespace-only stdout.
 *
 * Throws on non-string/undefined input so a task-authoring bug (malformed
 * truth) is loud rather than silently producing an empty/wrong parse.
 */
export function parseTuplesOnlyOutput(stdout: string, fieldSeparator = "|"): string[][] {
  if (typeof stdout !== "string") {
    throw new Error(`parseTuplesOnlyOutput: expected a string, got ${typeof stdout}`);
  }
  const lines = stdout.split(/\r?\n/);
  // Drop exactly one trailing empty line (psql always ends with \n).
  // Only the single final terminator is removed — interior empty lines are
  // preserved so a real result row whose only field is an empty string
  // (e.g. one row, one column, value '') is not silently discarded.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) return [];
  return lines.map((line) => line.split(fieldSeparator));
}

/**
 * Validates that `expected.rows` from grader-private truth is a non-empty
 * array of non-empty string arrays. Throws if not — a task-authoring bug must
 * be loud, not silently produce wrong results (same discipline as
 * `evaluateBehavioralOracle()`'s malformed-regex throw).
 */
function assertValidExpectedRows(rows: unknown): asserts rows is string[][] {
  if (!Array.isArray(rows)) {
    throw new Error(`Structured oracle expected rows must be an array; got ${typeof rows}`);
  }
  if (rows.length === 0) {
    throw new Error("Structured oracle expected rows must be non-empty");
  }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row)) {
      throw new Error(`Structured oracle expected rows[${i}] must be an array; got ${typeof row}`);
    }
    if (row.length === 0) {
      throw new Error(`Structured oracle expected rows[${i}] must be non-empty (at least one field)`);
    }
    for (let j = 0; j < row.length; j += 1) {
      if (typeof row[j] !== "string") {
        throw new Error(`Structured oracle expected rows[${i}][${j}] must be a string; got ${typeof row[j]}`);
      }
    }
  }
}

/**
 * Validates that no expected field value contains the field separator, a CR,
 * or a LF — all of which would make row/field boundaries ambiguous. Applied
 * only to grader-private truth (expected.rows), which task-authoring controls;
 * a task-authoring bug must be loud rather than silently producing wrong
 * results. Does not validate actual captured rows (agent-submitted output),
 * which may contain arbitrary bytes by design.
 */
function assertNoDelimiterInExpectedRows(rows: string[][], fieldSeparator: string): void {
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = 0; j < rows[i].length; j += 1) {
      const field = rows[i][j];
      if (field.includes(fieldSeparator)) {
        throw new Error(
          `Structured oracle expected rows[${i}][${j}] contains the field separator ${JSON.stringify(fieldSeparator)}, which makes field boundaries ambiguous`
        );
      }
      if (field.includes("\r")) {
        throw new Error(
          `Structured oracle expected rows[${i}][${j}] contains a CR character (\\r), which would corrupt row boundaries`
        );
      }
      if (field.includes("\n")) {
        throw new Error(
          `Structured oracle expected rows[${i}][${j}] contains a LF character (\\n), which would corrupt row boundaries`
        );
      }
    }
  }
}

/**
 * Evaluates captured `rows` (from `parseTuplesOnlyOutput()`) against a
 * declared `expected` side of a structured oracle.
 *
 * - Row count must exactly match (extra rows are NOT ignored — a
 *   deterministic query's exact row count is part of the structural contract,
 *   unlike the behavioral oracle's "extra trailing observations" leniency).
 * - Each row's field count must exactly match the corresponding expected row.
 * - Each field value must be exactly equal (string equality, no trimming).
 * - When `expected.ordered !== false` (the default), positional order is
 *   enforced. When `ordered === false`, comparison is a deterministic multiset:
 *   frequency maps keyed by `JSON.stringify(row)` are compared, so duplicate
 *   rows require matching multiplicity and row order is irrelevant.
 *
 * A malformed `expected.rows` (not an array of non-empty string arrays)
 * throws — task-authoring bugs must be loud, not silently produce wrong
 * results. A field value in `expected.rows` containing the field separator,
 * CR, or LF also throws for the same reason.
 */
export function evaluateStructuredOracle(
  rows: string[][],
  expected: HistoricalPostgresStructuredExpectation,
  fieldSeparator = "|"
): HistoricalPostgresStructuredOracleResult {
  assertValidExpectedRows(expected.rows);
  assertNoDelimiterInExpectedRows(expected.rows, fieldSeparator);
  const expectedRows = expected.rows;
  const diagnostics: string[] = [];

  if (expected.ordered === false) {
    // Deterministic multiset comparison: frequency maps keyed by
    // JSON.stringify(row). This avoids both locale-dependent ICU sort order
    // and the separator-ambiguity of joining fields with "" (["a","bc"] and
    // ["ab","c"] would both produce "abc" with join("")).
    const buildFrequencyMap = (arr: string[][]): Map<string, number> => {
      const map = new Map<string, number>();
      for (const row of arr) {
        const key = JSON.stringify(row);
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return map;
    };
    const actualFreq = buildFrequencyMap(rows);
    const expectedFreq = buildFrequencyMap(expectedRows);
    const allKeys = new Set([...actualFreq.keys(), ...expectedFreq.keys()]);
    let satisfied = true;
    for (const key of allKeys) {
      const actualCount = actualFreq.get(key) ?? 0;
      const expectedCount = expectedFreq.get(key) ?? 0;
      if (actualCount !== expectedCount) {
        satisfied = false;
        diagnostics.push(`Multiset mismatch: row ${key} expected ${expectedCount} time(s), got ${actualCount} time(s).`);
      }
    }
    return { rows, expected: expectedRows, satisfied, diagnostics };
  }

  if (rows.length !== expectedRows.length) {
    diagnostics.push(`Expected exactly ${expectedRows.length} row(s), got ${rows.length}.`);
    return { rows, expected: expectedRows, satisfied: false, diagnostics };
  }

  let satisfied = true;
  for (let i = 0; i < expectedRows.length; i += 1) {
    const expectedRow = expectedRows[i];
    const actualRow = rows[i];
    if (actualRow.length !== expectedRow.length) {
      satisfied = false;
      diagnostics.push(
        `Row ${i}: expected ${expectedRow.length} field(s), got ${actualRow.length} (expected ${JSON.stringify(expectedRow)}, got ${JSON.stringify(actualRow)}).`
      );
      continue;
    }
    for (let j = 0; j < expectedRow.length; j += 1) {
      if (actualRow[j] !== expectedRow[j]) {
        satisfied = false;
        diagnostics.push(`Row ${i}, field ${j}: expected ${JSON.stringify(expectedRow[j])}, got ${JSON.stringify(actualRow[j])}.`);
      }
    }
  }

  return { rows, expected: expectedRows, satisfied, diagnostics };
}

/**
 * Evaluates one revision run's captured stdout against *both* halves of a
 * declared structured oracle and produces a structural attribution. Pure, no
 * I/O. Parallel to `evaluateOracleAttribution()` in
 * `historical-behavioral-oracle.ts`, but consuming `stdout` (the tuples-only
 * query output already captured by `psqlFile()` in `runtime-container.ts`)
 * rather than `stderr`.
 *
 * When execution is not valid (`validity.valid === false`), no rows are
 * parsed and `attributedTo` is always `"unattributed"` — a client/transport/
 * runtime failure must never read as "the bug is absent" or contribute to a
 * miss just because it produced nothing useful in stdout.
 */
export function evaluateStructuredOracleAttribution(
  stdout: string,
  oracle: HistoricalPostgresStructuredOracle,
  validity: HistoricalPostgresExecutionValidity
): HistoricalPostgresStructuredOracleAttribution {
  // Pass empty rows when execution is not valid — consistent with
  // resolveOracleReproduction()'s "pass [] when !validity.valid" discipline
  // for the behavioral oracle.
  const rows = validity.valid ? parseTuplesOnlyOutput(stdout) : [];
  const historicalMatch = evaluateStructuredOracle(rows, oracle.historical);
  const referenceMatch = evaluateStructuredOracle(rows, oracle.reference);
  const attributedTo: HistoricalPostgresStructuredOracleAttribution["attributedTo"] = !validity.valid
    ? "unattributed"
    : historicalMatch.satisfied && !referenceMatch.satisfied
      ? "historical"
      : referenceMatch.satisfied && !historicalMatch.satisfied
        ? "reference"
        : "unattributed";
  return { validity, historicalMatch, referenceMatch, attributedTo };
}
