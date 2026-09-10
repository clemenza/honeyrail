# Study 1 — postgres-change-001 / PostgreSQL BUG #16867

Canonical experiment report: PR #220.

## Purpose

Evaluate E0–E3 context scaffolding on a historical PostgreSQL transaction-chaining correctness regression.

Causal family:
`transaction-chaining-savepoint-state-machine`

Primary endpoint:
authoritative HoneyRail grader outcome under `submitted-reproducer-structured-oracle-v1`.

## Formal matrix

| Condition | Official result | Agent duration | Steps | Decode tokens |
|---|---:|---:|---:|---:|
| E0 | miss | 597.9s | 94 | 23,963 |
| E1 | miss | 646.7s | 172 | 63,898 |
| E2 | miss | 172.0s | 37 | 7,831 |
| E3 | miss | 297.4s | 33 | 27,756 |

One additional E2 raw attempt ended in an infrastructure interruption before scored completion. It is retained separately and is not counted as an agent miss. The linked retry produced the formal E2 result above.

## Observed process pattern

All four conditions localized the investigation to the relevant transaction-chaining/state-machine neighborhood. E2 reached essentially the same root-cause area with much lower exploration cost than E1.

No condition converted the diagnosis into an authoritative rediscovery. The downstream failure involved incomplete construction of a minimal revision-discriminating, grader-legible reproducer/observable; report details distinguish output-shape mismatch from additional reproducer-design limitations rather than reducing the miss to a single formatting cause.

## Interpretation allowed in paper

- E1 did not improve verified rediscovery and increased observed exploration/cost relative to E0.
- E2 materially reduced observed steps, wall time, and decode tokens relative to E1 while reaching the same root-cause neighborhood.
- E3 showed no measured capability gain over E2 and increased wall/decode-token cost.
- Strong source/root-cause localization did not imply verified bug rediscovery.

## Interpretation not allowed

- E2 causally improves PostgreSQL bug rediscovery.
- E3 is generally harmful.
- the oracle alone caused all misses.
- this task provides independent transfer after its trajectory has informed methodology changes.

## Evidence status

- preregistered: yes;
- restricted egress/scored eligibility: verified;
- independent sessions: yes;
- raw attempt ledger retained: yes;
- sanitized formal report merged: yes;
- `n=1` per condition: exploratory only.