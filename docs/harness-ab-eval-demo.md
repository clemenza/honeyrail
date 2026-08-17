# Instruction-file A/B eval demo

A hand-built prototype of the v0.6 harness improvement loop on today's
primitives (issue #25): evaluate two instruction-file variants — the seed
of the future `HarnessProfile` — against a small task suite, aggregate gate
outcomes, and produce a comparison report in which every number links back
to per-trial evidence.

## How it works

The demo composes four pieces, none of which required new store entities
or REST surfaces:

1. **Instruction-file injection** (`agent-task` executor). A step may
   declare `input.instructionFile: { path, content, label }`. The file is
   written into the fresh task worktree *before* agent launch, so the agent
   CLI picks it up through its native instruction-file channel
   (`AGENTS.md` for Codex, `CLAUDE.md` for Claude Code), and removed again
   *before* the completion diff harvest — the injected configuration never
   appears in the measured code change nor in a later commit/merge of the
   worktree branch. Injection is recorded twice: as
   `harness.instruction_file` evidence at launch (path, variant label,
   content sha256, size) and inside the `agent.completion` evidence value,
   next to `harnessPromptVersion` (#52), where eval metrics can segment on
   it. Malformed declarations (absolute paths, `..` traversal, missing
   path) are rejected at preflight; a path that already exists in the
   worktree fails the step rather than shadowing repo content.
2. **The `eval-instruction-ab-trial` recipe.** One (variant, task, trial)
   cell: inject → implement → re-verify with the task's fixed check
   command → gate. Fully unattended by construction — a blocked agent or a
   failed check fails the trial (`onBlocked: fail`, `onFail: fail`), so a
   matrix always terminates without a human.
3. **The task suite** (`examples/harness-ab-eval/`). Five scoped,
   deterministic Python tasks, each with its own check command scoped to
   its own test file so trials cannot interfere; a seed repo fixture with
   one deliberately buggy function; and two instruction-file variants:
   `baseline` (terse) and `improved` (test-first discipline,
   self-verification, edge cases, no clarifying questions).
4. **The driver + report** (`scripts/evals-ab-demo.ts`,
   `server/evals/ab-report.ts`). The driver runs the matrix over REST and
   records per-trial state; the report builder aggregates pass rates, wall
   times, and per-task cells into `comparison-report.md`, with every
   aggregate linked to the runs (and their `/evidence`,
   `/gate-decisions`) it was computed from.

## Running it

Prerequisites: the HoneyRail server running (`npm run dev` or
`npm run ops:start`), the chosen agent CLI installed on the host
(`codex` by default), and Python 3 with `pytest` available to the check
steps.

```sh
# 1. Cheap end-to-end validation first: 2 tasks x 1 trial x 2 variants = 4 agent runs
node --import tsx scripts/evals-ab-demo.ts --seed-into ~/harness-ab-seed --smoke

# 2. The full matrix: 5 tasks x 3 trials x 2 variants = 30 agent runs
node --import tsx scripts/evals-ab-demo.ts --project-id <id-from-step-1>

# Rebuild the report from recorded state without re-running anything
node --import tsx scripts/evals-ab-demo.ts --report-only --out ./harness-ab-report
```

`--dry-run` prints the matrix and budget note without launching anything;
`--tasks`, `--trials`, `--variants label=path,...`, `--agent`, and
`--model` narrow or redirect the matrix. Run
`node --import tsx scripts/evals-ab-demo.ts --help` for the full option
list.

### Budget

Every cell launches a real agent CLI session: typically a few cents to
tens of cents and 1–10 minutes of wall time per trial depending on backend
and model. The full default matrix is 30 runs, executed sequentially on
purpose (interleaved sessions on one host would confound the wall-time
comparison). The driver prints this note, with the concrete matrix size,
before launching.

### Segmenting the built-in metrics by variant

Independent of the demo report, the #54 eval metrics can slice the same
runs per variant:

```
GET /api/evals/metrics?instructionLabel=baseline
GET /api/evals/metrics?instructionLabel=improved
```

`instructionLabel` matches runs whose `agent.completion` evidence recorded
an injected instruction file with that label, exactly parallel to the
existing `promptVersion` filter.

## Reading the report

`comparison-report.md` contains: the variant identities (label, injected
path, content sha256), a per-variant summary (trials, gate passes, pass
rate, mean wall time), a per-task breakdown with `(mixed)` marking cells
whose trials disagreed, a noise assessment, and the per-trial evidence
table linking every run.

The noise assessment is deliberately modest, matching what N=3 can
support: it states the pass-rate delta, states how many (task, variant)
cells were internally inconsistent across trials, and says which is
bigger. It does not pretend to a significance test.

## Findings (to fill in after real runs)

This section is the demo's third acceptance criterion and the input to the
v0.4 `TrialSet` design. After running the full matrix, record:

- **Result:** pass rate per variant, and the delta.
- **Noise:** which cells were mixed, and the within-cell flip share.
- **Verdict:** did the delta exceed the observed trial-to-trial noise?
- **Minimum-N implication:** given the observed instability, what trial
  count would TrialSet need for a delta of this size to clear the noise
  band? (If every cell was stable at N=3, note that too — it bounds noise
  from below, it does not prove determinism.)
- **Operational notes:** timeouts, blocked trials, driver errors — anything
  the TrialSet executor must handle first-class instead of by hand.

## Known limitations (prototype scope, accepted in #25)

- One instruction file per step; MCP configuration and launch flags wait
  for `HarnessProfile` (v0.4).
- The injected file is removed only by the successful-completion harvest;
  a failed or cancelled trial leaves it in the worktree. Those worktrees
  are never merged, so nothing leaks into the project repository.
- Trials run sequentially; no paired-statistics treatment yet (v0.5).
