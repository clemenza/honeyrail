/**
 * The candidate intervention under test in #237, and its frozen baseline
 * counterpart.
 *
 * Scope discipline (this is the part most likely to go wrong):
 *
 * - It is a **methodology card**, not a framework, not a profile system, not
 *   a prompt-optimizer. One string plus its content hash.
 * - It encodes **no** bug-specific material: no PostgreSQL state names, no SQL
 *   snippets, no canonical reproducer, no grader-private tuple, no
 *   family-003/family-004 content. Studies 1-3 are the evidence that this gap
 *   exists; they are not the source of its wording. Every principle below is
 *   stated in terms of "external observer", "channel", "differential" and
 *   "contract", so nothing here can be satisfied by recalling a particular
 *   historical case.
 * - It is **frozen by content hash** before any transfer validation. #237
 *   requires the candidate artifact to be exportable and evaluated on the
 *   separately reserved unseen family-004 path *without modification*; a
 *   changed body is a new intervention ID, never a silent edit of this one.
 *
 * The baseline condition is the empty intervention, so a paired run differs
 * in exactly one materialized file.
 */

import { sha256 } from "../postgres/historical-task.js";

export type GraderLegibleIntervention = {
  interventionId: string;
  /** Materialized as `workspace/INTERVENTION.md`. Empty for the baseline condition. */
  body: string;
  interventionHash: string;
};

/**
 * Content hash over the id and body together: two interventions that differ
 * only in identity are still distinct conditions, and a body edit under the
 * same id must change the hash loudly rather than reuse a frozen identity.
 */
export function graderLegibleInterventionHash(interventionId: string, body: string): string {
  return sha256(`${interventionId}\n---\n${body}`);
}

function intervention(interventionId: string, body: string): GraderLegibleIntervention {
  return { interventionId, body, interventionHash: graderLegibleInterventionHash(interventionId, body) };
}

const CANDIDATE_BODY = `# Constructing a grader-legible reproducer

You may already know *why* the system behaves as it does. This note is about
the step after that: turning a behavioral hypothesis into an artifact whose
discriminating signal an external, automated observer can read directly.

## The transformation

    behavioral hypothesis
      -> discriminating experiment
      -> minimal observable
      -> externally machine-checkable reproducer

Most of the work is in the last two arrows. A correct diagnosis submitted with
an unreadable observable is scored the same as no diagnosis at all.

## Principles

1. **The external observer owns pass/fail.** Your script's job is to make the
   behavior happen and let its raw effect reach an output channel. It is not
   your script's job to decide whether the behavior is correct. Any verdict
   your script computes is invisible to the evaluator - it sees bytes on
   channels, not your reasoning.

2. **Expose the smallest raw differential.** Identify the one observation that
   differs between the behavior you are claiming and the behavior that would
   occur without it. Emit that, unmodified. Everything that does not
   discriminate is noise, however informative it felt while exploring.

3. **Do not catch or translate the target signal.** If the discriminating
   signal is an error, a non-zero status, or a rejection, it must arrive at the
   observer in its original form and on its original channel. Suppressing it,
   rephrasing it as prose, or converting it into a success status destroys the
   only thing that was being measured. Catch an error only when the contract
   explicitly asks you to.

4. **Pick the channel that actually discriminates.** Ask, for each candidate
   channel: would this differ if the behavior were absent? A message emitted on
   every path discriminates nothing, no matter how descriptive it is. Prefer the
   channel that changes: a returned value, a status, a raw error.

5. **Stabilize cardinality, order and format.** If the same experiment can emit
   the same information in different shapes on different executions, an
   automated comparator cannot use it. Impose a deterministic projection -
   fixed ordering, fixed row count, fixed formatting - without altering the
   content being observed.

6. **Separate exploration from the final artifact.** Diagnostic scaffolding -
   progress messages, intermediate dumps, banners, extra probes - belongs to
   the investigation, not the submission. Build the reproducer fresh from what
   you learned rather than trimming down your exploration script.

7. **Validate against the declared contract, not against hidden truth.** Before
   submitting, re-read the stated submission contract and check your artifact
   against it channel by channel: which channel, what shape, what status, what
   must be absent. Run it more than once and compare the raw outputs to each
   other. You cannot verify your answer; you can verify your output shape, and
   that is the part that is failing.

## Final check

Ask, literally: if an automated comparator saw only my stdout, my stderr and my
exit status - with no access to my script, my comments and my reasoning - could
it distinguish the behavior I am claiming from its absence?
`;

/**
 * The candidate under test. Version the ID (not the body under a stale ID)
 * if this is ever revised.
 */
export const GRADER_LEGIBLE_CANDIDATE_INTERVENTION: GraderLegibleIntervention = intervention(
  "cap-glo-intervention-v1",
  CANDIDATE_BODY
);

/** The paired baseline: identical task surface, no methodology card. */
export const GRADER_LEGIBLE_BASELINE_INTERVENTION: GraderLegibleIntervention = intervention("cap-glo-baseline-v1", "");

export const GRADER_LEGIBLE_CONDITIONS = ["baseline", "candidate"] as const;
export type GraderLegibleCondition = (typeof GRADER_LEGIBLE_CONDITIONS)[number];

export function graderLegibleIntervention(condition: GraderLegibleCondition): GraderLegibleIntervention {
  return condition === "candidate" ? GRADER_LEGIBLE_CANDIDATE_INTERVENTION : GRADER_LEGIBLE_BASELINE_INTERVENTION;
}

/**
 * The portable frozen artifact handed to a later unseen-family (#229/#230/#232
 * family-004) validation. Deliberately self-contained and hash-carrying: the
 * receiving run re-derives `interventionHash` from `interventionId` + `body`
 * and refuses anything that does not match, so "validated the frozen
 * intervention" cannot silently become "validated a tweaked one".
 */
export type FrozenGraderLegibleIntervention = GraderLegibleIntervention & {
  schemaVersion: 1;
  frozenFor: string;
  provenance: string;
};

export function exportFrozenGraderLegibleIntervention(
  source: GraderLegibleIntervention = GRADER_LEGIBLE_CANDIDATE_INTERVENTION
): FrozenGraderLegibleIntervention {
  return {
    schemaVersion: 1,
    ...source,
    frozenFor: "unseen-family transfer validation (#229/#230/#232 reserved family-004 path)",
    provenance: "honeyrail#237 Capability Lab TRAIN; derived from the recurring gap in #216/#220, #222/#224, #233/#236, not from those cases' content"
  };
}

export class GraderLegibleInterventionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderLegibleInterventionIntegrityError";
  }
}

/** Fail-closed check for a re-imported frozen artifact. */
export function assertFrozenGraderLegibleIntervention(value: FrozenGraderLegibleIntervention): void {
  const recomputed = graderLegibleInterventionHash(value.interventionId, value.body);
  if (recomputed !== value.interventionHash) {
    throw new GraderLegibleInterventionIntegrityError(
      `Frozen intervention "${value.interventionId}" does not match its recorded hash (recomputed ${recomputed}, recorded ${value.interventionHash}). ` +
        "Refusing to run: a modified body must be registered as a new intervention ID, not validated as the frozen candidate."
    );
  }
}
