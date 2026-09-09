# Contributing

HoneyRail is an open-source evaluation and research platform for AI Database Test Engineering. Historical PostgreSQL is the current mainline; the execution runtime and Capability Lab support it. Use [ROADMAP.md](ROADMAP.md) to prioritize work and the [evaluation protocol](docs/evaluation-protocol.md) for experiment, evidence, and claim requirements. Runtime reliability, operator interfaces, compatibility, and documentation remain valid supporting contributions.

## Local Setup

Prerequisites:

- Node.js 22 or newer with npm
- tmux
- git
- Optional agent CLIs such as Codex CLI or Claude Code

Initialize the pinned evaluation dependency and install Node dependencies:

```sh
git submodule update --init --recursive
npm install
```

Check `git submodule status`: a leading `-` means the submodule is not initialized; a leading `+` means it differs from the recorded revision. CI initializes submodules. A missing `vendor/tinytable-evals/build_seed_root.py` is a checkout/setup failure, not evidence of an agent capability regression. Do not update the submodule pin merely to make local tests pass.

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
env -u HONEYRAIL_ACCOUNTS -u HONEYRAIL_TOKEN -u HONEYRAIL_SESSION_SECRET npm test
npm run build
npm run test:e2e
```

Unset auth environment variables for tests unless the test specifically covers inherited auth configuration.

For documentation-only changes, inspect the complete diff, check local links and referenced commands, and run `git diff --check`; behavior tests are unnecessary unless behavior also changes. Do not report a skipped test as passing. The [PostgreSQL Research Integration workflow](.github/workflows/pg-research-integration.yml) verifies the real runtime boundary on a pinned release; it does not establish historical-corpus or real-model capability results. Changes to historical task/grader behavior also need the relevant configured case integration evidence.

## Issues

Good issues include:

- The affected interface: Web UI, mobile/PWA, REST, MCP, ops script, or runtime.
- Expected behavior and actual behavior.
- Relevant task/session/worktree IDs when safe to share.
- Redacted logs or screenshots.
- Reproduction steps from a clean local checkout when possible.

Do not include real API keys, bearer tokens, cookies, private repository data, or sensitive terminal output.

### Evaluation issues and closure

Label the deliverable in the issue body as **implementation**, **experiment**, or **decision/roll-up**. State the capability question or concrete reliability problem, dependencies, acceptance evidence, and non-goals. An implementation PR must not auto-close an experiment parent unless the experiment's own acceptance criteria are satisfied.

Experiment issues use the [report template](docs/templates/experiment-report.md): register the plan before formal trials, then append results and the evidence-backed decision. Publish only sanitized material; grader truth and private raw telemetry stay outside public artifacts. A roll-up closes only after its own acceptance checklist is reconciled with linked child evidence. Superseded work records its replacement and closes as not planned, rather than implying successful execution. See the [closure rules](docs/evaluation-protocol.md#issue-and-pr-closure).

## Pull Requests

Pull requests should:

- Keep changes scoped to the stated problem.
- Preserve existing SQLite state, `~/.honeyrail` runtime data, `HONEYRAIL_*` configuration, REST paths, MCP tool names, and tmux-backed session behavior unless a migration is explicitly required.
- Preserve `Task` as an atomic execution primitive. Do not add workflow dependency, parent/child, or DAG semantics to `Task`; put future orchestration concepts above it.
- Add focused tests for lifecycle, project management, auth, ops scripts, or regression-prone behavior.
- Update README or docs when setup, security posture, public behavior, or supported agents change.
- Include validation results.
- Separate implementation validation, scripted-agent smoke, and real-model experiment results. Link the applicable experiment report when making a capability claim; a green CI run alone is insufficient.
- State which frozen inputs or metrics change. Version affected evaluation contracts and preserve old results rather than silently changing their interpretation.

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
