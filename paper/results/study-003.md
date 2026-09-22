# Study 3 — postgres-historical-003 / PostgreSQL BUG #18118

Canonical experiment report: PR #236.

## Purpose

Evaluate whether the E0–E3 context-scaffolding effects observed in Study 1 replicate on a sibling defect within the same causal family, using the already-frozen Corpus v0 Task 003 source/oracle (#199/#201), before investing in a genuinely unrelated third family (#232).

**This is a within-family sibling-defect replication, not a second independent cross-family transfer result.** BUG #18118 and Study 1's BUG #16867 are sibling defects in the same broader transaction-chaining feature family, both tracing to introducing commit `280a408b48d5ee42969f981bceb9e9426c3a344c`. Do not read this study as a second entry in the cross-family comparison alongside Study 2 — see `results/cross-family.md`'s addendum.

Causal family:
`transaction-chaining-savepoint-state-machine` (same family as Study 1)

Primary endpoint:
authoritative HoneyRail grader outcome under `submitted-reproducer-structured-oracle-v1` (Task 003's own pre-existing, already-validated oracle — unaffected by scaffolding level).

## Formal matrix

| Condition | Official result | Agent duration | Steps | Decode tokens |
|---|---:|---:|---:|---:|
| E0 | miss | 316.6s | 51 | 12,076 |
| E1 | miss | 183.6s | 34 | 11,999 |
| E2 | miss | 280.5s | 50 | 12,759 |
| E3 | miss | 495.0s | 76 | 24,006 |

All four attempts completed on the first try, were `scoredEligible: true`, and used verified restricted egress. Zero infrastructure retries — a cleaner run than Study 1's (one retained E2 infrastructure failure + linked retry) and matching Study 2's own clean run.

## Observed process pattern

E1, E2, and E3 (all of which had SPEC access) independently converged on essentially the same mechanism Study 1's own trajectories found for its sibling defect: a `TBLOCK_SUBCOMMIT` chain-flag/characteristics-save mismatch in `CommitTransactionCommand()`. Notably, SPEC access alone (E1) already reached this precise mechanism-level diagnosis without the introducing diff — a materially different pattern from both prior studies, where diff access (E2) was needed for either the efficiency gain (Study 1) or the localization-quality gain (Study 2). E0 (no SPEC, no diff) reached a real, adjacent defect in the same general subsystem but not the precise savepoint/subtransaction mechanism.

Cost direction also reversed relative to Study 1: here E1 cost *less* than E0 (34 vs. 51 steps, 183.6s vs. 316.6s), while E2 cost *more* than E1 (50 vs. 34 steps) — the opposite of Study 1's own E0→E1 increase and E1→E2 reduction. E3 again increased cost sharply over E2 (76 vs. 50 steps, +76% wall time, +88% decode tokens) without a measured diagnosis or outcome change, replicating the E2→E3 cost-without-benefit direction from both prior studies at a larger relative magnitude.

The self-asserting-reproducer/output-shape gap recurred at every level, structurally the same downstream gap Studies 1 and 2 both found — now observed a third time, this time as a within-family recurrence under the same grading protocol Study 1 used.

## Interpretation allowed in paper

- SPEC access alone reached the precise sibling-mechanism diagnosis in this single run, and cost *less* than the no-SPEC condition — opposite in cost direction from Study 1's own E0→E1, though the authoritative outcome was unchanged in both.
- Diff access (E2) did not show a distinguishable localization improvement over E1 here and cost *more* than E1 — the opposite of Study 1's own E1→E2 efficiency gain.
- E3 again increased wall time and decode tokens relative to E2, with no measured outcome or diagnosis gain, replicating the E2→E3 pattern seen in both prior studies.
- The observable/reproducer-output-shape gap recurred a third time, now including a within-family recurrence, strengthening the case that it is a general reproducer-authoring habit rather than an artifact of one causal family or grading protocol.
- The diagnosis content independently reconstructed in E1/E2/E3 closely matches Study 1's own trajectory-derived mechanism description, consistent with expected within-family replication.

## Interpretation not allowed

- this is a second independent cross-family transfer observation (Study 2 remains the only one in this program).
- the reversed E0→E1/E1→E2 cost-direction pattern here contradicts or supersedes Study 1's own single-trajectory result — both are single-run observations.
- diff access has no value for this causal family.
- the model had no prior pretraining exposure to BUG #18118 or the shared `280a408b` commit (2019, well-documented upstream).
- this study substitutes for #232's separately planned genuinely-unrelated third family.

## Evidence status

- within-family sibling replication, not cross-family transfer: yes;
- preregistered before scored execution: yes;
- frozen #199/#201 Task 003 source/oracle unchanged (scaffolding added via new optional parameters only): yes;
- E1 SPEC and E3 HarnessProfile byte-identical to Study 1: yes;
- formal cells completed: 4/4;
- infrastructure retries: 0;
- `n=1` per condition: exploratory only.
