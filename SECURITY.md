# Security Policy

HoneyRail is local developer tooling that can launch coding agents, execute shell commands, control tmux sessions, read and write repositories, receive uploaded files, expose REST/WebSocket/MCP interfaces, commit changes, and merge code. Deploy it with the same care you would apply to a privileged local automation service.

## Threat Model

Trusted:

- The authenticated operator.
- The owner of the local host where the gateway runs.

Potentially untrusted:

- Network clients.
- Uploaded files.
- Task prompts.
- Checked-out repositories.
- Agent-generated commands and output.
- MCP clients, depending on deployment and access controls.

## Main Risks

- Arbitrary command execution through agents, shell sessions, project checks, or malicious repositories.
- Accidental exposure of the gateway to the public internet.
- Weak, reused, default, or missing credentials.
- Leaked bearer tokens or session secrets.
- Agent prompt injection through repository content, uploaded files, terminal output, or MCP inputs.
- Malicious repositories with unsafe scripts, hooks, generated files, or test commands.
- Unsafe automation around commit, merge, approval, override, and rejection flows.
- Path traversal or unsafe file upload handling.
- Over-privileged MCP clients that can start sessions, send input, run checks, or merge work.

## Deployment Guidance

- Bind privately when possible and avoid direct public exposure.
- Prefer a private network, VPN, Tailscale, or authenticated reverse proxy / zero-trust gateway.
- Use strong unique account passwords, bearer tokens, and `HONEYRAIL_SESSION_SECRET` values.
- Do not run the gateway as root.
- Run with the least local privileges that still allow the intended repositories and agent CLIs to work.
- Protect source repositories, SSH keys, git credentials, agent credentials, and package-manager credentials on the host.
- Review task prompts and repository content before launching agents on sensitive code.
- Keep human approval for merge-sensitive workflows.
- Limit MCP access to clients that are allowed to operate on local repositories.
- Rotate tokens and secrets if logs, browser profiles, shell history, or repository history might have exposed them.

## Reporting Vulnerabilities

Before this repository is made public, maintainers should enable GitHub private vulnerability reporting. Once that is enabled, please use the repository's private security advisory workflow. If it is not enabled, open a minimal public issue that says you need to report a vulnerability, but do not include exploit details, secrets, private hostnames, or sensitive logs in the issue.

Maintainers should enable GitHub private vulnerability reporting before switching the repository to public:

```text
Settings -> Security -> Private vulnerability reporting -> Enable
```

## Supported Versions

HoneyRail is currently pre-1.0. Security fixes are expected to target the default branch until release branches exist.
