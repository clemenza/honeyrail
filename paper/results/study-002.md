# Study 2 — postgres-change-002 / PostgreSQL BUG #18574

Canonical experiment report: PR #224 (formal report complete; merge/review status should be checked before treating the report text as final).

## Purpose

Evaluate whether the frozen change-oriented method transfers to an unrelated PostgreSQL causal family without incorporating Study-1-specific prompt/profile tuning.

Causal family:
`plpgsql-call-cached-plan-invalidation`

Primary endpoint:
authoritative HoneyRail grader outcome under `submitted-reproducer-behavioral-oracle-v1`.

## Formal matrix

| Condition | Official result | Agent duration | Steps | Decode tokens |
|---|---:|---:|---:|---:|
| E0 | miss | 313.5s | 74 | 10,187 |
| E1 | miss | 460.6s | 95 | 23,493 |
| E2 | miss | 237.0s | 47 | 14,697 |
| E3 | miss | 314.2s | 48 | 27,009 |

All four attempts completed on the first try, were `scoredEligible: true`, and used verified restricted egress.

## Observed process pattern

E0 and E1 converged on an adjacent non-target defect in the same broad subsystem. E2, after receiving the introducing diff, shifted localization to `make_callstmt_target()` in `pl_exec.c`, the function modified by the historical fix, while also reducing steps and wall time relative to E1.

Despite improved localization, all conditions remained authoritative misses. Each produced a self-asserting reproducer that consumed the relevant pass/fail distinction internally through PL/pgSQL control flow (`DO` blocks and `RAISE` behavior) rather than exposing the historical/reference distinction as a raw grader-legible observation.

This downstream pattern is directionally consistent with Study 1 despite the unrelated causal family and different grading protocol.

## Interpretation allowed in paper

- E1 did not improve verified rediscovery or localization relative to E0 and increased observed cost.
- E2 reduced observed exploration cost and qualitatively improved target localization relative to E1.
- E3 showed no measured capability gain over E2 and increased wall/decode-token cost.
- The observable/reproducer-output-shape gap recurred under a second grading protocol and unrelated bug family.

## Interpretation not allowed

- E2 is proven to improve rediscovery rate.
- the repeated pattern establishes a population-level capability law.
- the model had no prior knowledge of BUG #18574 from pretraining.
- Study 2 can be used as unseen transfer after its trajectory has informed methodology changes.

## Evidence status

- unrelated-family transfer: yes;
- preregistered before scored execution: yes;
- E3 HarnessProfile byte-identical to Study 1: yes;
- task/oracle deterministic preflight: 10/10 semantic historical/reference attribution per revision;
- formal cells completed: 4/4;
- infrastructure retries: 0;
- `n=1` per condition: exploratory only.