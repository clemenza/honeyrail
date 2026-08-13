# HoneyRail

Give it an engineering goal. Get back evidence.

HoneyRail is an open-source runtime for long-horizon, verifiable engineering work. It will orchestrate mature coding agents such as Codex and Claude Code together with deterministic tools, environments, evaluators, artifacts, and human approval. The current v0.1 foundation is the execution/control-plane runtime those orchestration features will build on.

We don't build another coding agent. We harness the best ones.

HoneyRail starts from the Agent Gateway execution/control-plane subsystem: isolated git worktrees, tmux-backed agent sessions, task and worktree lifecycle state, project checks, evidence capture, REST/WebSocket/MCP automation, and an explicit human review step before merge.

## Why

Coding agents are becoming long-running engineering executors. Raw terminal sessions are useful, but they do not provide enough lifecycle management, isolation, verification, auditability, or approval control once agents start changing real repositories.

HoneyRail adds a local runtime around those agents so each engineering goal can become tracked work: a project, branch, worktree, session, checks, events, artifacts, and an explicit merge decision.

## What It Does

- Run multiple coding-agent backends from one local console.
- Create isolated git worktrees per task.
- Monitor project, task, session, worktree, and tmux state.
- Interact from desktop browsers or the mobile/PWA session UI.
- Inspect diffs, git status, and recent commits.
- Run configured project checks.
- Capture check results and session evidence.
- Review work before merge.
- Expose workflows through REST, WebSocket, and MCP interfaces.
- Create explicit multi-step Runs with dependency-ordered Steps and approval barriers.
- Self-host locally on your own machine or trusted network.

## Architecture

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
export AGENT_GATEWAY_ACCOUNTS='[{"username":"you@example.com","password":"change-me","permissions":["console"]}]'
export AGENT_GATEWAY_SESSION_SECRET='replace-with-a-long-random-secret'
```

Common configuration:

- `PORT`: server port, default `4178`
- `AGW_TMUX_SESSION`: tmux server session, default `honeyrail_server`
- `AGW_LOG_FILE`: server log path, default `npm_start.log`
- `AGENT_GATEWAY_CONFIG`: config file path, default `~/.agent-gateway/config.json`
- `AGENT_GATEWAY_DATA`: SQLite state file, default `~/.agent-gateway/gateway.sqlite`
- `AGENT_GATEWAY_LEGACY_JSON_DATA`: legacy JSON state file to migrate on first SQLite startup, default `~/.agent-gateway/gateway.json`
- `AGENT_WORKTREE_ROOT`: task worktree root, default `~/agent-worktrees`
- `AGENT_ATTACHMENT_ROOT`: uploaded attachment root, default `~/.agent-gateway/attachments`
- `AGENT_SESSION_LOG_ROOT`: per-session transcript root, default `~/.agent-gateway/sessions`
- `AGENT_GATEWAY_TOKEN`: optional bearer token for API clients
- `AGENT_GATEWAY_PUBLIC_BASE_URL`: public origin used for OAuth/MCP metadata behind a proxy
- `AGENT_HEALTH_INTERVAL_MS`: session health check interval, default `15000`
- `AGENT_SESSION_STALE_MS`: stale-session threshold, default `1800000`

The `AGENT_GATEWAY_*`, `~/.agent-gateway`, REST, MCP, SQLite, and tmux identifiers are compatibility surfaces inherited from the Agent Gateway subsystem. They are intentionally not renamed during the HoneyRail bootstrap.

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

For a concrete REST payload, see [docs/orchestration-dag-example.md](docs/orchestration-dag-example.md).

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
env -u AGENT_GATEWAY_ACCOUNTS -u AGENT_GATEWAY_TOKEN -u AGENT_GATEWAY_SESSION_SECRET npm test
npm run build
npm run test:e2e
```

The test command is usually run with gateway auth environment variables unset so tests that intentionally create unauthenticated local apps are not affected by the operator's shell environment.

Runtime data is stored outside source control:

- `~/.agent-gateway/config.json`
- `~/.agent-gateway/gateway.sqlite`
- `~/.agent-gateway/gateway.json.bak` after first legacy JSON migration, when applicable
- `~/.agent-gateway/attachments/`
- `~/.agent-gateway/sessions/`
- `~/agent-worktrees/`

Local generated or runtime directories such as `dist/`, `node_modules/`, `output/`, `test-results/`, `.omx/`, `.remember/`, `.playwright-cli/`, and `.omc/` should not be committed.

## Project Status

HoneyRail is pre-1.0 developer tooling. APIs, UI flows, and MCP tool shapes may evolve as the project hardens. Issues and focused pull requests are welcome.

## Roadmap

See [ROADMAP.md](ROADMAP.md). Near-term milestones are additive: M1 introduces Run/Step/Executor orchestration above the current execution runtime, while later milestones add evidence, quality gates, environment abstraction, benchmarking, and stable contracts.

## First Major Milestone: Database Testing Harness

The Database Testing Harness is a future/reference workflow, not a feature implemented in v0.1. This bootstrap establishes the runtime that can later orchestrate it.

```text
Goal
  -> task decomposition
  -> requirement analysis
  -> acquire package/build
  -> provision environment
  -> generate test plan/cases
  -> cross review
  -> generate automation
  -> execute
  -> triage/reproduce failures
  -> issue draft
  -> test report
  -> evaluation
```

## License

Apache-2.0. See [LICENSE](LICENSE).
