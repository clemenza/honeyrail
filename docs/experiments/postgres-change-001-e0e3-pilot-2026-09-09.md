# Experiment report: `postgres-change-001` E0–E3 real-agent pilot (BUG #16867)

Applies [evaluation-report-v1](../evaluation-protocol.md). Grader truth and raw private telemetry are kept outside this report; only structural/summary facts are included.

## Registration

- Status: completed
- Experiment ID: `exp216-e0e3-dsh-2026-09-09` — owner/custodian: clemenza (operator), executed 2026-09-10
- Issue/PR and implementation dependency evidence: tracker [#216](https://github.com/clemenza/honeyrail/issues/216) (preregistered plan + locked constants comment); prerequisite [#217](https://github.com/clemenza/honeyrail/pull/217) (restricted-egress wiring, merged); experiment-manifest implementation [#219](https://github.com/clemenza/honeyrail/pull/219); exit-code evidence gap [#218](https://github.com/clemenza/honeyrail/issues/218) (non-blocking, filed separately)
- Question and primary hypothesis: does realistic development context (SPEC, then introducing diff, then generic Test-Engineer methodology) improve rediscovery of PostgreSQL BUG #16867 (transaction-chaining `COMMIT AND CHAIN`/`ROLLBACK AND CHAIN` interacting with `SAVEPOINT`)?
- Deliverable: diagnostic pilot (`n=1` per level, trajectory/behavior analysis — not a statistically conclusive benchmark, per #216's own registration)
- Acceptance target, stop conditions and non-goals: per #216 — do not expand to `n=3`, do not rerun a valid miss, no tuning on this case before #18574 transfer validation
- Amendments: none to the preregistered constants after the #216 locked comment (2026-09-09). The E0 engineering dry run (`DRY-RUN-E0/`, same experiment ID, executed 2026-09-09 from the pre-merge PR #217 branch) remains excluded from this ledger per that comment and the [post-smoke clarification](https://github.com/clemenza/honeyrail/issues/216#issuecomment-5614855743).

## Identity and task exposure

- Repository commit: `7f5d0f76769cb4d4b729000265205ccec004de2d` (post-#217 `main`)
- Task: `postgres-change-001` (`HistoricalChangeTask v0`); no corpus — single change-task, not part of the frozen blind-discovery Historical Corpus v0
- Grading protocol: `submitted-reproducer-structured-oracle-v1`; oracle content is grader-private and not reproduced here
- Model/provider/version: DeepSeek official provider, `deepseek-v4-flash` (`agent-default-model` built-in default of DSH 0.1.0-rc.7's composed headless profile). No `--patch` overlay at any level.
- Agent/DSH version: `@deepseek-ai/dsh@0.1.0-rc.7`
- Resolved agent image: `honeyrail-postgres-research-agent-dsh:latest`, `sha256:26b7bc8ca5f45f3b043132743309d11baa755576872fb16e999c925fe4342ee9` — rebuilt fresh from the frozen repository commit's Dockerfiles for this pilot (differs from the engineering dry run's digest, which was built a day earlier from base images available at that time; recorded honestly rather than reused for convenience)
- Build/runtime identity: builder `sha256:f964f19cbcbf...`, runtime `sha256:8d590fde3567...`, both `debian:bookworm-slim`-based, `aarch64-linux-gnu` / `cc (Debian 12.2.0-14+deb12u1) 12.2.0`, build profile `--without-readline --without-zlib --without-icu`
- PostgreSQL historical/reference revisions: historical `280a408b48d5ee42969f981bceb9e9426c3a344c` ("Transaction chaining", 2019-03-24, PG 12devel), reference `fadcc4e81bd99e6032ae042cae53be0c6eea7580` ("Fix bug in COMMIT AND CHAIN command.", REL_12_STABLE, 2021-02-19)
- Isolation policy: `restrictedEgress` via a per-trial egress-gateway sidecar, `upstreamUrl=https://api.deepseek.com`; `scoredEligible: true` on every formal attempt, verified per attempt (`isolation.restrictedEgressVerified: true`)
- Execution entry point: `npm run historical-pg-212` (`scripts/historical-postgres-212.ts` → `runHistoricalPostgresTrial()`)
- Enforced budgets: `HONEYRAIL_PG_212_AGENT_TIMEOUT_MS=1800000` (30 min) per attempt, binding; token/tool budget: not enforced by this path (observed-only, per protocol)
- Machine-readable experiment manifest: `output/historical-pg-212/exp216-e0e3-dsh-2026-09-09/experiment-manifest.json` (frozen identity fields + per-condition `task-manifest.json` hashes for E0–E3)

| Task ID | Opaque causal family | Partition | Prior development exposure | Task/context hash | Evidence custodian reference |
|---|---|---|---|---|---|
| `postgres-change-001` | transaction-chaining (`COMMIT`/`ROLLBACK AND CHAIN` × `SAVEPOINT`) | change-task (not in frozen corpus) | none disclosed to the agent beyond E1+ SPEC/diff/HarnessProfile | per-level `taskDefinitionHash` in `experiment-manifest.json`'s `perConditionMaterializationHashes` | operator-local `output/historical-pg-212/exp216-e0e3-dsh-2026-09-09/` |

## Predeclared matrix and analysis

| Task | Condition/profile | Trial indices | Model | Wall/token/tool/resource limits | Order |
|---|---|---|---|---|---|
| `postgres-change-001` | E0 (source + prompt only) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 1st |
| `postgres-change-001` | E1 (+ contemporaneous SPEC) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 2nd |
| `postgres-change-001` | E2 (+ introducing change-set diff) | 1 (2 attempts: 1 infrastructure_error, 1 completed) | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 3rd |
| `postgres-change-001` | E3 (+ generic Test-Engineer HarnessProfile) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 4th |

- Independent-session and database/workspace reset policy: each level ran in its own container set (agent/runtime/egress-gateway), own internal network, own artifact directory; no shared model conversation, scratch files, or database state across levels, per #216.
- Retry policy: E2's first attempt failed before agent completion for infrastructure reasons (driving process was killed by the local orchestration environment, unrelated to the agent/harness/grader). Retained in full as `E2-ATTEMPT-1-INFRASTRUCTURE-ERROR/` (never deleted, never silently rerun over). `E2-ATTEMPT-2` is a new attempt ID, linked to its predecessor, run with a process-detachment method immune to the same interruption, and is the attempt that counts toward this ledger.
- Engineering smoke IDs excluded by prior designation: `DRY-RUN-E0/` (same experiment ID, executed 2026-09-09 from the pre-merge PR #217 branch; see the #216 post-smoke clarification comment).
- Planned counts: `n=1` per level as preregistered; not expanded.
- Metric definitions: `rediscovered | miss | invalid_submission | blocked | infrastructure_error | integrity_error | unscored`, per #216's outcome-attribution table.
- Artifact retention: full per-attempt evidence retained under `output/historical-pg-212/exp216-e0e3-dsh-2026-09-09/{E0,E1,E2,E2-ATTEMPT-1-INFRASTRUCTURE-ERROR,E3}/`, not committed to the repository (large, includes source trees and PostgreSQL build output).

## Attempt ledger

| Attempt / predecessor | Cell / trial index | Raw status / grade | scoredEligible / official result | Attributed cause and evidence | Time coverage | Artifact reference |
|---|---|---|---|---|---|---|
| E0 / none | E0, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, structured-oracle mismatch (see Trajectory analysis) | 597.9s agent duration | `output/historical-pg-212/exp216-e0e3-dsh-2026-09-09/E0/` |
| E1 / none | E1, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, structured-oracle mismatch | 646.7s agent duration | `.../E1/` |
| E2-ATTEMPT-1 / none | E2, trial 1 | *(no result — driver killed before agent completion)* | n/a / n/a | `infrastructure_error` (orchestration environment interruption, not agent/harness/grader) | ~6 min before interruption; no scored evidence produced | `.../E2-ATTEMPT-1-INFRASTRUCTURE-ERROR/` |
| E2-ATTEMPT-2 / E2-ATTEMPT-1 | E2, trial 1 (retry) | `completed` / `miss` | `true` / `miss` | Valid submission, structured-oracle mismatch | 172.0s agent duration | `.../E2/` |
| E3 / none | E3, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, structured-oracle mismatch | 297.4s agent duration | `.../E3/` |

## Results

- Planned: 4 cells (E0–E3), `n=1` each. Started: 4 (+1 infrastructure retry). Completed: 4/4. Pending/cancelled: none.
- No unfinished cell; the one non-scored attempt (E2-ATTEMPT-1) was superseded by a completed retry under the tracker's retry policy and does not affect the 4-cell result below.

| Task/partition/condition | Attempts A | Eligible E | Discoveries D (rediscovered) | End-to-end D/A | Conditional D/E |
|---|---|---|---|---|---|
| `postgres-change-001` / E0 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-change-001` / E1 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-change-001` / E2 | 1 (2 raw attempts, 1 `infrastructure_error` excluded) | 1 | 0 | 0/1 | 0/1 |
| `postgres-change-001` / E3 | 1 | 1 | 0 | 0/1 | 0/1 |

- All four scaffolding levels missed the target oracle. Per #216's own acceptance criteria, this is "a valid, complete experiment if the evidence is trustworthy and the report explains why" — see Trajectory analysis below.
- Unexpected findings retained for separate adjudication (no automatic target credit): at every level, the agent submitted a `status: "reproduced"` finding whose root-cause description is semantically about the same defect family as the target (COMMIT AND CHAIN silently failing to restart/restore transaction characteristics when a live SAVEPOINT/subtransaction is active, localized to the `TBLOCK_SUBCOMMIT` case of `CommitTransactionCommand()` in `src/backend/access/transam/xact.c`) — see below.

## Trajectory analysis and decision

**Every attempt (E0–E3) is a `miss` with the identical diagnostic shape**: `grader/grade.json`'s `historicalMatch`/`referenceMatch` both report a row-count mismatch against the declared single-row oracle expectation (`"Expected exactly 1 row(s), got 6/15/8/7."` for E0/E1/E2/E3 respectively), not a content mismatch reported independently of row count. `validity.valid: true` in every case — the submissions themselves were well-formed.

**Diagnosis consistency across levels.** Each level's `finding.json` independently converges on the same underlying mechanism: `COMMIT AND CHAIN` (E0's variant additionally explores `ROLLBACK`/`ABORT AND CHAIN`) issued while a live `SAVEPOINT`/subtransaction is open commits successfully but the `TBLOCK_SUBCOMMIT` branch of `CommitTransactionCommand()` does not perform the `StartTransaction()` + `RestoreTransactionCharacteristics()` sequence that the `TBLOCK_END`/`TBLOCK_ABORT_END`/`TBLOCK_ABORT_PENDING` branches do — so the chained transaction silently falls back to session-default characteristics instead of the just-finished transaction's isolation level/read-only/deferrable settings. This is the same subsystem, same file, and (per each finding's own described mechanism) the same class of state-machine gap as the target's introducing commit — not a different bug family from the near-neighbor BUG #15977 the engineering dry run surfaced.

**Root-cause diagnosis quality was not the limiting factor here; reproducer construction was.** Every one of the four agent-authored reproducers wraps its diagnostic `SHOW`/`current_setting()` observation in additional `SELECT`/`DO $$...$$`/`RAISE NOTICE` scaffolding intended to make the script self-assert pass/fail via exit status (per the task's own submission contract). That additional structure produces more output rows than the oracle's exact single-row expectation, which is consistent with (though not conclusively proven to be the *sole* cause of, since the grader short-circuits on row count before checking content) every `miss`. Separately, none of the four reproducers include an initial non-savepoint `COMMIT AND CHAIN` before the savepoint is opened — `docs/historical-postgres-task-v0.md`'s "Note on `SaveTransactionCharacteristics()` priming" documents that this priming statement is required for the corrected/reference build to restore a meaningful (rather than uninitialized-default) saved characteristic, which is an independent, real methodological gap in every submitted reproducer regardless of scaffolding level.

**Answers to the preregistered analysis questions:**

1. **Did E1 materially change behavior relative to E0?** Partially. E1's diagnosis broadened (explicitly covers both the savepoint path and a second, related "transaction already aborted by a top-level error" path) and used more turns/steps (172 steps / 3 turns vs. E0's 94 steps / 1 turn — see session stats below), consistent with H1 (SPEC prompts more targeted invariant articulation). It did not change the reproducer-construction gap that caused the miss.
2. **Did E2 materially change behavior relative to E1?** Yes, on efficiency: E2 reached the same diagnosis in 37 steps / 1 turn (171.9s agent duration) versus E1's 172 steps / 3 turns (646.7s) — a roughly 4x reduction in both step count and wall time, consistent with H2 (the introducing diff shifts budget from broad exploration toward change-focused probing). Diagnosis content and the reproducer-shape gap were unchanged.
3. **Did E3 materially change behavior relative to E2?** Not substantially. E3 (33 steps / 1 turn, 297.4s) stayed in the same efficiency range as E2 and reproduced the identical diagnosis and the identical reproducer-construction gap (no priming statement, extra diagnostic rows). The generic HarnessProfile's boundary/invariant-enumeration guidance did not visibly change reproducer minimization discipline in this run.
4. **Which stage of the discovery process changed?** Primarily *source-reading and hypothesis-formation efficiency* (step/turn count, wall time) between E1 and E2. *Reproducer construction discipline* — arguably the actual bottleneck to a `rediscovered` verdict — did not change across any level.
5. **Did richer context improve actual verified rediscovery, or only produce more plausible reasoning?** Neither in the binary sense (all four missed), but richer context (E2 specifically) improved diagnostic efficiency without improving the specific construct (reproducer output shape) the grader checks.
6. **Did richer context increase irrelevant search, tool use, or cost?** No — E2/E3 used markedly *less* tool/LLM time than E0/E1, the opposite of the confound risk registered in #216.
7. **Did any scaffolding level introduce answer leakage or hindsight bias?** No hindsight-marker wording (`SAVEPOINT`-as-answer framing, `TBLOCK_SUBCOMMIT`, `BUG #16867`, or fix-derived wording) was present in the E1 SPEC or E3 HarnessProfile inputs — both were authored under #216's own content-policy constraints before this pilot and were not modified because of this pilot's results.
8. **Is `postgres-change-001` too easy / too hard to discriminate scaffolding levels?** The uniform-miss outcome combined with a uniform, close-to-correct diagnosis at every level suggests the task is not too hard for locating the defect class, but the structured-oracle grading's strict single-row-match requirement may be too strict a discriminator for *this* task's submission contract — a construct-validity concern (see below), not a task-difficulty one.
9. **What capability gaps were observed?** Reproducer-output minimization/shape discipline (self-asserting scripts add diagnostic scaffolding that the strict oracle format does not tolerate) and, independently, priming-statement omission — both recurred identically at every scaffolding level and were not resolved by added context or generic test-engineering methodology.
10. **Which gaps, if any, should be pulled into the Capability Lab (M3)?** Reproducer output-shape minimization for structured-oracle-graded tasks is a plausible, narrowly-scoped capability-lab candidate; this pilot's `n=1`-per-level evidence is suggestive, not sufficient, to prioritize it.
11. **Is there enough evidence to justify converting BUG #18574 into the next change-oriented validation task?** Yes — this pilot is a complete, trustworthy engineering/behavior sample (no infrastructure blockers survived into the scored ledger, all four levels produced inspectable, valid submissions). It does not by itself establish rediscovery capability at any scaffolding level for this causal family, but it validates the harness end-to-end under real formal conditions, which is the prerequisite #216 registered this pilot to close.
12. **What must be frozen before #18574 is used as an unseen transfer test?** Per #216: do not tune the HarnessProfile, prompt, or methodology based on this pilot's exact trajectories before running #18574 (this report's reproducer-shape observation is retained as TRAIN evidence, not applied to #18574's task construction); freeze task materialization, HarnessProfile identity/hash, agent/model identity, and restricted-egress wiring identically to this pilot before that unrelated-family run.

**Session/cost summary** (from `agent-session-stats.json` per attempt; token/tool budget not enforced, recorded as observed-only):

| Level | Turns | Steps | Agent duration | LLM time | Decode tokens |
|---|---|---|---|---|---|
| E0 | 1 | 94 | 597.9s | 517.6s | 23,963 |
| E1 | 3 | 172 | 646.7s | 949.7s (overlapped across turns) | 63,898 |
| E2 (attempt 2) | 1 | 37 | 172.0s | 164.9s | 7,831 |
| E3 | 1 | 33 | 297.4s | 289.0s | 27,756 |

- What this experiment supports: the restricted-egress/DSH-trajectory/structured-oracle pipeline for `postgres-change-001` works end-to-end under real formal conditions at every scaffolding level; richer context measurably changed agent efficiency (E1→E2) without changing outcome; the specific construct (reproducer output shape) that gated every `miss` is now identified with evidence, not merely hypothesized.
- What this experiment cannot establish: any reliability/leaderboard claim (`n=1` per level, single model/provider); whether a corrected reproducer-format prompt would flip any of these four to `rediscovered` (that would be tuning on this exact case, explicitly out of scope here); whether this pattern generalizes to `postgres-change-001`'s DSH/DeepSeek combination specifically or is a general reproducer-authoring habit.
- Exposure/pretraining limitations: `deepseek-v4-flash`'s training-data exposure to this specific, real, previously-fixed PostgreSQL defect (introducing commit dated 2019, fix dated 2021) is unknown and not controlled for in this design, per #216's own registration.
- Decision: **retain** as a complete, trustworthy formal pilot. Recommend a **go** on converting BUG #18574 into the next `HistoricalChangeTask` for unrelated-causal-family transfer validation, per #216's follow-up sequence — this pilot's outcome (uniform miss with a construct-validity-relevant near-diagnosis) is itself valuable, reportable evidence, not a blocker.
- Next smallest intervention, if justified: none inside this experiment (per #216, tuning on this exact case is prohibited before #18574). A candidate follow-up *design* note (not implemented here): consider whether a future task version's submission contract should describe expected reproducer output shape more explicitly, evaluated only on unseen tasks per #216's TRAIN/contamination rule.

## Verification and closure

- `npm run typecheck`: clean at the frozen commit (`7f5d0f76769cb4d4b729000265205ccec004de2d`).
- `test/historical-postgres-212-task.test.ts` + `test/historical-postgres-212-integration.test.ts` + `test/historical-pg-trialset.test.ts`: 86 pass / 7 skipped (require live Docker/env, not applicable to typecheck-time CI) / 0 failed.
- `test/historical-postgres-212-experiment-manifest.test.ts` (new, PR #219): 5/5 pass.
- Real-model formal checks: 4/4 attempts reached `status: completed`, `scoredEligible: true` (restricted egress verified per attempt), DSH trajectory evidence persisted per attempt (`agent-transcript.ndjson`, `agent-trajectory.jsonl`).
- Failure signatures, reruns, fixes and residual follow-ups: one `infrastructure_error` (E2-ATTEMPT-1, driver process killed by the local orchestration environment mid-run), retained and superseded by E2-ATTEMPT-2 per retry policy; no fix required in harness code — cause was environmental, not a defect in `historical-postgres-212.ts`/`historical-task.ts`. `agent-trajectory.jsonl`'s `exit_code: null` gap (tracked in #218) observed again in these formal attempts, non-blocking per the same criteria as the engineering dry run (authoritative transcript retained, stdout reconstructable, grader/trial status unaffected).
- Public-artifact sanitization review: this report contains no grader-private oracle tuples, no canonical-reproducer contents, and no `private-truth.json`/`fix-evidence.diff`/`known-repro.sql` contents — reviewed before publication.
- Acceptance checklist mapped to evidence: preregistered constants locked before attempt 1 (#216 comment, 2026-09-09) ✓; all four attempts completed or explicitly accounted for including the linked retry ✓; no failed attempt disappeared from the record ✓; non-dataset outcomes correctly attributed (E2-ATTEMPT-1 is `infrastructure_error`, never counted as a miss) ✓; identities frozen and recorded in `experiment-manifest.json` ✓; no hidden bug report/fix commit/canonical reproducer/oracle exposed to the scored agent (task materialization uses only `spec.md`/`change-set.diff`/`harness-profile.md` per the existing #212/#213 content-policy machinery) ✓; each attempt has inspectable evidence per the Evidence requirements list ✓; each miss has a completed trajectory-process analysis (above) ✓; at least one comparative conclusion supported by observed evidence (E1→E2 efficiency shift) ✓; no same-case tuning presented as transfer evidence ✓; go/no-go recorded for BUG #18574 ✓ (go).
- Issue disposition: #216's formal E0–E3 pilot is complete; this report is the deliverable named in #216's "Final deliverables" item 6/7. Follow-up: converting BUG #18574 into a second `HistoricalChangeTask` is a separate, not-yet-filed issue per #216's explicit non-goals.
