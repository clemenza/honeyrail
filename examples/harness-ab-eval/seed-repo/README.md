# textkit seed repository

Seed fixture for HoneyRail's instruction-file A/B eval demo
(`examples/harness-ab-eval/`). It contains a tiny Python package with one
deliberately buggy function (`textkit/stats.py: median`) and the failing
test that exposes it, plus room for the self-contained tasks in
`../tasks.json` to create their own files at the repository root.

Requires Python 3 with pytest available on the host that runs the checks.
