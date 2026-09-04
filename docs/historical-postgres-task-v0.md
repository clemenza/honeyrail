# Historical PostgreSQL task v0

Issue #184 adds one local task contract for a historical PostgreSQL correctness regression. It uses the existing PostgreSQL research environment; it does not introduce another executor or orchestration layer.

## Layout and boundary

```text
case/
  task/
    source/                 # historical snapshot, no .git
    prompt.md
    task-manifest.json       # agent-visible: opaque id, hashes, execution settings only
    source-manifest.json     # agent-visible: sanitized {schemaVersion, sourceHash, gitDirPresent}
    workspace/               # agent-owned finding and repro files
  reference/                 # grader-owned only, never mounted into an agent
    reference-manifest.json  # protocol-level metadata (no revisions, no bug identity)
    truth.json                # the one place the bug identity and both revisions live
    source-manifest.json     # full PostgresSourceManifest: repoPath, ref, resolvedCommit, sourceDir
    expected-behavior/
    verification/
      canonical-reproducer.sql # retained only when truth.knownReproducerPath was supplied
```

The agent receives the historical source, prompt, live local instance, and writable workspace. It does not receive the reference bundle, the corrected source, either pinned revision, the original bug identity, a canonical reproducer, a local filesystem path, or anything else under `reference/`.

`task-manifest.json` is schema version 1. It carries only the opaque `taskId`, `database`/`taskType`, scaffolding/budget/build-profile settings, and SHA-256 hashes (`sourceTree`, `prompt`, `taskDefinition`, `truthBundle`) - no revision strings and no bug identity. `task/source-manifest.json` is likewise sanitized: `materializePostgresSource()` returns a full `PostgresSourceManifest` (`repoPath`, `ref`, `resolvedCommit`, `sourceDir`, `sourceHash`, `gitDirPresent`) which directly names the historical revision and a local grader-only mirror path, so only `{schemaVersion, sourceHash, gitDirPresent}` is written into `task/`; the full manifest is retained at `reference/source-manifest.json` instead. `reference-manifest.json` is grader-private protocol metadata (grading protocol, `taskDefinitionHash`, and a pointer hash to the truth bundle) and likewise carries no revisions or bug identity. `reference/truth.json` is the one artifact that records the original bug identity (`upstreamBug`, `commitFest`), both pinned revisions (`historicalRevision`, `referenceRevision`), and - when a canonical verification reproducer was supplied - the reproducer itself, physically retained at `reference/verification/canonical-reproducer.sql` (never the original host path), plus its grader-private relative path (`canonicalReproducer`) and SHA-256 (`canonicalReproducerSha256`); provenance only, the grader never executes it as part of grading. When no canonical reproducer was supplied, both `canonicalReproducer` and `canonicalReproducerSha256` are `null` and no file is created. Its `bundleHash` is computed over all of those fields plus a hash of the `expected-behavior`/`verification` material (so the retained reproducer file itself also moves the bundle hash), and is computed before `truth.json` is written, so the bundle's own hash is real provenance rather than a hash of unrelated shape metadata or of itself; `test/historical-postgres-task.test.ts` proves this by re-materializing the bundle with each field changed in turn and asserting the hash actually moves, not by comparing a fabricated tampered copy.

A dedicated test (`"no file anywhere under task/ leaks..."`) walks the entire `task/` tree recursively and asserts no file's text contains either revision, the upstream bug id, the CommitFest id, the local mirror path, the canonical reproducer's contents, relative path, or hash, or the canonical reproducer's original host path - so a future field added to any file under `task/` is covered automatically, not just `task-manifest.json`.

Two local cases exist so far. The first has the opaque id `postgres-historical-001` (`historicalPostgres001TaskSpec()`, #184); its truth bundle records the real upstream bug and both pinned revisions, but neither this document nor any agent-visible artifact does. The second has the opaque id `postgres-historical-002` (`historicalPostgres002TaskSpec()`, #200 - Bug 2 of the corpus tracked in #185); it follows the identical boundary and grading contract. Its descriptive corpus slot id, `pg-hist-plpgsql-call-stale-plan-002`, names PL/pgSQL, `CALL`, and "stale plan" outright, so it is used only in source comments and this document for administrative traceability back to #185 - it is never the agent-visible `taskId`, never written into `task-manifest.json`, and never reaches `HONEYRAIL_TASK_ID`. Its upstream bug was reported directly to pgsql-bugs rather than submitted through a CommitFest, so it has no CommitFest identity at all: `HistoricalPostgresTaskSpec.truth.commitFest` is optional, and `reference/truth.json` records `commitFest: null` rather than a fabricated number whenever a case has none. Every other truth field (`upstreamBug`, both revisions, the canonical-reproducer provenance) is still recorded and still covered by `bundleHash` exactly as before; `commitFest`'s presence or absence is just one more fact the hash covers, not a hole in it.

### Behavioral oracle: attributing a rediscovery to the specific bug, not just to a revision-discriminating script

An exit-status differential alone - the submitted reproducer exits 0 on the historical ref and non-zero on the reference ref - proves only that the script distinguishes *some* difference between the two builds, not that the agent actually rediscovered the specific regression a task is about. `HistoricalPostgresTaskSpec.truth.behavioralOracle` (`server/postgres/historical-behavioral-oracle.ts`) closes that gap with a small, generic, declarative mechanism any historical task can opt into - not a bug-specific executor branch:

```ts
behavioralOracle?: {
  historical: { label: string; matches: string }[]; // ordered patterns the buggy ref's captured output must match
  reference: { label: string; matches: string }[];  // ordered patterns the fixed ref's captured output is expected to match
}
```

When a task declares one, `resolveOracleReproduction()` extracts the ordered sequence of psql `ERROR` message bodies from the submitted reproducer's own captured stderr (`extractPsqlErrorObservations()` - this also strips any leading `psql:<file>:<line>:` label, so source path/line never enters an observation and never needs separate normalization) and matches it, in order, against `behavioralOracle.historical` (`evaluateBehavioralOracle()`). **The same `historical` pattern set is tested on both revisions** - symmetric by design: this is what makes `HistoricalPostgresRevisionObservation.reproduced` mean the same thing regardless of which side produced it ("does this build's captured output match the known regression's own signature?"), so the existing `historical.reproduced`/`reference.reproduced` classification formula in `gradeHistoricalPostgresSubmission()` needs no change at all - a reference-ref run that reproduces the buggy signature (e.g. a stale-cache failure appearing on the "fixed" build) is `reproduced: true` there too, which the formula already reads as disqualifying (`invalid_submission`), never a spurious `rediscovered`. `behavioralOracle.reference` is not dead data even though it doesn't drive `reproduced`: whenever a reference-ref run does *not* match the historical signature, its evidence additionally records whether it positively confirmed the declared expected (fixed) baseline pattern, or failed for some other, unattributed reason - visible in `oracle.diagnostics`.

A dynamic value like the stale-plan failure's OID is matched structurally (`matches: "^cache lookup failed for function \\d+$"`), never stripped out of the observation with a broad transform - a targeted, anchored pattern in the declared expectation is what keeps a meaningful difference elsewhere in a message from ever being silently erased.

Absent a declared oracle (case 001, and any synthetic/unit-test spec), `reproduced` is exactly the legacy `execution.ok` exit-status differential - zero behavior change.

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

## Scored vs. unscored: `HistoricalPostgresTrial.status`

`runHistoricalPostgresTrial()` returns `status: "completed" | "unscored" | "blocked" | "infrastructure_error" | "integrity_error"` and a top-level `scoredEligible: boolean`, which mirrors `session.isolation.scoredEligible` from `research-session.ts`. These are two separate facts and a consumer must check both, not just `status`:

- **`scoredEligible: false`** - the run's isolation was not the scored configuration (most commonly `network: "bridge"`, which a real LLM agent needs for model-API access; see `unscoredReasons()`). The deterministic grader still runs, because a diagnostic result is useful evidence, but `status` is `"unscored"`, never `"completed"` - a bridge-network run can never produce an official scored `miss` or `rediscovered`, no matter what `grade.status` says. `diagnostics` includes an explicit `"Not a scored trial: ..."` line carrying `session.isolation.warning`.
- **`scoredEligible: true` and `status: "completed"`** - `grade` is the official score.
- **`status: "blocked"`** - the agent process itself did not exit 0 (`session.agent.ok === false`): a driver configuration error, an LLM-API/driver exception, or exhausting its turn budget without a valid submission (see below). No grader ever runs in this case, and `grade` is `undefined` - a blocked run is never counted as a miss.

## Local use

The programmatic entry points are `historicalPostgres001TaskSpec()` / `historicalPostgres002TaskSpec()`, `materializeHistoricalPostgresTask()`, `runHistoricalPostgresTrial()`, and `gradeHistoricalPostgresSubmission()` from `server/postgres/historical-task.ts`. `runHistoricalPostgresTrial()` is the real-agent vertical slice: it passes the public task prompt as `HONEYRAIL_TASK_PROMPT` and the opaque id as `HONEYRAIL_TASK_ID`, gives the isolated agent its normal `$HR_PG_WORK_DIR`, copies returned files grader-side, and grades the same submitted file on both revisions.

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

Case 002 (#200) follows the identical shape, on `HONEYRAIL_PG_200_*` instead of `HONEYRAIL_PG_184_*` - **with one difference: `HONEYRAIL_PG_200_REPRODUCER` is a hard requirement for `npm run historical-pg-200`, not an optional one.** Unlike case 001's script, `scripts/historical-postgres-200.ts` fails fast if it's unset, so a real Bug 2 trial can never run without canonical truth provenance:

```sh
export HONEYRAIL_PG_200_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_200_REPRODUCER=/private/path/to/known-repro.sql
npm run test:historical-pg-200

export HONEYRAIL_PG_200_AGENT_COMMAND=/path/in/agent-image/to/agent
npm run historical-pg-200
```

### Case 002's canonical reproducer (private, not committed)

Like case 001's, case 002's canonical verification reproducer is deliberately **not** committed to this repository: this is a public repo, and checking in the answer key would let it leak into a future agent's training data, which would defeat the eval it is meant to validate. `HONEYRAIL_PG_200_REPRODUCER` points at a private local file; `historicalPostgres002TaskSpec()`'s `knownReproducerPath` parameter only hashes it into `reference/truth.json` for provenance (`canonicalReproducerSha256`) and, when the test above is run, retains a copy under the case's own `reference/verification/canonical-reproducer.sql` - grader-private, never mounted into an agent. The grader never executes this file as part of grading a submission; it exists only to prove a task instance is well-posed before any agent runs.

Thanks to the behavioral-oracle mechanism above, this file's own contract is now simpler than an earlier draft of this document described: the script no longer has to self-assert its own pass/fail via a captured-and-compared exit status. It only has to survive far enough into the session for HoneyRail's grader to capture both `ERROR` observations from its stderr. Building it locally, encode the five-step sequence recorded in #185 (create wrapper procedure `p1`, create called procedure `p2`, invoke `p1` once to record the baseline error, drop and recreate `p2`, invoke `p1` again) as a single `psql -X` script:

1. `\set ON_ERROR_STOP off` before any DDL/CALL runs - the first invocation of `p1` is *expected* to error (that is the recorded baseline, not a script failure), and the script must keep running past it to reach the drop/recreate and the second invocation. `psqlFile()` in `runtime-container.ts` invokes psql with `-v ON_ERROR_STOP=1` as an initial variable, but a `\set` meta-command inside the script file overrides it before the first statement runs, so no change to the shared research-environment code is needed for this.
2. Run the wrapper procedure `p1` once (recording the baseline `ERROR`), drop and recreate the called procedure `p2`, then run `p1` again (recording the second `ERROR`) - no captured-`SQLERRM`/`regexp_replace`/forced-exit-code machinery is needed in the script itself; HoneyRail's grader (`resolveOracleReproduction()`/`extractPsqlErrorObservations()`/`evaluateBehavioralOracle()`) independently extracts and matches both `ERROR` observations from psql's own stderr against `historicalPostgres002TaskSpec()`'s declared `truth.behavioralOracle` patterns, using `\d+` to match the buggy ref's dynamic OID rather than any client-side normalization.
3. `\set ON_ERROR_STOP on` and `psql -X` (ignore any local `.psqlrc`) at the end are still good practice for a clean exit, but the script's own final exit status is no longer what grading depends on for this task.

### Real-agent vertical slice

The base `docker/postgres-research` image deliberately ships no agent CLI ("which agent runs is the driver's choice"). `docker/postgres-research-agent-184/` is a derived image that adds exactly one: `mini-agent.mjs`, a small driver that makes genuine calls to an OpenAI-compatible chat-completions endpoint (no scripted/known-answer path) and drives `psql` through a `run_shell` tool, submitting via a `submit_finding` tool that is the only thing that writes `finding.json`.

A real LLM agent needs outbound network access to its model API, which the scored default (`network: "none"`) does not provide. `research-session.ts` already anticipates this: `isolation.network: "bridge"` is a supported, explicit opt-in that is honestly recorded as `scoredEligible: false` with a stated reason (see `unscoredReasons()`), rather than a silent downgrade. The two-revision **grading** of both pinned revisions is unaffected and stays fully isolated (`network: "none"`) regardless of the agent's own network mode, since grading never runs an agent - only `psqlFile()` against each revision's own runtime container. See "Scored vs. unscored" above: a bridge-network run is always `status: "unscored"`, never a scored `miss`/`rediscovered`.

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

The script prints a "Real-agent trial summary" block distinguishing integration status, `scoredEligible`, the diagnostic grader result, and the official scored result (`"N/A"` whenever `scoredEligible` is false) - and its own exit code reflects only integration failure (`blocked`/`infrastructure_error`/`integrity_error`), never "not scored".

#### mini-agent failure attribution

`research-session.ts` reads only the child process's exit code to decide `agent.ok`, so `mini-agent.mjs`'s exit code is what keeps a driver/protocol failure from being misreported as a graded outcome:

| Situation | Exit code | `HistoricalPostgresTrial.status` |
| --- | --- | --- |
| Valid `submit_finding` call (`reproduced` or `not-reproduced`) | 0 | proceeds to grading (`completed`/`unscored`) |
| Missing `HONEYRAIL_AGENT_LLM_API_KEY` or `HONEYRAIL_TASK_PROMPT` | 1 (config error) | `blocked` |
| LLM API error (401/429/500/...), malformed API response, or any other driver exception | 2 (driver error) | `blocked` |
| Turn budget exhausted without a valid `submit_finding` call | 3 (budget exhausted) | `blocked` |

The driver never fabricates a `finding.json` on the model's behalf: a malformed `submit_finding` call (missing/invalid `status`, empty `summary`, or a `"reproduced"` call missing `reproducer_filename`/`reproducer_sql`) returns a tool error to the model - recorded in the transcript exactly as attempted - rather than being silently normalized into a valid submission, and running out of budget without ever producing a valid call is a driver-attributed `blocked` run, not a manufactured `not-reproduced` miss. The validation itself (`validateSubmitFindingArgs`) is a small pure function in `docker/postgres-research-agent-184/finding-validation.mjs`, unit-tested directly in `test/historical-postgres-mini-agent-validation.test.ts` without a real API call.

#### Evidence: agent-owned vs. grader-owned

- **Grader-owned** (written by HoneyRail code, not the agent): `task-manifest.json`, `reference/truth.json`, `agent-result.json` (the full session/isolation/runtime record), `agent-stdout.txt`/`agent-stderr.txt` (the agent process's own captured stdio), `agent-postgres.log` (the live PostgreSQL server log from the agent's own investigation session - copy failure is recorded as an `evidence_warning` diagnostic, never silently dropped), and `grader/grade.json`.
- **Agent-owned** (written by the agent itself into its writable workspace, then copied grader-side as `agent-workspace/`): `finding.json`, any reproducer file, and `transcript.jsonl` (every model turn and tool call/result mini-agent.mjs logs). This is useful v0 evidence for understanding what the agent tried, but it is not immutable or grader-trusted the way the manifests above are - the agent process itself could in principle have written anything into its own workspace. Treat it as agent-reported trajectory, not verified execution evidence.
