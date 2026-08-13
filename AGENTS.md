# Agent Instructions

These instructions apply to the entire repository.

## Project Shape

- Frontend: React/Vite code in `src/`.
- Backend: Express/WebSocket/tmux control plane in `server/`.
- Ops scripts: `scripts/start.sh`, `scripts/restart.sh`, `scripts/stop.sh`, and `scripts/status.sh`.
- Tests: Node test runner files in `test/`; Playwright e2e tests in `test/e2e/`.
- Production static assets are generated into `dist/` by `npm run build`.

## Build And Run

- Use `npm run dev` for local development.
- Use `npm run ops:restart` or `scripts/restart.sh` for the local tmux-backed gateway.
- `scripts/start.sh` must build the frontend before launching a fresh tmux server. Do not remove this; restarting only the backend can leave the web console serving stale `dist` assets.
- `scripts/start.sh` intentionally exits early without rebuilding if the configured tmux session already exists and the port is already listening.

## Verification

Before claiming backend/frontend behavior is fixed, run the smallest relevant set and prefer the full stack when changes cross boundaries:

```sh
npm run typecheck
env -u AGENT_GATEWAY_ACCOUNTS -u AGENT_GATEWAY_TOKEN -u AGENT_GATEWAY_SESSION_SECRET npm test
npm run build
```

Run `npm run test:e2e` for browser-visible workflow or layout changes.

If `npm test` unexpectedly returns 401s, check for inherited `AGENT_GATEWAY_*`
environment variables and rerun with them unset as shown above.

## Runtime State And Git Hygiene

- Do not commit runtime or generated directories: `node_modules/`, `dist/`, `output/`, `test-results/`, `.omx/`, `.remember/`, `.playwright-cli/`, `.omc/`.
- Do not commit local logs such as `npm_start.log`, `npm_dev.log`, or `*.log`.
- Treat `~/.agent-gateway/gateway.json`, `~/.agent-gateway/attachments/`, and `~/agent-worktrees/` as live operator state.
- A dirty worktree may contain user/runtime state. Do not revert or delete files you did not create unless explicitly asked.

## Agent And Worktree Behavior

- Initial prompts for Codex/Claude sessions should be passed in the agent startup command, not pasted into the TUI after launch. Pasting the first prompt can leave Codex in `Queued follow-up inputs` without executing the task.
- If tmux capture reports a missing pane, synchronize the associated session/task/worktree status to `failed`; do not leave the task shown as running.
- Worktree merge behavior must update both task and worktree status and publish events so the dashboard refreshes.
- Treat `Task` as an atomic execution primitive tied to one agent/session/worktree lifecycle. Do not add Run/Step/DAG orchestration semantics to `Task` during M0 work.

## Style

- Follow existing TypeScript style and keep changes scoped.
- Prefer structured APIs and existing helpers over ad hoc string handling.
- Add focused tests for regressions in lifecycle, project management, auth, or ops scripts.
