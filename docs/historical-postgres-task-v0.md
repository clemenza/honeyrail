# Historical PostgreSQL task v0

Issue #184 adds one local task contract for a historical PostgreSQL correctness regression. It uses the existing PostgreSQL research environment; it does not introduce another executor or orchestration layer.

## Layout and boundary

```text
case/
  task/
    source/                 # historical snapshot, no .git
    prompt.md
    task-manifest.json
    workspace/              # agent-owned finding and repro files
  reference/                # grader-owned only
    reference-manifest.json
    expected-behavior/
    verification/
```

The agent receives the historical source, prompt, live local instance, and writable workspace. It does not receive the reference bundle, the corrected source, source/build identities, or a canonical reproducer.

`task-manifest.json` is schema version 1. It records the task id, both pinned revisions, build/scaffolding/budget settings, and SHA-256 hashes for the materialized source, task definition, and grader reference bundle. The selected local case is `postgres-historical-cf-7059`: historical `07fdee7c8a8b415fb3a2991e7aea34f08975d445`, corrected `2ebf25e7d70a8fce31ace78d723fa9271ab8af72`.

## Submission and deterministic grade

The agent writes directly in its workspace:

```text
finding.json
repro.sql
supporting-artifacts/       # optional
```

`finding.json` contains `status` (`reproduced` or `not-reproduced`), `summary`, and a direct workspace filename in `reproducer`. The SQL reproducer must encode its own assertion: exit success means the suspect behavior was observed; an assertion failure/nonzero exit means it was not observed. The grader executes that exact file against the historical build and the corrected build using the same research environment profile.

The grader accepts a direct workspace filename resolving within the workspace and up to 256 KiB. Before copying returned agent output it caps the workspace at 16 MiB and 2,048 entries; oversize output and paths that resolve outside the workspace are `integrity_error`, not infrastructure failures.

| Historical | Corrected | Grade |
| --- | --- | --- |
| reproduces | does not reproduce | `rediscovered` |
| does not reproduce | any | `miss` |
| reproduces | reproduces | `invalid_submission` |
| malformed/missing files | n/a | `invalid_submission` |
| build/start/grader failure | n/a | `infrastructure_error` |
| workspace escape/tamper | n/a | `integrity_error` |

Each revision’s artifact directory retains source/build/runtime manifests, server log, grader output, and final `grade.json`. No infrastructure failure is converted into a miss.

## Local use

The programmatic entry points are `commitfest7059TaskSpec()`, `materializeHistoricalPostgresTask()`, `runHistoricalPostgresTrial()`, and `gradeHistoricalPostgresSubmission()` from `server/postgres/historical-task.ts`. `runHistoricalPostgresTrial()` is the real-agent vertical slice: it passes the public task prompt as `HONEYRAIL_TASK_PROMPT`, gives the isolated agent its normal `$HR_PG_WORK_DIR`, copies returned files grader-side, and grades the same submitted file on both revisions.

The real two-revision check is opt-in because it needs the prebuilt local Docker images, PostgreSQL mirror, and the local known repro (the repro is intentionally not committed). It must report the historical/reference execution records, source/build hashes, `grade.json`, and artifact paths; a missing image, build, or startup is `infrastructure_error`, not an agent miss.

```sh
export HONEYRAIL_PG_184_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_184_REPRODUCER=/private/path/to/known-repro.sql
npm run test:historical-pg-184

# The configured agent command must be available inside the research image
# and write finding.json/repro.sql in $HR_PG_WORK_DIR.
export HONEYRAIL_PG_184_AGENT_COMMAND=/path/in/agent-image/to/agent
npm run historical-pg-184
```
