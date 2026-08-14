# Roadmap

HoneyRail is an open-source runtime for long-horizon, verifiable engineering work. It does not build another coding agent; it harnesses mature coding agents and deterministic tooling inside a verifiable runtime.

This roadmap is directional, not a feature promise.

## v0.1 / M0: Foundation And Execution Runtime

- Preserve the Agent Gateway-derived execution/control-plane kernel.
- Keep `Task` as an atomic unit of agent execution, worktree isolation, session state, checks, commit, merge, and discard.
- Document the execution plane versus future orchestration plane boundary.
- Add explicit SQLite schema migrations.
- Add baseline CI for typecheck, tests, and build.
- Keep compatibility surfaces stable: `AGENT_GATEWAY_*`, `~/.agent-gateway`, REST routes, MCP tool names, SQLite state semantics, and tmux identifiers.

## v0.2 / M1: Orchestration Core

- Status: implemented as alpha.
- Additive `Run`, `Step`, and `Executor` concepts sit above the existing task/session/worktree primitives.
- DAG scheduling, dependency tracking, and restart/resume behavior are present.
- REST/MCP control surfaces exist for run creation, inspection, cancellation, approval, and rejection.
- Keep existing task execution semantics intact.

## v0.3 / M2: Evidence And Quality

- Status: implemented as alpha.
- Artifact and evidence contracts are present.
- Deterministic evaluators and async/custom evaluator registry support are present.
- Quality gates can block, pass, request approval, record operator override, or record operator rejection.
- Verification outputs are queryable across runs.
- Keep deterministic, inspectable evaluation separate from executor success.

## v0.4 / M3/M4: Environments And Database Testing Harness Alpha

- Status: PostgreSQL harness implemented as alpha; broader environment abstraction remains directional.
- Build repeatable execution contexts for more targets.
- Harden the PostgreSQL Database Testing Harness Alpha on top of orchestration, evidence, and quality gate primitives.
- Keep database-specific harness logic outside the M0 execution kernel.

## v0.5: Benchmarking And Agent Evaluation

- Compare agent backends across repeatable workflows.
- Track cost, latency, success rate, evidence quality, and recovery behavior.
- Support workflow-level evaluation instead of one-off prompt comparisons.

## Later

- SDKs for recipes, executors, and evidence producers.
- Distributed runners.
- Richer integrations with code review, issue trackers, and CI systems.
- Self-improvement loops based on evaluated workflow outcomes.

## v1.0

- Stable Recipe, Executor, and Evidence contracts.
- Documented migration policy for compatibility surfaces.
- Production-grade recovery and auditability expectations.
