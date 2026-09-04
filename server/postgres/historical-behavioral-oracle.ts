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
 * Extracts the ordered sequence of psql `ERROR` message bodies from raw
 * stderr captured with `ON_ERROR_STOP off` (so the script can run past an
 * expected error to reach later statements - see
 * docs/historical-postgres-task-v0.md).
 *
 * Deliberately keeps only the text after `ERROR:` on each matching line, so
 * any leading `psql:<file>:<line>:` label is stripped along with it - source
 * path/line therefore never enters the observation text in the common case,
 * and the oracle never has to normalize it separately. `DETAIL`/`CONTEXT`/
 * `HINT` continuation lines are not included; each observation is exactly
 * one `ERROR` line's message, trimmed.
 */
export function extractPsqlErrorObservations(stderr: string): string[] {
  const observations: string[] = [];
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const match = /ERROR:\s?(.*)$/.exec(line);
    if (match) observations.push(match[1].trim());
  }
  return observations;
}

/**
 * Matches the first `expected.length` observations, in order, against
 * `expected[i].matches` (compiled as `new RegExp(expected[i].matches)`,
 * `.test()` against `observations[i].trim()`). Extra trailing observations
 * beyond `expected.length` are ignored - forgiving of incidental extra
 * queries a reproducer might run before/after the sequence under test.
 * Fewer observations than expected is unsatisfied, with a diagnostic saying
 * so rather than throwing (an under-producing reproducer is a legitimate,
 * gradeable miss).
 *
 * A malformed `matches` regex source throws rather than silently failing:
 * this data comes from grader-private truth (task authoring), never from
 * agent input, so a bad pattern is a task-authoring bug that must be loud,
 * not a quiet false result mis-attributed to the agent's submission.
 */
export function evaluateBehavioralOracle(observations: string[], expected: HistoricalPostgresObservationPattern[]): HistoricalPostgresOracleResult {
  const diagnostics: string[] = [];
  if (observations.length < expected.length) {
    diagnostics.push(`Expected ${expected.length} observation(s), captured only ${observations.length}.`);
  }
  let satisfied = observations.length >= expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    const pattern = expected[index];
    let regex: RegExp;
    try {
      regex = new RegExp(pattern.matches);
    } catch (error) {
      throw new Error(`Behavioral oracle pattern "${pattern.label}" (index ${index}) is not a valid regular expression: ${(error as Error).message}`);
    }
    const observed = observations[index]?.trim() ?? "";
    const matched = regex.test(observed);
    if (!matched) {
      satisfied = false;
      diagnostics.push(`Observation ${index} ("${pattern.label}") did not match /${pattern.matches}/: got ${JSON.stringify(observed)}.`);
    }
  }
  return { observations, expected, satisfied, diagnostics };
}

export type HistoricalPostgresOracleAttribution = {
  /**
   * True iff extraction captured at least one observation at all - i.e. the
   * run produced something to evaluate, as opposed to a totally empty
   * capture (e.g. psql never reached a CALL, or stderr was empty). This is
   * "did we get gradeable output", independent of whether what was captured
   * matches either declared pattern set - see #200's second review round,
   * which asked for execution validity to be represented separately from
   * behavioral attribution rather than folded into a single boolean.
   */
  gradeable: boolean;
  /** Observations matched against the oracle's `historical` pattern set. */
  historicalMatch: HistoricalPostgresOracleResult;
  /** Observations matched against the oracle's `reference` pattern set. */
  referenceMatch: HistoricalPostgresOracleResult;
  /**
   * Structural attribution - not just diagnostic prose. `"unattributed"`
   * covers both "matched neither declared pattern set" (the primary
   * correctness fix this type exists for: an unrelated/unexpected
   * reference-side failure must never silently pass as "the bug is absent")
   * and the pathological case where both matched (a task-authoring bug in
   * the declared oracle itself - historical and reference patterns should be
   * mutually exclusive by construction, so this fails closed rather than
   * picking one arbitrarily).
   */
  attributedTo: "historical" | "reference" | "unattributed";
};

/**
 * Evaluates one revision run's captured observations against *both* halves
 * of a declared oracle and produces a structural attribution. Pure, no I/O.
 */
export function evaluateOracleAttribution(observations: string[], oracle: HistoricalPostgresBehavioralOracle): HistoricalPostgresOracleAttribution {
  const historicalMatch = evaluateBehavioralOracle(observations, oracle.historical);
  const referenceMatch = evaluateBehavioralOracle(observations, oracle.reference);
  const attributedTo: HistoricalPostgresOracleAttribution["attributedTo"] =
    historicalMatch.satisfied && !referenceMatch.satisfied
      ? "historical"
      : referenceMatch.satisfied && !historicalMatch.satisfied
        ? "reference"
        : "unattributed";
  return { gradeable: observations.length > 0, historicalMatch, referenceMatch, attributedTo };
}
