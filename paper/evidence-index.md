# Evidence index

This file maps paper claims to reviewed repository evidence. It is a traceability index, not a substitute for experiment manifests or retained raw artifacts.

## Evidence hierarchy

Prefer evidence in this order:
1. frozen experiment manifest and per-attempt manifests;
2. authoritative grader/result artifacts;
3. sanitized reviewed experiment report;
4. preregistration issue/comments;
5. implementation PR/task tests;
6. operator interpretation.

## Study 1 — postgres-change-001 / BUG #16867

| Claim/evidence | Canonical source | Status |
|---|---|---|
| HistoricalChangeTask implementation and isolation surface | #212 / PR #213 | merged |
| Restricted-egress real-model scored path | PR #217 | merged |
| Experiment-level immutable manifest | PR #219 | merged |
| Preregistered constants | #216 locked-constants comment | complete |
| Four E0–E3 formal cells completed | PR #220 experiment report | complete |
| One E2 infrastructure failure retained and linked to retry | PR #220 | complete |
| E0/E1/E2/E3 authoritative outcome | PR #220 | 4/4 miss |
| E1→E2 investigation-cost reduction | PR #220 | exploratory `n=1` finding |
| E2→E3 cost increase without measured capability gain | PR #220 | exploratory `n=1` finding |
| Downstream discriminating-observable/reproducer gap | PR #220 | diagnostic finding |
| Derived trajectory shell-command exit-code limitation | #218 | open/non-blocking |

Raw custodian reference:
`output/historical-pg-212/exp216-e0e3-dsh-2026-09-09/`

## Study 2 — postgres-change-002 / BUG #18574

| Claim/evidence | Canonical source | Status |
|---|---|---|
| Selection as unrelated causal family | #211 / #221 | complete |
| HistoricalChangeTask implementation | #221 / PR #223 | merged |
| Historical/reference revision validation | PR #223 | complete |
| 10/10 semantic oracle attribution per revision | PR #223 | complete |
| E3 HarnessProfile byte-identical to Study 1 | PR #223 tests | complete |
| Contemporaneous-only SPEC provenance | PR #223 | complete |
| Preregistered constants | #222 locked-constants comment | complete |
| Four E0–E3 formal cells completed | PR #224 | complete (merged) |
| E0/E1/E2/E3 authoritative outcome | PR #224 | 4/4 miss |
| E1→E2 efficiency improvement | PR #224 | exploratory `n=1` finding |
| E1→E2 localization shifts to actual fixed function | PR #224 | exploratory `n=1` finding |
| E2→E3 cost increase without measured capability gain | PR #224 | exploratory `n=1` finding |
| Repeated self-asserting reproducer/output-shape gap | PR #224 | transfer diagnostic finding |

Raw custodian reference:
`output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/`

## Study 3 — postgres-historical-003 / BUG #18118 (within-family sibling replication)

Sibling defect in Study 1's own causal family (both trace to introducing commit `280a408b48d5ee42969f981bceb9e9426c3a344c`). Not an independent cross-family observation — see `results/study-003.md` and `results/cross-family.md`'s addendum.

| Claim/evidence | Canonical source | Status |
|---|---|---|
| Selection as within-family sibling (not independent third family) | #233 registration | complete |
| E0-E3 scaffolding compatibility fix for the frozen Corpus v0 task | #234 / PR #235 | merged |
| `changeContext.allowHistoricalSourceDivergence` (shown diff ≠ scored source revision) | PR #235 | merged |
| Preregistered constants | #233 locked-constants comment | complete |
| Four E0–E3 formal cells completed | PR #236 | complete (merged) |
| E0/E1/E2/E3 authoritative outcome | PR #236 | 4/4 miss |
| Zero infrastructure retries | PR #236 | complete |
| E1 SPEC / E3 HarnessProfile byte-identical to Study 1 | PR #236 | complete |
| SPEC-alone (E1) reaches precise sibling-mechanism diagnosis; cost direction reversed vs. Study 1's E0→E1 | PR #236 | exploratory `n=1` finding |
| E1→E2 shows no distinguishable localization gain and increased cost (opposite of Study 1) | PR #236 | exploratory `n=1` finding |
| E2→E3 cost increase without measured capability gain (same direction as Studies 1/2) | PR #236 | exploratory `n=1` finding |
| Self-asserting reproducer/output-shape gap recurs a third time, first within-family recurrence | PR #236 | diagnostic finding |
| Narrowly scoped Capability Lab issue opened from the 3x-recurring reproducer-construction gap | #237 | open, TRAIN evidence only |

Raw custodian reference:
`output/historical-pg-199/exp233-e0e3-dsh-2026-09-11/`

## Cross-family claims

Studies 1 and 2 only. Study 3 is excluded here by design (see above) — its evidence is indexed separately, not pooled into these rows.

| Candidate paper claim | Supporting evidence | Current strength |
|---|---|---|
| SPEC alone showed no measured benefit and increased observed cost | #220 + #224, E0→E1 | repeated direction across 2 families; exploratory |
| Introducing diff focused investigation and reduced cost | #220 + #224, E1→E2 | repeated direction across 2 families; exploratory transfer evidence |
| Introducing diff improved root-cause localization | #224 E1→E2 | one-family observation; needs third-family confirmation |
| Frozen generic HarnessProfile increased cost without measured gain | #220 + #224, E2→E3 | repeated direction across 2 families; exploratory transfer evidence |
| Downstream observable/reproducer construction is a recurring capability gap | #220 + #224 (+ #236 within-family) | repeated across 2 unrelated families, 2 grading protocols, and 1 within-family replicate (3 recurrences total); strongest current diagnostic finding |
| HoneyRail improves historical bug rediscovery | none | **not supported** |
| DeepSeek-v4-flash historical PostgreSQL rediscovery reliability | current pilots `n=1`/cell | **not supported** |
| Findings generalize across models | none | **not supported** |

## Future evidence needed

Before stronger submission-level empirical claims:
- a genuinely unrelated third causal family (#232) — Study 3 is a within-family sibling replication and does not satisfy this;
- predeclared decision on whether model/backend remains fixed;
- no Study-1/2/3 exact-case tuning before unseen-family validation;
- separately preregistered repeated-trial design if claiming reliability/improvement;
- public sanitized research artifact with verification hashes and scripts.

When a result changes during PR review, update this index only after the canonical experiment report is updated; never alter historical raw evidence.