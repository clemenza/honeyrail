# Agent Adapters

HoneyRail keeps backend-specific behavior in `server/agents/`. The rest of the backend should treat agents as registry-backed adapters, not as scattered string branches.

These adapters belong to the current execution plane. Future orchestration `Executor` concepts should call into or compose this layer rather than replacing adapter registration or task/session/worktree semantics.

## Contract

The shared interface lives in `server/agents/types.ts`. Each adapter provides:

- `id`, display labels, stability, and capability metadata.
- `buildLaunchCommand(input)`, which returns the tmux startup command. `input.unattended` is the #70 unattended-execution contract: when true (every run-launched `agent-task` step defaults to this — see [docs/human-in-the-loop.md](human-in-the-loop.md)), an adapter should prefer passing through the CLI's own non-interactive flag where one exists (e.g. codex's `--ask-for-approval never --sandbox workspace-write`, Claude Code's `--setting-sources project`) instead of relying solely on prompt text to suppress interactive prompts. Adapters without a CLI-level non-interactive flag (or without any interactive prompts to suppress at all, like `shell`) simply ignore the flag.
- `formatInput(context)`, which formats operator text and uploaded attachment paths.
- `findInteractivePromptResponse(output)`, when the CLI has known trust or update prompts that can be answered safely.
- `detectInstallation(run)`, which checks local CLI availability and version without network access.

`server/agents/registry.ts` is the single lookup point. Use `getAgentAdapter(agent)` in lifecycle code and let unknown identifiers throw a clear user-facing error.

## Current Backends

- `shell`: starts `$SHELL`, accepts generic text and attachment path input, and does not auto-answer prompts.
- `codex`: starts `codex`, adds `--model` when a model is selected, includes the initial prompt in the startup command, formats attachment paths in the generic attached-file block, and handles known Codex update/trust prompts.
- `claude`: starts `claude --dangerously-skip-permissions --setting-sources user` through an `env -u ...` prefix that clears inherited Anthropic/provider overrides, adds `--model` when selected, formats attachment paths as space-separated CLI arguments, and handles the Claude folder trust prompt.
- `hermes`: is experimental. On macOS it prefixes commands with `arch -arm64`, uses the two-step `hermes -z ... && exec hermes chat --continue ...` flow when an initial prompt is present, and otherwise starts `hermes chat --accept-hooks --yolo`.
- `null` and `minimal` (#71) are **calibration probes, not production-grade agents**. Deliberately excluded from `server/validation.ts`'s `agentType` enum and `server/mcp-server.ts`'s tool schemas - they don't belong in an interactive session, a real coding task, or a project's `defaultAgent`. They're only reachable through a DAG `agent-task` step's `input.agent` (checked at runtime via `isKnownAgent`, not a zod enum) or a recipe parameter that explicitly lists them, like the shipped `eval-instruction-ab-trial` recipe's `agent` parameter.
  - `null`: does no real work. Launches, declares the two artifact types `AgentTaskExecutor` auto-harvests (`diff`, `changed_files`) as empty via the manifest/artifacts channel - so a step that declares `produces: [diff, changed_files]` doesn't fail with `contract_violation` before ever reaching its real verification step - then idles. Intended use: the calibration floor for a task/eval matrix. If `null` ever passes a task's real check/gate, the check isn't actually verifying anything meaningful.
  - `minimal`: a bare ReAct loop (`scripts/minimal-agent.mjs`) that calls a model API directly and runs whatever shell command it asks for - no third-party CLI, so `interactivePrompts: false` is a structural guarantee, not just an unimplemented capability (the script has no code path that reads stdin at all). Sampling temperature is controllable via a step's `input.temperature`. Intended use: a low-capability anchor between `null` and a real agent CLI, for calibrating whether a task is discriminating (real agents pass, `null`/`minimal` don't) or suffers a ceiling effect (everything passes regardless of capability).

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
