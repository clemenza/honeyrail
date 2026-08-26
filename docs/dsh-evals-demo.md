# dsh-evals-demo.ts driver (#93)

`scripts/dsh-evals-demo.ts` runs the "Demo1: DSH x test-engineering trial-evals"
fixture matrix (#87-#93): `fixtures x profiles x trials` scored
`dsh-testengineer-trial` cells, aggregated into
`comparison-report.md` via `server/evals/dsh-report.ts`.

## Usage

```sh
git submodule update --init vendor/tinytable-evals              # once, or after a fresh clone
docker build -t tinytable-exam-room:latest docker/tinytable-exam-room  # once
DEEPSEEK_API_KEY=... node --import tsx scripts/dsh-evals-demo.ts --smoke
node --import tsx scripts/dsh-evals-demo.ts                            # full 48-run matrix
node --import tsx scripts/dsh-evals-demo.ts --report-only --out ./dsh-evals-report
```

Fixtures are now integer seeds into `vendor/tinytable-evals`'s mutation
operator library (default `0..7`), not mutant ids - `--fixtures 0,3,5`
selects a subset. `--grader-runs <n>`/`--kill-rate-threshold <t>` pass
through to `grade.py`'s own probabilistic multi-seed scoring (#21 upstream;
default `--grader-runs 1` reproduces the original single-run behavior
exactly).

`--pg-adjudicate` (upstream issue #57, off by default) passes
`--pg-adjudicate` through to `grade.py`: any agent test record that fails
against *both* the trial's mutant and the untouched `clean/` reference -
previously always scored a blanket `false_alarm` - gets a PostgreSQL oracle
to settle whether that's a genuine mistake or actually a bug in `clean/`
itself (a `reference_bug`, not counted against the agent - see
`clemenza/honeyrail#130`/`#134`, TRUTH_MODEL.md). Requires a reachable
PostgreSQL server and `psycopg2` - same setup as `tinytable-evals`'s
`oracle.py --backend postgres`:

```sh
docker compose -f vendor/tinytable-evals/docker-compose.postgres.yml up -d
pip install psycopg2-binary
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres
node --import tsx scripts/dsh-evals-demo.ts --pg-adjudicate ...
```

Omitted, `grade.py`'s original stdlib-only, zero-setup fast path is
unchanged - nothing about this flag is load-bearing for the rest of the
driver.

## Pinned upstream commit (#126)

The builder/grader/`task-prompt.md` this driver drives are no longer an
in-repo copy - they come from `vendor/tinytable-evals`, a git submodule
pinned to a specific upstream commit:

```
$ git -C vendor/tinytable-evals rev-parse HEAD
2a397bd0d327cf16d47904788e88348319eb64f0
```

Re-pinned for upstream's #55-58/#22 (a PostgreSQL-backed "truth model" -
`clean/` is a cheap reference, never assumed infallible, per
TRUTH_MODEL.md) - `2a397bd` (upstream #59): `oracle.py --backend postgres`,
`adjudicate.py` + `grade.py --pg-adjudicate` (this driver's `runScorePy()`
now threads a `pgAdjudicate` option through when `--pg-adjudicate` is
passed - off by default, see above), and a CI differential check of
`clean/tinytable` against real PostgreSQL. Building the truth model out
found and fixed a real bug in `clean/tinytable` along the way:
`core.Predicate` was two-valued, so `NOT` over a NULL comparison wrongly
became `TRUE` instead of staying unknown, contradicting `SPEC.md`'s own
"NULL semantics (three-valued logic)" section - independently discovered
first via `clemenza/honeyrail#130`/`#134`'s trial analysis (agents kept
reporting this exact behavior as a defect, always scored a blanket false
alarm since `clean/` shared the same bug) before upstream's own #55-58
investigation converged on the identical root cause and fixed it.

Re-pinned three times before that for upstream's #40 (from `78bcc98`):

- `1262518` (upstream #50): `trajectory.py` (structured JSONL trajectory
  logging - a stdlib-only writer/schema for `tool_call`/`shell_command`/
  `test_run`/`file_diff`/`agent_snapshot` events, now shipped into every
  seed-root by `build_seed_root.py`), `run_sql_tests.py --trajectory-log`
  (emits a `test_run` event per invocation), and `trajectory_schema.json`/
  `sample_trajectory.py`.
- `2a1a00f` (upstream #51): `grade.py --trajectory-log`, threaded through
  to its own step-1 `run_sql_tests.py` runs against `--artifacts` - the
  one `run_sql_tests.py` invocation site #50 didn't cover. This driver's
  `runScorePy()` (`scripts/dsh-evals-demo.ts`) now passes
  `trajectoryLog: "trajectory.jsonl"` on every call, so a real trial's
  `test_run` events land in the seed-root's `trajectory.jsonl` alongside
  the `tool_call`/`shell_command` events server/evals/dsh-trajectory-
  bridge.ts already derives from dsh's own session log - #40's full event
  set is now produced end to end by a real trial, not just
  `sample_trajectory.py`'s scripted demo.
- `19f521d` (upstream #52): fixes a bug found while porting
  `trajectory.py`'s `git_diff()` to server/evals/dsh-trajectory-
  filesystem-events.ts's `gitDiff()` - a plain `git diff <ref>` never
  mentions an untracked path, and every agent-added `sql-tests/agent/
  *.test` file starts out untracked, so it was silently missing from
  every `file_diff` event's `diff`/`files_changed` entirely (not just
  mislabeled). Both implementations now run `git add --intent-to-add
  --all` first; this driver's own fix landed in the same commit as
  `gitDiff()` itself (see that file's own history) rather than needing a
  separate re-pin.

Before #126, `examples/tinytable-eval/{mutants,golden,score.py}` was a
static copy frozen at the point #104 extracted it, and had already drifted
substantially from `clemenza/tinytable-evals`'s own evolution (dynamic
per-seed mutation instead of 8 static mutants, a deterministic scheduler/
simulation substrate, a conflict-serializability admissibility checker,
probabilistic multi-seed kill-rate scoring) by the time this migration
landed - see the issue for the full list. `examples/tinytable-eval/` now
holds only `profiles/` (the `cordis.patch.yml` baseline/candidate
instruction variants, which are a honeyrail-side eval concern, not tinytable
answer material); everything about the engine, its mutation operators, and
its grading pipeline comes from the pinned submodule instead.

**Re-pinning:** bump the pin whenever a `tinytable-evals` milestone issue
closes (its README documents forthcoming WAL/crash-recovery and MVCC engine
work), or periodically (e.g. every few weeks) if nothing forces it sooner.
To re-pin:

```sh
cd vendor/tinytable-evals && git fetch && git checkout <new-commit> && cd -
git add vendor/tinytable-evals
```

Then re-run this driver's own tests (`test/tinytable-seed-root-builder.test.ts`,
`test/dsh-evals-demo.test.ts`) and a `--smoke` run before committing the
bump - a re-pin can change `build_seed_root.py`'s seed-root layout or
`grade.py`'s `score.json` shape, same as it did for this migration itself.

## Why a scored cell never becomes a HoneyRail Run

The issue's original scope described this driver launching each cell "via
the `dsh-testengineer-trial` recipe (#92)" as a normal `POST
/api/recipes/.../runs` call - the same shape `scripts/evals-ab-demo.ts`
(#25) uses. That shape was overtaken by events: #103 (P0) found that an
agent launched that way could read `examples/tinytable-eval`'s answer key
straight off the shared host filesystem, because the only thing standing
between the agent and the rest of the host was dsh's own `workspace-write`
sandbox mode - which #103 proved does not restrict reads at all. The
amendment on #93 is explicit that the fix is architectural, not a
narrower prompt or a nicer error message: a scored cell must run "not as a
registered honeyrail project sharing host filesystem access."

So each cell instead calls the three zone components built for #104/#105/#106
directly, with no HoneyRail Run, Step, worktree, or tmux session involved at
all:

1. **Builder** (#104, migrated to `vendor/tinytable-evals`'s own
   `build_seed_root.py` by #126) - `buildSeedRoot()` shells out to
   `build_seed_root.py --seed N --out DIR`, which deterministically picks a
   mutation operator for `N`, applies it to a fresh copy of the vendored
   `clean/tinytable`, and assembles an answer-free, git-initialized
   seed-root. `buildSeedRoot()` then walks that output itself to build a
   manifest (file list + SHA-256 hashes) that never enters the seed-root -
   the chosen operator id (the actual answer) is passed only as
   `build_seed_root.py`'s `SEED_ROOT_JSON:` stdout line, parsed by the
   builder and written to the manifest, never to `DIR`.
2. **Preflight** (#106) - `findManifestMismatches()` checks the freshly-built
   seed-root against its own manifest before launch (defense in depth - the
   builder should already guarantee this holds).
3. **Exam room** (#105) - `runInExamRoom()` runs `dsh --profile headless
   --patch cordis.patch.yml <prompt>` inside an isolated container with only
   that seed-root bind-mounted. `build_seed_root.py` already git-inits and
   commits the seed-root itself before the driver ever sees it; the driver
   re-does a `git init`/`add`/`commit` anyway as defense in depth (a no-op
   against an already-clean tree) and to keep itself independent of exactly
   which builder produced the worktree - `grade.py`'s own docstring still
   requires the worktree to already be "its own git repository, freshly
   seeded before the agent touched it" for its protected-path check to
   work.
4. **Grader** (#107, zone 3; migrated to `vendor/tinytable-evals`'s own
   `grade.py` by #126) - after the container exits:
   - The *same* #106 manifest check runs again against the seed-root. Any
     difference from the pre-run check means a protected file (`tinytable/`,
     `sql-tests/official/`, `SPEC.md`, `run_sql_tests.py`, `scheduler.py`,
     `substrate.py`, `admissibility.py`, `findings.schema.json`) was
     tampered with - the exact #103 failure mode, including the specific
     `.gitignore`-hiding trick from that incident's transcript (reproduced
     exactly in `test/dsh-grader-invalidated.test.ts`), which this
     hash-based check catches even though it would fool `grade.py`'s own
     `git status`-based one.
   - `server/evals/transcript-audit.ts`'s `auditTranscript()` scans the
     container's captured stdout/stderr plus the agent's own artifacts
     (`findings.json`, its `.test` files) for references to material
     outside the exam room - `mutant`, `golden`, `score.py`, `honeyrail`,
     a literal `/home/`or `/Users/` path. The container structurally
     prevents actually *reading* any of that (there's nothing else mounted
     to read), but a reference in what the agent wrote or said is still
     worth flagging.
   - Either forces the trial's outcome to `invalidated` regardless of what
     `grade.py` itself reports - see `server/evals/dsh-report.ts`'s
     `classifyDshOutcome`.
   - `grade.py` then runs on the host (the grader zone proper, never inside
     the container), scoring `--grader-runs` seeds (default 1) of the
     agent's `sql-tests/agent/` suite against the seed-root's own mutant vs
     a fresh copy of the vendored `clean/`, and reports `kill_rate`
     (fraction of those seeds that killed it), `killed_by_kind`
     (`assertion` vs `invariant` - an `assert_stats`/`--check-admissibility`
     violation), and a `per_run` breakdown - upstream issue #21's
     "Grader v2" probabilistic scoring, in place of the single-run
     all-or-nothing `killed` this driver used to be the only consumer of
     (still reported, now derived from `kill_rate >= --kill-rate-threshold`,
     default 1.0 so `--grader-runs 1` is unchanged behavior).
   - `run_mt185iaf_ykwl0c` (the specific run #103's postmortem names as
     contaminated) isn't something this repo can mark discarded - it's
     production data on whoever ran that trial's own HoneyRail deployment,
     outside this codebase entirely. What #107 actually delivers is the
     *mechanism* (transcript audit, hash-based integrity re-check,
     `invalidated` verdict) that would have caught it automatically had it
     existed at the time.
   - **Dropped by #126: the private-mutant-pool kill matrix / "spray and
     pray" signal.** The old `score.py --kill-matrix-pool
     examples/tinytable-eval/mutants` replayed the agent's suite against
     every *other* static mutant in the repo to flag tests broad enough to
     reject almost any implementation. `vendor/tinytable-evals` has no
     persisted mutant pool to replay against - mutants are generated
     on-the-fly from a seed and never committed - so this signal has no
     upstream equivalent today. `DshTrialRecord.killMatrix` and
     `sprayAndPrayRate()` were removed; the per-fixture report table now
     shows `killed_by_kind` (assertion vs. invariant) instead.
   - **Dropped by #126: #108's `--agent-blocked-reason` contract waiver.**
     `grade.py` has no equivalent flag to the old `score.py`'s - a
     correctly-`BLOCKED:` trial's `contract_ok` may now read `false` for
     its empty submission instead of getting credit for stopping cleanly.
     This is cosmetic, not a classification regression:
     `classifyDshOutcome` already returns `"blocked"` before ever
     consulting `killed`/`contractOk` whenever `blockedReason` is set, so
     a blocked trial is still reported as `blocked`, distinct from an
     `invalidated` self-repair trial, exactly as before - only the raw
     `Contract OK` value shown for it in the per-trial evidence table
     changed.

## What this means for the original acceptance criteria

- "`--smoke` completes end-to-end, report generated, every number in it
  traceable back to a run" - still holds, reinterpreted for the new
  architecture: every report number traces back to a trial's artifacts
  directory (seed-root, manifest.json, score.json, container.log,
  transcript.ndjson) rather
  than a `/api/runs/:id` URL, since no HoneyRail run exists to link to.
- "`GET /api/evals/metrics?instructionLabel=` segments the two profile
  groups correctly" - no longer applicable as literally written: that
  endpoint segments HoneyRail-tracked runs, and a scored cell here is
  deliberately never one. `server/evals/dsh-report.ts`'s own
  `summarizeProfiles`/`summarizeFixtureCells` are this driver's equivalent
  segmentation, computed directly from `state.json`.

## Other notes

- Profiles default to `examples/tinytable-eval/profiles/{baseline,candidate}.cordis.patch.yml`.
  `candidate.cordis.patch.yml` is a placeholder, not tuned - real
  candidate-instruction content is #95's job.
- Cells run sequentially (mirrors `scripts/evals-ab-demo.ts`'s own
  rationale, adapted: bounds host resource usage from concurrent docker
  containers + `grade.py` processes). Each cell is fully isolated from the
  others, so parallelizing is safe to add later; #78 (server-side
  `maxParallel`) doesn't apply here since there's no Run to attach it to.
- `state.json` is written after every cell, so a `--report-only` rerun (or
  a crash mid-matrix) never loses completed cells.
- **#140: `container.log` is empty for a trial that hits
  `--trial-timeout-minutes` and gets killed.** `dsh --profile headless`
  only prints its human-readable output once, at the end of the run, so a
  mid-loop kill leaves nothing captured there (#134, #136 documented 6/115
  trials this way). Each cell's `transcript.ndjson` doesn't have this gap:
  it's a verbatim, one-line-per-event dump of dsh's own session-persistence
  log (`server/evals/dsh-transcript.ts`), which that plugin already
  appends to disk as the trial runs - so whatever ran before the kill is
  still there to read back, even when `container.log` is empty.
