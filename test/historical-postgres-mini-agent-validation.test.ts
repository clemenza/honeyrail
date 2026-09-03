import assert from "node:assert/strict";
import test from "node:test";
import { validateSubmitFindingArgs } from "../docker/postgres-research-agent-184/finding-validation.mjs";

/**
 * Pure unit tests for the #184 mini-agent's `submit_finding` validation,
 * split out specifically so failure-attribution behavior (missing/malformed
 * submissions must never be auto-normalized into a valid miss) can be
 * asserted without a real API call or a container.
 */

test("explicit not-reproduced with a summary is a valid submission", () => {
  const result = validateSubmitFindingArgs({ status: "not-reproduced", summary: "No deterministic correctness issue found." });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.finding, { status: "not-reproduced", summary: "No deterministic correctness issue found." });
    assert.equal(result.reproducerFile, undefined);
  }
});

test("reproduced with a filename and SQL is a valid submission", () => {
  const result = validateSubmitFindingArgs({
    status: "reproduced",
    summary: "Join removal drops the WHERE clause.",
    reproducer_filename: "repro.sql",
    reproducer_sql: "SELECT 1;"
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.finding, { status: "reproduced", summary: "Join removal drops the WHERE clause.", reproducer: "repro.sql" });
    assert.deepEqual(result.reproducerFile, { filename: "repro.sql", sql: "SELECT 1;" });
  }
});

test("missing status is rejected, not defaulted to not-reproduced", () => {
  const result = validateSubmitFindingArgs({ summary: "some summary" });
  assert.equal(result.ok, false);
});

test("an invalid status value is rejected", () => {
  const result = validateSubmitFindingArgs({ status: "maybe", summary: "some summary" });
  assert.equal(result.ok, false);
});

test("an empty summary is rejected, not replaced with a placeholder", () => {
  const result = validateSubmitFindingArgs({ status: "not-reproduced", summary: "   " });
  assert.equal(result.ok, false);
});

test("reproduced without reproducer_filename is rejected", () => {
  const result = validateSubmitFindingArgs({ status: "reproduced", summary: "observed", reproducer_sql: "SELECT 1;" });
  assert.equal(result.ok, false);
});

test("reproduced without reproducer_sql is rejected", () => {
  const result = validateSubmitFindingArgs({ status: "reproduced", summary: "observed", reproducer_filename: "repro.sql" });
  assert.equal(result.ok, false);
});

test("reproduced with only whitespace reproducer_sql is rejected", () => {
  const result = validateSubmitFindingArgs({ status: "reproduced", summary: "observed", reproducer_filename: "repro.sql", reproducer_sql: "   " });
  assert.equal(result.ok, false);
});

test("completely empty arguments are rejected", () => {
  const result = validateSubmitFindingArgs({});
  assert.equal(result.ok, false);
});

test("undefined arguments (malformed tool call) are rejected rather than throwing", () => {
  assert.doesNotThrow(() => validateSubmitFindingArgs(undefined));
  const result = validateSubmitFindingArgs(undefined);
  assert.equal(result.ok, false);
});
