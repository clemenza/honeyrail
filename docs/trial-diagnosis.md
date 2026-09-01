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
sql-tests/agent/*.test  ─┐
                          ├─▶ extractProbeShape() ─▶ ProbeShape (observed)
transcript.ndjson       ─┘                                │
                                                            ▼
manifest.json (operatorId) ─▶ PRIVATE_REQUIRED_PROBE_SHAPES[operatorId]
                                        │
                                        ▼
                              RequiredProbeShape (private)
                                        │
                                        ▼
                              diagnoseTrial() ─▶ TrialDiagnosis ─▶ trial-diagnosis.json
```

`extractProbeShape` is lightweight tokenization (regex + paren-depth
scanning) over the `.test` grammar in `vendor/tinytable-evals/SPEC.md` -
deliberately not a real SQL parser/AST (#174 §3). Each entry in its
`sqlStatements` array is one `.test` *record's* full text (its optional
`statement ok`/`statement error [substring]` header line, if present,
followed by the SQL body) - this preserves each statement's pass/fail
expectation without widening the function's own signature; see the
doc-comment at the top of `trial-diagnosis.ts` for the full reasoning.
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
- An operator id with no entry in the map just yields an empty
  `RequiredProbeShape`, i.e. no capability gaps - a safe default, not an
  error. The map is not required to be exhaustive for v0.

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
