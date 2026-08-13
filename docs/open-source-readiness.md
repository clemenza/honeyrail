# HoneyRail Bootstrap Readiness

Date: 2026-08-13

Repository: `clemenza/honeyrail`

Source snapshot: `clemenza/codex-remote-controller` `origin/main`

Source main SHA: `43949aa387be3efb1c66258b04ed6eedcb579422`

## Bootstrap Strategy

HoneyRail starts as a fresh-history repository created from the latest committed source tree of `clemenza/codex-remote-controller`.

The old repository is preserved as the original Agent Gateway / Codex Remote Controller project history. HoneyRail does not copy the old `.git` directory and does not mirror old commit history.

## Branding Position

Product name:

```text
HoneyRail
```

Tagline:

```text
Give it an engineering goal. Get back evidence.
```

Positioning:

```text
HoneyRail is an open-source runtime for long-horizon, verifiable engineering work. It will orchestrate mature coding agents such as Codex and Claude Code together with deterministic tools, environments, evaluators, artifacts, and human approval. The current bootstrap preserves the Agent Gateway execution/control-plane subsystem as the v0.1 foundation.
```

Core thesis:

```text
We don't build another coding agent. We harness the best ones.
```

## Compatibility Identifiers

The Agent Gateway execution/control-plane subsystem remains the current implementation base. The following identifiers are intentionally preserved unless a future migration explicitly changes them:

- `AGENT_GATEWAY_*` environment variables
- `~/.agent-gateway` runtime paths
- MCP tool names
- Internal MCP server name `codex-remote-controller`
- REST paths
- SQLite schema/state names
- tmux session naming conventions such as `agw_server`

## Repository Metadata

Expected package metadata:

```json
{
  "name": "honeyrail",
  "version": "0.1.0",
  "license": "Apache-2.0"
}
```

Repository URLs should point to:

```text
https://github.com/clemenza/honeyrail
```

## First Major Milestone: Database Testing Harness

This is a future/reference workflow and is not implemented during bootstrap.

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

## Runtime Artifact Policy

Runtime/generated directories remain ignored and should not be committed:

- `node_modules/`
- `dist/`
- `test-results/`
- `.omx/`
- `.remember/`
- `.playwright-cli/`
- `.omc/`
- local gateway logs/state

## Validation Checklist

Before publishing or tagging, run:

```sh
npm ci
npm run doctor
npm run typecheck
env -u AGENT_GATEWAY_ACCOUNTS -u AGENT_GATEWAY_TOKEN -u AGENT_GATEWAY_SESSION_SECRET npm test
npm run build
npm run test:e2e
git diff --check
```

Run a full-history secret scan when `gitleaks` is available:

```sh
gitleaks git . --redact
```

## Remaining Actions Before Public

1. Keep `clemenza/honeyrail` private until maintainers explicitly approve public release.
2. Enable GitHub private vulnerability reporting before making the repository public.
3. Confirm GitHub recognizes the license as Apache-2.0.
4. Decide whether and when to migrate compatibility identifiers such as `AGENT_GATEWAY_*` and `~/.agent-gateway`.
5. Tag `v0.1.0` only after validation and release approval.

## M0 Closeout Boundary

M0 freezes the existing `Task` model as an atomic execution primitive tied to session/worktree/check/merge lifecycle state. Future Run/Step orchestration is additive and should not rewrite or overload `Task` with DAG semantics.
