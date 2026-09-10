# Cross-family comparison

This page records only the current two-study comparison. It is not a statistical aggregate.

## Subjects

| Dimension | Study 1 | Study 2 |
|---|---|---|
| Task | `postgres-change-001` | `postgres-change-002` |
| Historical bug | BUG #16867 | BUG #18574 |
| Causal family | transaction chaining × SAVEPOINT | PL/pgSQL CALL cached-plan invalidation after DDL |
| Grading protocol | structured stdout oracle | behavioral raw-observation oracle |
| Formal E0–E3 outcomes | 4/4 miss | 4/4 miss |
| Formal infrastructure retries | 1 retained E2 infrastructure failure + linked retry | 0 |

## RQ1 — SPEC-only context

Direction observed in both studies:
- E1 did not improve the authoritative result.
- E1 did not improve target localization relative to E0.
- E1 increased observed inference/exploration cost.

Interpretation: repeated exploratory evidence against assuming that contemporaneous requirements alone improve measured database-test-agent performance.

## RQ2 — Introducing diff

Direction observed in both studies:
- E2 reduced steps/wall time relative to E1.

Study-specific difference:
- Study 1: primarily efficiency improvement while reaching a similar root-cause neighborhood.
- Study 2: efficiency improvement plus qualitative localization onto the actual historically fixed function.

Interpretation: strongest current positive signal. Introducing change context appears to focus source reading/hypothesis formation, but current data do not establish a rediscovery-rate benefit.

## RQ3 — Generic Test-Engineer HarnessProfile

Direction observed in both studies:
- E3 produced no measured rediscovery/localization gain over E2.
- E3 increased wall time and decode tokens relative to E2.

Interpretation: repeated direction under the same model/backend and byte-identical profile text applied to two unrelated tasks. This supports a scoped cost-without-measured-benefit observation, not a general claim that methodology prompting is harmful.

## RQ4 — Downstream verified-reproducer gap

Repeated pattern:
- agents reached plausible or improved diagnosis/localization;
- submitted reproducers failed to expose the relevant historical/reference distinction in the exact externally observable form required by the deterministic grader;
- Study 2 reproduced the pattern under a different grading protocol.

Interpretation: this is the strongest current cross-family capability-gap hypothesis because it survives a change in both causal family and oracle structure.

## What a third family should decide

A third unrelated HistoricalChangeTask should be selected before changing the generic method based on Studies 1/2. It should test whether:

1. diff access again improves investigation efficiency/localization;
2. E3 again raises cost without measured benefit;
3. the downstream discriminating-observable/reproducer gap recurs;
4. any Capability Lab intervention trained from Studies 1/2 transfers without same-case tuning.

Do not pool the two `n=1` ladders into pseudo-independent sample counts for statistical claims.