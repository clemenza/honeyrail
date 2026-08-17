# Instruction-file A/B eval demo (issue #25)

A hand-built prototype of the v0.6 harness improvement loop on today's
primitives: evaluate two instruction-file variants (the seed of the future
`HarnessProfile`) against a small task suite, aggregate gate outcomes, and
produce a comparison report where every number links to per-trial evidence.

## Layout

- `tasks.json` — the task suite: 5 scoped, deterministic, check-verifiable
  Python tasks. Each task pairs a prompt with its own check command, scoped
  to that task's test file so trials never interfere with each other (the
  seed repo's deliberately failing test only gates the `median-fix` task).
- `variants/baseline.md` — variant A: a terse, plausible-default
  instruction file.
- `variants/improved.md` — variant B: a deliberately improved instruction
  file adding test-first discipline, self-verification, edge-case coverage,
  and no-clarifying-questions rules.
- `seed-repo/` — the repository fixture trials run against: a tiny Python
  package with one buggy function and the failing test that exposes it.
  `scripts/evals-ab-demo.ts --seed-into <dir>` copies it, runs `git init`,
  and registers it as a HoneyRail project.

## Running the demo

Full instructions, cost notes, and the findings template live in
`docs/harness-ab-eval-demo.md`. The short version, with the HoneyRail
server already running:

```sh
# smoke mode: 2 tasks x 1 trial per variant (4 agent runs)
node --import tsx scripts/evals-ab-demo.ts --seed-into ~/harness-ab-seed --smoke

# full matrix: 5 tasks x 3 trials x 2 variants (30 agent runs)
node --import tsx scripts/evals-ab-demo.ts --seed-into ~/harness-ab-seed
```

The script prints a budget note before launching, drives one run per
(variant, task, trial) cell through the `eval-instruction-ab-trial`
recipe, and writes `state.json` plus `comparison-report.md` into the
output directory (`--out`, default `./harness-ab-report`).
