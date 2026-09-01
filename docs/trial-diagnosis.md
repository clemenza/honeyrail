# TrialDiagnosis v0 (#174)

`server/evals/trial-diagnosis.ts` turns a trial's own artifacts into a
deterministic answer to "why did this miss?" - not just whether a trial
killed its seeded mutant (that's `kill-attribution.ts`'s job), but which
*kind* of SQL/behavioral coverage the agent's own test suite never
exercised. No LLM sits anywhere in the critical path: every judgment is a
plain comparison over data already sitting in the trial's `artifactsDir`.

## Usage

```
node --import tsx scripts/tinytable-diagnose.ts <trial-id-or-path> [--out <dir>]
```

- A bare trial id (e.g. `m01-baseline-1`) is resolved against
  `<out>/state.json` (default `./dsh-evals-report`, the same convention
  `dsh-evals-demo.ts`'s `--out` uses) to find its `artifactsDir`.
- A path that already points at a trial's `artifactsDir` is used directly.

Writes `trial-diagnosis.json` into that same `artifactsDir`, alongside
`manifest.json`/`score.json`/`transcript.ndjson`. This is a separate,
opt-in stage - `dsh-evals-demo.ts` never calls it itself, so a trial with no
`trial-diagnosis.json` behaves exactly as it did before #174. The next time
a report is built (`--report-only` or a fresh run), `writeReport()`
best-effort-reads each trial's sibling `trial-diagnosis.json` and
`dsh-report.ts` renders a "Trial diagnoses" section for whichever trials
have one.

## Data flow

```
sql-tests/agent/a.test ─▶ SqlTestScenario ─▶ extractScenarioProbeShape() ─▶ ProbeShape ─┐
sql-tests/agent/b.test ─▶ SqlTestScenario ─▶ extractScenarioProbeShape() ─▶ ProbeShape ─┼─▶ aggregateProbeShapes() ─▶ ProbeShape (observed)
...                                                                                     ─┘         ▲
transcript.ndjson (hasOwnPassingTestRun reinforcement, trial-wide only) ────────────────────────────┘
                                                                                                     │
                                                                                                     ▼
manifest.json (operatorId) ─▶ PRIVATE_REQUIRED_PROBE_SHAPES[operatorId]
                                        │
                                        ▼
                              RequiredProbeShape (private)
                                        │
                                        ▼
                              diagnoseTrial() ─▶ TrialDiagnosis ─▶ trial-diagnosis.json
```

`.test` file boundaries are load-bearing, not cosmetic: `run_sql_tests.py`
gives every `.test` file its own fresh `tinytable.Database()` - there is no
schema/row/FK/transaction state shared between two `.test` files, ever.
`extractScenarioProbeShape()` is lightweight tokenization (regex +
paren-depth scanning) over the `.test` grammar in
`vendor/tinytable-evals/SPEC.md` - deliberately not a real SQL parser/AST
(#174 §3) - run once per `SqlTestScenario` (one `.test` file), each with its
own fresh internal state, never a state shared across files. Each entry in a
scenario's `records` array is one `.test` *record's* full text (its optional
`statement ok`/`statement error [substring]` header line, if present,
followed by the SQL body) - this preserves each statement's pass/fail
expectation. `extractProbeShape()` is the trial-level orchestrator: it runs
`extractScenarioProbeShape()` once per scenario, then folds the results with
`aggregateProbeShapes()` - presence fields (`checkTested`, `insertPresent`,
...) OR across scenarios, complexity fields (`tableCount`, `maxFkPerTable`,
...) take the MAX across scenarios (never a cross-file sum), and interaction
fields (`crossColumnDependency`, `multiObjectInteraction`,
`nonLastFkViolationTested`, ...) are already computed scenario-locally by
`extractScenarioProbeShape` (a single, fresh internal context per scenario),
so aggregating them is mechanically also OR - the correctness guarantee
comes from the per-scenario extraction never seeing another scenario's
state. See `trial-diagnosis.ts`'s own doc-comment and `aggregateProbeShapes`'s
doc-comment for the full reasoning, including why a `statement error` record
must never register a successful state transition (an expected-to-fail
`INSERT`/`CREATE TABLE` didn't actually leave that state behind - see
`extractScenarioProbeShape`'s handling of `expectation`).
`diagnoseTrial` is a pure diff: `Required Probe Shape - Observed Probe Shape
= Capability Gap`, one small named comparator per tag, no ontology or rule
engine.

## The private-truth boundary

`required_probe_shapes` never enters the exam room, by the same rule
`docs/dsh-evals-demo.md`'s three-zone design already applies to
`manifest.json`'s `operatorId` ("THE ANSWER - grader-side only; never
written into the seed-root"):

- `PRIVATE_REQUIRED_PROBE_SHAPES` is a plain host-side `Record<operatorId,
  RequiredProbeShape>` constant colocated in `trial-diagnosis.ts` - never
  materialized into any `seed-root`/`agent-root`, and looked up only by
  `scripts/tinytable-diagnose.ts` after a trial has finished, on the
  host/grader side.
- `transcript-audit.ts`'s `SUSPICIOUS_PATTERNS` includes a
  `required-probe-shape` pattern, so a leaked reference (a hallucination, or
  a genuinely confused agent) still gets flagged the same way a leaked
  `mutant`/`golden`/`score.py` reference already is.
- An operator id with no entry in the map is **not** silently treated as "no
  capability gap" - `lookupRequiredProbeShape()` is the only sanctioned way
  to read `PRIVATE_REQUIRED_PROBE_SHAPES`; for an unconfigured operator id it
  returns an empty shape *plus* an explicit `required-shape-unavailable`
  `Evidence` entry, and `diagnoseTrial()` reflects that as
  `diagnosisStatus: "required_shape_unavailable"` rather than
  `"complete"`. The map is not required to be exhaustive for v0, but callers
  must distinguish these three states:
  - **configured required shape, zero gaps** (`diagnosisStatus: "complete"`,
    `capabilityGaps: []`) - a genuine clean pass.
  - **required shape unavailable** (`diagnosisStatus:
    "required_shape_unavailable"`) - never actually checked; `capabilityGaps`
    is computed against an empty shape and is not meaningful evidence of
    anything.
  - **ineligible** (`diagnosisStatus: "ineligible"`) - the trial's own
    `outcome` is `blocked`/`invalidated`/`driver_error`, so its observed
    probe shape reflects a run that never produced trustworthy data to
    diagnose in the first place.

  `dsh-report.ts` renders each state differently (`"unknown - no required
  probe shape configured"` / `"not meaningful - trial outcome makes its
  observed probe shape untrustworthy"` vs. a real gap list or `"none"`) -
  never collapses "unknown" into "none". A future consumer (Harness
  Self-Improve v0, #173's M3) must check `diagnosisStatus` before trusting
  `capabilityGaps`, not infer validity from whether the gap list happens to
  be empty.

Every configured operator's `RequiredProbeShape` is held to one acceptance
principle: **a known valid killing workload for that operator must be
classified by `extractProbeShape()` as satisfying the requirement** (see
`test/trial-diagnosis.test.ts`'s per-operator acceptance tests) - not merely
"the feature that happened to be absent in one historical miss". For
`check-on-update-sees-only-assigned-columns`, for example, a single
per-column `CHECK`/full-row `UPDATE` (golden case A's own shape) does *not*
satisfy the requirement, because it isn't actually capable of triggering
that specific mutant; only an `OR`-composed, multi-column `CHECK` plus a
partial `UPDATE` that leaves a referenced column unassigned does (see that
operator's own comment in `PRIVATE_REQUIRED_PROBE_SHAPES` for the worked
three-valued-logic example of why `AND` alone doesn't distinguish it).

## Adding a new capability-gap tag

`CapabilityGapTag` is a closed, seven-member union (#174 §6) - v0
deliberately does not support an open/extensible tag set. To add an eighth:

1. Add the tag string to the `CapabilityGapTag` union in `trial-diagnosis.ts`.
2. Add one entry to `GAP_CHECKS`: a `{ tag, hasGap(required, observed) }`
   pair, following the existing entries' shape (a single required-vs-observed
   field comparison, not a multi-step rule).
3. If the new tag's signal isn't already a `ProbeShape` field,
   `extractProbeShape` needs to compute it first - keep the same "lightweight
   tokenization, not a real parser" scope as the rest of the function.

No batch of new tags, no generalized rule engine - each tag stays a small,
independently readable function (#174's own non-goal list).

## Non-goals (unchanged from #174)

Same list as the issue: no L0-L4 difficulty/IRT system, no large batch of
new mutation operators, no MVCC/WAL/concurrency modeling, no
PostgreSQL-track integration (tracked separately, #173), no automatic
HarnessProfile optimizer, no LLM-only postmortem, no full SQL semantic
parser.
