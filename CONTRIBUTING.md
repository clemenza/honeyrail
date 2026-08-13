# Contributing

HoneyRail is an open-source runtime for long-horizon, verifiable engineering work. Contributions should stay within that scope: project registration, atomic task/session/worktree lifecycle, agent execution boundaries, verification evidence, approval/merge flow, Web/mobile UI, MCP/REST automation, local runtime safety, documentation, and future orchestration layers above the execution runtime.

## Local Setup

Prerequisites:

- Node.js 22 or newer with npm
- tmux
- git
- Optional agent CLIs such as Codex CLI or Claude Code

Install dependencies:

```sh
npm install
```

Run the development server:

```sh
npm run dev
```

Run production-style local ops:

```sh
npm run ops:start
npm run ops:status
npm run ops:restart
npm run ops:stop
```

## Verification

Use the smallest relevant check while developing, then run the full stack before a pull request when behavior crosses frontend/backend/runtime boundaries:

```sh
npm run doctor
npm run typecheck
env -u AGENT_GATEWAY_ACCOUNTS -u AGENT_GATEWAY_TOKEN -u AGENT_GATEWAY_SESSION_SECRET npm test
npm run build
npm run test:e2e
```

Unset gateway auth environment variables for tests unless the test specifically covers inherited auth configuration.

## Issues

Good issues include:

- The affected interface: Web UI, mobile/PWA, REST, MCP, ops script, or runtime.
- Expected behavior and actual behavior.
- Relevant task/session/worktree IDs when safe to share.
- Redacted logs or screenshots.
- Reproduction steps from a clean local checkout when possible.

Do not include real API keys, bearer tokens, cookies, private repository data, or sensitive terminal output.

## Pull Requests

Pull requests should:

- Keep changes scoped to the stated problem.
- Preserve existing SQLite state, `~/.agent-gateway` runtime data, `AGENT_GATEWAY_*` configuration, REST paths, MCP tool names, and tmux-backed session behavior unless a migration is explicitly required. These are compatibility surfaces inherited from the Agent Gateway subsystem.
- Preserve `Task` as an atomic execution primitive. Do not add workflow dependency, parent/child, or DAG semantics to `Task`; put future orchestration concepts above it.
- Add focused tests for lifecycle, project management, auth, ops scripts, or regression-prone behavior.
- Update README or docs when setup, security posture, public behavior, or supported agents change.
- Include validation results.

## Backward Compatibility

Prefer compatibility over cosmetic cleanup for persisted identifiers, config keys, runtime paths, database fields, REST paths, MCP tool names, and tmux naming conventions. If a breaking change is unavoidable, document it and include a migration.

## Security-Sensitive Changes

Treat these as security-sensitive:

- Authentication, OAuth, sessions, cookies, bearer tokens, or MCP authorization.
- File uploads, attachment serving, path handling, or filesystem browsing.
- Shell command execution, tmux control, project checks, or agent launch commands.
- Merge, discard, commit, or approval automation.
- Logging, session transcript handling, and evidence capture.

Security-sensitive pull requests should describe the threat model impact and include tests for failure paths.

## Adding Future Agent Backends

Agent backends are implemented through `server/agents/`. Add a backend by creating an adapter and registering it in `server/agents/registry.ts`.

The adapter should own backend-specific launch commands, model arguments, attachment input formatting, interactive prompt responses, installation/version detection, and capability/stability metadata. Route handlers, MCP tools, restart flows, and monitors should ask the registry for an adapter instead of adding backend-specific branches.

Preserve existing launch semantics when changing current adapters. Unknown backend identifiers must fail with a clear error; do not silently fall back to shell. Update [docs/agent-adapters.md](docs/agent-adapters.md), tests, and `npm run doctor` expectations when supported backend behavior changes.
