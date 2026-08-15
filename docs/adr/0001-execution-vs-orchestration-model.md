# ADR 0001: Execution Plane Versus Orchestration Plane

Date: 2026-08-13

Status: Accepted

## Context

HoneyRail was bootstrapped from the Agent Gateway / codex-remote-controller codebase. The inherited system already provides the execution/control-plane kernel:

- Projects
- Atomic tasks
- Sessions
- Git worktrees
- Codex, Claude, Hermes, and Shell adapters
- tmux execution
- Checks
- Commit, merge, and discard operations
- REST, WebSocket, and MCP surfaces
- Authentication and OAuth
- SQLite persistence

HoneyRail's product direction adds orchestration and evidence concepts above that kernel. M0 must finish the foundation without changing the meaning of existing execution entities.

## Decision

HoneyRail separates the current execution plane from the future orchestration plane.

```text
Future orchestration plane

Goal
  |
  v
Recipe / Plan
  |
  v
Run
  |
  v
Step
  |
  v
Executor
  |
  v
Current execution plane

Project -> Task -> Worktree -> Session -> Checks -> Commit/Merge/Discard
                    |
                    v
               Agent adapter
                    |
                    v
                  tmux
```

The existing `Task` entity remains an atomic execution primitive: roughly one agent execution, one worktree, one session, and one verification/merge lifecycle.

Future orchestration will be additive and will sit above `Task`:

- `Goal`: the user-level engineering objective and acceptance intent.
- `Recipe`: a reusable or generated plan template for achieving a class of goals.
- `Run`: one execution attempt of a goal/recipe against a concrete repository and environment.
- `Step`: a schedulable orchestration unit inside a run.
- `Executor`: the component that turns a step into concrete work, which may create or operate existing tasks, sessions, checks, tools, or external systems.

## Why `Task` Is Not A DAG Node

`Task` currently has concrete execution semantics used across REST routes, MCP tools, UI state, tmux sessions, worktrees, checks, commit, merge, discard, events, and SQLite persistence. Overloading it with parent/child/dependency/DAG fields would mix two levels of abstraction:

- Execution lifecycle: what is running, where it runs, what branch it changed, whether checks passed, and whether it can merge.
- Orchestration lifecycle: why a unit exists, what depends on it, how a larger workflow resumes, and how retries or recovery are scheduled.

Keeping those separate avoids destabilizing existing behavior, preserves current API contracts, and lets M1 add orchestration without rewriting the execution kernel.

## Compatibility Surfaces

M0 preserved the Agent Gateway-derived compatibility surfaces. As of v0.2, these have been renamed:

- `HONEYRAIL_*` environment variables (old `AGENT_GATEWAY_*` / `AGW_*` names still accepted with a deprecation warning, removed no earlier than v0.4)
- `~/.honeyrail` runtime paths (old `~/.agent-gateway` auto-migrated on first run)
- Existing REST routes
- Existing MCP tool names
- Internal MCP server compatibility identifier `codex-remote-controller`
- Existing SQLite state semantics
- HoneyRail ops scripts default tmux session name `honeyrail_server`

## Consequences

- M1 can introduce `Run`, `Step`, `Executor`, scheduling, and restart/resume as additive tables and APIs above the current kernel.
- Existing task/worktree/session behavior remains stable during M0.
- Tests should protect the atomic task execution lifecycle and adapter registry behavior.
- No M0 change should add Run/Step/DAG semantics to `Task`.
