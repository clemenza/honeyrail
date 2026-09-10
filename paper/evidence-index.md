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
| Four E0–E3 formal cells completed | PR #224 | formal report complete; PR review/merge pending |
| E0/E1/E2/E3 authoritative outcome | PR #224 | 4/4 miss |
| E1→E2 efficiency improvement | PR #224 | exploratory `n=1` finding |
| E1→E2 localization shifts to actual fixed function | PR #224 | exploratory `n=1` finding |
| E2→E3 cost increase without measured capability gain | PR #224 | exploratory `n=1` finding |
| Repeated self-asserting reproducer/output-shape gap | PR #224 | transfer diagnostic finding |

Raw custodian reference:
`output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/`

## Cross-family claims

| Candidate paper claim | Supporting evidence | Current strength |
|---|---|---|
| SPEC alone showed no measured benefit and increased observed cost | #220 + #224, E0→E1 | repeated direction across 2 families; exploratory |
| Introducing diff focused investigation and reduced cost | #220 + #224, E1→E2 | repeated direction across 2 families; exploratory transfer evidence |
| Introducing diff improved root-cause localization | #224 E1→E2 | one-family observation; needs third-family confirmation |
| Frozen generic HarnessProfile increased cost without measured gain | #220 + #224, E2→E3 | repeated direction across 2 families; exploratory transfer evidence |
| Downstream observable/reproducer construction is a recurring capability gap | #220 + #224 | repeated across 2 unrelated families and 2 grading protocols; strongest current diagnostic finding |
| HoneyRail improves historical bug rediscovery | none | **not supported** |
| DeepSeek-v4-flash historical PostgreSQL rediscovery reliability | current pilots `n=1`/cell | **not supported** |
| Findings generalize across models | none | **not supported** |

## Future evidence needed

Before stronger submission-level empirical claims:
- third unrelated HistoricalChangeTask;
- predeclared decision on whether model/backend remains fixed;
- no Study-1/2 exact-case tuning before unseen-family validation;
- separately preregistered repeated-trial design if claiming reliability/improvement;
- public sanitized research artifact with verification hashes and scripts.

When a result changes during PR review, update this index only after the canonical experiment report is updated; never alter historical raw evidence.