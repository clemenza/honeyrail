# Database Testing Harness Alpha

HoneyRail's Database Testing Harness Alpha proves that the orchestration runtime can deploy a local database target, execute deterministic checks, persist artifacts and evidence, evaluate results, gate progression, and produce an auditable final report.

The first reference target is PostgreSQL running in Docker, with local binaries as a fallback. This is intentionally small: it validates transactional correctness and basic restart recovery, not replication, HA, PITR, upgrades, or performance.

## Architecture

The harness preserves the runtime boundary:

```text
Execution -> Artifact -> Evidence -> Evaluation -> Gate Decision -> Workflow Progression
```

For the PostgreSQL Alpha:

```text
postgres executor
  -> environment/query/log/report artifacts
  -> db.server.ready / db.query.result / db.assertion / db.restart evidence
  -> db-assertions and boolean evaluators
  -> QualityGateDecision
  -> report step
```

The `postgres` executor is DB-specific but isolated from the DAG kernel. It supports two operations:

- `transaction-restart-alpha`: starts PostgreSQL in Docker or from local binaries, runs commit/rollback SQL, verifies rows, restarts PostgreSQL, verifies again, records artifacts/evidence, then cleans up the process/container.
- `report`: reads the source step's artifacts, evidence, evaluations, and gate decisions, then writes `final-report.md`.

## Prerequisites

Docker is the preferred execution mode:

```sh
docker info
docker run --rm postgres:16-alpine postgres --version
```

The default Docker image is `postgres:16-alpine`. Override it per run with `input.dockerImage`, or process-wide with:

```sh
HONEYRAIL_POSTGRES_DOCKER_IMAGE=<your-postgres-image>
```

The optional test suite only runs Docker harness tests when Docker is available and a PostgreSQL image is available locally, or when `HONEYRAIL_POSTGRES_DOCKER_IMAGE` is set. This keeps CI from depending on Docker Hub network pulls.

Local PostgreSQL binaries are supported as a fallback when `executionMode` is `local-binaries` or Docker is unavailable in `auto` mode:

```sh
command -v initdb
command -v pg_ctl
command -v psql
command -v postgres
initdb --version
pg_ctl --version
psql --version
postgres --version
```

The executor uses trust auth inside the temporary Docker container or local data directory. It does not persist credentials or cloud secrets.

## REST Payload

Create a passing Alpha run:

```json
{
  "projectId": "proj_...",
  "goal": "PostgreSQL transaction restart alpha",
  "steps": [
    {
      "id": "verify",
      "name": "PostgreSQL transaction and restart validation",
      "executor": "postgres",
      "input": {
        "operation": "transaction-restart-alpha",
        "executionMode": "docker",
        "dockerImage": "postgres:16-alpine"
      },
      "qualityGate": {
        "evaluators": [
          { "type": "db-assertions" },
          { "type": "boolean", "source": "output.databaseReady", "expected": true }
        ],
        "onFail": "wait_approval"
      }
    },
    {
      "id": "report",
      "name": "Generate DB alpha report",
      "executor": "postgres",
      "dependsOn": ["verify"],
      "input": {
        "operation": "report",
        "sourceStepId": "verify"
      }
    }
  ]
}
```

Create a deterministic failing run by changing one expectation:

```json
{
  "operation": "transaction-restart-alpha",
  "expectedCommittedRows": 2
}
```

The deterministic data contains one committed row, so this fails `db-assertions` and puts the run into `waiting_approval`.

## Inspection

Reuse the existing run inspection APIs:

```sh
GET /api/runs/:runId
GET /api/runs/:runId/artifacts
GET /api/runs/:runId/evidence
GET /api/runs/:runId/evaluations
GET /api/runs/:runId/gate-decisions
```

Run detail includes verification summaries, all historical evaluations, and gate decisions. Evaluation summary counts are based on the latest attempt, while historical evaluations remain queryable.

## Artifact Flow

The Alpha creates generic artifacts with DB metadata:

- `environment.json`
- `setup.sql`
- `verification.sql`
- `query-results.json`
- `test-summary.json`
- `postgres.log`
- `final-report.md`

Metadata includes database product, scenario, phase, execution mode, Docker image or binary paths, version, port, and run id. Secrets are not written.

## Evidence Flow

The Alpha records DB-specific evidence on the generic Evidence model:

- `db.server.ready`
- `db.query.result`
- `db.assertion`
- `db.restart`
- `db.process.health`

Each artifact, evidence item, and evaluation created by a step records the step attempt.

## Evaluation And Gates

Evaluators can be synchronous or asynchronous. Registered custom evaluator types are accepted by run creation, and unknown types are rejected by the evaluator registry.

`db-assertions` consumes `db.assertion` evidence for the current step attempt and passes only when all assertions passed.

Quality gate decisions are first-class persisted records:

- Passing evaluations create `PASSED` by `system`.
- Failed evaluations with `onFail: "fail"` create `FAILED` by `system`.
- Failed evaluations with `onFail: "wait_approval"` create `FAILED` by `system` and pause the run.
- Operator approval creates `OVERRIDDEN` by `operator`; the failed Evaluation remains failed.
- Operator rejection creates `FAILED` by `operator` and the run fails.

## Passing Example

Expected Alpha result:

```text
Assertions
- committed rows persisted
- rolled-back rows absent
- total row count matches expectation
- PostgreSQL became ready after restart

Evaluations
- db-assertions: PASS
- boolean: PASS

Quality Gate
- PASSED by system

Result
VERIFIED
```

## Failing And Override Example

With `expectedCommittedRows: 2`:

```text
Evaluation: FAIL
Gate Decision: FAILED by system
Run: waiting_approval
```

If the operator approves:

```text
Evaluation: FAIL
Gate Decision: OVERRIDDEN by operator
Downstream report: runs
Final result: OVERRIDDEN BY OPERATOR
```

If the operator rejects:

```text
Evaluation: FAIL
Gate Decision: FAILED by operator
Run: failed
Report step: skipped
```

## Running Locally

Run the always-on tests:

```sh
env -u AGENT_GATEWAY_ACCOUNTS -u AGENT_GATEWAY_TOKEN -u AGENT_GATEWAY_SESSION_SECRET npm test
```

`test/postgres-alpha.test.ts` runs a real Docker PostgreSQL instance when Docker and a PostgreSQL image are available. It also probes local PostgreSQL binaries and skips that fallback probe when they are not runnable.

## Known Limitations

- PostgreSQL only.
- Docker and local binaries only; Podman and cloud provisioning are not implemented.
- No replication, HA, PITR, upgrade testing, performance benchmarking, distributed runners, LLM judge, or DB-specific UI.
- The executor is scenario-focused and does not expose a generic SQL plugin SDK.
