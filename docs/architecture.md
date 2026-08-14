# Architecture

HoneyRail is a local Node.js runtime for verifiable engineering work. The current implementation builds on the Agent Gateway execution/control-plane subsystem: a React frontend, an Express backend, SQLite runtime state, tmux-backed agent execution, and REST/WebSocket/MCP interfaces.

The execution plane remains the Agent Gateway-derived kernel. M1 adds a small orchestration plane above it: persisted Runs, DAG Steps, registry-backed Executors, restart reconciliation, approval barriers, and REST/MCP controls. See [ADR 0001](adr/0001-execution-vs-orchestration-model.md).

## Runtime Shape

```text
React / Vite frontend
        |
        | REST + SSE + WebSocket
        v
Express backend
        |
        +-- SQLiteStore for projects, sessions, tasks, worktrees, events
        +-- EventBus for dashboard/session refreshes
        +-- TmuxManager for terminal-backed sessions
        +-- WorktreeManager for git worktree, diff, checks, commit, merge
        +-- MCP server for automation clients
        +-- Auth / OAuth for console and MCP access
```

## Frontend

The frontend lives in `src/` and is built with React and Vite. It provides:

- A dashboard and management views for projects, sessions, tasks, and worktrees.
- Project registration and workspace configuration.
- Task creation and session launch surfaces.
- Worktree diff, checks, commit, merge, and discard actions.
- A dedicated mobile-friendly session page with chat and terminal views.

The production frontend is generated into `dist/` by `npm run build` and served by the Express process.

## Backend

The backend lives in `server/` and is an Express app assembled by `server/api.ts` and started by `server/index.ts`.

Key route groups:

- `project-routes.ts`: project registry, workspace management, repository creation/registration.
- `session-routes.ts`: standalone sessions, input, keys, stop/delete, output capture.
- `task-routes.ts`: worktree-backed task creation and initial agent launch.
- `worktree-routes.ts`: diff, checks, commit, merge, and discard.
- `mcp-http-transport.ts` and `mcp-server.ts`: MCP automation surface.
- `oauth.ts` and `auth.ts`: console auth, bearer auth, and OAuth support for MCP clients.

## SQLite Store

`SQLiteStore` stores mutable runtime state in `~/.agent-gateway/gateway.sqlite` by default. It tracks:

- Projects
- Runs
- Steps
- Sessions
- Tasks
- Worktrees
- Events
- Settings

The older JSON store remains present for compatibility. On startup, a legacy `gateway.json` can be imported into SQLite once and then renamed to `gateway.json.bak`.

SQLite startup uses explicit sequential schema migrations. Fresh installs migrate to the latest schema, older supported schemas are upgraded in order, and migration failures stop startup instead of silently continuing.

## Orchestration Plane

An orchestration `Run` represents one execution of an explicit multi-step workflow for a project goal. Each `Step` belongs to a run, declares dependencies by step ID, and names a registry-backed executor.

M1 executors are deliberately small:

- `agent-task`: creates and reconnects to the existing Task/Session/Worktree lifecycle.
- `shell`: runs deterministic shell commands in a configured working directory with bounded output and timeout support.
- `check`: reuses the existing worktree check implementation.
- `approval`: blocks until an operator explicitly approves or rejects the step.

The scheduler validates DAGs before creating runs, marks steps ready only after dependencies succeed, skips downstream steps after upstream failure, persists attempts and execution references, and reconciles non-terminal runs on startup. Shell steps that disappear across process restart are marked failed because M1 does not try to reattach arbitrary local processes.

See [orchestration-dag-example.md](orchestration-dag-example.md) for a concrete multi-step REST payload.

## Evidence And Quality

M2 keeps verification data separate from execution state:

- `Artifact`: durable output or reference produced by a run or step, such as a log, file, directory, JSON document, or text result.
- `Evidence`: an observed fact or measurement, such as a command, status, exit code, duration, pass count, or extracted claim. Evidence may reference artifacts.
- `Evaluation`: deterministic rule output that says whether evidence, artifacts, or step output satisfies a criterion.

`step.status === "succeeded"` only means execution succeeded. A step can additionally declare a `qualityGate`:

```json
{
  "qualityGate": {
    "evaluators": [
      { "type": "check" },
      { "type": "boolean", "source": "output.ok" },
      { "type": "numeric-threshold", "source": "check.exitCode", "operator": "<=", "threshold": 0 }
    ],
    "onFail": "fail"
  }
}
```

Supported M2 evaluators are deterministic:

- `boolean`: compares a resolved source to an expected boolean, defaulting to `true`.
- `numeric-threshold`: compares a numeric source with `>`, `>=`, `<`, `<=`, `==`, or `!=`.
- `check`: requires all `check.command` evidence for the step to have passed with exit code `0`.

Quality gates are deliberately small. Passing gates allow downstream scheduling. Failed gates either fail the step or put it into the existing `waiting_approval` flow when `onFail` is `wait_approval`.

The first evidence producer is the `check` executor. Each command run registers a log artifact metadata record and a `check.command` evidence record with command, status, exit code, and duration.

## Event Bus

Domain events are published through `domain-events.ts` and `events.ts`. Events are stored and also emitted to connected UI clients so dashboards update after project, session, task, worktree, checks, commit, merge, and delete changes.

## tmux And Agent Execution

HoneyRail starts tmux sessions through `TmuxManager`. Backend-specific behavior is isolated in `server/agents/` adapters instead of being embedded in route handlers or lifecycle helpers.

Supported agent values in the current type model are:

- `shell`
- `codex`
- `claude`
- `hermes`

Each adapter owns the behavior that varies by backend:

- Launch command construction, including model flags and startup prompt placement.
- Initial and follow-up input formatting for text plus uploaded attachments.
- Interactive prompt auto-responses for known CLI trust/update dialogs.
- CLI installation/version detection used by health checks and `npm run doctor`.
- Capability and stability metadata consumed by generic API surfaces.

Routes, MCP tools, task creation, session restart, session monitoring, and health checks resolve adapters through the registry. Unknown backend identifiers fail clearly instead of falling back to shell.

Sessions capture logs under `~/.agent-gateway/sessions` by default. The WebSocket terminal endpoint streams tmux/session output to the frontend.

## Project, Task, Session, And Worktree Entities

A project points at a local git repository and defines defaults such as branch, agent, and check commands.

A task is an atomic execution primitive for a requested unit of agent work. It is not a workflow node and does not carry parent/child/dependency/DAG semantics in M0. Worktree-backed task creation:

1. Creates a task with `worktree_preparing`.
2. Creates a git worktree and branch under `AGENT_WORKTREE_ROOT`.
3. Starts the selected agent in tmux from that worktree.
4. Creates a session bound to the task/worktree.
5. Updates the task to `agent_running`.
6. Publishes events for UI and MCP observers.

A worktree tracks isolation and verification state, including branch, base revision, status, check runs, commit metadata, merge metadata, and errors.

Future orchestration should create or operate these task/session/worktree primitives from an additive Run/Step/Executor layer rather than overloading `Task`.

## Checks, Evidence, And Merge

Worktree checks run configured project commands or request-provided commands through `WorktreeManager`. Check results are stored on the worktree and task as `checkRuns`, including command, status, exit code, stdout, stderr, and timestamps.

Commit and merge actions are explicit API operations. MCP clients can call `propose_merge` to inspect merge readiness and `approve_merge` to perform the merge. The current implementation expects the operator or trusted client to decide when a merge is appropriate.

## MCP

The MCP server exposes projects, sessions, tasks, worktrees, checks, merges, dashboard state, and orchestration runs. MCP tool names are intentionally stable compatibility identifiers and are not renamed as part of branding work.

M1 adds `create_run`, `get_run`, `list_runs`, `cancel_run`, `approve_step`, and `reject_step`.

M2 run inspection includes verification summaries. REST additionally exposes:

- `GET /api/runs/:runId/artifacts`
- `GET /api/runs/:runId/evidence`
- `GET /api/runs/:runId/evaluations`
- `GET /api/artifacts/:artifactId`

The internal MCP server name remains `codex-remote-controller` during the HoneyRail bootstrap for client compatibility.

## Authentication

The gateway supports:

- Account login with signed session cookies.
- Optional bearer-token auth for API clients.
- OAuth authorization-code flow for MCP clients.

Production mode requires authentication. Development mode can run unauthenticated for local testing.
