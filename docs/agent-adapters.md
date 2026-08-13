# Agent Adapters

HoneyRail keeps backend-specific behavior in `server/agents/`. The rest of the backend should treat agents as registry-backed adapters, not as scattered string branches.

These adapters belong to the current execution plane. Future orchestration `Executor` concepts should call into or compose this layer rather than replacing adapter registration or task/session/worktree semantics.

## Contract

The shared interface lives in `server/agents/types.ts`. Each adapter provides:

- `id`, display labels, stability, and capability metadata.
- `buildLaunchCommand(input)`, which returns the tmux startup command.
- `formatInput(context)`, which formats operator text and uploaded attachment paths.
- `findInteractivePromptResponse(output)`, when the CLI has known trust or update prompts that can be answered safely.
- `detectInstallation(run)`, which checks local CLI availability and version without network access.

`server/agents/registry.ts` is the single lookup point. Use `getAgentAdapter(agent)` in lifecycle code and let unknown identifiers throw a clear user-facing error.

## Current Backends

- `shell`: starts `$SHELL`, accepts generic text and attachment path input, and does not auto-answer prompts.
- `codex`: starts `codex`, adds `--model` when a model is selected, includes the initial prompt in the startup command, formats attachment paths in the generic attached-file block, and handles known Codex update/trust prompts.
- `claude`: starts `claude --dangerously-skip-permissions --setting-sources user` through an `env -u ...` prefix that clears inherited Anthropic/provider overrides, adds `--model` when selected, formats attachment paths as space-separated CLI arguments, and handles the Claude folder trust prompt.
- `hermes`: is experimental. On macOS it prefixes commands with `arch -arm64`, uses the two-step `hermes -z ... && exec hermes chat --continue ...` flow when an initial prompt is present, and otherwise starts `hermes chat --accept-hooks --yolo`.

## Where Adapters Are Used

Adapters are resolved by session creation, task creation, MCP tools, model-change restart, follow-up input handling, session monitoring, worktree task defaults, health checks, and `npm run doctor`.

Backend-specific conditions outside `server/agents/` should be limited to compatibility surfaces such as persisted type definitions, API validation enums, frontend option rendering, tests, and legacy response fields.

## Adding Or Changing A Backend

1. Add or update the adapter under `server/agents/`.
2. Register it in `server/agents/registry.ts`.
3. Add launch, formatting, prompt, and installation tests.
4. Add route or MCP integration tests for any lifecycle behavior that could regress.
5. Update README, this document, and contributing notes when public support changes.

Do not add speculative capabilities. Capability metadata should describe behavior that is implemented and covered by tests.
