# Security Model

This document complements `SECURITY.md` with implementation-oriented boundaries for the current codebase.

## Privilege Boundary

HoneyRail runs with the privileges of the local OS user that starts it. Anything reachable by that user may be reachable by agents, shell sessions, project check commands, git commands, or uploaded-file workflows.

Do not treat the gateway as a sandbox. Git worktrees isolate repository working directories, not operating-system permissions.

## Trusted Operator Model

The primary security assumption is a trusted authenticated operator on a trusted host. The operator can:

- Register local repositories.
- Start agent and shell sessions.
- Send terminal input.
- Upload images.
- Run check commands.
- Commit and merge worktree changes.
- Grant MCP clients access when OAuth is enabled.

## Network Boundary

The Express server binds to `0.0.0.0` by default. Production mode requires authentication, but authentication is not a substitute for network-level protection. Prefer private bind/network placement, VPN, Tailscale, or an authenticated reverse proxy.

`AGENT_GATEWAY_PUBLIC_BASE_URL` controls OAuth/MCP metadata when the gateway is behind a proxy. Configure it carefully so MCP clients receive the expected issuer and resource URLs.

## Filesystem Boundary

Runtime state defaults:

- Config: `~/.agent-gateway/config.json`
- SQLite: `~/.agent-gateway/gateway.sqlite`
- Legacy JSON import source: `~/.agent-gateway/gateway.json`
- Attachments: `~/.agent-gateway/attachments`
- Session logs: `~/.agent-gateway/sessions`
- Worktrees: `~/agent-worktrees`

These paths and the `AGENT_GATEWAY_*` environment variables are compatibility identifiers inherited from the Agent Gateway subsystem. They are intentionally preserved during the HoneyRail bootstrap.

The repository should not contain those runtime files. `.gitignore` covers common local outputs, runtime directories, logs, SQLite files, attachments, reports, and package-manager auth files.

## Command Execution Boundary

Commands can be executed through:

- Agent launch commands.
- Shell sessions.
- Tmux input.
- Project check commands.
- Git worktree, diff, commit, merge, and discard operations.

Repository content, task prompts, and agent output can influence later operator actions. Review commands and diffs before committing or merging.

## Uploaded Files

Image attachments are stored outside the repository by default. Treat uploaded files and generated paths as untrusted input. Attachment serving should preserve basename checks and avoid path traversal.

## MCP Boundary

MCP clients can operate the same workflows exposed by the local gateway. Only connect MCP clients that are allowed to see repository state and operate local agent workflows. Avoid granting MCP access through weak shared credentials or public network exposure.

## Merge Boundary

Merge is a high-impact operation. Keep an explicit human approval step for sensitive repositories. Automated clients should use merge preview/proposal flows and preserve verification evidence before calling final approval operations.

## Secrets

Do not store real tokens, API keys, cookies, private keys, SSH keys, or `.env` files in this repository. If any credential appears in logs, screenshots, shell history, Git history, or issue comments, rotate it before publication or sharing.
