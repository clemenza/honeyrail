/**
 * Capability Lab TRAIN archetypes for **grader-legible observable /
 * reproducer-output-shape construction** (issue #237).
 *
 * Studies 1-3 (#216/#220, #222/#224, #233/#236) repeatedly showed the same
 * downstream failure shape: a trajectory can localize a behavioral
 * differential and still submit a reproducer whose discriminating signal is
 * consumed *inside* the script (self-asserting `DO $$ ... END $$` blocks,
 * swallowed errors, `RAISE NOTICE` in place of the raw behavior, extra
 * diagnostic output, internal pass/fail branching) instead of being surfaced
 * as a minimal external observable.
 *
 * The capability under test here is therefore **not** PostgreSQL diagnosis.
 * It is the downstream transformation:
 *
 * ```text
 * behavioral hypothesis -> discriminating experiment -> minimal observable
 *   -> externally machine-checkable reproducer
 * ```
 *
 * ## Why these fixtures are synthetic
 *
 * The exact Historical PostgreSQL cases are TRAIN evidence for *identifying*
 * the gap only. Per #237 we must not tune on #16867 / #18574 / #18118, must
 * not touch their frozen graders, and must not consume family-003 or the
 * reserved family-004 here. So every archetype below is a neutral synthetic
 * fixture: a tiny deterministic POSIX-sh "system under test" that preserves
 * the output-shape challenge without reproducing any historical bug, SQL
 * snippet, state name, or grader-private tuple.
 *
 * ## Public vs grader-private material
 *
 * `publicBrief` and `publicSubmissionContract` are the only agent-visible
 * strings; `materializeGraderLegibleArchetype()` writes nothing else. The
 * `observationContract`, `discriminatingInvocation`, and the reference
 * candidate shapes are grader-private and stay operator-side, mirroring the
 * truth-isolation discipline in `server/postgres/historical-task.ts`.
 *
 * This module is deliberately pure data + hashing: no filesystem, no
 * execution, no grading. Materialization lives in
 * `grader-legible-fixture.ts`, grading in `grader-legible-grader.ts`.
 */

import { sha256, stableJson } from "../postgres/historical-task.js";

/**
 * The six output-shape failure classes #237 requires the TRAIN set to cover.
 * These are archetype identities, not runtime enums: the grader never decides
 * anything from this string, it only labels which class a task exercises.
 */
export const GRADER_LEGIBLE_FAILURE_CLASSES = [
  "swallowed-raw-error",
  "self-asserting-wrapper",
  "extra-diagnostic-output",
  "wrong-observable-channel",
  "overfit-internal-branching",
  "nondeterministic-row-shape"
] as const;
export type GraderLegibleFailureClass = (typeof GRADER_LEGIBLE_FAILURE_CLASSES)[number];

/**
 * Expected shape of one output channel. Each archetype constrains only the
 * channels that are load-bearing for its failure class, and leaves the rest
 * `ignored` — a contract that pinned every channel everywhere would grade
 * incidental style rather than the capability under test.
 */
export type GraderLegibleChannelExpectation =
  | { mode: "ignored" }
  | { mode: "empty" }
  /** stdout/stderr must be exactly these lines, in this order (one trailing newline tolerated). */
  | { mode: "exact-lines"; lines: readonly string[] }
  /** The channel must contain this line verbatim, unmodified and untranslated, among its lines. */
  | { mode: "contains-exact-line"; line: string };

/**
 * Grader-private expected external observation for one archetype. The
 * evaluator compares raw captured stdout/stderr/exit status against this; it
 * never reads the submission's prose and never sees agent-asserted verdicts.
 */
export type GraderLegibleObservationContract = {
  exitStatus: number;
  stdout: GraderLegibleChannelExpectation;
  stderr: GraderLegibleChannelExpectation;
  /**
   * Every archetype requires byte-identical output across repeated execution:
   * the evaluator runs each submission more than once against the same fixture
   * state. Declared explicitly (rather than implied) so the contract is
   * self-describing in retained artifacts.
   */
  deterministicAcrossRuns: true;
};

/**
 * Grader-private reference candidate shape. `bad` is the
 * bad-but-plausible self-asserting solution #237 requires for every
 * archetype; `good` is the grader-legible shape. Both exist so the harness
 * can prove — deterministically, with no model in the loop — that the grader
 * actually distinguishes them. They are harness-validation fixtures, never
 * capability evidence, and are never materialized into an agent workspace.
 */
export type GraderLegibleReferenceCandidates = { bad: string; good: string };

export type GraderLegibleArchetype = {
  archetypeId: string;
  failureClass: GraderLegibleFailureClass;
  /** Name of the fixture command placed on the submission's PATH. */
  fixtureCommand: string;
  /** POSIX-sh body of that command (the synthetic system under test). */
  fixtureProgram: string;
  /** Agent-visible scenario. Describes the fixture's surface, never the answer. */
  publicBrief: string;
  /**
   * Agent-visible submission contract. Declares the channel, shape and
   * determinism requirements the external evaluator applies — the artifact is
   * validated against *this*, never against hidden truth. It deliberately
   * states no observed value.
   */
  publicSubmissionContract: string;
  observationContract: GraderLegibleObservationContract;
  /**
   * Grader-private POSIX extended-regex, matched against the fixture's own
   * invocation log (recorded outside the agent), that identifies the
   * discriminating experiment. Used only for failure-stage attribution: it
   * separates "never ran the discriminating experiment" from "ran it but
   * encoded the observable badly". It never contributes to the pass/fail
   * decision.
   */
  discriminatingInvocation: string;
  referenceCandidates: GraderLegibleReferenceCandidates;
};

/**
 * Preamble shared by every fixture program. Two responsibilities:
 *
 * 1. Append each invocation's arguments to a grader-owned log in the fixture
 *    state directory. The agent's submission never sees this file's role; it
 *    is a harness-side observation, which is what lets failure-stage
 *    attribution stay independent of anything the agent asserts.
 * 2. Fail loudly if the harness forgot to provide the state directory, rather
 *    than silently degrading to an unlogged run.
 */
const FIXTURE_PREAMBLE = `#!/bin/sh
# Synthetic HoneyRail Capability Lab fixture. Deterministic, no network, no
# external dependencies. Not a model of any real database.
set -u
if [ -z "\${HONEYRAIL_FIXTURE_STATE:-}" ]; then
  printf 'fixture: HONEYRAIL_FIXTURE_STATE is not set\\n' >&2
  exit 70
fi
printf '%s\\n' "$*" >> "\${HONEYRAIL_FIXTURE_STATE}/invocations.log"
`;

function fixtureProgram(body: string): string {
  return `${FIXTURE_PREAMBLE}${body}`;
}

/**
 * Shared tail of every archetype's public submission contract. States the
 * evaluator's own rules — external observer owns pass/fail, raw channels are
 * compared, repeated execution must agree — without naming any observed
 * value, so an agent can validate its artifact against the declared contract
 * instead of guessing hidden truth.
 */
const COMMON_SUBMISSION_CONTRACT = [
  "Submit a single POSIX shell script. It is executed with /bin/sh in a scratch directory with the fixture command on PATH.",
  "An external evaluator - not your script - decides pass/fail. It captures raw stdout, raw stderr and the exit status of your script and compares them against a private expected observation.",
  "The evaluator does not read prose, verdict words, log lines or comments. A script that reports its own conclusion instead of exposing the underlying behavior cannot pass.",
  "Your script is executed more than once against the same fixture state. Every captured channel must be byte-identical across those executions.",
  "Do not print anything beyond what this contract requires."
].join("\n");

function publicContract(specific: readonly string[]): string {
  return [...specific, "", COMMON_SUBMISSION_CONTRACT].join("\n");
}

// ---------------------------------------------------------------------------
// Archetype 1 - swallowed raw error
// ---------------------------------------------------------------------------

const SWALLOWED_RAW_ERROR: GraderLegibleArchetype = {
  archetypeId: "cap-glo-001",
  failureClass: "swallowed-raw-error",
  fixtureCommand: "ledger",
  fixtureProgram: fixtureProgram(`
case "\${1:-}" in
  stage)
    case "\${2:-}" in
      alpha|beta) printf 'staged %s\\n' "$2"; exit 0 ;;
      *) printf 'ledger: unknown stage target: %s\\n' "\${2:-}" >&2; exit 2 ;;
    esac ;;
  commit)
    case "\${2:-}" in
      alpha) printf 'committed alpha\\n'; exit 0 ;;
      beta)
        printf 'LEDGER-E0412: commit rejected: stage "beta" was superseded\\n' >&2
        exit 3 ;;
      *) printf 'ledger: unknown commit target: %s\\n' "\${2:-}" >&2; exit 2 ;;
    esac ;;
  *) printf 'ledger: unknown command: %s\\n' "\${1:-}" >&2; exit 2 ;;
esac
`),
  publicBrief: [
    "The `ledger` command has two subcommands: `ledger stage <target>` and `ledger commit <target>`. Valid targets are `alpha` and `beta`.",
    "One of the two targets cannot be committed: the ledger rejects it and reports why on its own error channel with its own exit status.",
    "Find that target and build the minimal reproducer that exposes the rejection exactly as the ledger produced it."
  ].join("\n"),
  publicSubmissionContract: publicContract([
    "Your script must terminate with the ledger's own exit status for the rejected commit.",
    "The ledger's raw error line must reach stderr unmodified: do not catch it, do not rewrite it, do not summarise it, do not redirect it into stdout."
  ]),
  observationContract: {
    exitStatus: 3,
    stdout: { mode: "ignored" },
    stderr: { mode: "contains-exact-line", line: 'LEDGER-E0412: commit rejected: stage "beta" was superseded' },
    deterministicAcrossRuns: true
  },
  discriminatingInvocation: "^commit beta$",
  referenceCandidates: {
    // Plausible: it does run the discriminating experiment, then converts the
    // raw differential into prose and exits 0.
    bad: `#!/bin/sh
ledger stage beta >/dev/null 2>&1
if ledger commit beta >/dev/null 2>&1; then
  echo "PASS: commit beta succeeded"
else
  echo "FAIL: commit beta was rejected by the ledger"
fi
exit 0
`,
    good: `#!/bin/sh
ledger stage beta >/dev/null
exec ledger commit beta >/dev/null
`
  }
};

// ---------------------------------------------------------------------------
// Archetype 2 - self-asserting procedural wrapper
// ---------------------------------------------------------------------------

const SELF_ASSERTING_WRAPPER: GraderLegibleArchetype = {
  archetypeId: "cap-glo-002",
  failureClass: "self-asserting-wrapper",
  fixtureCommand: "meter",
  fixtureProgram: fixtureProgram(`
case "\${1:-}" in
  read)
    case "\${2:-}" in
      base) printf '1000\\n'; exit 0 ;;
      adjusted) printf '1007\\n'; exit 0 ;;
      *) printf 'meter: unknown gauge: %s\\n' "\${2:-}" >&2; exit 2 ;;
    esac ;;
  gauges) printf 'base\\nadjusted\\n'; exit 0 ;;
  *) printf 'meter: unknown command: %s\\n' "\${1:-}" >&2; exit 2 ;;
esac
`),
  publicBrief: [
    "`meter gauges` lists the readable gauges; `meter read <gauge>` prints one gauge's current value.",
    "The two gauges are documented as always agreeing, and they do not. Build the minimal reproducer that exposes the value which disagrees."
  ].join("\n"),
  publicSubmissionContract: publicContract([
    "stdout must be exactly one line: the raw value the meter printed for the disagreeing gauge, byte for byte as the meter printed it.",
    "Do not compare, annotate, round or label the value, and do not decide inside the script whether it is correct.",
    "Exit 0."
  ]),
  observationContract: {
    exitStatus: 0,
    stdout: { mode: "exact-lines", lines: ["1007"] },
    stderr: { mode: "ignored" },
    deterministicAcrossRuns: true
  },
  discriminatingInvocation: "^read adjusted$",
  referenceCandidates: {
    bad: `#!/bin/sh
base=$(meter read base)
adjusted=$(meter read adjusted)
if [ "$base" = "$adjusted" ]; then
  echo "OK: gauges agree"
else
  echo "DRIFT DETECTED: adjusted gauge disagrees with base gauge"
fi
exit 0
`,
    good: `#!/bin/sh
exec meter read adjusted
`
  }
};

// ---------------------------------------------------------------------------
// Archetype 3 - extra diagnostic rows/output
// ---------------------------------------------------------------------------

const EXTRA_DIAGNOSTIC_OUTPUT: GraderLegibleArchetype = {
  archetypeId: "cap-glo-003",
  failureClass: "extra-diagnostic-output",
  fixtureCommand: "queue",
  fixtureProgram: fixtureProgram(`
case "\${1:-}" in
  depth) printf '137\\n'; exit 0 ;;
  status)
    printf 'queue: build 2f9c1a\\n'
    printf 'queue: workers 3\\n'
    printf 'queue: depth 137\\n'
    printf 'queue: drained no\\n'
    exit 0 ;;
  drain) printf 'queue: drain is disabled in this fixture\\n' >&2; exit 4 ;;
  *) printf 'queue: unknown command: %s\\n' "\${1:-}" >&2; exit 2 ;;
esac
`),
  publicBrief: [
    "`queue status` prints a multi-line operator dump; `queue depth` prints the queue depth on its own.",
    "The depth is the quantity under investigation. Build the minimal reproducer that exposes it and nothing else."
  ].join("\n"),
  publicSubmissionContract: publicContract([
    "stdout must be exactly one line: the raw depth value.",
    "No banners, labels, headers, progress notes, timestamps or surrounding diagnostic lines. Exploration output belongs in your working notes, not in the submitted reproducer.",
    "Exit 0."
  ]),
  observationContract: {
    exitStatus: 0,
    stdout: { mode: "exact-lines", lines: ["137"] },
    stderr: { mode: "ignored" },
    deterministicAcrossRuns: true
  },
  discriminatingInvocation: "^(depth|status)$",
  referenceCandidates: {
    bad: `#!/bin/sh
echo "=== queue reproducer ==="
echo "--- full status ---"
queue status
echo "--- depth ---"
queue depth
echo "=== end ==="
exit 0
`,
    good: `#!/bin/sh
exec queue depth
`
  }
};

// ---------------------------------------------------------------------------
// Archetype 4 - wrong observable channel
// ---------------------------------------------------------------------------

const WRONG_OBSERVABLE_CHANNEL: GraderLegibleArchetype = {
  archetypeId: "cap-glo-004",
  failureClass: "wrong-observable-channel",
  fixtureCommand: "gate",
  fixtureProgram: fixtureProgram(`
case "\${1:-}" in
  check)
    case "\${2:-}" in
      open|sealed)
        printf 'NOTICE: gate evaluated token %s\\n' "$2" >&2
        if [ "$2" = "sealed" ]; then exit 7; fi
        exit 0 ;;
      *) printf 'gate: unknown token: %s\\n' "\${2:-}" >&2; exit 2 ;;
    esac ;;
  tokens) printf 'open\\nsealed\\n'; exit 0 ;;
  *) printf 'gate: unknown command: %s\\n' "\${1:-}" >&2; exit 2 ;;
esac
`),
  publicBrief: [
    "`gate tokens` lists the tokens; `gate check <token>` evaluates one.",
    "`gate check` always emits a NOTICE line on its message channel, for every token, whatever the outcome. The accept/reject decision itself is carried elsewhere.",
    "One token is rejected. Build the minimal reproducer that exposes the rejection through the channel that actually discriminates."
  ].join("\n"),
  publicSubmissionContract: publicContract([
    "Your script must terminate with the gate's own exit status for the rejected token.",
    "stdout must be empty. The NOTICE text is emitted for every token and therefore discriminates nothing; do not capture, grep, echo or redirect it into stdout.",
    "Do not swap channels: exit status is the signal."
  ]),
  observationContract: {
    exitStatus: 7,
    stdout: { mode: "empty" },
    stderr: { mode: "ignored" },
    deterministicAcrossRuns: true
  },
  discriminatingInvocation: "^check sealed$",
  referenceCandidates: {
    bad: `#!/bin/sh
gate check sealed 2>&1 | grep NOTICE
exit 0
`,
    good: `#!/bin/sh
exec gate check sealed >/dev/null
`
  }
};

// ---------------------------------------------------------------------------
// Archetype 5 - overfit internal branching
// ---------------------------------------------------------------------------

const OVERFIT_INTERNAL_BRANCHING: GraderLegibleArchetype = {
  archetypeId: "cap-glo-005",
  failureClass: "overfit-internal-branching",
  fixtureCommand: "pair",
  fixtureProgram: fixtureProgram(`
case "\${1:-}" in
  value)
    case "\${2:-}" in
      left) printf 'L:42\\n'; exit 0 ;;
      right) printf 'R:41\\n'; exit 0 ;;
      *) printf 'pair: unknown side: %s\\n' "\${2:-}" >&2; exit 2 ;;
    esac ;;
  sides) printf 'left\\nright\\n'; exit 0 ;;
  *) printf 'pair: unknown command: %s\\n' "\${1:-}" >&2; exit 2 ;;
esac
`),
  publicBrief: [
    "`pair value left` and `pair value right` print the two sides of a replicated counter. They are specified to stay in lock-step and they do not.",
    "Build the minimal reproducer that lets an external comparator see the divergence for itself."
  ].join("\n"),
  publicSubmissionContract: publicContract([
    "stdout must be exactly two lines: the raw left value, then the raw right value, each byte for byte as the fixture printed it.",
    "Do not encode the expected relationship in the script. No comparison, no if/else on the values, no verdict, no derived difference - the external comparator owns that judgement.",
    "Exit 0."
  ]),
  observationContract: {
    exitStatus: 0,
    stdout: { mode: "exact-lines", lines: ["L:42", "R:41"] },
    stderr: { mode: "ignored" },
    deterministicAcrossRuns: true
  },
  discriminatingInvocation: "^value (left|right)$",
  referenceCandidates: {
    bad: `#!/bin/sh
left=$(pair value left | cut -d: -f2)
right=$(pair value right | cut -d: -f2)
if [ "$left" -eq "$right" ]; then
  echo "PASS: sides are in lock-step"
else
  echo "FAIL: sides diverged by $((left - right))"
fi
exit 0
`,
    good: `#!/bin/sh
pair value left
pair value right
`
  }
};

// ---------------------------------------------------------------------------
// Archetype 6 - nondeterministic / multi-row shape
// ---------------------------------------------------------------------------

const NONDETERMINISTIC_ROW_SHAPE: GraderLegibleArchetype = {
  archetypeId: "cap-glo-006",
  failureClass: "nondeterministic-row-shape",
  fixtureCommand: "roster",
  fixtureProgram: fixtureProgram(`
case "\${1:-}" in
  list)
    counter_file="\${HONEYRAIL_FIXTURE_STATE}/roster-rotation"
    n=0
    if [ -f "$counter_file" ]; then n=$(cat "$counter_file"); fi
    n=$((n + 1))
    printf '%s\\n' "$n" > "$counter_file"
    case $((n % 3)) in
      0) printf 'r-alpha|1\\nr-beta|2\\nr-gamma|3\\n' ;;
      1) printf 'r-gamma|3\\nr-alpha|1\\nr-beta|2\\n' ;;
      *) printf 'r-beta|2\\nr-gamma|3\\nr-alpha|1\\n' ;;
    esac
    exit 0 ;;
  *) printf 'roster: unknown command: %s\\n' "\${1:-}" >&2; exit 2 ;;
esac
`),
  publicBrief: [
    "`roster list` returns the roster rows. The row set is fixed; the order in which the fixture emits them is not stable between calls.",
    "The row set is the quantity under investigation. Build a reproducer whose output an external evaluator can compare across repeated executions."
  ].join("\n"),
  publicSubmissionContract: publicContract([
    "stdout must contain exactly the roster rows, one per line, byte for byte as the fixture printed each row, in ascending byte order.",
    "Do not add, drop, deduplicate, reformat or renumber rows. Stabilise the projection rather than the content.",
    "Exit 0."
  ]),
  observationContract: {
    exitStatus: 0,
    stdout: { mode: "exact-lines", lines: ["r-alpha|1", "r-beta|2", "r-gamma|3"] },
    stderr: { mode: "ignored" },
    deterministicAcrossRuns: true
  },
  discriminatingInvocation: "^list$",
  referenceCandidates: {
    bad: `#!/bin/sh
exec roster list
`,
    good: `#!/bin/sh
roster list | LC_ALL=C sort
`
  }
};

/**
 * The frozen TRAIN archetype set. Order is part of the set's identity (it
 * feeds `graderLegibleArchetypeSetHash()`); append-only if this ever grows,
 * and version the set rather than reordering it.
 */
export const GRADER_LEGIBLE_ARCHETYPES: readonly GraderLegibleArchetype[] = [
  SWALLOWED_RAW_ERROR,
  SELF_ASSERTING_WRAPPER,
  EXTRA_DIAGNOSTIC_OUTPUT,
  WRONG_OBSERVABLE_CHANNEL,
  OVERFIT_INTERNAL_BRANCHING,
  NONDETERMINISTIC_ROW_SHAPE
];

export function graderLegibleArchetype(archetypeId: string): GraderLegibleArchetype {
  const found = GRADER_LEGIBLE_ARCHETYPES.find((archetype) => archetype.archetypeId === archetypeId);
  if (!found) {
    throw new Error(
      `Unknown grader-legible archetype "${archetypeId}". Known: ${GRADER_LEGIBLE_ARCHETYPES.map((a) => a.archetypeId).join(", ")}`
    );
  }
  return found;
}

/**
 * Content hash of one archetype, over everything that defines the task
 * surface *and* its grading truth: fixture program, public strings,
 * observation contract and discriminating-invocation pattern. Reference
 * candidate shapes are excluded - they are harness-validation fixtures that
 * exercise the grader, not part of the task's identity, so adding a second
 * bad shape later must not invalidate retained run records.
 */
export function graderLegibleArchetypeHash(archetype: GraderLegibleArchetype): string {
  return sha256(
    stableJson({
      archetypeId: archetype.archetypeId,
      failureClass: archetype.failureClass,
      fixtureCommand: archetype.fixtureCommand,
      fixtureProgram: archetype.fixtureProgram,
      publicBrief: archetype.publicBrief,
      publicSubmissionContract: archetype.publicSubmissionContract,
      observationContract: archetype.observationContract,
      discriminatingInvocation: archetype.discriminatingInvocation
    })
  );
}

/** Content hash of the whole frozen TRAIN set: ordered per-archetype hashes, re-hashed. */
export function graderLegibleArchetypeSetHash(archetypes: readonly GraderLegibleArchetype[] = GRADER_LEGIBLE_ARCHETYPES): string {
  return sha256(stableJson(archetypes.map((archetype) => [archetype.archetypeId, graderLegibleArchetypeHash(archetype)])));
}
