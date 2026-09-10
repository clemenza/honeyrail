# Experiment report: `postgres-change-002` E0–E3 real-agent transfer pilot (BUG #18574)

Applies [evaluation-report-v1](../evaluation-protocol.md). Grader truth and raw private telemetry are kept outside this report; only structural/summary facts are included.

## Registration

- Status: completed
- Experiment ID: `exp222-e0e3-dsh-2026-09-10` — owner/custodian: clemenza (operator), executed 2026-09-10
- Issue/PR and implementation dependency evidence: tracker [#222](https://github.com/clemenza/honeyrail/issues/222) (preregistered plan); prerequisite [#221](https://github.com/clemenza/honeyrail/issues/221) / [PR #223](https://github.com/clemenza/honeyrail/pull/223) (task implementation, merged); locked-constants comment posted to #222 before attempt 1 (2026-09-10)
- Question and primary hypothesis: does the already-frozen change-oriented method (task structure, generic Test-Engineer HarnessProfile, model/runtime identity, execution policy — all frozen independently of BUG #18574's outcome) transfer to an unrelated causal family (PL/pgSQL `CALL`/cached-plan invalidation after DDL), and does realistic development context (SPEC, then introducing diff, then generic HarnessProfile) improve rediscovery the way it was hypothesized to for `postgres-change-001` (#216)?
- Deliverable: diagnostic transfer pilot (`n=1` per level, trajectory/behavior analysis — not a statistically conclusive benchmark, per #222's own registration)
- Acceptance target, stop conditions and non-goals: per #222 — do not expand to `n=3`, do not rerun a valid miss, no tuning of the generic prompt/HarnessProfile/grader based on this pilot's own results or on `postgres-change-001`'s exact #16867 trajectories before this transfer pilot completed
- Amendments: none to the preregistered constants after the #222 locked comment (2026-09-10)

## Identity and task exposure

- Repository commit: `84b44e47e4623bb2965bcb2fc3f735b89bfb6079` (post-#223 `main`, dependency #221 merged)
- Task: `postgres-change-002` (`HistoricalChangeTask v0`); no corpus — single change-task, not part of the frozen blind-discovery Historical Corpus v0
- Grading protocol: `submitted-reproducer-behavioral-oracle-v1` (shared verbatim with `postgres-historical-002` via `historicalPostgresBug18574BehavioralOracle()`) — a different grading protocol from `postgres-change-001`'s `submitted-reproducer-structured-oracle-v1`; oracle content is grader-private and not reproduced here
- Model/provider/version: DeepSeek official provider, `deepseek-v4-flash` (`agent-default-model` built-in default of DSH 0.1.0-rc.7's composed headless profile, verified via `dsh --dump-config` before attempt 1). No `--patch` overlay at any level — identical model/provider/version to `postgres-change-001`.
- Agent/DSH version: `@deepseek-ai/dsh@0.1.0-rc.7`
- Resolved agent image: `honeyrail-postgres-research-agent-dsh:latest`, `sha256:26b7bc8ca5f45f3b043132743309d11baa755576872fb16e999c925fe4342ee9` — **byte-identical digest to the formal `postgres-change-001` E0–E3 run**, because `docker/postgres-research-agent-dsh/Dockerfile` and its base images have not changed since 2026-09-04, well before either pilot. All four images were rebuilt (not merely re-tagged) from that unchanged Dockerfile chain before attempt 1, confirmed via `docker build` producing the identical content digest from cache, and all four formal cells' `agent-result.json` → `isolation.imageIdentity.id` report this same digest — no image drift mid-experiment.
- Build/runtime identity: builder `sha256:f964f19cbcbf...`, runtime `sha256:8d590fde3567...` — same resolved digests as `postgres-change-001`, both `debian:bookworm-slim`-based, `aarch64-linux-gnu` / `cc (Debian 12.2.0-14+deb12u1) 12.2.0`, build profile `--without-readline --without-zlib --without-icu`
- PostgreSQL historical/reference revisions: historical `ee895a655ce4341546facd6f23e3e8f2931b96bf` ("Improve performance of repeated CALLs within plpgsql procedures", 2021-01-25) — confirmed introducing commit per #211's first-bad-commit validation; reference `7f875fb5bd603d8640cc7aca2c79c604aacd3890` ("Fix edge case in plpgsql's make_callstmt_target()", 2024-08-07) — the actual upstream fix, same `master` lineage
- Isolation policy: `restrictedEgress` via a per-trial egress-gateway sidecar, `upstreamUrl=https://api.deepseek.com`; `scoredEligible: true` on every formal attempt, verified per attempt (`isolation.restrictedEgressVerified: true`)
- Execution entry point: `npm run historical-pg-221` (`scripts/historical-postgres-221.ts` → `runHistoricalPostgresTrial()`)
- Enforced budgets: `HONEYRAIL_PG_221_AGENT_TIMEOUT_MS=1800000` (30 min) per attempt, binding; token/tool budget: not enforced by this path (observed-only, per protocol)
- Machine-readable experiment manifest: `output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/experiment-manifest.json` (frozen identity fields + per-condition `task-manifest.json`/`reference-manifest.json` hashes for E0–E3, generated with the reused, unmodified `scripts/historical-postgres-212-experiment-manifest.ts` tooling — `taskId: "postgres-change-002"`)

| Task ID | Opaque causal family | Partition | Prior development exposure | Task/context hash | Evidence custodian reference |
|---|---|---|---|---|---|
| `postgres-change-002` | PL/pgSQL `CALL`/cached-plan invalidation after DDL | change-task (not in frozen corpus) | none disclosed to the agent beyond E1+ SPEC/diff/HarnessProfile | per-level `taskDefinitionHash` in `experiment-manifest.json`'s `perConditionMaterializationHashes` | operator-local `output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/` |

## Predeclared matrix and analysis

| Task | Condition/profile | Trial indices | Model | Wall/token/tool/resource limits | Order |
|---|---|---|---|---|---|
| `postgres-change-002` | E0 (source + prompt only) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 1st |
| `postgres-change-002` | E1 (+ contemporaneous SPEC) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 2nd |
| `postgres-change-002` | E2 (+ introducing change-set diff) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 3rd |
| `postgres-change-002` | E3 (+ generic Test-Engineer HarnessProfile) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 4th |

- Independent-session and database/workspace reset policy: each level ran in its own container set (agent/runtime/egress-gateway), own internal network, own artifact directory; no shared model conversation, scratch files, or database state across levels, per #222.
- Retry policy: no retries were needed — all four attempts completed cleanly on the first try (unlike `postgres-change-001`'s one `infrastructure_error` retry at E2).
- Engineering smoke: none run separately for this pilot; the harness's plumbing (restricted egress, DSH trajectory capture, image resolution, behavioral-oracle grading) was already validated end-to-end by `postgres-change-001`'s formal run and by `postgres-change-002`'s own 31/31 `test/historical-postgres-221-*.test.ts` suite (including 10x-determinism and real two-revision attribution) immediately before attempt 1.
- Planned counts: `n=1` per level as preregistered; not expanded.
- Metric definitions: `rediscovered | miss | invalid_submission | blocked | infrastructure_error | integrity_error | unscored`, per #222's outcome-attribution table.
- Artifact retention: full per-attempt evidence retained under `output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/{E0,E1,E2,E3}/`, not committed to the repository (large, includes source trees and PostgreSQL build output).

## Attempt ledger

| Attempt / predecessor | Cell / trial index | Raw status / grade | scoredEligible / official result | Attributed cause and evidence | Time coverage | Artifact reference |
|---|---|---|---|---|---|---|
| E0 / none | E0, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission (`status: "reproduced"`), behavioral-oracle observation mismatch (see Trajectory analysis) | 313.5s agent duration | `output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/E0/` |
| E1 / none | E1, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, behavioral-oracle observation mismatch | 460.6s agent duration | `.../E1/` |
| E2 / none | E2, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, behavioral-oracle observation mismatch | 237.0s agent duration | `.../E2/` |
| E3 / none | E3, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, behavioral-oracle observation mismatch | 314.2s agent duration | `.../E3/` |

No infrastructure-error attempts occurred; every cell reached `completed`/`scoredEligible: true` on its first and only attempt.

## Results

- Planned: 4 cells (E0–E3), `n=1` each. Started: 4. Completed: 4/4. Pending/cancelled: none. Retries: 0.

| Task/partition/condition | Attempts A | Eligible E | Discoveries D (rediscovered) | End-to-end D/A | Conditional D/E |
|---|---|---|---|---|---|
| `postgres-change-002` / E0 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-change-002` / E1 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-change-002` / E2 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-change-002` / E3 | 1 | 1 | 0 | 0/1 | 0/1 |

- All four scaffolding levels missed the target oracle. As with `postgres-change-001`, per the tracker's own acceptance criteria, this is "a valid, complete experiment if the evidence is trustworthy and the report explains why" — see Trajectory analysis below.
- End-to-End Budget Success: 4/4 (every attempt reached `completed` within its 30-minute budget with a well-formed submission). Eligible Sample Rate: 4/4 (100% `scoredEligible`, restricted egress verified on every attempt). Conditional Historical Bug Rediscovery: 0/4.

## Trajectory analysis and decision

**Every attempt (E0–E3) is a `miss` with the identical diagnostic shape.** Each attempt's `finding.json` reports `status: "reproduced"` (a well-formed, valid submission), but the grader's behavioral-oracle attribution reports the same failure mode on every cell: `"Expected 2 observation(s), captured only 0."`, with both declared observation patterns unmatched (`got ""` for each). `validity.valid: true` in every case — the submissions themselves were well-formed and `scoredEligible: true`, restricted egress verified, throughout.

**Diagnosis quality diverges sharply between E0/E1 and E2/E3 — the clearest signal in this pilot.**

- **E0 and E1** (no introducing diff) independently converge on a *different, but real and plausible*, adjacent defect: a PL/pgSQL `CALL` statement's cached plan records no dependency on the called procedure's OID, so `DROP`/`CREATE PROCEDURE` in the same session leaves the cached plan pointing at a stale function OID, and the next invocation fails with `cache lookup failed for function <N>`. E0's own diagnosis names `extract_query_dependencies_walker()` (`src/backend/optimizer/plan/setrefs.c`) and `ResetPlanCache()` (`src/backend/utils/cache/plancache.c`) as the responsible functions. This is a genuine, well-localized finding in the right subsystem (PL/pgSQL `CALL` plan-cache invalidation) — but it is not the target's actual introducing mechanism, and neither `extract_query_dependencies_walker` nor `ResetPlanCache` is where the real fix landed.
- **E2 and E3** (with the introducing diff) both converge, independently, on `exec_stmt_call()` / `make_callstmt_target()` in `src/pl/plpgsql/src/pl_exec.c` — **the exact function the real 2024 fix commit patches** ("Fix edge case in plpgsql's `make_callstmt_target()`"). Both diagnoses correctly identify that the cached `CALL` statement's OUT-argument target row is computed once (`if (expr->plan == NULL)`) and never rebuilt when the plan is later revalidated to resolve a different procedure — the same mechanism the actual fix addresses. Notably, `make_callstmt_target()` is *introduced by* the E2/E3 change-set diff itself (as part of the 2021 performance optimization this diff represents caching the CALL target/plan across repeated executions), but the diff does not describe or hint at the 2024 edge-case bug; E2/E3 had to infer the downstream consequence in a file the diff modifies, for a scenario the diff's own commit message does not describe. This is second-order reasoning from the diff's mechanism, not diff-text pattern-matching.

This is a stronger and more legible signal than `postgres-change-001` produced: there, all four levels converged on the same (adjacent, non-target) subsystem regardless of diff access. Here, diff access (E2/E3) visibly and consistently shifted root-cause localization onto the actual fixed function, while its absence (E0/E1) consistently produced a different, non-target diagnosis in the same general subsystem. With `n=1` per level this is suggestive, not proof, but it is a cleaner replication of H2 ("the introducing diff improves source-reading/hypothesis-formation") than `postgres-change-001`'s own E1→E2 result, which showed an efficiency gain without a localization-quality gain.

**The downstream reproducer-construction gap recurred identically at every level, reproducing `postgres-change-001`'s central finding in an unrelated family under a different grading protocol.** Inspecting each attempt's `repro.sql` (already-retained artifacts; this report does not quote or characterize oracle content):

- **E0, E1, E2, E3** each wrap their entire pass/fail assertion inside a `DO $$ ... END $$` block with an internal `BEGIN ... EXCEPTION WHEN OTHERS` (or direct branch) that re-emits the observed condition only as `RAISE NOTICE`/`RAISE EXCEPTION` *message text*, after computing the comparison itself in PL/pgSQL. None of the four scripts lets the historical/reference differential surface as a raw, uncaught top-level `ERROR` the way the declared oracle's observation patterns are anchored against. This is structurally the same self-asserting-reproducer pattern `postgres-change-001`'s report identified at E1/E2/E3 ("the qualitative pass/fail signal is computed and consumed entirely inside the script's expression logic rather than printed as a directly legible observable") — now observed at **every** level of an unrelated family, under `submitted-reproducer-behavioral-oracle-v1` (raw-observation matching) rather than `submitted-reproducer-structured-oracle-v1` (stdout-tuple matching). The two grading protocols fail this same authoring habit in different but related ways: one wants a specific captured stdout tuple, the other wants a specific captured raw error observation; both are defeated by a script that swallows the differential inside its own internal branching logic instead of letting it propagate.

**A more precise decomposition of the four `miss` outcomes**, mirroring `postgres-change-001`'s own decomposition:

```text
source / root-cause localization:                     E0/E1 near-hit (adjacent, real, non-target); E2/E3 strong hit (target's actual function)
target invariant selection:                             incomplete at every level
historical-vs-reference discriminating reproducer:      constructed at every level, but self-asserting (see above)
grader-compatible output shape:                         incomplete at every level (same defect as postgres-change-001)
```

**Answers to the preregistered transfer questions:**

1. **Did E1 materially change behavior relative to E0?** Both converge on the same adjacent (non-target) defect and the same reproducer-construction gap. E1 used more steps (95 vs. 74) and more decode tokens (23,493 vs. 10,187) and longer wall time (460.6s vs. 313.5s) for an outcome that did not change either qualitatively (diagnosis subsystem) or in the official grade. This single run does not support a positive SPEC effect on rediscovery, echoing `postgres-change-001`'s own E0→E1 result.
2. **Did E2 materially change behavior relative to E1?** Yes, and more clearly than in `postgres-change-001`: E2 both (a) used markedly fewer steps (47 vs. 95) and less wall time (237.0s vs. 460.6s) than E1, and (b) qualitatively shifted its root-cause diagnosis onto the actual fixed function (`make_callstmt_target()`) instead of the adjacent defect E0/E1 found. This is the strongest single observation in this pilot supporting H2 (diff access improves source-reading/hypothesis quality), though `n=1`/fixed order/one model still means this is hypothesis-supporting trajectory evidence, not a causal or reliability claim.
3. **Did E3 materially change behavior relative to E2?** Step count stayed essentially flat (48 vs. 47), but wall time rose (314.2s vs. 237.0s, ~1.33x) and decode tokens rose (27,009 vs. 14,697, ~1.84x) for the identical qualitative diagnosis and the identical outcome. This is the same directional pattern `postgres-change-001` observed at E2→E3 (flat/slightly-down steps, higher wall time and tokens, no outcome gain) — replicated here under a different causal family, oracle protocol, and (necessarily) different exact HarnessProfile content applied to different task-specific input, though the HarnessProfile *text itself* is byte-identical to `postgres-change-001`'s own frozen E3 content.
4. **Which stage of the discovery process changed?** Primarily *root-cause localization* between E1 and E2 (a qualitative change, not just efficiency, unlike `postgres-change-001`'s E1→E2 which was efficiency-only) and, secondarily, *source-reading/hypothesis-formation efficiency* (step/wall-time). *Reproducer construction/output-shape discipline* — the actual bottleneck to `rediscovered` — did not change across any level, exactly as in `postgres-change-001`.
5. **Did the introducing diff reduce exploration cost/steps/wall time as it did on #16867?** Yes for E1→E2 (95→47 steps, 460.6s→237.0s), consistent with `postgres-change-001`'s E1→E2 shift (172→37 steps, 646.7s→172.0s) in direction, though a smaller relative reduction here.
6. **Did any condition produce a valid target rediscovery?** No — 0/4, same binary outcome as `postgres-change-001`.
7. **Did the same downstream reproducer/observable failure shape seen on #16867 recur in this unrelated family?** Yes, and this is the pilot's central transfer finding: a self-asserting reproducer that computes and consumes its own pass/fail signal internally, rather than letting the historical-vs-reference differential surface as a raw, grader-legible observable, recurred at all four levels here, under a structurally different grading protocol (raw-observation matching vs. stdout-tuple matching) and an unrelated bug family/subsystem. This is meaningfully stronger evidence than a single-family observation that this is a general reproducer-authoring habit rather than an artifact of `postgres-change-001`'s specific oracle format.
8. **If not, was #16867 likely task/oracle-specific rather than a generic capability gap?** Not applicable — the pattern did recur (see Q7), so this pilot does not support attributing `postgres-change-001`'s gap to that task/oracle alone.
9. **Did richer context create hindsight leakage or merely focus the search?** No hindsight-marker wording (`BUG #18574`, `make_callstmt_target` as a given answer, fix-commit-derived wording, or the canonical reproducer's own scenario) appeared in the E1 SPEC or E3 HarnessProfile inputs — both were authored/reused under #222's content-policy constraints (verified by `test/historical-postgres-221-task.test.ts`'s prompt/SPEC hindsight-marker and bug-identity-leak tests, 31/31 pass) before this pilot, and were not modified because of this pilot's results. E2/E3's correct identification of `make_callstmt_target()` is explainable as second-order reasoning from the diff's own mechanism (see above), not as a leaked answer, since the diff does not mention or describe the 2024 edge case.
10. **Is `postgres-change-002` too easy / too hard to discriminate scaffolding levels?** The uniform-`miss`-with-diverging-diagnosis-quality outcome suggests the task successfully discriminates E0/E1 from E2/E3 on localization quality, while the strict behavioral-oracle's raw-observation-matching requirement is, like `postgres-change-001`'s structured oracle, a severe discriminator on reproducer-construction style specifically — a construct-validity property of the grading contract, not evidence the task itself is miscalibrated.
11. **Is there now enough cross-family evidence to justify a Capability Lab task for a specific observed capability gap?** Yes — see Case A below. The self-asserting-reproducer/output-shape gap has now been observed at every scaffolding level across two unrelated causal families, two different grading protocols, and two different specific PostgreSQL subsystems, with `n=1` per cell in each pilot (so still not a reliability claim), but no longer a single-family observation.
12. **Is there enough evidence to justify a third unrelated HistoricalChangeTask?** See go/no-go below — recommended, primarily to further separate "reproducer output shape" (now evidenced twice) from "root-cause localization" (E2/E3's strong hit here suggests the diff-access effect on localization is itself worth testing again before treating it as established).

**Stage-wise capability interpretation.** Against the same seven-stage decomposition `postgres-change-001` used:

```text
understand requirement/change
-> identify impacted state-machine/code paths
-> formulate correctness invariant
-> choose discriminating observable
-> construct historical/reference differential experiment
-> minimize reproducer
-> encode machine-checkable submission
```

E0–E3 all reached a plausible subsystem; E2/E3 reached the *actual* target subsystem/function, a qualitatively stronger result at the early-to-middle stages than `postgres-change-001` achieved at any level. All four constructed a real historical/reference differential experiment (their own described scenario does reproduce a genuine defect on the supplied build, per each `finding.json`'s internal logic). But all four failed at the *encode machine-checkable submission* stage: the differential's observable was computed internally and never allowed to surface as the grader's expected raw observation. This isolates the bottleneck more precisely than `postgres-change-001`'s report could alone — it is not root-cause localization, and (per Q2/Q3 above) diff access can visibly improve localization — the unresolved gap is specifically reproducer-output-shape discipline.

**Answers to the required decision-gate case:**

### Case A: #18574 shows the same downstream reproducer/observable failure pattern — **this case applies**

Per Q7 above, `postgres-change-002` reproduced `postgres-change-001`'s self-asserting-reproducer/output-shape failure pattern at all four scaffolding levels, under a different grading protocol and an unrelated causal family. Per #222's predeclared interpretation policy for this case:

- There is now unrelated-family evidence that reproducer construction/minimization or grader-visible observable design is a reusable capability gap, not an artifact of `postgres-change-001`'s specific task/oracle.
- Recommended next action (per #222, applied literally): open a narrowly scoped Capability Lab issue targeting this evidenced capability (grader-legible observable construction / avoiding self-asserting-only reproducers); do not tune on `postgres-change-002` and then claim improvement on `postgres-change-002`; validate any intervention on another unseen historical family.

Cases B, C, and D do not apply: outcome did not flip in either direction relative to `postgres-change-001` (both are uniform `miss`, so Case B's "rediscovered here, missed there" does not hold), source/hypothesis localization was not the earliest failure point (Case C requires an earlier-stage failure; here localization at E2/E3 was strong), and no infrastructure or eligibility issue occurred (Case D requires infrastructure/eligibility to dominate; all four attempts were clean `completed`/`scoredEligible: true` with zero retries).

**Session/cost summary** (from `agent-session-stats.json` per attempt; token/tool budget not enforced, recorded as observed-only):

| Level | Turns | Steps | Agent duration | LLM time | Decode tokens |
|---|---|---|---|---|---|
| E0 | 1 | 74 | 313.5s | 298.2s | 10,187 |
| E1 | 1 | 95 | 460.6s | 451.0s | 23,493 |
| E2 | 1 | 47 | 237.0s | 228.9s | 14,697 |
| E3 | 1 | 48 | 314.2s | 304.1s | 27,009 |

## Cross-family comparison against `postgres-change-001` (#216/#220)

| Dimension | `postgres-change-001` (BUG #16867, transaction-chaining) | `postgres-change-002` (BUG #18574, PL/pgSQL CALL cached-plan) |
|---|---|---|
| Grading protocol | `submitted-reproducer-structured-oracle-v1` (stdout tuple match) | `submitted-reproducer-behavioral-oracle-v1` (raw observation match) |
| Outcome, all levels | `miss` (4/4) | `miss` (4/4) |
| Infrastructure retries | 1 (E2, driver process killed; superseded by a clean retry) | 0 |
| Root-cause localization | Uniform near-hit at every level (same subsystem/state-machine area regardless of diff access) | Diverges: E0/E1 near-hit on an adjacent, non-target defect; E2/E3 strong hit on the actual fixed function |
| E1→E2 effect | Efficiency only (steps 172→37, wall 646.7s→172.0s), no diagnosis-quality change | Both efficiency (steps 95→47, wall 460.6s→237.0s) **and** diagnosis-quality change (adjacent defect → actual fixed function) |
| E2→E3 effect | Steps flat (37→33), wall time up (~1.73x), tokens up (~3.54x), no outcome change | Steps flat (47→48), wall time up (~1.33x), tokens up (~1.84x), no outcome change — same direction, smaller magnitude |
| Downstream reproducer-construction gap | Present at every level (self-asserting DO-block scripts; extra diagnostic rows / no raw observable) | Present at every level (self-asserting DO-block scripts; RAISE NOTICE/EXCEPTION instead of raw ERROR) — **same construct-validity pattern, different grading protocol** |
| Hindsight/contamination check | N/A (originating pilot) | No #16867-derived wording found in E1 SPEC or E3 HarnessProfile; E3 HarnessProfile proven byte-identical to `postgres-change-001`'s frozen content by an automated test |

**Interpretation.** The E2→E3 wall-time/token regression without outcome gain, and the uniform downstream reproducer-construction gap, both replicate directionally across two unrelated families, two grading protocols, and (for the wall-time/token pattern) the same generic HarnessProfile content applied to different task-specific context. This is now transfer evidence, not single-task evidence, for: (a) the generic Test-Engineer HarnessProfile costing more without a measured benefit on this backend/model at this budget, and (b) reproducer-output-shape discipline being a genuine, recurring gap rather than an artifact of one task's oracle design. The E1→E2 *diagnosis-quality* shift (not just efficiency) is new in this pilot and was not observed in `postgres-change-001`; it is the strongest evidence so far that diff access specifically helps root-cause localization, and is itself worth testing on a third unrelated family before treating it as established (per the go/no-go recommendation below).

## Predeclared transfer questions — see "Answers to the preregistered transfer questions" (Trajectory analysis section above); all twelve are addressed there.

## Go/no-go decision

- **Capability Lab**: **go**, narrowly scoped to grader-legible observable/reproducer-output-shape construction — evidenced at every level across two unrelated families and two grading protocols (Case A above). Do not tune on either `postgres-change-001` or `postgres-change-002` and then claim improvement on the same case; validate any intervention on a third, unseen historical family.
- **Third unrelated HistoricalChangeTask**: **go**. Primary reasons: (1) further separate the reproducer-output-shape gap (now evidenced twice, good candidate for a Capability Lab fix) from the diff-access-improves-localization effect (evidenced clearly for the first time here, still `n=1`/one-family for that specific claim); (2) the E2→E3 HarnessProfile cost-without-benefit pattern has now replicated in direction across two families and is worth a third data point before treating it as a stable finding worth acting on; (3) both pilots so far used the identical DeepSeek/DSH backend — a third pilot is also the natural point to consider (as a separate, explicitly predeclared decision) whether to hold backend/model fixed again or begin a controlled backend comparison, per #222's own "prefer keeping ... identical when practical" guidance for *this* pilot, not necessarily forever.

## Verification and closure

- `npm run typecheck`: clean at the frozen commit (`84b44e47e4623bb2965bcb2fc3f735b89bfb6079`).
- `test/historical-postgres-221-task.test.ts` + `test/historical-postgres-221-integration.test.ts`: 31/31 pass (with `HONEYRAIL_PG_221_MIRROR`/`_REPRODUCER`/`_FIX_EVIDENCE` configured against the operator-private mirror/reproducer/fix-evidence) — includes the 10x-determinism attribution checks, the real two-revision verification, the E3 HarnessProfile byte-identity check, and the no-leak/no-hindsight-marker checks, run immediately before attempt 1.
- Real-model formal checks: 4/4 attempts reached `status: completed`, `scoredEligible: true` (restricted egress verified per attempt), DSH trajectory evidence persisted per attempt (`agent-transcript.ndjson`, `agent-trajectory.jsonl`), zero infrastructure retries.
- Docker image provenance: all five images (`honeyrail-postgres-builder`, `honeyrail-postgres-runtime`, `honeyrail-postgres-research`, `honeyrail-postgres-egress-gateway`, `honeyrail-postgres-research-agent-dsh`) rebuilt from their unchanged Dockerfiles at the frozen commit before attempt 1; all resolved to digests identical to the formal `postgres-change-001` run, confirming a reproducible build rather than a stale reused tag.
- Public-artifact sanitization review: this report contains no grader-private oracle observation strings, no canonical-reproducer contents, and no fix-evidence diff contents — reviewed before publication. `repro.sql` contents are described only by their structural properties (self-asserting `DO $$` block, `RAISE NOTICE`/`EXCEPTION` usage) and by the agents' own `finding.json` prose, which HoneyRail's own leak-check tests (`test/historical-postgres-221-task.test.ts`) already confirm does not itself contain bug-identity or hindsight-marker text.
- Acceptance checklist mapped to evidence: preregistered constants locked before attempt 1 ✓ (comment posted to #222, 2026-09-10, before any attempt); task implementation (#221/PR #223) already merged and unchanged during formal execution ✓; E3 used the exact same frozen HarnessProfile as `postgres-change-001`, proven by automated test ✓; no #16867-derived prompt/methodology tuning occurred before this transfer test ✓ (task materialization authored in PR #223 before this pilot ran, per #221's own instruction); four formal E0–E3 cells completed, zero retries needed ✓; every attempt has a unique attempt ID (`E0`/`E1`/`E2`/`E3`, no collisions, no retries to link) ✓; scored eligibility and restricted egress evidenced per formal attempt ✓; every completed cell has inspectable trajectory + grader evidence ✓; primary results remain the authoritative grader outcomes (all four `miss`, no promotion of the diagnostic near-hits) ✓; stage-wise trajectory analysis complete for every valid completed attempt ✓; comparative E0/E1/E2/E3 conclusions evidence-backed ✓; cross-family comparison against `postgres-change-001` explicit, without overclaiming (`n=1` per cell in each pilot noted throughout) ✓; End-to-End Budget Success / Eligible Sample Rate / Conditional Historical Bug Rediscovery reported together ✓; public report sanitized ✓; go/no-go recorded for Capability Lab and for a third unrelated HistoricalChangeTask ✓; no same-case tuning presented as transfer evidence ✓ (nothing in the task, HarnessProfile, or grader was changed because of this pilot's own results before or during its execution).
- Issue disposition: #222's formal E0–E3 transfer pilot is complete. This report, the locked preregistration comment, the raw attempt ledger under `output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/` (gitignored, operator-local), and the machine-readable experiment manifest are the deliverables named in #222's "Final deliverables" list. Follow-up: opening the Capability Lab issue and selecting a third unrelated HistoricalChangeTask are separate, not-yet-filed issues per #222's own non-goals ("No Capability Lab implementation until the transfer evidence is analyzed").
