/**
 * Generic, declarative, hidden behavioral-oracle mechanism for Historical
 * PostgreSQL tasks (#200 review round on #184's task contract).
 *
 * An exit-status differential alone (did the submitted script exit 0 on the
 * historical ref and non-zero on the reference ref?) only proves the script
 * distinguishes *some* difference between the two revisions - not that the
 * agent actually rediscovered the specific upstream regression a task is
 * about. A `HistoricalPostgresBehavioralOracle`, declared once in a task's
 * grader-private `truth`, lets the shared grader additionally require that
 * the submitted reproducer's own captured psql output contains the ordered,
 * revision-specific sequence of observations the real bug produces.
 *
 * This module is deliberately pure and PostgreSQL-agnostic beyond "psql's
 * stderr shape": no filesystem, no Docker, no bug-specific branching. A task
 * without a declared oracle (case 001, and any synthetic/unit-test spec)
 * behaves exactly as before - see historical-task.ts's `defaultGradeRevision`.
 */

export type HistoricalPostgresObservationPattern = {
  /** Human-readable, e.g. "first CALL". Diagnostics only - never matched against. */
  label: string;
  /**
   * JS `RegExp` source, tested with `.test()` against one extracted
   * observation's trimmed text. Encode dynamic data structurally (e.g.
   * `\d+` for an OID) rather than normalizing it out of the observation -
   * a targeted pattern here is what keeps the oracle from ever needing a
   * broad "strip every digit" transform that could erase a meaningful
   * difference elsewhere in the message.
   */
  matches: string;
  /**
   * Optional exact SQLSTATE requirement (#200 fourth review round,
   * Blocking 2 - fabrication resistance). Requires psql's `VERBOSITY` to be
   * `verbose` so SQLSTATE actually appears in the rendered message (see
   * `PSQL_MESSAGE_LINE`); when declared, an observation must have exactly
   * this SQLSTATE, in addition to matching `matches`, to satisfy the
   * pattern. A plain `RAISE EXCEPTION '<text>'` with no explicit
   * `USING ERRCODE = ...` always gets SQLSTATE `P0001` - meaningfully
   * distinct from a genuine internal-error SQLSTATE - so declaring this
   * raises the bar against a submitted script fabricating matching message
   * text without the real error actually occurring. Left undeclared on
   * `historicalPostgres002TaskSpec()`'s own patterns because the real
   * SQLSTATE values for its two error conditions have not been verified
   * against an actual PostgreSQL 14 build in this sandbox - see
   * docs/historical-postgres-task-v0.md.
   */
  sqlstate?: string;
};

export type HistoricalPostgresBehavioralOracle = {
  historical: HistoricalPostgresObservationPattern[];
  reference: HistoricalPostgresObservationPattern[];
};

export type HistoricalPostgresOracleResult = {
  observations: string[];
  expected: HistoricalPostgresObservationPattern[];
  satisfied: boolean;
  diagnostics: string[];
};

/**
 * One psql/libpq message-record line: an optional non-semantic
 * "psql:<file>:<line>:" label, then a recognized severity level, a colon,
 * the canonical two-space psql/libpq formatting (`errmsg`/`errdetail`'s own
 * convention), an optional SQLSTATE token (exactly 5 alphanumeric
 * characters, followed by ": " - present when psql's `VERBOSITY` is set to
 * `verbose`), then the message body. Anchored to the start of the line - not
 * just "contains ERROR:" - so ordinary query output that merely *mentions*
 * the substring "ERROR:" (e.g. a literal string a SELECT returns, or prose
 * logged mid-line) is never mistaken for a real server error record. Every
 * recognized severity is listed (not just ERROR) so `extractPsqlErrorObservations`
 * can positively exclude WARNING/NOTICE/DETAIL/HINT/CONTEXT/STATEMENT/LOG/
 * INFO/DEBUG* continuation lines rather than merely happening not to match
 * them.
 */
const PSQL_MESSAGE_LINE = /^(?:psql:[^:]*:\d+:\s*)?(ERROR|WARNING|NOTICE|DETAIL|HINT|CONTEXT|STATEMENT|LOG|INFO|DEBUG\d?):  (?:([0-9A-Z]{5}): )?(.*)$/;

export type HistoricalPostgresPsqlMessage = { severity: string; sqlstate?: string; message: string };

/** Every recognized psql/libpq message record in stderr, in order, with severity and (when present) SQLSTATE kept structurally. */
export function extractPsqlMessages(stderr: string): HistoricalPostgresPsqlMessage[] {
  const messages: HistoricalPostgresPsqlMessage[] = [];
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const match = PSQL_MESSAGE_LINE.exec(line);
    if (match) messages.push({ severity: match[1], sqlstate: match[2] || undefined, message: match[3].trim() });
  }
  return messages;
}

/** Every recognized `ERROR`-severity message record in stderr, in order, structurally (severity + optional SQLSTATE + message). */
export function extractPsqlErrorMessages(stderr: string): HistoricalPostgresPsqlMessage[] {
  return extractPsqlMessages(stderr).filter((entry) => entry.severity === "ERROR");
}

/**
 * Extracts the ordered sequence of psql `ERROR` message bodies (text only -
 * see `extractPsqlErrorMessages()` for the SQLSTATE-preserving structured
 * form `evaluateBehavioralOracle()` actually consumes) from raw stderr
 * captured with `ON_ERROR_STOP off` (so the script can run past an expected
 * error to reach later statements - see docs/historical-postgres-task-v0.md).
 *
 * Requires the canonical two-space `LEVEL:  message` formatting, anchored to
 * the start of the line (with an optional leading `psql:<file>:<line>:`
 * label, which is stripped along with the rest of the label - source
 * path/line therefore never enters the observation text in the common case,
 * and the oracle never has to normalize it separately). `WARNING`/`NOTICE`/
 * `DETAIL`/`HINT`/`CONTEXT`/`STATEMENT`/`LOG`/`INFO`/`DEBUG*` lines are
 * recognized but deliberately excluded - only `ERROR`-severity records ever
 * become observations. A bare substring `ERROR:` appearing mid-line in
 * otherwise-ordinary output never matches, since it isn't anchored to the
 * start of the line in the required record shape.
 */
export function extractPsqlErrorObservations(stderr: string): string[] {
  return extractPsqlErrorMessages(stderr).map((entry) => entry.message);
}

/**
 * `evaluateBehavioralOracle()`/`evaluateOracleAttribution()` accept either a
 * plain message string (treated as `{severity: "ERROR", message}`, no
 * SQLSTATE - the shape every pre-existing caller/test already used) or a
 * structured `HistoricalPostgresPsqlMessage` (from `extractPsqlErrorMessages()`,
 * which is what `resolveOracleReproduction()` now passes in production so
 * SQLSTATE is available when a task's oracle opts into checking it).
 */
export type HistoricalPostgresOracleObservationInput = string | HistoricalPostgresPsqlMessage;

function normalizeOracleObservation(entry: HistoricalPostgresOracleObservationInput): HistoricalPostgresPsqlMessage {
  return typeof entry === "string" ? { severity: "ERROR", message: entry } : entry;
}

/**
 * Matches the first `expected.length` observations, in order, against
 * `expected[i].matches` (compiled as `new RegExp(expected[i].matches)`,
 * `.test()` against `observations[i].message.trim()`) and, when
 * `expected[i].sqlstate` is declared, requires an exact SQLSTATE match too
 * (#200 fourth review round, Blocking 2 - see `HistoricalPostgresObservationPattern.sqlstate`).
 * Extra trailing observations beyond `expected.length` are ignored -
 * forgiving of incidental extra queries a reproducer might run before/after
 * the sequence under test. Fewer observations than expected is unsatisfied,
 * with a diagnostic saying so rather than throwing (an under-producing
 * reproducer is a legitimate, gradeable miss).
 *
 * A malformed `matches` regex source throws rather than silently failing:
 * this data comes from grader-private truth (task authoring), never from
 * agent input, so a bad pattern is a task-authoring bug that must be loud,
 * not a quiet false result mis-attributed to the agent's submission.
 */
export function evaluateBehavioralOracle(
  observations: HistoricalPostgresOracleObservationInput[],
  expected: HistoricalPostgresObservationPattern[]
): HistoricalPostgresOracleResult {
  const normalized = observations.map(normalizeOracleObservation);
  const diagnostics: string[] = [];
  if (normalized.length < expected.length) {
    diagnostics.push(`Expected ${expected.length} observation(s), captured only ${normalized.length}.`);
  }
  let satisfied = normalized.length >= expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    const pattern = expected[index];
    let regex: RegExp;
    try {
      regex = new RegExp(pattern.matches);
    } catch (error) {
      throw new Error(`Behavioral oracle pattern "${pattern.label}" (index ${index}) is not a valid regular expression: ${(error as Error).message}`);
    }
    const observed = normalized[index];
    const observedMessage = observed?.message?.trim() ?? "";
    const messageMatched = regex.test(observedMessage);
    const sqlstateMatched = pattern.sqlstate === undefined || observed?.sqlstate === pattern.sqlstate;
    if (!messageMatched) {
      satisfied = false;
      diagnostics.push(`Observation ${index} ("${pattern.label}") did not match /${pattern.matches}/: got ${JSON.stringify(observedMessage)}.`);
    } else if (!sqlstateMatched) {
      satisfied = false;
      diagnostics.push(
        `Observation ${index} ("${pattern.label}") matched the message pattern but had SQLSTATE ${JSON.stringify(observed?.sqlstate ?? null)}, expected ${JSON.stringify(pattern.sqlstate)}.`
      );
    }
  }
  return { observations: normalized.map((entry) => entry.message), expected, satisfied, diagnostics };
}

/**
 * `{ valid: true }` when a captured psql execution is even interpretable;
 * `{ valid: false, reason }` when it is a client/transport/runtime failure
 * that must never be scored as a `miss` or `invalid_submission` just
 * because it happened to produce zero (or garbage) observations - see
 * `classifyExecutionValidity()`, which is what decides this, and #200's
 * third review round, which is why this exists as its own structural
 * concept rather than being inferred from observation count.
 */
export type HistoricalPostgresExecutionValidity = { valid: true } | { valid: false; reason: string };

/**
 * Decides whether a captured psql execution is even interpretable before any
 * behavioral matching runs - derived **authoritatively from `execution.exitCode`
 * alone**, using psql's own real, documented, stable exit-status contract
 * (#200 fourth review round, Blocking 1 - this replaces an earlier
 * stderr-signature-regex approach, which the review correctly flagged as
 * fragile: real failures have forms a fixed phrase list can miss, and
 * ordinary SQL/application text could coincidentally match one):
 *
 * - `0` - success (or, with `ON_ERROR_STOP` off, "no fatal client-level
 *   error"; the script may still contain tolerated SQL errors).
 * - `1` - a fatal **client-side** error (out of memory, could not open the
 *   script, bad invocation) - never caused by SQL content. `docker exec`
 *   itself failing to even launch psql (a dead container, an OCI runtime
 *   failure, etc.) also surfaces as this same nonzero exit from the `docker`
 *   process - either way, psql never reached interpretable SQL execution.
 * - `2` - a **connection failure** - psql's own documented meaning; also
 *   never caused by SQL content.
 * - `3` - a SQL/script-level error occurred **and** `ON_ERROR_STOP` was in
 *   effect at that point.
 * - `"ETIMEDOUT"` - `execWithInput()`'s own timeout path (runtime-container.ts);
 *   never a SQL-content outcome either.
 *
 * `0` and `3` are the *only* possible outcomes of SQL content execution, so
 * anything else (`1`, `2`, `"ETIMEDOUT"`) is unambiguously a client/
 * transport/runtime failure, decided from the real signal the layer that
 * actually ran the command produced - not inferred from free text. A real
 * `ERROR:` record from the server, even a completely unexpected one, is
 * still a *valid*, interpretable execution (exit `0` or `3`); whether it
 * matches anything declared is a separate question `evaluateOracleAttribution()`
 * answers, not this function. No stderr-text fallback is needed or used.
 */
export function classifyExecutionValidity(execution: {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | string;
  durationMs: number;
}): HistoricalPostgresExecutionValidity {
  if (execution.exitCode === "ETIMEDOUT") {
    return { valid: false, reason: "psql execution timed out before completing - not attributable to any declared behavior." };
  }
  if (execution.exitCode === 1) {
    return {
      valid: false,
      reason:
        "psql/docker reported a fatal client-level failure (exit code 1) - psql's own documented exit status for a client-side error, never a SQL-content outcome. This also covers the container/exec transport never reaching psql at all (a dead container or OCI runtime failure surfaces as this same child-process exit code)."
    };
  }
  if (execution.exitCode === 2) {
    return {
      valid: false,
      reason: "psql reported a connection failure (exit code 2) - psql's own documented meaning; the session never reached interpretable SQL execution."
    };
  }
  return { valid: true };
}

export type HistoricalPostgresOracleAttribution = {
  /**
   * Execution-validity decision, computed *before* any behavioral matching -
   * see `classifyExecutionValidity()`. When `valid: false`, `attributedTo` is
   * always `"unattributed"` regardless of what (if anything) was captured;
   * a client/transport/runtime failure must never read as "the bug is
   * absent" or "the bug wasn't reproduced" just because it produced no
   * usable observations.
   */
  validity: HistoricalPostgresExecutionValidity;
  /** Observations matched against the oracle's `historical` pattern set. */
  historicalMatch: HistoricalPostgresOracleResult;
  /** Observations matched against the oracle's `reference` pattern set. */
  referenceMatch: HistoricalPostgresOracleResult;
  /**
   * Structural attribution - not just diagnostic prose. `"unattributed"`
   * covers: an invalid execution (see `validity` above); "matched neither
   * declared pattern set" (an unrelated/unexpected reference-side failure
   * must never silently pass as "the bug is absent"); and the pathological
   * case where both matched (a task-authoring bug in the declared oracle
   * itself - historical and reference patterns should be mutually exclusive
   * by construction, so this fails closed rather than picking one
   * arbitrarily).
   */
  attributedTo: "historical" | "reference" | "unattributed";
};

/**
 * Evaluates one revision run's captured observations against *both* halves
 * of a declared oracle and produces a structural attribution. Pure, no I/O.
 * `validity` must already reflect whether `observations` is trustworthy
 * (callers should pass `[]` when `!validity.valid` - see
 * `resolveOracleReproduction()` in historical-task.ts).
 */
export function evaluateOracleAttribution(
  observations: HistoricalPostgresOracleObservationInput[],
  oracle: HistoricalPostgresBehavioralOracle,
  validity: HistoricalPostgresExecutionValidity
): HistoricalPostgresOracleAttribution {
  const historicalMatch = evaluateBehavioralOracle(observations, oracle.historical);
  const referenceMatch = evaluateBehavioralOracle(observations, oracle.reference);
  const attributedTo: HistoricalPostgresOracleAttribution["attributedTo"] = !validity.valid
    ? "unattributed"
    : historicalMatch.satisfied && !referenceMatch.satisfied
      ? "historical"
      : referenceMatch.satisfied && !historicalMatch.satisfied
        ? "reference"
        : "unattributed";
  return { validity, historicalMatch, referenceMatch, attributedTo };
}
