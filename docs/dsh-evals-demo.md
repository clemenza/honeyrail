# dsh-evals-demo.ts driver (#93)

`scripts/dsh-evals-demo.ts` runs the "Demo1: DSH x test-engineering trial-evals"
fixture matrix (#87-#93): `fixtures x profiles x trials` scored
`dsh-testengineer-trial` cells, aggregated into
`comparison-report.md` via `server/evals/dsh-report.ts`.

## Usage

```sh
docker build -t tinytable-exam-room:latest docker/tinytable-exam-room  # once
DEEPSEEK_API_KEY=... node --import tsx scripts/dsh-evals-demo.ts --smoke
node --import tsx scripts/dsh-evals-demo.ts                            # full 48-run matrix
node --import tsx scripts/dsh-evals-demo.ts --report-only --out ./dsh-evals-report
```

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

1. **Builder** (#104) - `buildSeedRoot()` materializes an answer-free
   seed-root for the chosen mutant, plus a manifest (file list + SHA-256
   hashes) that never enters the seed-root itself.
2. **Preflight** (#106) - `findManifestMismatches()` checks the freshly-built
   seed-root against its own manifest before launch (defense in depth - the
   builder should already guarantee this holds).
3. **Exam room** (#105) - `runInExamRoom()` runs `dsh --profile headless
   --patch cordis.patch.yml <prompt>` inside an isolated container with only
   that seed-root bind-mounted. Before launch, the driver `git init`s the
   seed-root itself (score.py's own docstring requires the worktree to
   already be "its own git repository, freshly committed before the agent
   touched it" for its protected-path check to work - #104's builder
   deliberately doesn't do this, since it's an exam-room/launch concern,
   not a builder one).
4. **Integrity check + grading** (grader zone) - after the container exits,
   the *same* #106 manifest check runs again against the seed-root. Any
   difference from the pre-run check means a protected file (`tinytable/`,
   `sql-tests/official/`, `SPEC.md`, `run_sql_tests.py`,
   `findings.schema.json`) was tampered with - the exact #103 failure mode,
   including the specific `.gitignore`-hiding trick from that incident's
   transcript, which this hash-based check catches even though it would
   fool score.py's own `git status`-based check. A trial that fails this
   is scored `invalidated` regardless of what `score.py` itself reports -
   see `server/evals/dsh-report.ts`'s `classifyDshOutcome`. `score.py` then
   runs on the host (the grader zone proper, never inside the container) to
   produce the actual kill/false-alarm/contract verdict. This is #93's own
   lightweight version of the check; #107 (not yet built) is the fuller
   out-of-band grader this ties into once it lands.

## What this means for the original acceptance criteria

- "`--smoke` completes end-to-end, report generated, every number in it
  traceable back to a run" - still holds, reinterpreted for the new
  architecture: every report number traces back to a trial's artifacts
  directory (seed-root, manifest.json, score.json, container.log) rather
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
  containers + `score.py` processes). Each cell is fully isolated from the
  others, so parallelizing is safe to add later; #78 (server-side
  `maxParallel`) doesn't apply here since there's no Run to attach it to.
- `state.json` is written after every cell, so a `--report-only` rerun (or
  a crash mid-matrix) never loses completed cells.
