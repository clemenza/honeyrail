# Experiment report: `postgres-historical-003` E0–E3 within-family sibling replication (BUG #18118)

Applies [evaluation-report-v1](../evaluation-protocol.md). Grader truth and raw private telemetry are kept outside this report; only structural/summary facts are included.

**This is Study 3: a within-family sibling-defect replication, not an independent cross-family transfer result.** `postgres-historical-003`'s target (BUG #18118) and Study 1's `postgres-change-001` target (BUG #16867) are sibling defects in the same broader transaction-chaining feature family, both tracing to introducing commit `280a408b48d5ee42969f981bceb9e9426c3a344c` ("Transaction chaining", 2019-03-24). This must never be aggregated with Study 2 (`postgres-change-002`, an unrelated PL/pgSQL/cache-invalidation family) as a second independent cross-family observation.

## Registration

- Status: completed
- Experiment ID: `exp233-e0e3-dsh-2026-09-11` — owner/custodian: clemenza (operator), executed 2026-09-11
- Issue and preregistration: tracker [#233](https://github.com/clemenza/honeyrail/issues/233) (locked constants comment posted before attempt 1, 2026-09-11); prerequisite implementation issue [#234](https://github.com/clemenza/honeyrail/issues/234) / PR [#235](https://github.com/clemenza/honeyrail/pull/235) (E0-E3 scaffolding compatibility fix for Task 003, merged before attempt 1)
- Question and primary hypothesis: with the frozen Historical PG Task 003 source/oracle (#199/#201) and the same E0-E3 treatment semantics used in Studies 1/2, do SPEC, introducing-diff access, and the frozen generic HarnessProfile produce the same stage-level effects on a sibling transaction-chaining defect (BUG #18118) that they produced on Study 1's BUG #16867?
- Deliverable: within-family sibling replication (`n=1` per level — diagnostic, not a statistically conclusive benchmark)
- Acceptance target, stop conditions and non-goals: per #233 — do not expand to `n=3`, do not rerun a valid miss, no tuning on this case, do not present as an independent third causal family, do not modify #232's plan
- Amendments: none to the preregistered constants after the #233 locked comment (2026-09-11)

## Identity and task exposure

- Repository commit: `b7b99162a093302fea8a346fa44623d89c74892f` (post-#235 `main`)
- Task: `postgres-historical-003` (opaque; corpus slot `pg-hist-xact-chain-savepoint-003`, #185/#199/#201); part of the frozen Corpus v0, used here through the new optional `scaffoldingLevel`/`changeContext` parameters added in #235 — the frozen Corpus v0 scoring path itself is unchanged (default-argument calls are byte-identical to before #235, proven by `test/historical-postgres-003-task.test.ts`)
- Grading protocol: `submitted-reproducer-structured-oracle-v1`; oracle content is grader-private and not reproduced here (Task 003's own pre-existing, already-validated oracle from #199/#201 — unaffected by scaffolding level)
- Model/provider/version: DeepSeek official provider, `deepseek-v4-flash` (verified via `dsh --profile headless --dump-config` inside the built agent image before attempt 1). No `--patch` overlay at any level. Identical to Studies 1/2.
- Agent/DSH version: `@deepseek-ai/dsh@0.1.0-rc.7`, identical to Studies 1/2
- Resolved agent image: `honeyrail-postgres-research-agent-dsh:latest`, `sha256:0201ea99a292767382fb72bbfb0493e29da1f04d4814c07df47c92904e65a804` — rebuilt fresh from the unchanged Dockerfile chain at the commit above (different digest from Studies 1/2's own recorded digests because those were built on a different machine at a different time; the Dockerfiles themselves are unchanged since Study 2)
- Build/runtime identity: builder `honeyrail-postgres-builder:latest` (`sha256:363d8ca89c4fd2803ccdd3587559a47f19c1bd02c49ba34095b3f4ae8ddeaebb`), runtime `honeyrail-postgres-runtime:latest` (`sha256:71eed7865e5128b5a569c7e2ec051cb0c0ab1392870c812f83af11aa5f2d2440`), both `debian:bookworm-slim`-based, `aarch64-linux-gnu` / `cc (Debian 12.2.0-14+deb12u1) 12.2.0`, build profile `--without-readline --without-zlib --without-icu` — same profile as Studies 1/2
- PostgreSQL historical/reference revisions: operator-private, per #199/#201's existing Corpus v0 disclosure policy (not posted in this report or the preregistration comment, consistent with #199/#201's own precedent — unlike Studies 1/2's change-tasks, which disclosed their revisions because those facts were already public before the task existed). Both confirmed present and diffable in the local mirror before attempt 1.
- Introducing change shown at E2/E3: `280a408b48d5ee42969f981bceb9e9426c3a344c` (public, already named in #233's own issue text) — `changeContext.allowHistoricalSourceDivergence: true` (#235) intentionally decouples this shown commit from the task's own frozen historical/reference revisions, per #233's "Source/snapshot rule"
- SPEC (E1+): byte-for-byte reuse of Study 1's `historicalPostgresChange16867Spec()`, sha256 `38feaf21c6fce5cee057b0fe7b3df23c2418e8b0741d438d684470a710613452`
- HarnessProfile (E3): byte-for-byte reuse of Study 1/2's `historicalPostgresChange16867HarnessProfile()`, sha256 `d8933502d1697c71addab3c027c0c5066bbb3a41fc2ead4a55f357386880339a` — identical to the value recorded for Study 2's own E3 `harness-profile.md`
- Isolation policy: `restrictedEgress` via a per-trial egress-gateway sidecar, `upstreamUrl=https://api.deepseek.com`; `scoredEligible: true` on every formal attempt, verified per attempt
- Execution entry point: `npm run historical-pg-199` (`scripts/historical-postgres-199.ts` → `runHistoricalPostgresTrial()`), extended in #235 with `HONEYRAIL_PG_199_SCAFFOLDING`, `HONEYRAIL_PG_199_EGRESS_UPSTREAM_URL`, `HONEYRAIL_PG_199_AGENT_TRAJECTORY`
- Enforced budgets: `HONEYRAIL_PG_199_AGENT_TIMEOUT_MS=1800000` (30 min) per attempt, binding; token/tool budget not enforced by this path (observed-only)
- Machine-readable experiment manifest: `output/historical-pg-199/exp233-e0e3-dsh-2026-09-11/experiment-manifest.json` (frozen identity fields + per-condition `task-manifest.json` hashes for E0–E3, generated with the reused, unmodified `scripts/historical-postgres-212-experiment-manifest.ts` tooling — `taskId: "postgres-historical-003"`)

| Task ID | Opaque causal family | Partition | Prior development exposure | Task/context hash | Evidence custodian reference |
|---|---|---|---|---|---|
| `postgres-historical-003` | `transaction-chaining-subtransaction-state` — **same family as Study 1**, sibling defect | frozen Corpus v0 task (#199/#201), scaffolding treatment added via #235 | none disclosed to the agent beyond E1+ SPEC/diff/HarnessProfile | per-level `taskDefinitionHash` in `experiment-manifest.json`'s `perConditionMaterializationHashes` | operator-local `output/historical-pg-199/exp233-e0e3-dsh-2026-09-11/` |

## Predeclared matrix and analysis

| Task | Condition/profile | Trial indices | Model | Wall/token/tool/resource limits | Order |
|---|---|---|---|---|---|
| `postgres-historical-003` | E0 (source + prompt only) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 1st |
| `postgres-historical-003` | E1 (+ contemporaneous SPEC, reused from Study 1) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 2nd |
| `postgres-historical-003` | E2 (+ `280a408b` introducing change-set diff) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 3rd |
| `postgres-historical-003` | E3 (+ generic Test-Engineer HarnessProfile, reused from Studies 1/2) | 1 | deepseek-v4-flash | 30 min agent timeout; token/tool not enforced | 4th |

- Independent-session and database/workspace reset policy: each level ran in its own container set (agent/runtime/egress-gateway), own internal network, own artifact directory; no shared model conversation, scratch files, or database state across levels.
- Retry policy: not exercised — **zero infrastructure retries needed**, all four attempts completed cleanly on the first try.
- Engineering smoke IDs excluded by prior designation: a 5-minute-budget E0 smoke (two iterations, artifact roots `/tmp/pg199-dry-run-smoke` and `/tmp/pg199-dry-run-smoke2`, not under the formal `output/` artifact root) confirmed the full pipeline end-to-end before the formal ledger; both excluded, per the same designation precedent as #216's own `DRY-RUN-E0`.
- Planned counts: `n=1` per level as preregistered; not expanded.
- Metric definitions: `rediscovered | miss | invalid_submission | blocked | infrastructure_error | integrity_error | unscored`, same vocabulary as Studies 1/2.
- Artifact retention: full per-attempt evidence retained under `output/historical-pg-199/exp233-e0e3-dsh-2026-09-11/{E0,E1,E2,E3}/`, not committed to the repository (large, includes source trees and PostgreSQL build output; gitignored).

## Attempt ledger

| Attempt / predecessor | Cell / trial index | Raw status / grade | scoredEligible / official result | Attributed cause and evidence | Time coverage | Artifact reference |
|---|---|---|---|---|---|---|
| E0 / none | E0, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission (`status: "reproduced"`), structured-oracle mismatch | 316.6s agent duration | `output/historical-pg-199/exp233-e0e3-dsh-2026-09-11/E0/` |
| E1 / none | E1, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, structured-oracle mismatch | 183.6s agent duration | `.../E1/` |
| E2 / none | E2, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, structured-oracle mismatch | 280.5s agent duration | `.../E2/` |
| E3 / none | E3, trial 1 | `completed` / `miss` | `true` / `miss` | Valid submission, structured-oracle mismatch | 495.0s agent duration | `.../E3/` |

No infrastructure-error retries occurred anywhere in this ledger — a cleaner run than Study 1's (which needed one E2 retry) and matching Study 2's own clean run.

## Results

- Planned: 4 cells (E0–E3), `n=1` each. Started: 4. Completed: 4/4. Pending/cancelled: none.

| Task/partition/condition | Attempts A | Eligible E | Discoveries D (rediscovered) | End-to-end D/A | Conditional D/E |
|---|---|---|---|---|---|
| `postgres-historical-003` / E0 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-historical-003` / E1 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-historical-003` / E2 | 1 | 1 | 0 | 0/1 | 0/1 |
| `postgres-historical-003` / E3 | 1 | 1 | 0 | 0/1 | 0/1 |

- All four scaffolding levels missed the target oracle — the same uniform-miss shape as both Studies 1 and 2.
- Unexpected findings retained for separate adjudication (no automatic target credit): at E1, E2, and E3, the agent's own root-cause description converges on the same mechanism independently identified in Study 1's own trajectories (#216/#220's report): `COMMIT AND CHAIN`/`ROLLBACK AND CHAIN` issued while a live `SAVEPOINT`/subtransaction is open loses the finished transaction's characteristics, because `CommitTransactionCommand()`'s `TBLOCK_SUBCOMMIT` path checks the chain flag on the innermost (subtransaction) `TransactionState` rather than the top-level one where `EndTransactionBlock()` actually records it, so `SaveTransactionCharacteristics()` is skipped while `RestoreTransactionCharacteristics()` still runs and installs stale, zero-initialized process-global values. E0 (no SPEC/diff) instead converged on a related but distinct trigger condition (transaction abort before any `AND CHAIN`, rather than a live savepoint at commit time).

## Trajectory analysis and decision

**Every attempt (E0–E3) is a `miss` with a valid, well-formed submission** (`validity.valid: true` in every case). This is the identical diagnostic shape both Studies 1 and 2 showed.

**Diagnosis convergence.** E1, E2, and E3 (all of which had SPEC access) each independently produced essentially the same mechanism description — `TBLOCK_SUBCOMMIT`'s chain-flag/characteristics-save mismatch in `CommitTransactionCommand()`/`xact.c` — despite E1 lacking the introducing diff that E2/E3 had. This is a materially different pattern from both prior studies: in Study 1, diff access (E2) was primarily an *efficiency* effect on an already-adjacent diagnosis; in Study 2, diff access was a *localization-quality* effect (E0/E1 landed on a different, non-target defect; E2/E3 landed on the actual fixed function). Here, SPEC access alone (E1) already achieved the precise mechanism-level diagnosis that Studies 1/2 needed diff access to reach — consistent with this being a sibling defect in a family the SPEC itself already describes in enough structural depth (transaction characteristics under `AND CHAIN`) for the model's own reasoning to localize the specific interaction with subtransactions without needing the implementation diff. E0 (no SPEC, no diff) reached a real, adjacent defect in the same general area (transaction-abort interaction with `AND CHAIN`) but not the precise savepoint/subtransaction mechanism.

**Reproducer-construction gap recurs.** Every attempt's submitted reproducer wraps its pass/fail assertion inside a `DO $ ... RAISE NOTICE/EXCEPTION` block (self-asserting pattern) rather than exclusively surfacing the historical-vs-reference differential as a raw, grader-legible observable — structurally the same downstream gap Studies 1 and 2 both found, now recurring a third time under this structured-oracle protocol specifically (the same protocol Study 1 used). This is consistent with, but does not by itself prove, the same construct-validity explanation Study 1's report proposed for its own misses.

**Preregistered eight-stage adjudication.** The labels below are diagnostic process classifications, not alternate grader outcomes: `strong` means the retained trajectory/submission contains direct evidence for that stage; `partial` means the stage was attempted or substantially present but remained incomplete/adjacent; `miss` means the required stage outcome was not achieved. The authoritative outcome remains `miss` for all four cells.

| Stage | E0 | E1 | E2 | E3 | Retained evidence used |
|---|---|---|---|---|---|
| 1. Requirement/change understanding | partial | strong | strong | strong | transcript/trajectory + `finding.json` |
| 2. Source/change-impact localization | partial — correct subsystem, adjacent trigger | strong — precise savepoint/subtransaction mechanism | strong — same precise mechanism | strong — same precise mechanism | source/tool trajectory + `finding.json` |
| 3. Correctness-invariant formulation | partial | strong | strong | strong | hypothesis/reasoning in trajectory + submitted finding |
| 4. Hypothesis generation | partial — related transaction-abort interaction | strong | strong | strong | trajectory + `finding.json` |
| 5. Discriminating-observable selection | partial | partial | partial | partial | authored `repro.sql` and grader mismatch |
| 6. Historical/reference differential experiment design | partial | partial | partial | partial | submitted reproducer + historical/reference execution evidence retained per cell |
| 7. Reproducer construction/minimization | partial — self-asserting | partial — self-asserting | partial — self-asserting | partial — self-asserting | `repro.sql` structure + workspace inventory |
| 8. Machine-checkable submission encoding | miss | miss | miss | miss | structured-oracle mismatch / authoritative grade |

This decomposition deliberately separates three claims that must not be conflated: **(A)** whether the trajectory diagnosed the relevant mechanism, **(B)** whether the submitted experiment exposed a target-attributed historical/reference differential, and **(C)** whether that differential was encoded in the grader-legible form required by the external evaluator. E1–E3 provide strong evidence for (A), while the evidence for (B) and (C) remains incomplete. Therefore this report does **not** claim the counterfactual that changing only the output shape would necessarily have converted any cell to `rediscovered`.

**Session/cost summary** (from `agent-session-stats.json` per attempt; token/tool budget not enforced, recorded as observed-only):

| Level | Turns | Steps | Agent duration | Decode tokens | Workspace files / bytes |
|---|---|---|---|---|---|
| E0 | 1 | 51 | 316.6s | 12,076 | 12 files / 17.7 KB |
| E1 | 1 | 34 | 183.6s | 11,999 | 5 files / 12.3 KB |
| E2 | 1 | 50 | 280.5s | 12,759 | 6 files / 15.0 KB |
| E3 | 1 | 76 | 495.0s | 24,006 | 10 files / 78.5 KB |

**Answers to the preregistered analysis questions:**

1. **Does E1 change hypothesis quality or only increase cost relative to E0?** Hypothesis *quality* changed materially — E1 reached the precise savepoint/subtransaction mechanism that E0 missed — while *cost* actually **decreased** relative to E0 (34 vs. 51 steps, 183.6s vs. 316.6s, comparable decode tokens). This is a positive SPEC effect on both quality and efficiency in this single run, opposite in direction to Study 1's E1 (which increased cost with no outcome change) and different in kind from Study 2's E1 (no localization-quality change).
2. **Does E2 reduce source-search cost or improve localization relative to E1?** Localization was already at the same precise-mechanism level in E1; E2's diagnosis is not distinguishably more precise. Cost went *up* relative to E1 (50 vs. 34 steps, 280.5s vs. 183.6s) — the opposite of Study 1's own E1→E2 efficiency gain. With `n=1`, this does not establish that diff access has no value here; it is consistent with SPEC alone having already captured most of the value diff access provided in Studies 1/2.
3. **Does E3 improve experiment design/reproducer quality relative to E2, or mainly increase cost?** Mainly cost: steps rose from 50 to 76 (+52%), wall time from 280.5s to 495.0s (+76%), decode tokens from 12,759 to 24,006 (+88%), and workspace output grew to a 5-file `tests/` directory (78.5 KB, the largest of any level) — consistent with the HarnessProfile's boundary-condition-enumeration methodology producing more artifacts. The outcome (`miss`) and the underlying diagnosis were unchanged. This replicates the E2→E3 cost-without-measured-benefit direction from both Studies 1 and 2, here at a larger relative magnitude.
4. **Does the introducing diff still help when the scored source snapshot is substantially later than the introducing commit?** This run does not show a clear independent diff effect beyond what SPEC alone already achieved (see Q1/Q2) — but it also does not show diff access *hurting* localization. The temporal gap between the shown `280a408b` diff and Task 003's own later frozen source did not visibly confuse or misdirect either E2 or E3's diagnosis; both remained on the correct sibling mechanism.
5. **Does the agent converge on the correct transaction-state subsystem?** Yes, at every level — including E0, which reached an adjacent (not precisely matching) defect in the same subsystem rather than an unrelated area.
6. **Does any condition produce authoritative rediscovery?** No — 0/4, same as both prior studies.
7. **Does the discriminating-observable / grader-legible-output gap recur?** Yes, structurally, at every level (see "Reproducer-construction gap recurs" above) — now observed a third time, under the same grading protocol Study 1 used.
8. **Is the failure pattern closer to Study 1 than Study 2, as expected for a sibling transaction-chaining task?** Yes, both in diagnosis content (E1/E2/E3 essentially reconstruct Study 1's own trajectory finding almost verbatim: the `TBLOCK_SUBCOMMIT` / `SaveTransactionCharacteristics()` mechanism) and in grading protocol (structured-oracle, same as Study 1, not Study 2's behavioral-oracle). This is the expected result for a same-family sibling replication and should not be read as new cross-family evidence.
9. **Which observations are plausibly family-level rather than cross-family?** The specific mechanism-level diagnosis (`TBLOCK_SUBCOMMIT` chain-flag mismatch) is almost certainly family-level — it is a property of the shared `280a408b` transaction-chaining implementation, not of either specific downstream defect. The recurring self-asserting-reproducer construct-validity gap is the one observation that has now recurred across all three studies (two different families, one shared family), which is the strongest evidence yet in this program that it is a general reproducer-authoring habit rather than a family- or task-specific artifact.
10. **Does this experiment strengthen or weaken the case for a reproducer/observable Capability Lab intervention?** Strengthens it. This is a **third observed recurrence, specifically an additional within-family recurrence**, across a program that now spans two grading protocols and two causal families. It raises confidence that reproducer-output-shape/grader-legible-observable construction is a genuine, reusable capability gap rather than an artifact of one task's grading contract, while adding no new independent causal-family count.
11. **Which claims remain invalid because this is a sibling-family study and `n=1` per cell?** No claim from this report should be read as a second independent cross-family transfer observation — Study 2 remains the only cross-family evidence in this program. No reliability, ranking, or "SPEC helps more than diff for this family" claim is supported beyond this single run; the reversed cost-direction findings relative to Study 1 (Q1/Q2) are single-trajectory observations, not a contradiction of Study 1's own single-trajectory result. Pretraining exposure to BUG #18118 and the shared `280a408b` commit (2019) is unknown and uncontrolled, same limitation as both prior studies.
12. **What additional information can #232 test that E0–E3 cannot answer?** Whether the recurring reproducer-construction gap and the HarnessProfile cost-without-benefit pattern hold under a *genuinely* unrelated third family with a *richer* contemporaneous-context design (C0–C3) — this study, by construction, cannot speak to generalization beyond the transaction-chaining family for the diagnosis-quality findings, only for the twice-cross-family-recurring construct-validity gap.

**Cross-study comparison table.**

| Study | Causal family | Defect | Grading protocol | E0 | E1 | E2 | E3 | Diff-access effect | Self-asserting-reproducer gap |
|---|---|---|---|---|---|---|---|---|---|
| Study 1 (#216/#220) | transaction-chaining / subtransaction state | BUG #16867 | structured-oracle | miss | miss | miss | miss | efficiency only (steps/time/tokens down E1→E2, no localization change) | present at every level |
| Study 2 (#222/#224) | unrelated: PL/pgSQL `CALL`/cache invalidation | BUG #18574 | behavioral-oracle | miss | miss | miss | miss | localization-quality (E0/E1 wrong defect, E2/E3 correct function) | present at every level |
| Study 3 (this report) | transaction-chaining / subtransaction state (**sibling of Study 1**) | BUG #18118 | structured-oracle | miss | miss | miss | miss | no clear independent effect beyond SPEC (Q1/Q2) | present at every level |

```text
Study 1: transaction-chaining family, defect A (BUG #16867)
Study 2: unrelated PL/pgSQL/cache family, defect C (BUG #18574)
Study 3: transaction-chaining family, sibling defect B (BUG #18118)
```

Studies 1 and 3 are **not** aggregated as two independent causal-family observations anywhere in this report. The one finding that legitimately strengthens across all three rows above is the recurring self-asserting-reproducer gap, because it recurs under two distinct grading protocols and both a shared and an unrelated causal family.

- What this experiment supports: the E0-E3 harness, restricted-egress/DSH-trajectory pipeline, and reused SPEC/HarnessProfile machinery all work identically well against a second task within Study 1's own family, with zero infrastructure retries; the recurring reproducer-construction gap now has a third independent (though partially family-correlated) data point; SPEC access alone can, in at least one run, reach a precise sibling-mechanism diagnosis without diff access.
- What this experiment cannot establish: any reliability/leaderboard claim (`n=1` per level, single model/provider); a second independent cross-family transfer result (Study 2 remains the only one); whether the reversed E1-cost-decrease / E2-cost-increase pattern relative to Study 1 generalizes, or is single-trajectory noise; whether the diagnosis-quality findings here would hold on a genuinely unrelated family (that is #232's question, not this one's).
- Exposure/pretraining limitations: `deepseek-v4-flash`'s training-data exposure to BUG #18118 and to the well-documented `280a408b` "Transaction chaining" commit (2019) is unknown and not controlled for, same limitation class as both prior studies.
- Decision: **retain** as a complete, trustworthy within-family sibling-replication pilot. Recommend a **go** on both follow-ups per #233's own registration: (a) the narrowly scoped Capability Lab issue [#237](https://github.com/clemenza/honeyrail/issues/237) for reproducer-output-shape/grader-legible-observable construction — supported by independent cross-family evidence from Studies 1→2 and strengthened by this additional within-family recurrence; (b) proceeding with #232's separately planned genuinely-unrelated third family with richer C0-C3 context, since this study's family-correlated results cannot substitute for that unrelated-family evidence.
- Next smallest intervention, if justified: none inside this experiment (tuning on this exact case is prohibited before #232's unrelated-family run, same contamination discipline as Studies 1/2). This report's reproducer-shape observation is retained as accumulating TRAIN evidence across three studies, not applied to any task's construction here.

## Verification and closure

- `npm run typecheck`: clean at the frozen commit (`b7b99162a093302fea8a346fa44623d89c74892f`).
- `test/historical-postgres-003-task.test.ts` + `test/historical-postgres-212-task.test.ts` + `test/historical-postgres-221-task.test.ts` + `test/historical-postgres-199-integration.test.ts` + `test/historical-postgres-221-integration.test.ts` + `test/historical-postgres-212-integration.test.ts` + `test/historical-pg-trialset.test.ts` + `test/historical-postgres-200-integration.test.ts`: 145 pass / 16 skipped (require live Docker/env, not applicable to typecheck-time CI) / 0 failed. `test/historical-postgres-199-integration.test.ts` additionally run with the operator-private mirror/reproducer/private-truth configured before attempt 1, confirming real two-revision attribution remained deterministic.
- Real-model formal checks: 4/4 attempts reached `status: completed`, `scoredEligible: true` (restricted egress verified per attempt), DSH trajectory evidence persisted per attempt (`agent-transcript.ndjson`, `agent-trajectory.jsonl`).
- Failure signatures, reruns, fixes and residual follow-ups: **none** — zero infrastructure retries, zero fixes required mid-experiment. The one compatibility blocker (`historicalPostgres003TaskSpec()` lacking E0-E3 scaffolding support, and the harder `source.historicalRevision`/`changeContext.introducingCommit` equality invariant from #212) was found and fixed *before* this experiment's attempt 1, via the separate smallest-implementation issue #234/PR #235, exactly as #233 itself anticipated and required.
- Public-artifact sanitization review: this report contains no grader-private oracle tuples, no canonical-reproducer contents, no Task 003 historical/reference revision SHAs, and no upstream bug identity beyond the already-public `#18118` issue-tracker number that #233's own issue text and title already disclose — reviewed before publication. A preflight materialization+grep check (documented in the preregistration comment) confirmed no agent-visible file contained the bug number, either private revision SHA, or the reproducer's own distinctive content.
- Acceptance checklist mapped to evidence: locked preregistration posted before attempt 1 (2026-09-11) ✓; frozen #199/#201 Task 003 source/oracle unchanged (only new optional parameters used, defaults preserved and tested) ✓; E0/E1/E2/E3 used the same semantics as Studies 1/2 ✓; E1 SPEC provenance contemporaneous and frozen (byte-identical reuse of Study 1's, hash-verified) ✓; E2 used the complete `280a408b` introducing diff ✓; E3 HarnessProfile byte-identical to the previous formal experiments (hash-verified against Study 2's own recorded value) ✓; four cells completed, zero retries needed ✓; every attempt retained ✓; restricted egress/scored eligibility evidenced per attempt ✓; primary outcomes come only from the deterministic grader ✓; stage-wise analysis completed for every valid attempt (see Trajectory analysis) ✓; cross-study comparison explicitly distinguishes sibling-family from unrelated-family evidence (comparison table above) ✓; no result presented as an independent third-family transfer ✓; sanitized report contains no grader-private truth ✓; decision recorded on what this result adds before #232 (go on #237 Capability Lab TRAIN and on #232's unrelated-family context study, with the two kept methodologically separate) ✓; no same-case tuning presented as transfer evidence ✓.
- Issue disposition: #233's formal E0–E3 sibling-replication pilot is complete. This report, the locked preregistration comment, the raw attempt ledger under `output/historical-pg-199/exp233-e0e3-dsh-2026-09-11/` (gitignored, operator-local), and the machine-readable experiment manifest are the deliverables named in #233's "Final deliverables"-equivalent scope. Follow-up: #232's separately planned genuinely-unrelated third family remains out of scope here, per #233's own "Relationship to #232" section.
