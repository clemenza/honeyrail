# Open Source Readiness

Date: 2026-08-14

Repository: `clemenza/honeyrail`

Latest inspected main SHA: `631789922d3bfb29dd434ca725ca9e23e9b8cb7f`

HoneyRail is still private until maintainers explicitly approve the public switch. This checklist tracks code, documentation, runtime hygiene, verification, security, and GitHub-side release actions without marking unverified repository settings complete.

## Repository

- Package name is `honeyrail`.
- Package license is `Apache-2.0`.
- Repository, bugs, and homepage metadata point to `https://github.com/clemenza/honeyrail`.
- GitHub currently detects the license as Apache-2.0.
- Repository description is `Open-source runtime for long-horizon, verifiable engineering work.`
- Default branch is `main`.
- No open issues or pull requests were present at the latest inspection.
- GitHub topics are set: `agentic-ai`, `ai-agents`, `coding-agents`, `codex`, `claude-code`, `database-testing`, `postgresql`, `evaluation`, `test-automation`, `developer-tools`, `mcp`, `self-hosted`.

## Documentation

- README describes the implemented runtime, alpha orchestration primitives, verification data, quality gates, and PostgreSQL Database Testing Harness Alpha.
- README preserves the positioning: `We don't build another coding agent. We harness the best ones.`
- README includes the architecture flow from goal through quality gate decision to verified result.
- `ROADMAP.md` marks M1/M2 and the PostgreSQL harness as alpha implementations while keeping future environment and benchmarking work directional.
- `docs/database-testing-harness-alpha.md` documents Docker and local-binary PostgreSQL modes, artifacts, evidence, evaluations, quality gate decisions, and limitations.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `LICENSE` are present.

## Runtime Hygiene

- Runtime and generated outputs are ignored: `node_modules/`, `dist/`, `output/`, `test-results/`, `playwright-report/`, `coverage/`, logs, `.omx/`, `.omc/`, `.remember/`, and `.playwright-cli/`.
- Local config, secrets, and state are ignored: `.env`, `.env.*`, `gateway.json`, `gateway.json.bak`, `attachments/`, `sessions/`, `agent-worktrees/`, `*.sqlite`, `*.sqlite-*`, `*.db`, `*.pem`, `*.key`, `*.p12`, and `*.pfx`.
- `.env.example` remains allowed if added later.
- Runtime state under `~/.honeyrail/` and `~/agent-worktrees/` must not be copied into the repository.

## Verification

Run this clean-clone gate before tagging or making the repository public:

```sh
npm ci
npm run doctor
npm run typecheck
env -u HONEYRAIL_ACCOUNTS -u HONEYRAIL_TOKEN -u HONEYRAIL_SESSION_SECRET npm test
npm run build
npm run test:e2e
git diff --check
```

Required CI on push and pull request should continue to cover:

- `npm ci`
- `npm run typecheck`
- `env -u HONEYRAIL_ACCOUNTS -u HONEYRAIL_TOKEN -u HONEYRAIL_SESSION_SECRET npm test`
- `npm run build`

The PostgreSQL harness may skip real Docker/local-binary environment tests when PostgreSQL is unavailable. CI must not require Docker image downloads for the default test path.

## Security

- Run `npm audit` against the official npm registry before publication.
- Run a full-history secret scan with `gitleaks git . --redact` when available.
- Also scan source text for common token, private key, password, and bearer-token patterns.
- Review Git author identity before publishing. Do not rewrite history automatically; decide explicitly if author names or emails should change.
- Keep examples free of real credentials, private hostnames, cookies, OAuth secrets, bearer tokens, and database passwords.
- Treat HoneyRail as privileged local developer tooling: it can launch agents, run shell commands, control tmux, read/write repositories, accept uploads, expose REST/WebSocket/MCP surfaces, and commit or merge code.

## Public Switch

Latest GitHub API inspection on 2026-08-14:

- Repository visibility is private.
- Dependabot vulnerability alerts are disabled.
- Dependabot automated security fixes endpoint returned success, but alerts still need to be enabled before publication.
- Private vulnerability reporting returned 404 and is not verified as enabled.
- Secret scanning status was not available in the repository metadata returned to the current token.
- Repository topics are set.

Do not make the repository public until these GitHub-side items are verified or intentionally accepted:

- Private vulnerability reporting is enabled, or SECURITY.md has an approved public fallback process.
- Dependabot alerts are enabled.
- Dependabot security updates are enabled where available.
- Secret scanning is enabled where available for the plan/repository visibility.
- Repository topics remain set.
- Maintainers have approved visibility change from private to public.
- A final clean-clone release gate has passed on the exact commit being published.
