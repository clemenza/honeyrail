import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExecutionValidity,
  evaluateBehavioralOracle,
  evaluateOracleAttribution,
  extractPsqlErrorObservations,
  type HistoricalPostgresBehavioralOracle
} from "../server/postgres/historical-behavioral-oracle.js";

const VALID = { valid: true } as const;

function executionOf(overrides: { stderr?: string; exitCode?: number | string; ok?: boolean }) {
  return { ok: overrides.ok ?? true, stdout: "", stderr: overrides.stderr ?? "", exitCode: overrides.exitCode ?? 0, durationMs: 1 };
}

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

test("extractPsqlErrorObservations: a NOTICE line is recognized but excluded", () => {
  assert.deepEqual(extractPsqlErrorObservations("NOTICE:  identifier will be truncated\n"), []);
});

test("extractPsqlErrorObservations: a WARNING line is recognized but excluded", () => {
  assert.deepEqual(extractPsqlErrorObservations("WARNING:  there is already a transaction in progress\n"), []);
});

test("extractPsqlErrorObservations: a DETAIL line is recognized but excluded", () => {
  assert.deepEqual(extractPsqlErrorObservations('DETAIL:  Key (id)=(1) is not present in table "parent".\n'), []);
});

test("extractPsqlErrorObservations: a CONTEXT line is recognized but excluded", () => {
  assert.deepEqual(extractPsqlErrorObservations('CONTEXT:  SQL statement "INSERT INTO child VALUES (1)"\n'), []);
});

test("extractPsqlErrorObservations: a HINT line is recognized but excluded", () => {
  assert.deepEqual(extractPsqlErrorObservations("HINT:  You will need to rewrite or cast the expression.\n"), []);
});

test("extractPsqlErrorObservations: arbitrary stderr text merely containing the literal substring \"ERROR:\" mid-line is never treated as an observation", () => {
  assert.deepEqual(extractPsqlErrorObservations("the query log noted an ERROR: condition earlier\n"), []);
  assert.deepEqual(extractPsqlErrorObservations("this line mentions ERROR: but is not a real record and has no leading anchor\n"), []);
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

// #200 fourth review round, Blocking 2 - reward-hacking regression test
// (load-bearing for the benchmark trust boundary). A submitted reproducer
// controls its own psql session and can emit arbitrary text to stderr - a
// plain `RAISE EXCEPTION '<text>'` with no explicit `USING ERRCODE = ...`
// produces a completely authentic-looking `ERROR:` line with attacker-chosen
// text, at SQLSTATE `P0001`. A pattern that declares `sqlstate` requires an
// exact match on that structural field too, which a bare RAISE EXCEPTION
// cannot fake without deliberately setting a matching ERRCODE - meaningfully
// raising the bar against naive text-only fabrication. This test uses a
// synthetic oracle that opts into `sqlstate` (task 002's own real oracle
// does not yet - see historical-task.ts's historicalPostgres002TaskSpec()
// for why: the real SQLSTATE values haven't been verified against an actual
// build in this sandbox), proving the mechanism works when a task uses it.
test("evaluateBehavioralOracle: SQLSTATE requirement rejects a fabricated RAISE EXCEPTION that matches the message text but not the SQLSTATE", () => {
  const hardenedPattern = [{ label: "internal error", matches: "^cache lookup failed for function \\d+$", sqlstate: "XX000" }];

  // The genuine internal error: correct text, correct (internal-error-class) SQLSTATE.
  const genuine = evaluateBehavioralOracle([{ severity: "ERROR", sqlstate: "XX000", message: "cache lookup failed for function 16386" }], hardenedPattern);
  assert.equal(genuine.satisfied, true);

  // A fabricated `RAISE EXCEPTION 'cache lookup failed for function 99999';`
  // with no explicit ERRCODE: identical message text, but psql's default
  // RAISE EXCEPTION SQLSTATE (P0001), not the declared XX000. Must fail.
  const fabricated = evaluateBehavioralOracle(
    [{ severity: "ERROR", sqlstate: "P0001", message: "cache lookup failed for function 99999" }],
    hardenedPattern
  );
  assert.equal(fabricated.satisfied, false);
  assert.ok(fabricated.diagnostics.some((line) => line.includes("SQLSTATE")));

  // An observation with no SQLSTATE captured at all (e.g. VERBOSITY wasn't
  // verbose) also fails a pattern that requires one - fails closed, not
  // "SQLSTATE unknown so skip the check".
  const noSqlstate = evaluateBehavioralOracle([{ severity: "ERROR", message: "cache lookup failed for function 16386" }], hardenedPattern);
  assert.equal(noSqlstate.satisfied, false);

  // Without a declared `sqlstate` (task 002's actual current oracle shape),
  // the same fabricated observation *does* satisfy a message-only pattern -
  // this is the honest, currently-unmitigated gap the sqlstate mechanism
  // exists to close once a task's oracle opts into it.
  const messageOnlyPattern = [{ label: "internal error", matches: "^cache lookup failed for function \\d+$" }];
  const messageOnlyResult = evaluateBehavioralOracle(
    [{ severity: "ERROR", sqlstate: "P0001", message: "cache lookup failed for function 99999" }],
    messageOnlyPattern
  );
  assert.equal(messageOnlyResult.satisfied, true);
});

const ORACLE: HistoricalPostgresBehavioralOracle = {
  historical: [
    { label: "first", matches: "^baseline error$" },
    { label: "second", matches: "^stale-cache error \\d+$" }
  ],
  reference: [
    { label: "first", matches: "^baseline error$" },
    { label: "second", matches: "^baseline error$" }
  ]
};

test("evaluateOracleAttribution: attributes \"historical\" when only the historical pattern set matches", () => {
  const result = evaluateOracleAttribution(["baseline error", "stale-cache error 42"], ORACLE, VALID);
  assert.equal(result.attributedTo, "historical");
  assert.equal(result.historicalMatch.satisfied, true);
  assert.equal(result.referenceMatch.satisfied, false);
  assert.equal(result.validity.valid, true);
});

test("evaluateOracleAttribution: attributes \"reference\" when only the reference pattern set matches", () => {
  const result = evaluateOracleAttribution(["baseline error", "baseline error"], ORACLE, VALID);
  assert.equal(result.attributedTo, "reference");
  assert.equal(result.historicalMatch.satisfied, false);
  assert.equal(result.referenceMatch.satisfied, true);
  assert.equal(result.validity.valid, true);
});

test("evaluateOracleAttribution: attributes \"unattributed\" when neither pattern set matches", () => {
  const result = evaluateOracleAttribution(["baseline error", "connection refused"], ORACLE, VALID);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.historicalMatch.satisfied, false);
  assert.equal(result.referenceMatch.satisfied, false);
});

test("evaluateOracleAttribution: attributes \"unattributed\" (fails closed) when, pathologically, both pattern sets match", () => {
  const overlapping: HistoricalPostgresBehavioralOracle = {
    historical: [{ label: "only", matches: "^ambiguous error$" }],
    reference: [{ label: "only", matches: "^ambiguous error$" }]
  };
  const result = evaluateOracleAttribution(["ambiguous error"], overlapping, VALID);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.historicalMatch.satisfied, true);
  assert.equal(result.referenceMatch.satisfied, true);
});

test("evaluateOracleAttribution: an invalid execution is always unattributed, regardless of what text happens to be present", () => {
  const invalid = { valid: false, reason: "test-injected transport failure" } as const;
  // Even text that would otherwise satisfy the historical pattern set must
  // not be attributed when the execution itself wasn't valid/interpretable.
  const result = evaluateOracleAttribution(["baseline error", "stale-cache error 42"], ORACLE, invalid);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.validity.valid, false);
});

test("evaluateOracleAttribution: zero observations on a valid execution is unattributed, not a special case", () => {
  const result = evaluateOracleAttribution([], ORACLE, VALID);
  assert.equal(result.attributedTo, "unattributed");
  assert.equal(result.validity.valid, true);
});

// #200 fourth review round, Blocking 1: validity is now decided
// authoritatively from execution.exitCode alone, using psql's own
// documented exit-status contract - not stderr text-matching, which the
// review correctly flagged as fragile (real failures have many forms; SQL
// content could coincidentally resemble a phrase). Fixtures below construct
// exitCode directly; stderr text is kept only for realism/evidence, never
// read by classifyExecutionValidity anymore.

test("classifyExecutionValidity: a client/spawn invocation failure is invalid (exit code 1)", () => {
  // Exit code 1 is psql's own documented "fatal client-side error" status,
  // and also what a dead container/OCI runtime failure surfaces as when
  // `docker exec` itself never reaches psql - either way, never a SQL-content
  // outcome.
  const result = classifyExecutionValidity(
    executionOf({ stderr: "docker: Error response from daemon: No such container: honeyrail-pg-runtime-abc123.", exitCode: 1, ok: false })
  );
  assert.equal(result.valid, false);
});

test("classifyExecutionValidity: a Docker/runtime exec failure is invalid (exit code 1)", () => {
  const result = classifyExecutionValidity(
    executionOf({ stderr: "OCI runtime exec failed: exec failed: unable to start container process", exitCode: 1, ok: false })
  );
  assert.equal(result.valid, false);
});

test("classifyExecutionValidity: a connection/setup failure is invalid (exit code 2)", () => {
  // Exit code 2 is psql's own documented "connection failure" status.
  const result = classifyExecutionValidity(
    executionOf({
      stderr:
        'psql: error: connection to server on socket "/tmp/.s.PGSQL.5432" failed: No such file or directory\n\tcould not connect to server',
      exitCode: 2,
      ok: false
    })
  );
  assert.equal(result.valid, false);
});

test("classifyExecutionValidity: a timeout is invalid", () => {
  const result = classifyExecutionValidity(executionOf({ stderr: "\ntimed out after 120000ms", exitCode: "ETIMEDOUT", ok: false }));
  assert.equal(result.valid, false);
});

test("classifyExecutionValidity: runtime/server death is invalid (exit code 2)", () => {
  const result = classifyExecutionValidity(
    executionOf({
      stderr: "server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally",
      exitCode: 2,
      ok: false
    })
  );
  assert.equal(result.valid, false);
});

test("classifyExecutionValidity: a completed execution (exit code 0) containing a real, unrelated ERROR record is valid", () => {
  // The crux: a genuine SQL-level error - however unexpected - is a valid,
  // interpretable execution. Whether it matches anything declared is
  // evaluateOracleAttribution's job, not this function's.
  const result = classifyExecutionValidity(
    executionOf({ stderr: 'ERROR:  relation "totally_unrelated_table" does not exist', exitCode: 0, ok: true })
  );
  assert.equal(result.valid, true);
});

test("classifyExecutionValidity: a completed execution under ON_ERROR_STOP (exit code 3) is valid", () => {
  // Exit code 3 is psql's own documented "a script error occurred and
  // ON_ERROR_STOP was in effect" status - still a SQL-content outcome, not a
  // client/transport failure.
  const result = classifyExecutionValidity(
    executionOf({ stderr: "ERROR:  syntax error at or near \"SELCT\"", exitCode: 3, ok: false })
  );
  assert.equal(result.valid, true);
});

test("classifyExecutionValidity: no oracle observations after a valid execution is still valid - a normal miss/unattributed result, not an infrastructure failure", () => {
  const result = classifyExecutionValidity(executionOf({ stderr: "", exitCode: 0, ok: true }));
  assert.equal(result.valid, true);
});
