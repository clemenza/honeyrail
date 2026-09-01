# Roadmap

> HoneyRail is an open-source runtime and evaluation harness for long-horizon, verifiable engineering work. Its flagship near-term workload is AI Database Test Engineering: agents inspect real database systems, design and execute tests, collect evidence, and are evaluated by deterministic truth whenever possible.

> The database roadmap is PG-led: PostgreSQL defines the capabilities that matter; controllable Capability Lab tasks make those capabilities measurable and improvable.

This roadmap is directional, not a feature promise.

## Current shipped foundation

The following capabilities are present in HoneyRail today:

- **Execution runtime:** persisted `Run`/`Step` orchestration, atomic `Task` lifecycle, git worktree isolation, tmux-backed sessions, checks, commit, merge, discard, human approval.
- **Task and execution isolation:** worktree-per-task, container-based exam rooms, manifest-preflight integrity checks.
- **Artifacts/evidence/quality gates:** artifact and evidence contracts, deterministic evaluators, async/custom evaluator registry, `QualityGateDecision` records with operator override and rejection.
- **Agent adapters / DSH eval driver:** multi-agent support, trial sets, comparison reporting.
- **Transcript/trajectory/session telemetry:** streaming transcripts, turn-level tool-call capture, session metadata.
- **Tinytable mutation + grading integration:** mutation operators (Gen1 + Gen2), seed-root builder, `grade.py` scoring, differential adjudication.
- **Truth adjudication:** PostgreSQL differential oracle (`--pg-adjudicate`), SPEC-vs-implementation disagreement tracking.
- **Engine-access modes:** source-visible, bytecode (research/diagnostic), and real process-boundary oracle mode (`engineAccess=oracle`) via separate engine-service container.
- **Kill attribution:** discovery-channel classification (test-driven, code-review, bytecode-review, leak).
- **TrialDiagnosis v0:** deterministic probe-shape extraction, required-vs-observed comparison, diagnosis validity, scenario-local state handling, discriminating shapes for Gen2 operators.
- **PostgreSQL transaction/restart alpha:** deterministic PostgreSQL lifecycle/evidence plumbing over Docker or local binaries.
- **Explicit SQLite schema migrations and baseline CI** for typecheck, tests, and build.

Not every API above is stable/v1.

## Architecture: three validation layers

```text
Capability Lab
      ↓↑
Historical PostgreSQL
      ↓
PostgreSQL HEAD Frontier
```

- **Capability Lab** = controllability. Cheap, dense, repeatable experiments with full telemetry. tinytable is one provider; others may include PG microtasks, planner metamorphic tests, state-transition tasks, concurrency micro-models. Lab work exists to make a real capability gap measurable and optimizable.
- **Historical PostgreSQL** = real complexity + deterministic truth. Previously-fixed PostgreSQL bugs provide the bridge between synthetic evals and open-world bug finding. Real source, real subsystem interactions, deterministic hidden ground truth (pre-fix source, fix commit, canonical reproducer).
- **PostgreSQL HEAD Frontier** = final open-world credibility. Fresh PostgreSQL source, no known injected answer, fixed budget. Goal is validated novel defect discovery, not mutant kill rate.

## Milestones

### M0 — Eval Science Foundation — mostly shipped

Exam isolation, engine-access modes, truth adjudication, transcript/trajectory, kill attribution, precision/runtime telemetry, TrialDiagnosis v0, PostgreSQL transaction/restart alpha.

**Exit condition:** Synthetic trial results are trustworthy enough to use as diagnostic evidence. Remaining tinytable truth hygiene tracked in tinytable-evals#61.

### M1 — Historical PostgreSQL Discovery Foundation — current mainline

- Generic PostgreSQL research environment v0 ([#179](https://github.com/clemenza/honeyrail/issues/179))
- Historical PostgreSQL bug corpus v0 ([#178](https://github.com/clemenza/honeyrail/issues/178)), initially 3 bugs, then 5–10
- Source-visible agent workspace, hidden fix/truth, pre-fix materialization
- Deterministic buggy-vs-fixed verification
- No future git history / no answer-key access in default historical mode
- First end-to-end real-agent historical rediscovery trial

**Primary metric:** `Historical Bug Rediscovery Rate @ Budget`

### M2 — PG Discovery Observability

- First small pilot over historical PG tasks ([#180](https://github.com/clemenza/honeyrail/issues/180))
- Trajectory analysis across success + miss
- Empirical failure-stage taxonomy
- Only after data exists, define `DiscoveryDiagnosis v1`

### M3 — Capability Lab v1, PG-pulled

- Create synthetic/microbench tasks only for gaps observed in M1/M2
- Possible providers: tinytable, PG subsystem microtasks, planner/metamorphic tasks, state-transition tasks, deterministic concurrency micro-models
- Revive tinytable MVCC/WAL/planner/etc. only if PG evidence justifies the cost

### M4 — Self-Improve v1

- Real/synthetic diagnosed evidence → sanitized optimizer input → Candidate DiscoveryPolicy/HarnessProfile → Capability Lab check → unseen Historical PG → promote/reject/inconclusive
- [#177](https://github.com/clemenza/honeyrail/issues/177) is mechanics v0 only; Historical PG is the principal reality validation for v1

### M5 — Stateful / Systems PostgreSQL Discovery

- Multi-session → locking/deadlock → prepared plans/catalog invalidation → restart/recovery → VACUUM/freeze → replication/multi-node
- State exploration ([#176](https://github.com/clemenza/honeyrail/issues/176)) becomes implementation-heavy only when this layer produces a concrete need

### M6 — PostgreSQL HEAD Frontier

- Fresh PG source, fixed budget, source-guided exploration, unknown defects
- Reproducible evidence, minimization, regression test, report
- **Metric:** `Validated Novel Defect Yield @ Budget`

## Current priorities

### P0
- [#178](https://github.com/clemenza/honeyrail/issues/178) — Historical PG Corpus v0
- [#179](https://github.com/clemenza/honeyrail/issues/179) — PostgreSQL Research Environment v0
- tinytable-evals#61 — generated PG differential oracle (truth hygiene)

### P1
- [#177](https://github.com/clemenza/honeyrail/issues/177) — Self-Improve Mechanics v0
- [#180](https://github.com/clemenza/honeyrail/issues/180) — Historical PG Pilot v0

### P2
- [#172](https://github.com/clemenza/honeyrail/issues/172) — provider abstraction after provisional PG use
- [#176](https://github.com/clemenza/honeyrail/issues/176) — exploration contract
- tinytable no-defect/confidence work if capacity exists

### P3 / evidence-gated
- Large tinytable calibration/statistics work
- Compound mutants
- Planner-lite
- Toy MVCC/WAL/concurrency
- Large synthetic PG mutation pools

## Contract freeze rule

> Do not freeze `EvalTask`, `TruthBundle`, or `EvalProvider` from tinytable alone. Exercise provisional contracts on tinytable and at least three Historical PG tasks, then extract/freeze the common seam.

## Claim discipline

Tinytable can support:
- "profile B improved mutant discovery under oracle-mode behavioral testing"

Historical PG can support:
- "profile B improved rediscovery of unseen real PostgreSQL bugs"

PG HEAD is required for:
- "HoneyRail helps discover novel PostgreSQL defects"

Self-improvement claims require unseen tasks; TRAIN improvement never counts.

## What we are intentionally not doing now

- Full deterministic hypervisor
- Arbitrary-system model checking
- Mass tinytable feature expansion
- Large IRT/leaderboard infrastructure
- Large 48-run launch matrix for the old tinytable demo
- Distributed runners before single-node PG discovery is proven
- Multi-node PG systems work before single-node historical tasks establish the workflow

## Platform / Adoption (supporting work)

These support the flagship evaluation loop rather than driving the current technical milestone:

- Developer experience: one-line startup, quickstart hardening
- GitHub integration: publish evidence summaries and gate decisions as PR checks/comments
- Extension contracts: evaluator/evidence-producer stability for community adoption
- Distributed runners: after single-node runtime is proven at scale
- Additional agent backends via community-contributed adapters
- Richer integrations with code review, issue trackers, and CI systems

## v1.0

- Stable Recipe, Executor, and Evidence contracts.
- Documented migration policy for compatibility surfaces.
- Production-grade recovery and auditability expectations.
