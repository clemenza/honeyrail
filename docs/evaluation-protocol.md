# Evaluation protocol

Protocol version: `evaluation-report-v1` (2026-09-09).

This document defines contributor and reviewer requirements for HoneyRail's local database correctness evaluations. MUST denotes a requirement for an accepted experiment report or capability claim; SHOULD denotes a default whose exception needs a recorded reason. It does not change executable grading semantics. The [roadmap](../ROADMAP.md) defines priority; the [report template](templates/experiment-report.md) records compliance and results.

## Implementation status

| Area | Current implementation | Requirement or remaining work |
|---|---|---|
| Historical Corpus v0 | Three tasks; immutable manifest validation, environment fingerprint, preflight/execution binding | Preserve existing inputs and verdicts; version any changed contract |
| Historical TrialSet | Matrix identity, resume, per-cell evidence, `datasetEligible`, `officialScoredResult`, conditional rate | Add end-to-end reporting, detailed attribution, costs and uncertainty as versioned work; until then supply a reviewed report supplement |
| Change tasks | E0–E3 materialization and single-trial execution | Formal experiment identity, real-agent eligibility, restricted model egress and repeated-trial reporting must be demonstrated together before claiming an official comparison |
| Partition controls | Frozen v0 task partitions; HOLDOUT empty | Causal-family registry, exposure ledger and holdout access review are manual requirements; automatic enforcement is not implemented |
| Acceptance | CI, runtime integration tests and task-specific tests | Registration, empirical report review and issue closure are reviewer responsibilities, not automated gates |

`scripts/historical-postgres-212.ts` calls `runHistoricalPostgresTrial()` directly; it does not use the frozen-corpus pilot/TrialSet boundary. Its CLI supports `none`/`bridge` networking and, since the #216 execution-gap fix, restricted model egress via `HONEYRAIL_PG_212_EGRESS_UPSTREAM_URL` (the same scored `isolation.restrictedEgress` mechanism the DSH TrialSet uses) plus an explicit `HONEYRAIL_PG_212_AGENT_TRAJECTORY=dsh` trajectory expectation. A bridge-network diagnostic run or a scripted agent MUST NOT be promoted into capability evidence. Do not insert change tasks into the frozen three-task corpus.

## Evidence levels and claims

| Level | Required evidence | Permitted conclusion |
|---|---|---|
| Implementation | Relevant tests, versioned contract, configured integration where execution behavior changes | A component or execution path works under the recorded conditions |
| Harness validation | Known controls and scripted-agent runs; deterministic grading, isolation and cleanup evidence | The harness recognizes the tested outcomes; no model capability conclusion |
| Real-agent pilot | Predeclared attempts, verified inputs, genuine model runs, outcomes and inspectable trajectories | Observed behavior under the stated task, context and budget; small samples remain diagnostic |
| Transfer | Frozen intervention evaluated on previously untouched, unrelated causal families | Evidence of transfer within the sampled scope, with uncertainty and exposure limitations |

A reliable three-case result requires repeated real-agent evidence for each case, a reliability target declared before results, and reported uncertainty. Neither three materialized cases nor one successful scripted trial satisfies it. Model configuration SHOULD be fixed and recorded; temperature/seed settings do not guarantee determinism. Public historical bugs may have appeared in pretraining even when the runtime never exposes their answers.

## Register before formal trials

The operator MUST save a dated plan using the report template before the first formal attempt. Keep amendments and their reasons; do not overwrite the original plan after seeing results. Record:

- The hypothesis, primary comparison, acceptance/stop conditions, task IDs, causal families, partitions and prior exposure.
- Repository commit, corpus/task/truth hashes, grader and reporting versions, model/provider identity, agent version and image identity, exact effective profile hashes, environment identity and isolation policy. Unknown model identity is explicitly `unknown`, with its effect on the claim stated.
- The complete task × condition × trial-index matrix, execution order, independent-session/reset policy, fixed wall/token/tool/resource budgets, and the predeclared retry policy. Distinguish limits actually enforced from targets only observed.
- Artifact retention, metric denominators, cost accounting and uncertainty method. Record public provenance using safe references; do not place private truth or raw telemetry in the plan.

Engineering smoke and formal trials MUST be designated before execution. Debugging uses TRAIN or synthetic fixtures; it must not consume FRONTIER/HOLDOUT silently. Fresh sessions must not share model conversation, scratch files or mutable database state across conditions. An unchanged read-only build cache is acceptable when its identity is recorded.

A retry gets a new attempt ID linked to its predecessor; it never replaces a failed attempt. If results expose a harness defect, retain the affected attempts, document the cause, and register a corrected experiment/version. Do not tune inputs, increase limits or change scoring in the middle of a frozen comparison. Reports with unfinished planned cells are explicitly partial.

## Outcomes, attribution and denominators

Preserve the runner's original status, grader result, `datasetEligible` and `officialScoredResult`. Add report-level attribution separately; do not invent a competing implementation of eligibility.

Each attempt MUST record both **what happened** and **why**, with evidence. Suggested primary causes are `agent_budget_exhausted`, `agent_invalid_submission`, `agent_resource_limit`, `external_block`, `harness_or_evaluator`, `infrastructure`, `isolation_or_integrity`, and `unknown`. These are report vocabulary, not new runtime enums. Choose one primary cause for count reconciliation; retain contributing causes as notes. A timeout from normal budget exhaustion is different from a database startup failure. A workspace policy violation is not automatically an attack or an infrastructure defect. Uncertain causes remain `unknown`.

The current runner maps unsuccessful agent completion, including timeout, to `blocked`, and excludes non-eligible outcomes from its conditional rate. Reports MUST retain this historical behavior while also exposing the operational cost of unsuccessful attempts:

| Metric | Definition |
|---|---|
| Formal attempts (`A`) | All started, predeclared formal attempts, including preflight failures, cancellations after start and retries; excluding predeclared engineering smoke |
| Eligible attempts (`E`) | Sum of authoritative `datasetEligible === true` for those attempts |
| Valid discoveries (`D`) | Eligible attempts with authoritative `officialScoredResult === rediscovered` |
| End-to-end budget success | `D / A`; infrastructure, invalid, blocked and integrity outcomes remain visible in this operational denominator |
| Conditional rediscovery | `D / E`; the current TrialSet conditional rate |
| Eligible sample rate | `E / A` |
| Failure/outcome rates | Counts by raw status and by attributed cause, each over `A`; report unknown attribution explicitly |
| Cost per valid discovery | Total measured cost of all formal attempts, including failures/retries, divided by `D` |
| Time to first valid reproducer | First machine-confirmed valid candidate relative to attempt start, only when timestamps support it; otherwise unavailable |

For zero denominators, report `N/A` and the counts. When `D = 0`, report total cost and "no valid discovery", not zero cost per discovery. Missing cost/telemetry MUST be reported as incomplete; never impute zero. Show planned, started, pending and never-started/cancelled cells separately so selective non-execution cannot disappear from the report. Do not call a partial matrix a final experiment result.

For illustration only: 10 attempts, 2 eligible and 1 valid discovery means 10% end-to-end success, 50% conditional rediscovery and 20% eligible sample rate. These are not HoneyRail results.

Until automated reporting supports these additions, a reviewed supplement MUST show its input attempt ledger and calculations. A change-task path without authoritative experiment eligibility remains diagnostic until its integration is validated; a hand-authored success label cannot fill that gap. New automated reporting must version the output schema/formulas and keep previous reports and raw verdicts intact.

## Comparison and uncertainty

Compare conditions on the same task and matched budgets/environment/model identity. Report each task and partition separately as well as any declared aggregate; do not pool tuned TRAIN results into a transfer result. Source review is a legitimate discovery method when permitted by the task; record it separately from behavioral discovery and answer leakage.

An E0/E1/E2/E3 comparison isolates additional context: baseline, specification, full introducing change-set, then generic methodology. The specification must be contemporaneous, the change-set complete, and the source historically consistent with the shown change. Grader truth and future answers remain unavailable. Context conditions receive independent sessions. Running several rungs on one development case supports within-case analysis, not independent transfer.

Small pilots may report counts only, explicitly as diagnostic. For a reliability or improvement claim, predeclare repetitions and an appropriate interval/comparison method; `n >= 3` alone is not statistical proof. Account for repeated runs clustered within tasks/families, and do not present extra attempts on one bug as additional independent bugs. Report uncertainty on comparative conclusions. `pass@k`, if used, must state `k`, its estimator/assumptions and total sampling cost; it must not conceal failed attempts or be compared across unequal budgets without qualification.

## Partition and exposure rules

- Record an opaque causal-family ID, partition, exposure history and custodian reference for each task. Private family mappings and answer material stay operator-side.
- Once any family member informs prompt/profile/method tuning, the family is development-exposed. Siblings may remain explicitly labeled diagnostic or same-family transfer cases, but MUST NOT substantiate independent transfer or pristine holdout claims. Validate on unrelated families first.
- FRONTIER becomes development-exposed if its results inform subsequent changes. Preserve its original results and partition history; select fresh families for subsequent validation instead of relabeling used cases as unseen.
- HOLDOUT requires private evaluation material from inception, recorded access, a frozen intervention, and no feedback to the optimizer before the final evaluation. Any material exposure retires the pristine claim; moving or deleting current files does not erase earlier public exposure.
- [Corpus v0](historical-postgres-corpus-v0.md) remains TRAIN 001, FRONTIER 002/003, HOLDOUT empty. Its frozen labels MUST NOT be edited to implement a new partition policy. Record exposure separately and create a new corpus version when inputs/partitions change.
- Runtime answer isolation and unknown pretraining exposure are separate limitations. Describe a case as unseen by the development process only when the exposure record supports it; do not claim that a public historical case was necessarily unseen by the model.

## Evidence, verification and publication

Every formal attempt needs an ID and recorded identity/budget, original result, attribution with supporting evidence, sanitized agent transcript, submitted artifacts where available, and grader/environment evidence. On timeout, invalid input, workspace limits or infrastructure failure, retain bounded sanitized diagnostics and explicitly list missing artifacts; do not discard the entire attempt or alter a valid existing verdict just to repair reporting.

Distinguish agent-originated telemetry from grader-owned observations. A transcript is diagnostic evidence, not an independent truth oracle. Unexpected candidate findings require separate adjudication and evidence; they must not silently receive the known target's score.

The public report MUST exclude credentials, private paths, hidden truth, canonical answers and raw private telemetry. Store raw evidence in the existing operator-controlled artifact storage; publish safe references/hashes and a sanitized report after review. Do not commit generated runtime directories. A descriptive report may live under `docs/experiments/` when sanitized; the directory need not contain raw trial data.

Verification records distinguish unit tests, configured task integration, release-runtime integration, scripted-agent controls and real-model trials. A skip is not a pass. Investigate CI failure signatures; a later green rerun does not erase earlier failures. A flake issue closes only when each tracked signature is fixed or explicitly assigned to a linked follow-up with residual risk.

## Issue and PR closure

| Deliverable | Required closure evidence |
|---|---|
| Implementation | Merged change, acceptance mapping, relevant verification and remaining limitations; scripted agents identified |
| Experiment | Registered plan, complete attempt ledger or explicit partial/terminated disposition, report, evidence references, per-case analysis and a supported decision |
| Decision/roll-up | Accepted decision or reconciled child checklist, final evidence links, and explicit unresolved work |

Closing an issue as completed MUST mean its own acceptance conditions are met. An unsuccessful experiment may complete its research objective if its predeclared criteria permit a well-explained negative result. Terminated or superseded work records its disposition/replacement; it does not imply an unmet empirical target succeeded. An implementation PR uses "advances #..." for an unfinished experiment parent instead of an automatic closing keyword.

Reconcile README/ROADMAP status when a milestone changes. Date snapshots, name their evidence basis, and retain corrections to prior claims. Code determines available behavior; the recorded experiment determines measured capability; issue state alone determines neither. Proposal and implementation remain explicitly distinct.

## Scope and promotion

Each new capability feature SHOULD name the observed PG gap, how improvement will be measured away from tuned cases, the harness correctness evidence, and the smallest reusable change. Extend Capability Lab only for a demonstrated need. Defer provider abstractions, state explorers and automatic optimizers until they solve an observed problem. Where existing modules impede review, extract cohesive responsibilities incrementally while preserving frozen inputs, hashes and behavior; do not combine that work with new scoring semantics.

Promotion follows evidence: trusted execution → completed pilot → repeated real-agent results → unrelated-family validation → broader corpus or capability intervention. Calendar targets and closed issue counts do not substitute for these gates. A rule deviation requires a dated rationale and its effect on acceptance/claims in the report; it cannot retroactively turn diagnostic data into official evidence.
