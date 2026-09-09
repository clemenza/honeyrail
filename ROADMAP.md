# Roadmap

> HoneyRail is an open-source evaluation and research platform for AI Database Test Engineering. Its execution runtime supports controlled database testing, evidence collection and deterministic evaluation. Historical PostgreSQL is the current mainline.

> The database roadmap is PG-led: PostgreSQL defines the capabilities that matter; controllable Capability Lab tasks make those capabilities measurable and improvable.

This roadmap is directional, not a feature promise. Milestones advance on evidence, not elapsed time or issue counts. The [evaluation protocol](docs/evaluation-protocol.md) defines acceptance, reporting and claim rules; its implementation-status table distinguishes reviewer requirements from automated enforcement. M0–M6 below name the current evaluation roadmap, not the older orchestration/verification milestones used in historical design documents.

## Current evidence status

Snapshot: **2026-09-09**, reviewed against `main` at `d9f88bc` and the linked issue/PR records. This is a dated evidence assessment, not a live issue dashboard. Missing empirical evidence means the claim is unestablished by these records; it does not prove no private experiment exists.

| Deliverable | Evidence | Status and limit |
|---|---|---|
| Historical PG environment and three task definitions | [#179](https://github.com/clemenza/honeyrail/issues/179), [#184](https://github.com/clemenza/honeyrail/issues/184), [#199](https://github.com/clemenza/honeyrail/issues/199), [#200](https://github.com/clemenza/honeyrail/issues/200) | Implementation complete; configured grading/control validation is not independent model rediscovery |
| Frozen Corpus v0 | [#201](https://github.com/clemenza/honeyrail/issues/201), [committed manifest](corpus/historical-postgres-corpus-v0.json) | Three cases frozen; TRAIN 001, FRONTIER 002/003, HOLDOUT empty; no pristine holdout claim |
| Experiment execution foundation | [#207](https://github.com/clemenza/honeyrail/pull/207), [#208](https://github.com/clemenza/honeyrail/pull/208), [#210](https://github.com/clemenza/honeyrail/pull/210) | Preflight, TrialSet and failure evidence shipped; recorded TRAIN reruns include timeout/workspace-limit outcomes excluded from the capability dataset |
| Formal Historical PG pilot | [#180](https://github.com/clemenza/honeyrail/issues/180) is closed | Closure needs empirical reconciliation: linked implementation PRs explicitly do not establish its formal dataset/analysis acceptance; a complete report is not established by the reviewed records |
| Change-oriented task | [#212](https://github.com/clemenza/honeyrail/issues/212), merged [#213](https://github.com/clemenza/honeyrail/pull/213) | E0–E3 task surface, grading and scripted-agent validation shipped; official real-model E0–E3 experiment integration/results remain a separate gate |
| Runtime integration reliability | [#205](https://github.com/clemenza/honeyrail/issues/205), [#213](https://github.com/clemenza/honeyrail/pull/213) | Timeout-observation fix and repeated validation recorded; reconcile each failure signature before closing #205 |

The immediate research question is whether contemporaneous requirements, a complete introducing change-set, and generic test methodology improve valid outcomes within a fixed budget. Neither the corpus freeze nor the change-task vertical slice establishes reliable three-bug rediscovery or independent transfer.

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
- **PostgreSQL research environment v0:** exact source snapshots, containerized build/runtime, isolated agent research surface, manifests/evidence, and deterministic cleanup.
- **Historical PG corpus and TrialSet:** three frozen tasks, preflight and execution identity checks, resumable profile matrices, conditional rediscovery reporting and bounded failure evidence.
- **HistoricalChangeTask v0:** E0–E3 context materialization, hidden grading and single-trial execution; a separate experimental track from frozen Corpus v0.
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

**M1 engineering acceptance:** implemented research environment, three-case frozen corpus, shared task/grader execution, isolated truth, deterministic controls, TrialSet identity and retained failure evidence. Reconcile the remaining roll-up acceptance items in [#178](https://github.com/clemenza/honeyrail/issues/178)/[#185](https://github.com/clemenza/honeyrail/issues/185); do not describe their completed implementation children as new work.

**M1 capability acceptance:** repeated real-agent attempts for each of the three cases under predeclared budgets, a declared reliability target, valid machine-confirmed outcomes, complete attempt accounting and uncertainty. Infrastructure validation alone does not satisfy this gate. A small pilot may produce an informative negative result without meeting the reliability target.

Report **End-to-End Budget Success**, **Conditional Historical Bug Rediscovery** and **Eligible Sample Rate** together, plus failure attribution and measured cost. The current runner implements the conditional measure; additional metrics are reporting requirements with manual supplements until versioned automation exists. Definitions are in the [evaluation protocol](docs/evaluation-protocol.md#outcomes-attribution-and-denominators).

**Immediate critical path:**

```text
Reconcile corpus/pilot acceptance and runtime failure records
→ register a small formal experiment and its complete attempt ledger
→ complete any concrete change-task eligibility/egress/reporting integration gap
→ run and report real-agent baseline/context comparisons
→ validate a frozen intervention on unrelated causal families
→ derive only the diagnosis or Capability Lab work supported by those results
```

The blind Corpus v0 baseline stays frozen. The change-oriented E0–E3 track gets its own experiment/task identity; it must not be added to or substituted into the old corpus silently. Its current standalone CLI does not establish the same official experiment boundary as the frozen-corpus TrialSet; see the [implementation status](docs/evaluation-protocol.md#implementation-status).

### M2 — PG Discovery Observability

- Complete the empirical pilot acceptance record associated with [#180](https://github.com/clemenza/honeyrail/issues/180), or explicitly assign its unmet requirements to a linked successor
- Trajectory analysis across success + miss
- Empirical failure-stage taxonomy, separating normal budget exhaustion, invalid submissions, external blocks, harness defects and infrastructure failures
- Account for every formal attempt and publish a sanitized [experiment report](docs/templates/experiment-report.md), including negative or inconclusive results
- Only after data exists, define `DiscoveryDiagnosis v1`

**Exit condition:** complete, reviewable real-agent data and per-attempt analysis, with a supported capability-gap or no-abstraction-needed decision. Expand to 5–10 historical cases only after execution and attribution are usable and the selection adds diversity; an empty holdout or repeated runs on one family cannot establish independent transfer.

### M3 — Capability Lab v1, PG-pulled

- Create synthetic/microbench tasks only for gaps observed in M1/M2
- Possible providers: tinytable, PG subsystem microtasks, planner/metamorphic tasks, state-transition tasks, deterministic concurrency micro-models
- Revive tinytable MVCC/WAL/planner/etc. only if PG evidence justifies the cost

### M4 — Self-Improve v1

- Real/synthetic diagnosed evidence → sanitized optimizer input → Candidate DiscoveryPolicy/HarnessProfile → Capability Lab check → unseen Historical PG → promote/reject/inconclusive
- [#177](https://github.com/clemenza/honeyrail/issues/177) is mechanics v0 only; Historical PG is the principal reality validation for v1
- Promotion requires a frozen candidate and evaluation outside development-exposed causal families; use the protocol's exposure ledger and holdout rules. Corpus v0 alone cannot provide a pristine HOLDOUT result.

### M5 — Stateful / Systems PostgreSQL Discovery

- Multi-session → locking/deadlock → prepared plans/catalog invalidation → restart/recovery → VACUUM/freeze → replication/multi-node
- State exploration ([#176](https://github.com/clemenza/honeyrail/issues/176)) becomes implementation-heavy only when this layer produces a concrete need

### M6 — PostgreSQL HEAD Frontier

- Fresh PG source, fixed budget, source-guided exploration, unknown defects
- Reproducible evidence, minimization, regression test, report
- **Metric:** `Validated Novel Defect Yield @ Budget`

## Current priorities

### P0
- Reconcile [#178](https://github.com/clemenza/honeyrail/issues/178)/[#185](https://github.com/clemenza/honeyrail/issues/185) child completion and [#180](https://github.com/clemenza/honeyrail/issues/180) empirical acceptance. Link evidence or remaining work before updating their completion claims.
- Close the experiment integration gaps and produce a small formal real-agent report, including all failed attempts and conditional/end-to-end metrics. [#212](https://github.com/clemenza/honeyrail/issues/212) is the completed task implementation, not a completed E0–E3 experiment.
- Reconcile [#205](https://github.com/clemenza/honeyrail/issues/205) with [#213](https://github.com/clemenza/honeyrail/pull/213): record which failure signatures are resolved and give residual signatures explicit follow-ups.

### P1
- Minimal metric/uncertainty reporting from [#75](https://github.com/clemenza/honeyrail/issues/75)/[#76](https://github.com/clemenza/honeyrail/issues/76); a reviewed supplement is sufficient before building a statistics subsystem.
- Family/exposure registration and an unrelated-family validation set; derive Capability Lab work only from observed gaps.
- Contributor setup clarity and a report-centered evaluation entry point. Check the pinned tinytable-evals submodule before diagnosing local test failures; a dedicated doctor check remains follow-up implementation work.
- [#84](https://github.com/clemenza/honeyrail/issues/84) — `BLOCKED:` classification, if #180 uses the affected DAG/agent-task path
- [tinytable-evals#61](https://github.com/clemenza/tinytable-evals/issues/61) remains a prerequisite for claims relying on affected lab truth; it does not automatically block an independent PG experiment.

### P2 — require an observed need
- [#172](https://github.com/clemenza/honeyrail/issues/172) — provider abstraction after real task usage exposes a shared contract worth extracting
- [#176](https://github.com/clemenza/honeyrail/issues/176) — exploration contract only when trajectories identify a state-exploration gap
- [#177](https://github.com/clemenza/honeyrail/issues/177) — Self-Improve Mechanics v0, not Historical PG proof; prioritize usable evaluation data first
- tinytable no-defect/confidence work if capacity exists

### P3 / evidence-gated
- Large tinytable calibration/statistics work
- Compound mutants
- Multi-agent tinytable exam-room support unless required for the single Historical PG MVP agent
- Planner-lite
- Toy MVCC/WAL/concurrency
- Large synthetic PG mutation pools

## Contract freeze rule

> Do not freeze shared `EvalTask`, `TruthBundle`, or `EvalProvider` APIs from tinytable alone. Exercise provisional contracts on tinytable and at least three Historical PG tasks, and require evidence of actual reuse before extracting/freezing a shared API. Three task definitions alone do not justify an abstraction. This does not weaken the already-frozen Corpus v0 input contract.

## Claim discipline

Tinytable can support:
- "profile B improved mutant discovery under oracle-mode behavioral testing"

Historical PG can support:
- "profile B improved rediscovery of unseen real PostgreSQL bugs"

PG HEAD is required for:
- "HoneyRail helps discover novel PostgreSQL defects"

These claims require actual supporting experiments, not merely access to the corresponding task type. Self-improvement and independent-transfer claims require evaluation outside development-exposed causal families. TRAIN improvement never counts as independent transfer. Report pretraining uncertainty separately from runtime leakage, and disclose Corpus v0's empty HOLDOUT.

## What we are intentionally not doing now

- Full deterministic hypervisor
- Arbitrary-system model checking
- Mass tinytable feature expansion
- Large IRT/leaderboard infrastructure
- Large 48-run launch matrix for the old tinytable demo
- Generic `EvalProvider` before three Historical PG tasks
- State explorer before PG evidence
- Self-improvement claims based on TRAIN or repeated exact cases
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

Older v0.2/v0.3 and demo issues remain supporting backlog unless a current experiment requires them. Do not use their version numbers as aliases for the PG-led milestones. Close superseded trackers with a replacement/disposition rather than implying all original work shipped.

## Follow-up specifications

These are scoped implementation or review tasks, not claims of implemented automation or newly created GitHub issues:

| Follow-up | Acceptance evidence |
|---|---|
| Official change-task experiment entry point | Versioned identity/attempt ledger; real-agent eligibility and restricted model egress demonstrated using existing mechanisms; repeated E0–E3 evidence/reporting; no mutation of Corpus v0 and no second eligibility classifier |
| Reporting v1 automation | Retain current raw verdicts/conditional rate; add attempts, end-to-end/eligible rates, cause evidence, missing-data and cost accounting per the protocol; version output and preserve previous reports |
| Family/exposure checks | Opaque family registry and exposure ledger; demonstrate that a tuned sibling cannot count as independent transfer; retain frozen v0 partition history |
| Contributor preflight | Detect missing or mismatched pinned submodule and explain its remedy without updating the pin; distinguish this from unavailable model/runtime prerequisites |
| Incremental module separation | Extract cohesive task-definition, materialization, grading or evidence responsibilities only where review/maintenance needs it; demonstrate unchanged frozen inputs/hashes and runtime behavior |

Use the [experiment report template](docs/templates/experiment-report.md) and [closure rules](docs/evaluation-protocol.md#issue-and-pr-closure) to turn these into reviewable work. Each proposed change identifies its concrete PG evaluation benefit and smallest necessary scope.

## v1.0

- Stable Recipe, Executor, and Evidence contracts.
- Documented migration policy for compatibility surfaces.
- Production-grade recovery and auditability expectations.
