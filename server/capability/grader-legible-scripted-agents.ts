/**
 * Scripted (model-free) candidate providers for the #237 archetypes.
 *
 * These exist for one reason: to prove, deterministically and in CI, that the
 * external grader distinguishes a bad-but-plausible self-asserting reproducer
 * from a grader-legible one, and that the paired pipeline retains raw
 * observations either way.
 *
 * They are **harness validation only**. `docs/evaluation-protocol.md` is
 * explicit that a scripted agent must not be promoted into capability
 * evidence, and `runGraderLegiblePairedExperiment()` enforces the same thing
 * by setting `capabilityEvidenceEligible: false` for any non-`command`
 * provider. A scripted run says the instrument works; it says nothing about
 * whether the intervention helps a model.
 */

import type { GraderLegibleCandidateProvider } from "./grader-legible-run.js";

/** Always submits the archetype's bad-but-plausible self-asserting shape. */
export const SCRIPTED_SELF_ASSERTING_PROVIDER: GraderLegibleCandidateProvider = {
  kind: "scripted",
  label: "scripted:self-asserting (harness validation, not capability evidence)",
  script: (archetype) => archetype.referenceCandidates.bad
};

/** Always submits the archetype's grader-legible shape. */
export const SCRIPTED_GRADER_LEGIBLE_PROVIDER: GraderLegibleCandidateProvider = {
  kind: "scripted",
  label: "scripted:grader-legible (harness validation, not capability evidence)",
  script: (archetype) => archetype.referenceCandidates.good
};

/**
 * Submits the self-asserting shape under `baseline` and the grader-legible
 * shape under `candidate`. This is a *staged* demonstration of the paired
 * pipeline end to end - materialization, capture, grading, attribution,
 * reporting - not a measurement of the intervention. Any report produced from
 * it must be read as instrument validation.
 */
export const SCRIPTED_PAIRED_DEMONSTRATION_PROVIDER: GraderLegibleCandidateProvider = {
  kind: "scripted",
  label: "scripted:staged-paired-demonstration (harness validation, not capability evidence)",
  script: (archetype, condition) => (condition === "candidate" ? archetype.referenceCandidates.good : archetype.referenceCandidates.bad)
};
