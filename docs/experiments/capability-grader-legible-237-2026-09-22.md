# Experiment report: Capability Lab grader-legible observable / reproducer-output construction (#237)

Applies [evaluation-report-v1](../evaluation-protocol.md). Design reference: [Capability Lab: grader-legible observable and reproducer-output construction](../capability-lab-grader-legible.md). Grader truth and raw private telemetry stay outside this report.

## Registration

- Status: **partial** — implementation and harness validation complete; no real-agent attempt has been run, so no capability result is claimed.
- Experiment ID: `cap-glo-237`; owner/custodian: repository operator; registered 2026-09-22.
- Issue/PR: [#237](https://github.com/clemenza/honeyrail/issues/237). Implementation dependency evidence: `npm run typecheck`, `npm run test:capability-glo-237`, `npm run build`, and one end-to-end paired run (below).
- Question: does a small, transferable methodology artifact improve construction of grader-legible reproducers — reproducers whose discriminating signal is a minimal external observable — at a fixed task and budget?
- Primary hypothesis: the recurring downstream failure shape observed in Studies 1–3 is a reusable capability gap, improvable by an intervention that carries no case-specific content.
- Deliverable for this record: **engineering validation**. A diagnostic pilot and any transfer claim are separate, later records.
- Acceptance target for this record: a deterministic TRAIN archetype set covering the six output-shape failure classes, an external grader that does not leak expected truth, paired baseline/candidate conditions differing in exactly one file, retained raw observations, and a content-hashed frozen candidate.
- Stop conditions: any archetype whose grading depends on parsing the submitted script, or on an agent-asserted verdict, is removed rather than patched.
- Non-goals: rerunning or regrading Studies 1–3; tuning on `#16867`/`#18574`/`#18118`; touching frozen Historical PG task/oracle material; any family-003 or family-004 consumption; a generic experiment framework or provider abstraction.
- Amendments: none.

## Identity and task exposure

- Repository commit: recorded at run time in the operator's artifact store; this record is written against the #237 implementation branch.
- Archetype set hash: `c02ba99ccdf69ee28bda1071ae73b153539278f659c4c18b2996f4c25bf5a666`.
- Candidate intervention: `cap-glo-intervention-v1`, hash `6c91b112134a6afa0976902b83bc0c5a4cf3dfd8a0fe31055fff622ffcc867f2`. Baseline: `cap-glo-baseline-v1` (empty body).
- Frozen artifact: `corpus/capability-grader-legible-intervention-v1.json` (idempotent; refuses to overwrite a differing freeze).
- Grader: `server/capability/grader-legible-grader.ts`, report schema version 1, two executions per attempt.
- Model/provider/version: **not applicable to this record** — no model was run. The one executed paired run used a scripted provider and is explicitly `capabilityEvidenceEligible: false`.
- Build/runtime identity: Node 24.20.0, macOS, no Docker, no PostgreSQL, no network. Fixtures are POSIX-sh; execution uses a constructed environment (`PATH` = fixture `bin` plus standard system directories, plus `HONEYRAIL_FIXTURE_STATE`), not the operator's shell environment.
- Agent isolation: none in this record, because no agent ran. A real-agent run records its own isolation policy and declared identity in the report as `realAgentIdentity`, including the content-addressed image id its image reference resolved to before the first attempt ran; without a Docker image the agent would execute on the host beside the harness's private material, and such a run is `capabilityEvidenceEligible: false` by construction rather than by reviewer discretion.
- Enforced limits: per-execution submission timeout (default 30 s, process-group kill), per-attempt agent budget (default 10 min), submission size ≤ 16 KiB.

| Task ID | Opaque causal family | Partition | Prior development exposure | Task/context hash | Evidence custodian reference |
|---|---|---|---|---|---|
| `cap-glo-001` … `cap-glo-006` | `cap-glo-synthetic` | TRAIN | Authored for #237; synthetic, no historical case content | per-archetype hashes in the frozen artifact | operator artifact store |

The Historical PostgreSQL cases from Studies 1–3 appear in this experiment only as the motivation for the capability gap. No historical task, oracle, reproducer, state name or grader-private tuple is reproduced in the archetypes or the intervention; an automated test asserts the intervention body mentions no PostgreSQL, case, family or fixture-specific term. Family-003 ([#230](https://github.com/clemenza/honeyrail/issues/230)/[#232](https://github.com/clemenza/honeyrail/issues/232)) was not used, and the reserved family-004 was not consumed at any point during implementation or debugging.

## Predeclared matrix and analysis

| Task | Condition/profile | Trial indices | Model | Wall/token/tool/resource limits | Order |
|---|---|---|---|---|---|
| `cap-glo-001` … `cap-glo-006` | `baseline` (`cap-glo-baseline-v1`) | 1 per archetype | — (real-agent run pending) | 10 min agent budget; 30 s × 2 executions; ≤ 16 KiB submission | baseline then candidate, per archetype |
| `cap-glo-001` … `cap-glo-006` | `candidate` (`cap-glo-intervention-v1`) | 1 per archetype | — (real-agent run pending) | as above | as above |

- Independent-session policy: each attempt materializes a fresh archetype root; conditions share no workspace, no fixture state and no scratch directory.
- Retry policy: a retry is a new experiment ID into a fresh artifact root. The runner refuses any artifact root that already holds an entry — including a root written by an identical earlier run of the same experiment — before it materializes anything or calls the provider, and it never deletes or rewrites anything under a used root. A failed attempt therefore cannot be silently replaced, and the predecessor's evidence stays available for comparison.
- Engineering smoke: every scripted-provider run, including the one below, is designated engineering/harness validation and excluded from any formal capability ledger.
- Pairing: same task surface per archetype, enforced by comparing each attempt's as-presented task-surface hash before any comparison is reported.
- Metrics: primary endpoint is end-to-end budget success `D/A` — grader-legible successes over every formal attempt, per condition. Conditional rediscovery `D/E` (over completed attempts) is reported beside it and never alone, since it excludes everything that failed before grading. Non-capability outcomes (`invalid_submission`, `integrity_error`, `infrastructure_error`) are reported separately, alongside failure-stage counts and a `primaryCause` census in evaluation-report-v1 vocabulary that sums to `A`. Six archetypes is a small sample; counts only, no reliability claim.

## Attempt ledger

| Attempt / predecessor | Cell / trial index | Start/end | Raw status / grade | Capability-evidence eligible | Attributed cause and evidence | Time/cost coverage | Artifact reference |
|---|---|---|---|---|---|---|---|
| `cap-glo-237-harness-validation-2026-09-22` (12 attempts, scripted provider) / none | all 6 archetypes × 2 conditions | 2026-09-22 | 12 `completed`; baseline 0/6 grader-legible, candidate 6/6 | **no** — scripted provider | staged demonstration: the baseline submitted each archetype's bad-but-plausible self-asserting shape, the candidate its grader-legible shape | wall time recorded per attempt; no token/model cost (no model) | operator artifact store, `output/capability-grader-legible/harness-validation-2026-09-22/` (not committed) |

## Results

- Planned: 12 engineering-validation cells. Started: 12. Pending: 0. Cancelled before start: 0.
- Real-agent formal cells: **0 started**. This record is partial by design; the capability question is unanswered.

| Task/partition/condition | Attempts A | Eligible E | Grader-legible D | D/A | D/E | Non-capability outcomes | Failure stages |
|---|---|---|---|---|---|---|---|
| `cap-glo-*` TRAIN / baseline (scripted, engineering) | 6 | 6 | 0 | 0.000 | 0.000 | 0 / 0 / 0 | `exit_status_mismatch` 2, `stdout_shape_mismatch` 3, `nondeterministic_output` 1 |
| `cap-glo-*` TRAIN / candidate (scripted, engineering) | 6 | 6 | 6 | 1.000 | 1.000 | 0 / 0 / 0 | — |
| `cap-glo-*` TRAIN / real agent | 0 | 0 | 0 | N/A | N/A | N/A | N/A |

`D/A` and `D/E` coincide here only because the scripted provider never fails before grading; on a real-agent run they diverge, which is why both are recorded.

**What this does and does not show.** The engineering rows are a staged demonstration: a scripted provider submitted predetermined shapes, so the 0/6 and 6/6 are properties of those shapes and of the grader, not of any model. They establish that the instrument distinguishes a self-asserting reproducer from a grader-legible one, attributes the miss to a specific stage, and retains raw observations either way. They establish nothing about whether the intervention improves an agent. Per the evaluation protocol, a scripted agent must not be promoted into capability evidence, and the runner marks these runs `capabilityEvidenceEligible: false`.

## Verification

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | pass |
| Capability unit + integration tests | `npm run test:capability-glo-237` | 47 pass, 0 fail |
| Full suite | `npm test` | 1124 pass, 14 fail — all 14 in `tinytable-seed-root-builder` / `dsh-testengineer-trial` / `dsh-grader-invalidated`, caused by the uninitialized `vendor/tinytable-evals` submodule in this environment; pre-existing and unrelated to this change |
| Build | `npm run build` | pass |
| End-to-end paired run | `npm run capability-glo-237` | 12 attempts, paired surface hash verified, report written |
| Freeze | `npm run capability-glo-237-freeze` | written and idempotent on rerun |

Automated coverage of the properties #237 asks for: the six failure classes are covered exactly once; agent-visible material does not contain the expected observation or the failure-class name; grader diagnostics do not echo expected values; an invalid execution, a missing submission, an oversized submission and an agent that cannot start are each classified away from capability misses; nondeterministic output is attributed to determinism specifically; a submission that never ran the discriminating experiment is attributed upstream of output shape; a diverging task surface is refused; any rerun into a non-empty artifact root is refused before any materialization or provider call — including a rerun of the same experiment ID over the same task set — with every previously retained file left byte-identical under a recursive hash and a legitimate fresh-root retry leaving its predecessor untouched; an agent that exhausts its budget is attributed to a resource limit rather than an invalid submission; `causeCounts` sums to `A`; a bare command provider is capability-ineligible, a declared and isolated one is eligible and carries a resolved image id, a run claiming isolation against an absent image is refused before any attempt, and the provider environment never reaches the retained report. Two further tests run the stub agent inside the container: one confirms the confined agent can still solve the task through the facade, the other probes from inside — using the same PATH the agent has — that the fixture source, archetype manifest, grader state and retained runs are unreachable and that the readable PATH entry carries none of the archetype's private values. They require Docker and a locally built stub image and skip — never pull — otherwise.

## Exit-criteria mapping (#237)

| Criterion | State |
|---|---|
| Small, deterministic TRAIN archetype set | met — 6 archetypes, POSIX-sh fixtures, no external dependencies |
| Covers the six output-shape failure classes | met — asserted in tests |
| Graders external to the agent, no leaked truth | met — raw-channel comparison only; expected observation never written to disk |
| Frozen baseline and candidate run under otherwise paired conditions | met — one-file difference, enforced by task-surface hash |
| Evidence identifies the stage at which improvement occurs | instrument met (stage attribution implemented and tested); **evidence pending a real-agent run** |
| No exact Study-1/2/3 bug-specific guidance used as the intervention | met — asserted in tests |
| No family-003 C0–C3 contamination | met — not used |
| No family-004 run during implementation/debugging | met — not consumed |
| Candidate content-hashed and frozen before any family-004 validation | met — `corpus/capability-grader-legible-intervention-v1.json` |
| Exact commands, environment, logs, submissions, grader results and attribution retained | met for the executed run; artifacts retained operator-side, and any rerun into a non-empty root is refused before it can overwrite them, with no same-root exception |
| Real-agent runs separated from the harness's private material | instrument met (opt-in Docker isolation, probed from inside the container); **unexercised in this record — no agent ran** |
| Real-agent runs attributable to a declared identity | instrument met (`realAgentIdentity`, required for eligibility, carries no provider environment); **unexercised in this record** |

## Decision and next steps

Implementation and harness validation are complete; the capability question is open. The supported next step is a registered real-agent paired pilot on this TRAIN set (`HONEYRAIL_CAP_GLO_PROVIDER=command`), with predeclared repetitions, before any transfer claim. Transfer validation of the frozen candidate belongs on the separately reserved unseen family-004 path ([#229](https://github.com/clemenza/honeyrail/issues/229)/[#230](https://github.com/clemenza/honeyrail/issues/230)/[#232](https://github.com/clemenza/honeyrail/issues/232)) and only after that pilot. [#232](https://github.com/clemenza/honeyrail/issues/232) stays methodology-neutral and must not consume this intervention in C0–C3.
