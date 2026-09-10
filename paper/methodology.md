# Methodology draft

## Evaluation object

HoneyRail evaluates an AI Database Test Engineer against a real historical PostgreSQL change rather than a synthetic mutation alone.

A `HistoricalChangeTask` consists of:

```text
historical post-change PostgreSQL source/runtime
+ neutral testing prompt
+ optional contemporaneous requirement context
+ optional full introducing change-set
+ optional frozen generic test methodology
```

The scored agent must investigate the provided local system and submit a finding plus executable reproducer. Future bug reports, fixes, canonical reproducers, reference source, and grader-private oracle material remain unavailable during formal execution.

## Conditions

The current intervention ladder is cumulative:

- **E0** — source + neutral task prompt.
- **E1** — E0 + contemporaneous requirement/SPEC.
- **E2** — E1 + complete introducing implementation diff.
- **E3** — E2 + frozen generic Test-Engineer HarnessProfile.

The SPEC is constructed only from material available at or before the introducing change. The introducing diff is complete rather than hindsight-narrowed to the eventual defect. The E3 HarnessProfile is generic and must not encode lessons derived from the exact evaluation case before an unrelated-family transfer test.

## Historical/reference truth model

Each task binds:
- a historically justified buggy/introduction-side revision;
- a corrected reference revision;
- deterministic non-LLM grading logic;
- canonical operator-side validation material proving that the task is well-posed.

The authoritative rediscovery verdict comes from running the agent-authored reproducer under the task's existing historical/reference oracle contract. Agent narrative confidence, source localization, or manual plausibility never overrides the grader result.

## Experimental governance

Formal studies follow `docs/evaluation-protocol.md` and require:

1. preregistration before inspecting scored results;
2. exact task, repository, model/backend, image, environment, budget, execution-order, and retry identities;
3. one independent session/environment per condition;
4. restricted model egress with authoritative scored eligibility;
5. immutable per-condition materialization hashes;
6. retention of every started formal attempt, including retries and infrastructure failures;
7. no mid-experiment prompt/profile/grader changes;
8. explicit separation between engineering smoke, formal evaluation, TRAIN/debug reruns, and unseen-family transfer.

## Outcomes and denominators

Preserve the runner's authoritative classifications:

```text
rediscovered
miss
invalid_submission
blocked
infrastructure_error
integrity_error
unscored
```

Report at minimum:

- **Formal Attempts (A)** — all started preregistered formal attempts, including retained failed/retry attempts.
- **Eligible Attempts (E)** — attempts accepted by the harness's authoritative eligibility mechanism.
- **Valid Discoveries (D)** — eligible attempts with official `rediscovered` result.
- **End-to-End Budget Success** — `D / A`.
- **Eligible Sample Rate** — `E / A`.
- **Conditional Historical Bug Rediscovery** — `D / E`.

Infrastructure and integrity failures are not agent misses. Invalid submissions are not silently converted to misses. A valid miss is not rerun simply to obtain a successful example.

## Process-level analysis

The primary endpoint remains binary/authoritative grading. To explain failures and context effects, trajectories are analyzed using this staged capability chain:

```text
1. requirement/change understanding
2. source/change-impact localization
3. correctness-invariant formulation
4. hypothesis generation
5. discriminating-observable selection
6. historical/reference differential experiment design
7. reproducer construction and minimization
8. machine-checkable submission encoding
```

Stage evidence must be grounded in retained transcript/tool/file/command artifacts. Narrative plausibility alone does not award credit. Post-hoc diagnostics are marked exploratory and never change the official grade.

## Current study design

### Study 1 — `postgres-change-001`

- PostgreSQL BUG #16867.
- Causal family: transaction chaining × SAVEPOINT / transaction state machine.
- Four E0–E3 formal cells, `n=1` per condition.
- Same model/backend/runtime across all cells.
- Formal report: PR #220.

### Study 2 — `postgres-change-002`

- PostgreSQL BUG #18574.
- Causal family: PL/pgSQL CALL cached-plan invalidation after DDL.
- Four E0–E3 formal cells, `n=1` per condition.
- Same model/backend/runtime and byte-identical E3 HarnessProfile as Study 1.
- Formal report: PR #224.

The second study is an unrelated-family transfer validation. No Study-1-specific prompt/profile tuning is applied before Study 2.

## Claim discipline

The two current pilots support descriptive and transfer-oriented observations, not statistical reliability claims. Generalized improvement claims require additional unrelated families and separately preregistered repeated trials with uncertainty treatment that respects clustering by task/family.

Public historical bugs may have appeared in model pretraining. HoneyRail's isolation controls establish runtime answer isolation and development-process exposure discipline, not guaranteed model-pretraining novelty.