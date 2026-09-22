# Cross-family comparison

This page records only the current two-study *cross-family* comparison (Study 1 vs. Study 2). It is not a statistical aggregate.

Study 3 (`postgres-historical-003`, `results/study-003.md`) is deliberately excluded from the table and RQ sections below: it is a within-family sibling replication of Study 1, not an independent causal family. It is discussed separately, in its own addendum at the bottom of this page.

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

## Study 3 addendum — within-family sibling replication (not a third cross-family row)

`postgres-historical-003` / BUG #18118 (`results/study-003.md`, PR #236) is a sibling defect in Study 1's own causal family, both tracing to introducing commit `280a408b48d5ee42969f981bceb9e9426c3a344c`. It must never be pooled with Study 2 as a second independent cross-family observation, and the "Subjects"/RQ1–RQ4 sections above stay unchanged by it.

What it adds, read only against Study 1:

- **RQ1 (SPEC-only context) — direction reversed within-family.** Study 1's E1 cost more than E0 with no outcome/localization change. Study 3's E1 cost *less* than E0 (34 vs. 51 steps) while *also* reaching a more precise mechanism-level diagnosis than E0 — a single-trajectory reversal, not a contradiction, since both remain `n=1`.
- **RQ2 (Introducing diff) — no distinguishable additional effect here.** Study 1's E2 was a clear efficiency gain over E1. In Study 3, E1 (SPEC only, no diff) already reached the same precise mechanism E2/E3 later confirmed, so E2 shows no distinguishable localization gain over E1 and costs more (50 vs. 34 steps) — consistent with SPEC alone having already captured most of the value diff access provided in Study 1, on this specific sibling defect.
- **RQ3 (HarnessProfile) — direction replicated, larger magnitude.** E3 again increased cost over E2 with no measured outcome/diagnosis gain (steps +52%, wall time +76%, decode tokens +88%), the same direction as Study 1 and Study 2, here at the largest relative magnitude of the three studies.
- **RQ4 (downstream reproducer gap) — recurs a third time, now within-family.** The self-asserting-reproducer/grader-legible-observable gap recurred at every level, under the same structured-oracle protocol Study 1 used. This is now the strongest evidence in the program that the gap is a general reproducer-authoring habit rather than an artifact of one task, family, or oracle: it has recurred across two unrelated families (Study 1 → Study 2) *and* within a family (Study 1 → Study 3).

What a genuinely unrelated third family (#232) must still decide, because Study 3 cannot: whether Study 3's reversed RQ1/RQ2 cost-direction findings are family-specific (this sibling defect's SPEC already contains enough structural detail to localize it) or would recur outside the transaction-chaining family; whether the RQ4 reproducer-construction gap — now evidenced across two families and one within-family replicate — justifies the narrowly scoped Capability Lab issue (#237) without same-case tuning.
