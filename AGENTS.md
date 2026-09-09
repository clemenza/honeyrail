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
env -u HONEYRAIL_ACCOUNTS -u HONEYRAIL_TOKEN -u HONEYRAIL_SESSION_SECRET npm test
npm run build
```

Run `npm run test:e2e` for browser-visible workflow or layout changes.

If `npm test` unexpectedly returns 401s, check for inherited `HONEYRAIL_*`
environment variables and rerun with them unset as shown above.

## Runtime State And Git Hygiene

- Do not commit runtime or generated directories: `node_modules/`, `dist/`, `output/`, `test-results/`, `.omx/`, `.remember/`, `.playwright-cli/`, `.omc/`.
- Do not commit local logs such as `npm_start.log`, `npm_dev.log`, or `*.log`.
- Treat `~/.honeyrail/gateway.json`, `~/.honeyrail/attachments/`, and `~/agent-worktrees/` as live operator state.
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

## Evaluation And Roadmap Discipline

- Follow `docs/evaluation-protocol.md` for experiment planning, metrics, evidence, partitioning, and closure; use `docs/templates/experiment-report.md` for experiment records. These are contributor/reviewer rules; consult the protocol's implementation-status table before claiming a rule is automatically enforced.
- Historical PostgreSQL is the mainline. Justify new Capability Lab work with an observed PG capability gap. Gate generic providers, exploration frameworks, and self-improvement on evidence rather than adding them merely because three task definitions exist.
- Distinguish implementation completion, scripted-agent validation, and real-model capability evidence. Do not auto-close an experiment parent from an implementation PR without its empirical acceptance evidence.
- Preserve frozen corpus/task inputs and existing raw verdicts. New scoring, budget, prompt, truth, or environment contracts require explicit versioning; do not reinterpret old runs silently.
- Keep all predeclared formal attempts visible, including timeouts, invalid submissions, integrity failures, and infrastructure failures. Report conditional rediscovery alongside end-to-end outcomes; missing data is not zero and skipped checks are not passes.
- Partition evaluation by causal family, record prior exposure, and never use a tuned family as evidence of independent transfer. Corpus v0 has no pristine HOLDOUT; runtime isolation does not establish absence of model pretraining contamination.
- Keep private truth and raw operator telemetry out of public reports and agent inputs. Retain bounded sanitized failure evidence without changing an established verdict merely to improve report completeness.
- For documentation-only work, inspect the full diff, verify local links and commands, and run `git diff --check`. Do not run model trials or modify live operator state to validate prose.
