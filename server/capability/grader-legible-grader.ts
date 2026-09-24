/**
 * Deterministic external grader for the #237 grader-legible-observable
 * Capability Lab archetypes.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **The external observer owns pass/fail.** The grader consumes only raw
 *    stdout, raw stderr and the exit status captured *outside* the agent, plus
 *    the fixture's own invocation log. It never parses the submitted script,
 *    never reads prose, and never honours an agent-asserted verdict. A
 *    self-asserting submission fails not because the grader pattern-matches
 *    the word "PASS", but because the raw differential it was supposed to
 *    surface is simply not on any channel.
 * 2. **The grader does not leak expected truth.** Diagnostics are
 *    operator-side artifacts. Nothing this module produces is fed back to the
 *    agent, and the archetypes are single-shot, so there is no channel through
 *    which expected values could reach a candidate.
 *
 * Pure: no filesystem, no process spawning. Execution lives in
 * `grader-legible-run.ts`.
 */

import type { GraderLegibleArchetype, GraderLegibleChannelExpectation, GraderLegibleObservationContract } from "./grader-legible-archetypes.js";

/** One externally captured execution of a submitted reproducer. */
export type GraderLegibleRunObservation = {
  stdout: string;
  stderr: string;
  /** `null` when the process was killed by a signal or never produced a status. */
  exitStatus: number | null;
};

/**
 * Whether the observation is usable at all. An invalid execution is an
 * infrastructure/harness outcome, never a capability miss - #237 requires
 * retry/infrastructure failures to stay separable from "the agent built a
 * badly shaped reproducer".
 */
export type GraderLegibleExecutionValidity = { valid: true } | { valid: false; reason: string };

/**
 * Failure-stage attribution. `infrastructure` is not a capability outcome.
 * `no_discriminating_experiment` means the trajectory never ran the
 * experiment that distinguishes the behaviours; the remaining stages all mean
 * "ran the right experiment, encoded the observable wrongly", which is exactly
 * the gap #237 is about.
 */
export type GraderLegibleFailureStage =
  | "infrastructure"
  | "no_discriminating_experiment"
  | "nondeterministic_output"
  | "exit_status_mismatch"
  | "stdout_shape_mismatch"
  | "stderr_signal_missing";

export type GraderLegibleSecondaryDiagnostics = {
  /** Did the submission actually run the discriminating experiment? (fixture invocation log, grader-owned) */
  discriminatingExperimentPerformed: boolean;
  /** Were all captured executions byte-identical on every channel? */
  deterministicExternalOutput: boolean;
  exitStatusMatched: boolean;
  stdoutMatched: boolean;
  /** Was the target signal surfaced rather than swallowed/translated? `true` when the contract does not constrain stderr. */
  stderrSignalPreserved: boolean;
  /** Minimization proxies. Reported, never graded. */
  submissionBytes: number;
  fixtureInvocationCount: number;
};

export type GraderLegibleGrade = {
  result: "grader_legible" | "not_grader_legible" | "invalid_execution";
  failureStage: GraderLegibleFailureStage | null;
  diagnostics: string[];
  secondary: GraderLegibleSecondaryDiagnostics;
};

/**
 * Splits a captured channel into lines, dropping exactly one trailing empty
 * line (a well-formed final newline). Interior empty lines are preserved: a
 * genuinely empty output line is data, not noise. Same discipline as
 * `parseTuplesOnlyOutput()` in `server/postgres/historical-structured-oracle.ts`.
 */
export function channelLines(raw: string): string[] {
  if (typeof raw !== "string") {
    throw new Error(`channelLines: expected a string, got ${typeof raw}`);
  }
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function matchChannel(
  name: "stdout" | "stderr",
  raw: string,
  expectation: GraderLegibleChannelExpectation,
  diagnostics: string[]
): boolean {
  switch (expectation.mode) {
    case "ignored":
      return true;
    case "empty": {
      const lines = channelLines(raw);
      if (lines.length === 0) return true;
      diagnostics.push(`${name}: expected no output, got ${lines.length} line(s); first line ${JSON.stringify(lines[0])}.`);
      return false;
    }
    case "exact-lines": {
      const lines = channelLines(raw);
      const expected = expectation.lines;
      if (lines.length !== expected.length) {
        diagnostics.push(`${name}: expected exactly ${expected.length} line(s), got ${lines.length}.`);
        return false;
      }
      let ok = true;
      for (let i = 0; i < expected.length; i += 1) {
        if (lines[i] !== expected[i]) {
          ok = false;
          diagnostics.push(`${name}: line ${i} did not match the expected observation (got ${JSON.stringify(lines[i])}).`);
        }
      }
      return ok;
    }
    case "contains-exact-line": {
      const lines = channelLines(raw);
      if (lines.includes(expectation.line)) return true;
      diagnostics.push(
        `${name}: the expected raw signal line was not present verbatim. The target signal was swallowed, translated or redirected off this channel.`
      );
      return false;
    }
    default: {
      // Exhaustiveness: a new channel mode must be handled explicitly rather
      // than silently grading as a pass.
      const unreachable: never = expectation;
      throw new Error(`Unhandled channel expectation: ${JSON.stringify(unreachable)}`);
    }
  }
}

function runsAgree(runs: readonly GraderLegibleRunObservation[]): boolean {
  if (runs.length < 2) return true;
  const [first] = runs;
  return runs.every((run) => run.stdout === first.stdout && run.stderr === first.stderr && run.exitStatus === first.exitStatus);
}

/**
 * Grades one submission against one archetype.
 *
 * `runs` must hold every externally captured execution of the submission (at
 * least one; at least two when the contract requires cross-run determinism,
 * which every #237 archetype does). `invocationLog` is the fixture's own
 * record of how it was called, read from the grader-owned state directory.
 *
 * Check order is the failure-stage order: infrastructure, then "was the
 * discriminating experiment run at all", then output-shape stages. That
 * ordering is what lets a paired baseline/candidate comparison say *where*
 * improvement happened rather than only whether it happened.
 */
export function gradeGraderLegibleSubmission(input: {
  archetype: GraderLegibleArchetype;
  validity: GraderLegibleExecutionValidity;
  runs: readonly GraderLegibleRunObservation[];
  invocationLog: readonly string[];
  submissionBytes: number;
}): GraderLegibleGrade {
  const { archetype, validity, runs, invocationLog, submissionBytes } = input;
  const contract: GraderLegibleObservationContract = archetype.observationContract;
  const diagnostics: string[] = [];

  const discriminatingPattern = new RegExp(archetype.discriminatingInvocation);
  const discriminatingExperimentPerformed = invocationLog.some((line) => discriminatingPattern.test(line));

  const baseSecondary = {
    discriminatingExperimentPerformed,
    deterministicExternalOutput: false,
    exitStatusMatched: false,
    stdoutMatched: false,
    stderrSignalPreserved: contract.stderr.mode === "ignored",
    submissionBytes,
    fixtureInvocationCount: invocationLog.length
  };

  if (!validity.valid) {
    return {
      result: "invalid_execution",
      failureStage: "infrastructure",
      diagnostics: [`Execution was not valid: ${validity.reason}`],
      secondary: baseSecondary
    };
  }

  if (runs.length === 0) {
    // Defensive: a valid execution with no captured runs is a harness bug, not
    // an agent failure, so it must not be scored as a capability miss.
    return {
      result: "invalid_execution",
      failureStage: "infrastructure",
      diagnostics: ["Execution was marked valid but no runs were captured."],
      secondary: baseSecondary
    };
  }

  const deterministicExternalOutput = runsAgree(runs);

  const [observation] = runs;
  const exitStatusMatched = observation.exitStatus === contract.exitStatus;
  const stdoutMatched = matchChannel("stdout", observation.stdout, contract.stdout, diagnostics);
  const stderrSignalPreserved = matchChannel("stderr", observation.stderr, contract.stderr, diagnostics);

  const secondary: GraderLegibleSecondaryDiagnostics = {
    ...baseSecondary,
    deterministicExternalOutput,
    exitStatusMatched,
    stdoutMatched,
    stderrSignalPreserved
  };

  if (!discriminatingExperimentPerformed) {
    return {
      result: "not_grader_legible",
      failureStage: "no_discriminating_experiment",
      diagnostics: [
        "The submission never ran the discriminating experiment against the fixture; the miss is upstream of output-shape construction.",
        ...diagnostics
      ],
      secondary
    };
  }

  if (!deterministicExternalOutput) {
    return {
      result: "not_grader_legible",
      failureStage: "nondeterministic_output",
      diagnostics: ["Repeated executions of the submission did not produce byte-identical external output.", ...diagnostics],
      secondary
    };
  }

  if (!exitStatusMatched) {
    return {
      result: "not_grader_legible",
      failureStage: "exit_status_mismatch",
      diagnostics: [`Exit status ${String(observation.exitStatus)} did not satisfy the expected observation.`, ...diagnostics],
      secondary
    };
  }

  if (!stdoutMatched) {
    return { result: "not_grader_legible", failureStage: "stdout_shape_mismatch", diagnostics, secondary };
  }

  if (!stderrSignalPreserved) {
    return { result: "not_grader_legible", failureStage: "stderr_signal_missing", diagnostics, secondary };
  }

  return { result: "grader_legible", failureStage: null, diagnostics, secondary };
}
