# HoneyRail

Give it an engineering goal. Get back evidence.

HoneyRail is an open-source runtime for long-horizon, verifiable engineering work.

It orchestrates mature coding agents and deterministic tools through persisted DAG workflows, artifacts, evidence, evaluators, quality gates, human approvals, and reproducible engineering harnesses.

We don't build another coding agent. We harness the best ones.

HoneyRail starts from the Agent Gateway execution/control-plane subsystem: isolated git worktrees, tmux-backed agent sessions, task and worktree lifecycle state, project checks, evidence capture, REST/WebSocket/MCP automation, and an explicit human review step before merge. Run/Step orchestration, verification records, quality gate decisions, and the PostgreSQL Database Testing Harness Alpha now sit above that execution plane.

## Why

Coding agents are becoming long-running engineering executors. Raw terminal sessions are useful, but they do not provide enough lifecycle management, isolation, verification, auditability, or approval control once agents start changing real repositories.

HoneyRail adds a local runtime around those agents so each engineering goal can become tracked work: a project, branch, worktree, session, checks, events, artifacts, and an explicit merge decision.

## What It Does

- Runs persisted `Run` / `Step` DAG workflows above the atomic task/session/worktree lifecycle.
- Executes workflow steps through `agent-task`, `shell`, `check`, `approval`, and PostgreSQL harness executors.
- Creates isolated git worktrees per task and monitors project, task, session, worktree, and tmux state.
- Captures artifacts and evidence from checks, sessions, and harness steps.
- Runs deterministic evaluators plus async/custom evaluator registry entries.
- Persists `QualityGateDecision` records for pass, fail, operator override, and operator rejection.
- Supports human approval, rejection, commit, and merge review flows.
- Provides a PostgreSQL Database Testing Harness Alpha for Docker or local-binary transaction/restart validation.
- Exposes inspection and control through the web UI, REST, WebSocket, and MCP interfaces.
- Self-hosts locally on your own machine or trusted network.

## Architecture

```text
Goal -> Run / DAG -> Executors -> Artifacts -> Evidence -> Evaluation -> Quality Gate Decision -> Human override / progression -> Verified result
```

```text
                 Web / Mobile
                      |
          MCP / REST / Automation
                      |
                      v
                HoneyRail
        +-----------------------+
        | Execution runtime     |
        | Atomic task lifecycle |
        | Worktree isolation    |
        | Checks / approval     |
        | Events & state        |
        +-----------+-----------+
                    |
          +---------+---------+
          |         |         |
          v         v         v
        Codex     Claude    Shell/...
```

See [docs/architecture.md](docs/architecture.md) for the current implementation and [docs/adr/0001-execution-vs-orchestration-model.md](docs/adr/0001-execution-vs-orchestration-model.md) for the M0 architecture boundary.

## Quick Start

### Prerequisites

- Node.js 22 or newer with npm
- tmux
- git
- At least one agent CLI if you want agent-backed sessions, such as Codex CLI or Claude Code

Clone the repository:

```sh
git clone https://github.com/clemenza/honeyrail.git
cd honeyrail
```

Install dependencies:

```sh
npm install
```

Check local runtime readiness without starting the server:

```sh
npm run doctor
```

Create a local production configuration with a hashed console password:

```sh
npm run setup
```

Start the local runtime:

```sh
npm run ops:start
```

Open `http://127.0.0.1:4178`.

Basic first-project workflow:

1. Open Projects.
2. Register an existing local git repository.
3. Choose a default agent and optional check commands.
4. Create a worktree-backed task.
5. Watch the agent session, inspect the diff, run checks, commit, and merge after review.

Production-style local ops run the runtime in a tmux session named `honeyrail_server`:

```sh
npm run ops:start
npm run ops:status
npm run ops:restart
npm run ops:stop
```

`ops:start` builds the frontend and runs TypeScript checks before launching a fresh server. `ops:restart` stops the current tmux server and then calls `ops:start`, so both backend code and frontend assets are refreshed.

Production mode refuses to start unless account or bearer-token authentication is configured:

```sh
export HONEYRAIL_ACCOUNTS='[{"username":"you@example.com","password":"change-me","permissions":["console"]}]'
export HONEYRAIL_SESSION_SECRET='replace-with-a-long-random-secret'
```

Common configuration:

- `PORT`: server port, default `4178`
- `HONEYRAIL_TMUX_SESSION`: tmux server session, default `honeyrail_server`
- `HONEYRAIL_LOG_FILE`: server log path, default `npm_start.log`
- `HONEYRAIL_CONFIG`: config file path, default `~/.honeyrail/config.json`
- `HONEYRAIL_DATA`: SQLite state file, default `~/.honeyrail/gateway.sqlite`
- `HONEYRAIL_LEGACY_JSON_DATA`: legacy JSON state file to migrate on first SQLite startup, default `~/.honeyrail/gateway.json`
- `HONEYRAIL_WORKTREE_ROOT`: task worktree root, default `~/agent-worktrees`
- `HONEYRAIL_ATTACHMENT_ROOT`: uploaded attachment root, default `~/.honeyrail/attachments`
- `HONEYRAIL_SESSION_LOG_ROOT`: per-session transcript root, default `~/.honeyrail/sessions`
- `HONEYRAIL_TOKEN`: optional bearer token for API clients
- `HONEYRAIL_PUBLIC_BASE_URL`: public origin used for OAuth/MCP metadata behind a proxy
- `HONEYRAIL_HEALTH_INTERVAL_MS`: session health check interval, default `15000`
- `HONEYRAIL_SESSION_STALE_MS`: stale-session threshold, default `1800000`
- `HONEYRAIL_ORCHESTRATION_POLL_INTERVAL_MS`: interval for re-scheduling non-terminal orchestration runs (needed for executors like `shell` that complete a detached background process), default `3000`

Deprecated names: the old `AGENT_GATEWAY_*` / `AGW_*` / `~/.agent-gateway` names still work with a startup warning and will be removed no earlier than v0.4. Run `npm run doctor` to check which naming scheme is active.

## Example Workflow

```text
Create task
  -> create worktree
  -> launch agent
  -> inspect changes
  -> run checks
  -> commit
  -> propose merge
  -> human approve
  -> merge
```

The current UI exposes commit, checks, and merge actions directly on worktrees. MCP clients can use `propose_merge` to preview risk and `approve_merge` to perform the merge after an operator decision.

Tasks remain atomic execution primitives: one agent execution, one worktree, one session, and one verification/merge lifecycle. Run/Step orchestration sits above tasks rather than changing that meaning.

M1 orchestration can run explicit DAGs through `agent-task`, `shell`, `check`, and `approval` executors. Runs and steps persist in SQLite, resume on server restart, and are exposed through REST and MCP.

M2 adds first-class verification data above execution status. A step can now emit artifacts, record evidence, run deterministic evaluators, and apply a quality gate before downstream steps proceed. Execution success and verification success are intentionally separate.

For concrete REST payloads, see [docs/orchestration-dag-example.md](docs/orchestration-dag-example.md).

## Human-in-the-loop & timeouts

An `agent-task` step can never hold a run open forever waiting on a clarifying question. Run-launched agents default to an unattended mode that tells them not to ask and to state assumptions instead; if one asks (or stalls) anyway, an `onBlocked` policy per step controls what happens next — mark it `blocked` immediately for a human/script to retry (the default for unattended steps), retry automatically, get auto-answered by an LLM, or escalate to an operator, bounded by a timeout in every case so nothing hangs indefinitely. A blocked step can be answered directly from the Runs UI or via `POST /api/runs/:runId/steps/:stepId/answer`, without opening its tmux session, or retried via `POST /api/runs/:runId/steps/:stepId/retry`.

See [docs/human-in-the-loop.md](docs/human-in-the-loop.md) for the `interaction`/`onBlocked` fields, the answer endpoint, and the `BLOCKED:` escape hatch an unattended agent uses when it's genuinely stuck.

## Interfaces

- Web UI: project registry, task creation, session console, worktree inventory, diffs, checks, commits, and merges.
- Mobile/PWA: a focused session view for phone and tablet operation, including chat/terminal tabs, pinned composer, image input, and common control actions.
- MCP: tools for projects, sessions, tasks, worktrees, checks, merge proposal/approval, and dashboard state.

Mobile is an interface, not the product identity. The core product is the runtime for verifiable engineering work.

## Supported Agents

Stable in the current codebase:

- Shell sessions
- Codex CLI sessions
- Claude Code sessions

Experimental or deployment-specific:

- Hermes sessions
- MCP automation clients

Agent-specific launch commands, attachment input formatting, interactive prompt handling, CLI detection, and capability metadata live behind server-side adapters in `server/agents/`. See [docs/agent-adapters.md](docs/agent-adapters.md) before adding or changing an agent backend. Do not assume every CLI feature from every agent is supported today.

## Security Model

HoneyRail can execute local shell commands, launch coding agents, control tmux sessions, read repositories, accept uploaded images, and merge code. Treat it like privileged local developer tooling.

- Do not expose it directly to the public internet.
- Prefer a private network, VPN, Tailscale, or authenticated reverse proxy.
- Use strong unique account passwords, bearer tokens, and session secrets.
- Do not run it as root.
- Keep human approval for merge-sensitive workflows.

See [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md).

## Development And Verification

Common verification commands:

```sh
npm run dev
npm run doctor
npm run typecheck
env -u HONEYRAIL_ACCOUNTS -u HONEYRAIL_TOKEN -u HONEYRAIL_SESSION_SECRET npm test
npm run build
npm run test:e2e
```

The test command is usually run with auth environment variables unset so tests that intentionally create unauthenticated local apps are not affected by the operator's shell environment.

Runtime data is stored outside source control:

- `~/.honeyrail/config.json`
- `~/.honeyrail/gateway.sqlite`
- `~/.honeyrail/gateway.json.bak` after first legacy JSON migration, when applicable
- `~/.honeyrail/attachments/`
- `~/.honeyrail/sessions/`
- `~/agent-worktrees/`

Local generated or runtime directories such as `dist/`, `node_modules/`, `output/`, `test-results/`, `.omx/`, `.remember/`, `.playwright-cli/`, and `.omc/` should not be committed.

## Project Status

HoneyRail is pre-1.0 developer tooling. APIs, UI flows, and MCP tool shapes may evolve as the project hardens. Issues and focused pull requests are welcome.

## Roadmap

See [ROADMAP.md](ROADMAP.md). M1/M2 orchestration and verification primitives are present as alpha interfaces. The Database Testing Harness is also available as a PostgreSQL Alpha. Later milestones harden environment abstraction, benchmarking, distributed operation, and stable contracts.

## First Major Milestone: Database Testing Harness

The Database Testing Harness Alpha is implemented for PostgreSQL transaction/restart validation through Docker or local PostgreSQL binaries. It deploys a temporary target, runs deterministic SQL checks, records artifacts and evidence, evaluates DB assertions, writes quality gate decisions, and produces a final Markdown report.

See [docs/database-testing-harness-alpha.md](docs/database-testing-harness-alpha.md) for the current scope, payloads, artifacts, evidence, quality gate behavior, and limitations.

Its sibling for Historical PostgreSQL work is the PostgreSQL Research Environment: build an exact PostgreSQL source ref, stand up an isolated ephemeral cluster, let an agent run arbitrary local experiments against it, and clean up deterministically. See [docs/postgres-research-environment.md](docs/postgres-research-environment.md).

```text
Goal
  -> Run / DAG
  -> PostgreSQL executor
  -> temporary Docker or local-binary environment
  -> deterministic transaction/restart checks
  -> artifacts and evidence
  -> db-assertions evaluator
  -> QualityGateDecision
  -> final report
```

## Eval Harness Demo

The DSH x tinytable-evals mutation-testing demo (agent-as-test-engineer, kill-rate scoring) is documented in [docs/dsh-evals-demo.md](docs/dsh-evals-demo.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
