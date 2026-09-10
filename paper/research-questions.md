# Research questions and claim boundaries

## RQ1 — Requirement context

**Question:** Does contemporaneous requirement/SPEC context improve an AI Database Test Engineer's verified rediscovery or investigation quality over source + neutral task prompt alone?

Current evidence:
- Study 1: E1 changed the trajectory but did not improve verified rediscovery; observed exploration/cost increased.
- Study 2: E1 again did not improve verified rediscovery or localization; observed steps, wall time, and decode tokens increased.

Permitted current claim:
> Across two exploratory historical PostgreSQL tasks, adding contemporaneous SPEC context alone did not produce a measured rediscovery or localization improvement and increased observed inference cost.

Not yet permitted:
- "SPEC is useless."
- a population-level negative effect.
- statistical significance.

## RQ2 — Introducing change-set

**Question:** Does access to the full introducing implementation change-set improve investigation efficiency, root-cause localization, or verified rediscovery?

Current evidence:
- Study 1: E2 reached essentially the same root-cause neighborhood as E1 with substantially fewer steps, wall time, and decode tokens.
- Study 2: E2 used fewer steps/time than E1 and shifted diagnosis from an adjacent non-target defect to the actual function modified by the historical fix.

Permitted current claim:
> Introducing-diff access consistently focused investigation across both studied families, reducing observed search cost in both and improving target localization in one.

Not yet permitted:
- causal/reliability claim across PostgreSQL bugs.
- rediscovery-rate improvement claim.

## RQ3 — Generic test-engineering methodology

**Question:** Does the frozen generic Test-Engineer HarnessProfile add measurable value beyond SPEC + introducing diff?

Current evidence:
- Study 1: E3 increased wall time and decode tokens relative to E2, with no measured outcome gain.
- Study 2: same directional pattern; near-flat step count, higher wall time/tokens, same diagnosis and same grader result.

Permitted current claim:
> Under the evaluated DeepSeek/DSH configuration and budget, the generic HarnessProfile increased generation cost in both studied families without a measured gain in rediscovery or localization.

Not yet permitted:
- methodology is generally harmful.
- result generalizes to other models/backends.

## RQ4 — Failure-stage attribution

**Question:** When agents approach the correct subsystem/root cause but still fail authoritative rediscovery, which test-engineering stage breaks down?

Current evidence:
- Both families show strong or improving source/hypothesis work before the final grader verdict.
- Both expose a recurring downstream problem in choosing externally grader-legible observables and constructing/minimizing revision-discriminating reproducers.
- The pattern occurs under two different grading protocols.

Permitted current claim:
> The current studies provide cross-family evidence that plausible diagnosis can fail to become verified rediscovery because downstream observable/reproducer construction remains incomplete.

Not yet permitted:
- this is the dominant failure mode for AI Database Test Engineers in general.

## Future confirmation questions

A third unrelated family should test whether:
1. E2 again reduces investigation cost and/or improves target localization.
2. E3 again costs more without measured benefit.
3. the downstream observable/reproducer gap recurs without adapting the evaluation to the first two exact failures.

Any capability intervention trained from Studies 1/2 must be validated on an unseen unrelated family; same-case reruns are TRAIN/debug evidence only.