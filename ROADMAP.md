# Roadmap

HoneyRail is an open-source runtime for long-horizon, verifiable engineering work. It does not build another coding agent; it harnesses mature coding agents and deterministic tooling inside a verifiable runtime.

The long-term direction: every capability converges on evidence-driven improvement — first of engineering work itself, then of the agent harnesses that perform it.

This roadmap is directional, not a feature promise.

## Shipped: v0.1 (M0–M2 + PostgreSQL Harness Alpha)

- Execution runtime: atomic `Task` lifecycle, git worktree isolation, tmux-backed sessions, checks, commit, merge, discard, human approval.
- Orchestration core (alpha): persisted `Run` / `Step` DAGs, `agent-task` / `shell` / `check` / `approval` executors, restart reconciliation, REST/MCP control surfaces.
- Evidence and quality (alpha): artifact and evidence contracts, deterministic evaluators, async/custom evaluator registry, `QualityGateDecision` records with operator override and rejection.
- PostgreSQL Database Testing Harness Alpha: Docker or local-binary transaction/restart validation with artifacts, evidence, evaluation, gating, and a final report.
- Explicit SQLite schema migrations and baseline CI for typecheck, tests, and build.

## v0.2: Adoption And Developer Experience

Goal: make the shipped runtime usable by people outside the core team. No new concepts; driven by post-launch feedback.

- Built-in recipe templates: named, reusable workflow definitions (for example implement → check → gate → approve, and migration-safety verification) selectable from the UI and API, so operators do not hand-write DAG JSON.
- One-line startup path (for example `npx honeyrail`) alongside the clone-based flow.
- Rename compatibility surfaces from `AGENT_GATEWAY_*` / `~/.agent-gateway` to `HONEYRAIL_*` equivalents with an automatic, documented migration. This is the last low-cost window for the rename.
- Platform documentation: macOS/Linux support, Windows via WSL.
- Quickstart hardening based on real first-run reports.

## v0.3: Goal-To-DAG And GitHub Integration

Goal: close the gap between "give it an engineering goal" and "hand-write a DAG".

- Agent-generated DAG drafts from a plain-language goal, always confirmed by a human before execution. Template selection plus parameter filling is an acceptable first implementation.
- GitHub integration: publish evidence summaries and `QualityGateDecision` outcomes as pull request checks and comments, so verification results appear where teams already review code.
- Freeze the evaluator and evidence-producer extension contracts ahead of the rest of the API surface. Community extension happens at these points first; they need stability before anyone builds on them.

## v0.4: Eval Infrastructure And Execution Environments

Goal: turn single verified runs into measurable, repeatable evaluation. Prerequisite for everything after it.

- `HarnessProfile`: a versioned, hashable agent configuration package — backend, injected instruction files (for example `CLAUDE.md` / `AGENTS.md`), MCP configuration, launch flags — injectable through the existing agent adapters.
- `EvalSuite`: curated task sets, each task pairing a prompt and repository fixture with deterministic checks, evaluators, and a gate policy, executed in isolated worktrees.
- `TrialSet`: N-trial execution of a (profile, task) pair with aggregated metrics — gate pass rate, cost, wall time, human interventions — and a comparison report artifact.
- Cost and usage capture in agent adapters.
- Sandboxed execution option (Docker/devcontainer) for agent steps, as an opt-in alternative to host tmux execution.
- Deepen the PostgreSQL harness as a first-class eval workload: migration testing against schema snapshots, rollback verification, constraint and index regressions. A second database target waits until the PostgreSQL abstraction is proven.

## v0.5: Benchmarking

Goal: credible, repeatable comparison of agent harnesses on real workflows.

- A/B comparison of `HarnessProfile`s over shared `EvalSuite`s with paired trials and explicit statistical treatment of agent nondeterminism.
- Run-level budget caps, smoke modes, and early stopping to keep eval cost bounded.
- Track cost, latency, success rate, evidence quality, and recovery behavior at the workflow level, not per-prompt.
- Publish reproducible public benchmark results built on this infrastructure.

## v0.6: Harness Improvement Loop

Goal: the flagship capability — HoneyRail improves an agent harness using its own evidence, under the same gates it applies to code.

- An optimizer step (itself an ordinary `agent-task`) reads failure evidence from baseline trials and proposes a diff to a `HarnessProfile`.
- Candidate profiles are re-evaluated, compared against baseline with paired statistics, and gated: improvements below the noise band fail, cost regressions fail.
- Holdout task sets guard against overfitting the eval suite; adoption requires passing the holdout gate.
- Human approval is required to adopt a new profile version. Every adoption is a recorded, auditable decision.

## Later

- Distributed runners, once the single-node runtime is proven at scale.
- Additional database and environment targets for the testing harness.
- SDKs for recipes, executors, and evidence producers, abstracted from the built-in templates once real usage exists.
- Additional agent backends via community-contributed adapters, supported by an adapter authoring guide rather than first-party integrations.
- Richer integrations with code review, issue trackers, and CI systems.

## v1.0

- Stable Recipe, Executor, and Evidence contracts.
- Documented migration policy for compatibility surfaces.
- Production-grade recovery and auditability expectations.
