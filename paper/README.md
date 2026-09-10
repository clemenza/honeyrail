# HoneyRail paper workspace

This directory is the working area for HoneyRail's first empirical paper on AI Database Test Engineering over historical PostgreSQL regressions.

## Current paper thesis

The paper studies whether realistic development context changes an AI test engineer's ability to investigate and rediscover real PostgreSQL correctness regressions. The primary intervention ladder is:

```text
E0: source + neutral task prompt
E1: E0 + contemporaneous requirement/SPEC
E2: E1 + introducing implementation change-set
E3: E2 + frozen generic Test-Engineer HarnessProfile
```

The current evidence base contains two preregistered real-agent pilots on unrelated causal families:

- `postgres-change-001` / PostgreSQL BUG #16867 — transaction chaining × SAVEPOINT; formal report merged in PR #220.
- `postgres-change-002` / PostgreSQL BUG #18574 — PL/pgSQL CALL cached-plan invalidation after DDL; formal report in PR #224.

The paper must preserve HoneyRail's evidence discipline: authoritative grader outcomes remain primary; trajectory analysis is diagnostic; no same-case tuning is presented as transfer; public historical cases are not claimed to be unseen by model pretraining.

## Directory map

- `outline.md` — paper structure and current narrative.
- `research-questions.md` — RQs and claim boundaries.
- `methodology.md` — task formulation, experimental controls, metrics, and process analysis.
- `threats-to-validity.md` — current validity threats and mitigations.
- `evidence-index.md` — claim-to-evidence traceability map.
- `artifact-plan.md` — custodial raw evidence vs public research artifact policy.
- `results/` — study-specific evidence summaries; these are not substitutes for the canonical experiment reports under `docs/experiments/`.

## Rules for this workspace

1. Do not copy raw runtime directories into Git.
2. Do not include credentials, local private paths, grader-private oracle content, canonical hidden reproducers, or private telemetry.
3. Every empirical statement must be traceable through `evidence-index.md` to a preregistered experiment and retained evidence.
4. Distinguish observed facts from interpretation.
5. Keep exploratory/post-hoc diagnostics explicitly separate from preregistered primary endpoints.
6. Do not write a reliability, statistical-significance, or model-ranking claim from the current `n=1`-per-cell pilots.
7. Treat task families used for analysis or tuning as development-exposed thereafter.

## Current status

Paper stage: **Draft v0 / evidence-backed structure**.

The Introduction, task formulation, methodology, Study 1, Study 2, cross-family analysis, and threats-to-validity sections can now be drafted. Stronger generalized empirical claims should wait for at least one additional unrelated historical family and a separately preregistered confirmation design.