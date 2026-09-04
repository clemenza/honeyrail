import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBehavioralOracle, extractPsqlErrorObservations } from "../server/postgres/historical-behavioral-oracle.js";

test("extractPsqlErrorObservations: single ERROR line", () => {
  const stderr = 'psql:<stdin>:3: ERROR:  procedure parameter "r1" is an output parameter but corresponding argument is not writable\n';
  assert.deepEqual(extractPsqlErrorObservations(stderr), ['procedure parameter "r1" is an output parameter but corresponding argument is not writable']);
});

test("extractPsqlErrorObservations: multiple ERROR lines, in order", () => {
  const stderr = [
    'psql:<stdin>:3: ERROR:  procedure parameter "r1" is an output parameter but corresponding argument is not writable',
    "psql:<stdin>:9: ERROR:  cache lookup failed for function 16386"
  ].join("\n");
  assert.deepEqual(extractPsqlErrorObservations(stderr), [
    'procedure parameter "r1" is an output parameter but corresponding argument is not writable',
    "cache lookup failed for function 16386"
  ]);
});

test("extractPsqlErrorObservations: DETAIL/CONTEXT/HINT continuation lines are excluded", () => {
  const stderr = [
    "psql:<stdin>:3: ERROR:  insert or update on table violates foreign key constraint",
    'DETAIL:  Key (id)=(1) is not present in table "parent".',
    "CONTEXT:  SQL statement \"INSERT INTO child VALUES (1)\"",
    "PL/pgSQL function inline_code_block line 2 at SQL statement"
  ].join("\n");
  assert.deepEqual(extractPsqlErrorObservations(stderr), ["insert or update on table violates foreign key constraint"]);
});

test("extractPsqlErrorObservations: no leading psql:<file>:<line>: label leaks into the observation", () => {
  const stderr = "ERROR:  relation \"missing\" does not exist\n";
  const [observation] = extractPsqlErrorObservations(stderr);
  assert.equal(observation, 'relation "missing" does not exist');
  assert.ok(!observation.includes("psql:"));
  assert.ok(!/:\d+:/.test(observation));
});

test("extractPsqlErrorObservations: empty stderr yields no observations", () => {
  assert.deepEqual(extractPsqlErrorObservations(""), []);
  assert.deepEqual(extractPsqlErrorObservations("NOTICE:  everything fine\n"), []);
});

test("evaluateBehavioralOracle: ordered match succeeds", () => {
  const result = evaluateBehavioralOracle(["first error", "second error"], [
    { label: "first", matches: "^first error$" },
    { label: "second", matches: "^second error$" }
  ]);
  assert.equal(result.satisfied, true);
  assert.deepEqual(result.diagnostics, []);
});

test("evaluateBehavioralOracle: wrong first observation fails", () => {
  const result = evaluateBehavioralOracle(["not the first error", "second error"], [
    { label: "first", matches: "^first error$" },
    { label: "second", matches: "^second error$" }
  ]);
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((line) => line.includes('"first"')));
});

test("evaluateBehavioralOracle: wrong second observation fails", () => {
  const result = evaluateBehavioralOracle(["first error", "not the second error"], [
    { label: "first", matches: "^first error$" },
    { label: "second", matches: "^second error$" }
  ]);
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((line) => line.includes('"second"')));
});

test("evaluateBehavioralOracle: too few observations fails with a clear diagnostic", () => {
  const result = evaluateBehavioralOracle(["first error"], [
    { label: "first", matches: "^first error$" },
    { label: "second", matches: "^second error$" }
  ]);
  assert.equal(result.satisfied, false);
  assert.ok(result.diagnostics.some((line) => line.includes("Expected 2 observation(s), captured only 1")));
});

test("evaluateBehavioralOracle: extra trailing observations beyond the expected count are ignored", () => {
  const result = evaluateBehavioralOracle(["first error", "second error", "an incidental third query's error"], [
    { label: "first", matches: "^first error$" },
    { label: "second", matches: "^second error$" }
  ]);
  assert.equal(result.satisfied, true);
});

test("evaluateBehavioralOracle: dynamic OID values of different magnitudes all match \\d+", () => {
  const pattern = [{ label: "stale cache", matches: "^cache lookup failed for function \\d+$" }];
  assert.equal(evaluateBehavioralOracle(["cache lookup failed for function 16386"], pattern).satisfied, true);
  assert.equal(evaluateBehavioralOracle(["cache lookup failed for function 1"], pattern).satisfied, true);
  assert.equal(evaluateBehavioralOracle(["cache lookup failed for function 999999999"], pattern).satisfied, true);
  assert.equal(evaluateBehavioralOracle(["cache lookup failed for function abc"], pattern).satisfied, false);
});

test("evaluateBehavioralOracle: a buggy-ref-shaped observation does not satisfy a differently-shaped expectation, and vice versa", () => {
  const staleCachePattern = [{ label: "stale cache", matches: "^cache lookup failed for function \\d+$" }];
  const baselinePattern = [{ label: "baseline", matches: '^procedure parameter "r1" is an output parameter but corresponding argument is not writable$' }];
  const baselineObservation = ['procedure parameter "r1" is an output parameter but corresponding argument is not writable'];
  const staleCacheObservation = ["cache lookup failed for function 16386"];
  assert.equal(evaluateBehavioralOracle(baselineObservation, staleCachePattern).satisfied, false);
  assert.equal(evaluateBehavioralOracle(staleCacheObservation, baselinePattern).satisfied, false);
  assert.equal(evaluateBehavioralOracle(staleCacheObservation, staleCachePattern).satisfied, true);
  assert.equal(evaluateBehavioralOracle(baselineObservation, baselinePattern).satisfied, true);
});

test("evaluateBehavioralOracle: a malformed pattern throws rather than silently failing", () => {
  assert.throws(() => evaluateBehavioralOracle(["anything"], [{ label: "broken", matches: "(unterminated" }]), /not a valid regular expression/);
});
