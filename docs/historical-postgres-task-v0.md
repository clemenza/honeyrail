# Historical PostgreSQL task v0

Issue #184 adds one local task contract for a historical PostgreSQL correctness regression. It uses the existing PostgreSQL research environment; it does not introduce another executor or orchestration layer.

## Layout and boundary

```text
case/
  task/
    source/                 # historical snapshot, no .git
    prompt.md
    task-manifest.json       # agent-visible: opaque id, hashes, execution settings only
    workspace/               # agent-owned finding and repro files
  reference/                 # grader-owned only, never mounted into an agent
    reference-manifest.json  # protocol-level metadata (no revisions, no bug identity)
    truth.json                # the one place the bug identity and both revisions live
    expected-behavior/
    verification/
```

The agent receives the historical source, prompt, live local instance, and writable workspace. It does not receive the reference bundle, the corrected source, either pinned revision, the original bug identity, a canonical reproducer, or anything else under `reference/`.

`task-manifest.json` is schema version 1. It carries only the opaque `taskId`, `database`/`taskType`, scaffolding/budget/build-profile settings, and SHA-256 hashes (`sourceTree`, `prompt`, `taskDefinition`, `truthBundle`) - no revision strings and no bug identity. `reference-manifest.json` is grader-private protocol metadata (grading protocol, `taskDefinitionHash`, and a pointer hash to the truth bundle) and likewise carries no revisions or bug identity. `reference/truth.json` is the one artifact that records the original bug identity (`upstreamBug`, `commitFest`), both pinned revisions (`historicalRevision`, `referenceRevision`), and - when a canonical verification reproducer was supplied - its SHA-256 (`canonicalReproducerSha256`, provenance only; the grader never executes it). Its `bundleHash` is computed over all of those fields plus a hash of the `expected-behavior`/`verification` material, so the bundle's own hash is real provenance rather than a hash of unrelated shape metadata.

The selected local case has the opaque id `postgres-historical-001` (`historicalPostgres001TaskSpec()`); its truth bundle records the real upstream bug and both pinned revisions, but neither this document nor any agent-visible artifact does.

## Submission and deterministic grade

The agent writes directly in its workspace:

```text
finding.json
repro.sql                  # only when status is "reproduced"
supporting-artifacts/      # optional
```

`finding.json` always requires a non-empty `summary`. When `status` is `"not-reproduced"`, that is the entire requirement - no `reproducer` is needed, and if one happens to be present it is never read by the grader: a legitimate miss is never upgraded to `rediscovered` by a `reproducer` field the submission did not rely on. The grader does not run the two-revision reproducer at all in this case; it grades directly to `miss`. When `status` is `"reproduced"`, `reproducer` is required and must name a file directly inside the workspace, resolvable, non-directory, and within the 256 KiB limit.

The SQL reproducer must encode its own assertion: **on the historical (buggy) revision, the assertion succeeds and the script exits 0 - that is what "the regression is observed" means. On the corrected reference revision, the same script must exit non-zero (raise/abort) - that is what "the regression is absent" means.** (Issue #184's prose - "fails on the buggy ref, passes on the fixed ref" - describes the same underlying regression from the opposite direction: whether the *correct answer* was produced, not the reproducer script's own exit status. This document's exit-code convention is the one the grader actually implements and the one every test in this repository asserts against.) The grader executes exactly that file against the historical build and the corrected build using the same research environment profile - never any canonical verification reproducer, which (when one exists for a case) exists only to prove the task instance is well-posed before an agent ever runs.

Before copying returned agent output the grader caps the workspace at 16 MiB and 2,048 entries; oversize output and paths that resolve outside the workspace are `integrity_error`, not infrastructure failures.

| Submission | Historical | Corrected | Grade |
| --- | --- | --- | --- |
| `not-reproduced` (any/no reproducer) | n/a | n/a | `miss` |
| `reproduced`, reproducer reproduces | does not reproduce | `rediscovered` |
| `reproduced`, reproducer does not reproduce | any | `miss` |
| `reproduced`, reproducer reproduces | reproduces | `invalid_submission` |
| malformed/missing `finding.json`, or `reproduced` without a valid `reproducer` | n/a | `invalid_submission` |
| build/start/grader failure | n/a | `infrastructure_error` |
| workspace escape/tamper | n/a | `integrity_error` |

Each revision's artifact directory retains source/build/runtime manifests, server log, grader output, and final `grade.json`. No infrastructure failure is converted into a miss.

## Local use

The programmatic entry points are `historicalPostgres001TaskSpec()`, `materializeHistoricalPostgresTask()`, `runHistoricalPostgresTrial()`, and `gradeHistoricalPostgresSubmission()` from `server/postgres/historical-task.ts`. `runHistoricalPostgresTrial()` is the real-agent vertical slice: it passes the public task prompt as `HONEYRAIL_TASK_PROMPT` and the opaque id as `HONEYRAIL_TASK_ID`, gives the isolated agent its normal `$HR_PG_WORK_DIR`, copies returned files grader-side, and grades the same submitted file on both revisions.

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

### Real-agent vertical slice

The base `docker/postgres-research` image deliberately ships no agent CLI ("which agent runs is the driver's choice"). `docker/postgres-research-agent-184/` is a derived image that adds exactly one: `mini-agent.mjs`, a small driver that makes genuine calls to an OpenAI-compatible chat-completions endpoint (no scripted/known-answer path) and drives `psql` through a `run_shell` tool, submitting via a `submit_finding` tool that is the only thing that writes `finding.json`.

A real LLM agent needs outbound network access to its model API, which the scored default (`network: "none"`) does not provide. `research-session.ts` already anticipates this: `isolation.network: "bridge"` is a supported, explicit opt-in that is honestly recorded as `scoredEligible: false` with a stated reason (see `unscoredReasons()`), rather than a silent downgrade. The two-revision **grading** of both pinned revisions is unaffected and stays fully isolated (`network: "none"`) regardless of the agent's own network mode, since grading never runs an agent - only `psqlFile()` against each revision's own runtime container.

```sh
docker build -t honeyrail-postgres-research-184-agent:latest docker/postgres-research-agent-184

export HONEYRAIL_PG_184_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_184_AGENT_COMMAND=node
export HONEYRAIL_PG_184_AGENT_ARGS='["/opt/agent/mini-agent.mjs"]'
export HONEYRAIL_PG_184_AGENT_IMAGE=honeyrail-postgres-research-184-agent:latest
export HONEYRAIL_PG_184_AGENT_NETWORK=bridge
export HONEYRAIL_PG_184_AGENT_ENV='{"HONEYRAIL_AGENT_LLM_API_KEY":"...","HONEYRAIL_AGENT_LLM_BASE_URL":"https://api.deepseek.com","HONEYRAIL_AGENT_LLM_MODEL":"deepseek-chat"}'
npm run historical-pg-184
```

`mini-agent.mjs` writes a `transcript.jsonl` (every model turn and tool call/result) into `$HR_PG_WORK_DIR`, so it is retained as part of the returned `agent-workspace` artifact alongside `finding.json` and any reproducer the agent wrote.
