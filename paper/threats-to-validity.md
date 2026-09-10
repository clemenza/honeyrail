# Threats to validity

This document is intentionally conservative. It should shrink only when new evidence directly addresses a threat.

## Internal validity

### Small sample size

The current two studies use `n=1` per E0–E3 condition. They support trajectory/process observations and cross-family directional replication, not statistical significance or reliability estimates.

Mitigation: treat current studies as exploratory pilots; preregister repeated trials separately before inspecting confirmation outcomes.

### Fixed execution order

Both current ladders execute E0 → E1 → E2 → E3. Independent sessions prevent conversational/state carryover, but fixed ordering can still confound operational/time effects.

Mitigation: record exact order; consider randomized or counterbalanced order in a later repeated-trial design.

### Model/backend identity

Both studies use the same DeepSeek/DSH configuration. Findings about context/profile effects may be specific to this model, agent implementation, inference behavior, or budget.

Mitigation: scope current claims explicitly; introduce controlled backend/model comparison only as a separately preregistered study.

### Budget enforcement

Wall-clock timeout is enforced, while token/tool budgets on the current path are observed rather than enforced. Different conditions can therefore consume different token/tool amounts.

Mitigation: report observed cost alongside outcomes; do not compare unequal resource consumption as if the budget dimensions were fully controlled.

## Construct validity

### Rediscovery oracle strictness

A grader-valid rediscovery is narrower than plausible diagnosis. This is intentional for reproducible attribution, but an oracle can under-credit useful investigation if the agent expresses a finding in a non-grader-legible form.

Mitigation: keep authoritative grade primary; separately report process-stage evidence; validate task/oracle determinism and historical/reference attribution; never silently promote near-hits.

### Reproducer-output representation

Both studies reveal self-asserting or otherwise poorly exposed observables. This may represent an agent testing-capability gap, an interface-contract mismatch, or both.

Mitigation: replication across two unrelated families and two grading protocols reduces the likelihood that the pattern is unique to one oracle, but a third unseen family is required before stronger generalization.

### Stage-wise trajectory coding

Process-stage interpretation can be subjective.

Mitigation: ground every stage assessment in concrete transcript/tool/file/command evidence; retain source artifacts; use explicit coding rules before larger studies; consider independent second-pass review for final paper data.

## External validity

### PostgreSQL-only evidence

The paper currently studies PostgreSQL correctness regressions. Results do not establish behavior on other DBMSs or general software engineering tasks.

### Historical bugs vs novel bugs

Historical rediscovery is a controlled proxy for real testing work, not proof that HoneyRail helps discover novel PostgreSQL HEAD defects.

### Task selection

The two studies are deliberately selected historical bugs with trustworthy introducing changes, deterministic oracles, and suitable local reproduction. They may not represent the full distribution of PostgreSQL defects.

Mitigation: document selection criteria and rejected candidates; expand by causal family rather than selecting only cases favorable to the current method.

## Contamination and exposure validity

### Public historical bug pretraining exposure

Runtime isolation does not prove that a public historical PostgreSQL bug was absent from model pretraining.

Mitigation: never call these cases pristine model holdouts; distinguish runtime answer isolation from unknown pretraining exposure.

### Development-process contamination

Once a task trajectory informs prompt/profile/methodology changes, the task/family becomes development-exposed.

Mitigation: retain original results, mark exposure history, and evaluate interventions on unrelated unseen development-process families.

### Hindsight leakage through task construction

A SPEC or narrowed diff could accidentally encode future bug knowledge.

Mitigation: contemporaneous-only SPEC provenance; complete introducing diff; leakage tests; separate future truth/fix/reproducer from agent-visible task material.

## Reproducibility threats

### Local container/image availability

A recorded image digest establishes identity but not necessarily retrievability by reviewers.

Mitigation: publish retrievable immutable images or reproducible Dockerfiles with pinned base-image identities for the final artifact.

### Raw artifact retention

Operator-held raw directories contain large derivable build products and potentially private material, so they are not directly suitable as a public artifact.

Mitigation: freeze immutable L0 archives; generate a deterministic sanitized L1 evidence pack; publish exact hashes and verification scripts.

### Derived trajectory exit codes

Issue #218 records missing `exit_code` values for derived shell-command trajectory events in Study 1. The authoritative transcript remains available.

Mitigation: fix the derivation where possible or document the limitation and source-of-truth hierarchy explicitly in the released artifact.