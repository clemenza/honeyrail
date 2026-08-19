# DSH Adapter Spike Notes

Phase A0 for "Demo1: DSH × test-engineering trial-evals" (#87). Findings here decide
the launch-command/variant-injection route for the DSH adapter (#88).

## Install & version

```
npm i -g @deepseek-ai/dsh@0.1.0-rc.7
dsh --version   # -> 0.1.0-rc.7   (bare semver-with-prerelease, no "v" prefix, no extra text)
```

Pinned `0.1.0-rc.7` — `latest`/`next` dist-tags both point at it as of the spike date;
6 older `0.0.1-rc.*`/`0.1.0-rc.*` releases exist on npm, confirming the "expect breakage
between versions" warning in the issue.

**Node version requirement (undocumented, found by trial):** `0.1.0-rc.7` fails to boot
under Node 23.4.0 with:

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry session-persistence-jsonl (@deepseek-ai/dsh-session-persistence-jsonl):
The requested module 'node:zlib' does not provide an export named 'createZstdDecompress'
```

`node:zlib` only gained `createZstdDecompress` in newer Node builds; this environment's default
(Node 23.4.0 via nvm) predates it. Installing/using Node 24.19.0 (LTS) resolves it — `dsh` boots
cleanly and every test below was run under Node 24. **Adapter installation docs/doctor checks
should pin a minimum Node version (24.x confirmed working; earlier 23.x confirmed broken) alongside
the dsh version**, not just check `dsh --version`.

`npm i -g` also prints an `allow-scripts` warning for 5 packages with native/install scripts
(`koffi`, `node-pty`, `@deepseek-ai/dsh-subprocess-local`, `@google/genai`, `protobufjs`) under a
package manager that blocks scripts by default (this environment's npm has global
`allow-scripts` policy). The scripts were **not** run in this spike's install and `dsh --profile
headless` still worked fully — headless mode doesn't appear to depend on `node-pty`/`koffi` (those
back the TUI/PTY profile). Worth a smoke check in #88 but not a blocker.

## Headless one-shot smoke test

```
dsh --profile headless "create hello.txt with 'hi' in the current directory"
```

Run in an empty `git init`'d directory, no other flags:

- **Fully non-interactive, no hangs.** Completed in ~5.5s wall time, exit code `0`, `hello.txt`
  containing `hi` created in cwd. No approval/trust prompt appeared on stdout.
- **Exit code semantics:** `0` on success. `1` on any fatal error (missing credential, plugin-load
  crash) — confirmed by forcing both. It's a real one-shot subprocess that exits on its own; there
  is no persistent pane to watch for a marker the way codex/claude's TUI needs.
- `dsh --profile headless <task>` prints only the final assistant message to stdout, then exits.

### Fatal error formats observed

Missing `DEEPSEEK_API_KEY`:
```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
EXIT: 1
```

Plugin/tree load failure (e.g. Node-version mismatch above) throws a Node `Error` in the
`dsh: <stage>: <detail>` shape with a JS stack trailing after it, also `EXIT: 1`. `findFatalError`
in #88 should match on the leading `dsh: <STAGE_CODE>:` / `dsh: plugin tree failed to load:`
prefixes rather than trying to parse the full stack.

## Required env vars & model selection

- **`DEEPSEEK_API_KEY`** — required for the default `deepseek-official` provider route. No
  interactive credential prompt in headless mode; a missing key is a hard, immediate failure
  (see above), not a hang.
- No `--model` CLI flag exists for `--profile headless` (its `--help` only takes a `task` arg).
  Model selection is **config, not CLI**: the composed profile has an `agent-default-model`
  plugin entry (`config: { provider: deepseek-official, model: deepseek-v4-flash }` is the
  built-in default). A `--patch` entry targeting `id: agent-default-model` overrides it — verified
  via `--dump-config` that a patched `{ provider: deepseek-official, model: deepseek-v4 }` shows up
  in the composed tree. This is the same patch mechanism as the Route A instruction override below,
  so adapter `modelSelection` capability should also route through `--patch`, not a flag.

## Permission / approval policy for full automation

Two relevant plugin entries, both env-var-driven out of the box (no patch needed for the common case):

- `sandbox-policy` (`@deepseek-ai/dsh-sandbox-policy`): `config.mode` reads
  `process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`.
- `approval` (`@deepseek-ai/dsh-user-approval`): `config.policy` is `'never'` when
  `DSH_PERMISSION_MODE === 'danger-full-access'`, else `'ask'`.
- A `permission` presets plugin maps three named presets: `read-only` (sandbox read-only, approval
  ask), `workspace-write` (sandbox workspace-write, approval ask — **the default**),
  `danger-full-access` (sandbox danger-full-access, approval never).

Critically, per `@deepseek-ai/dsh-user-approval`'s README: **headless has no built-in answerer**,
so any tool call that actually needs to *ask* for approval resolves `unavailable` and **fails
closed** (the specific tool call is rejected, the agent gets an error result and can react to it —
the run does not hang waiting for a human). This was confirmed empirically: the default
`workspace-write` + unset `DSH_PERMISSION_MODE` smoke test above wrote a file inside cwd with zero
prompts, because in-sandbox writes don't need to go through the approval seam at all — only
escalation *beyond* the sandbox does, and that fails closed automatically.

**Recipe for full automation:**
- Default (`DSH_PERMISSION_MODE` unset → `workspace-write`/`ask`) is sufficient and is the
  *safer* choice for tasks confined to the working directory: in-sandbox tool calls proceed with
  no prompts, out-of-sandbox escalation attempts fail closed instead of hanging.
- Set `DSH_PERMISSION_MODE=danger-full-access` in the launch environment only if a task legitimately
  needs to touch things outside the worktree (network, other paths); this also flips approval to
  `never` so nothing can block.
- No CLI flag equivalent exists for this — it's env-var only (`DSH_PERMISSION_MODE`), so the
  adapter's `buildLaunchCommand` should set it via the launch environment, not a patch or arg.

## `--patch` and `--dump-config`

- `--patch <path>` accepts a **worktree-relative path** — confirmed: `--patch cordis.patch.yml`
  run from inside the worktree resolves the same as an absolute path.
- `--patch` is a top-level YAML array of `{ id, config, disabled?, inject? }` entries; each `id`
  targets one plugin node in the composed cordis tree (same shape as the profile's own
  `cordis.patch.yml`, per its header comment: "a top-level YAML array of loader patch entries").
- `--dump-config` prints the fully composed tree (profile bundles + profile's own
  `cordis.patch.yml` + any `--patch` overlays) and exits without booting a session — **usable as a
  fingerprint**: it's deterministic YAML, diffable, and confirmed to change byte-for-byte when a
  patch actually takes effect (used throughout this spike to verify overrides landed before
  spending a live LLM call to confirm behaviorally).
- `--dump-default-config` is the same tree without the user's own `cordis.patch.yml`/`--patch`
  layers — with an empty user patch (the fresh-install default), it was byte-identical to
  `--dump-config`, as expected.

## Key decision: Route A confirmed, and it's preferred

**Route A works.** The composed `headless` profile has an `id: system-prompt`
(`@deepseek-ai/dsh-system-prompt`) plugin entry with `config.persona` — a template string
(`"You are a coding agent powered by {{model}} model. Your working directory is {{cwd}}."` by
default) that becomes the agent's system-prompt persona. A `--patch` entry targeting
`system-prompt`'s `config.persona` reaches the instruction layer directly:

1. **Static verification** — `--dump-config` with a patch overriding `persona` to a marker string
   showed the override applied in the composed tree.
2. **Behavioral verification** — a live headless run with that patch, asked to quote its exact
   persona/identity string, echoed the patched marker verbatim back (model:
   `deepseek-v4-flash`, run against real `DEEPSEEK_API_KEY`).

Route B also works and was independently verified: with no `--patch` at all, dropping an
`AGENTS.md` with a marker token at the worktree root (`.git`-marked project root) and asking the
agent what workspace instructions it received produced the marker verbatim, sourced by the model
as "from AGENTS.md" — this is the `@deepseek-ai/dsh-agent-instructions` plugin's default
`instructionFileCandidates: ['AGENTS.md', 'CLAUDE.md']` project-root discovery, injected as a
durable `<system-reminder>`-framed user message rather than the system-prompt persona.

**Conclusion: Route A.** Candidate/baseline differences should live in `cordis.patch.yml`,
patching `id: system-prompt`'s `config.persona`. It reaches a higher-authority layer (the actual
system prompt, not a "may be relevant, doesn't override direct instructions" workspace note), it's
one self-contained file colocated with the rest of the patch overlay (same file that will also
carry the permission/model patches if any adapter iteration needs them), and it keeps the eval
narrative as "harness/profile instruction-layer optimization" rather than degrading to the existing
AGENTS.md A/B mechanics. `--patch cordis.patch.yml` (worktree-relative, confirmed above) is the
adapter's launch-command shape; baseline injects a no-op patch (`[]`, the same content the fresh
profile ships with) and candidate injects a `system-prompt` override — both via the existing
`instructionFile` mechanism, differing only in target file (`cordis.patch.yml` instead of
`AGENTS.md`) and label.

## Summary for #88's `buildLaunchCommand`

```
DSH_PERMISSION_MODE=<unset|danger-full-access> dsh --profile headless --patch cordis.patch.yml <prompt>
```

- `interactivePrompts: false` is accurate — headless has no answerer, fails closed on anything
  needing one, never blocks on stdin.
- `modelSelection`: the spike confirmed model choice *is* patchable (`agent-default-model`'s
  `config.model`), but only through the same single `cordis.patch.yml` the `instructionFile`
  mechanism already owns for the Route A variant content — there's no `--model` flag and the
  adapter has no way to write a second patch file on its own. #88 ships this capability as
  `false` rather than claim something nothing in the adapter actually implements or tests.
- `attachments`/`images`: not tested in this spike (out of scope — headless's only documented
  input is the `task` positional string); #88 already specs these as `false`.
- Completion detection: real process exit (`0`/`1`), but #88 still needs the tail-marker +
  idle-forever tail (`; echo HR_DSH_DONE; while :; do sleep 3600; done`), not just the marker —
  headless is a true one-shot subprocess that exits on its own, so without the idle loop the tmux
  pane (and the shell running it) would close the instant the marker prints, racing
  session-monitor's poller. Same reasoning as null-agent/minimal-agent's own keep-alive tails.

## #88 implementation note: live end-to-end verification

Built the adapter (`server/agents/dsh.ts`, registered in `server/agents/registry.ts`, `"dsh"`
added to `server/types.ts`'s `AgentType`) and verified it for real, not just via unit tests: spun
up a second, fully isolated HoneyRail instance (scratch `HONEYRAIL_CONFIG`/`HONEYRAIL_DATA`/
`HONEYRAIL_WORKTREE_ROOT`, its own port and token) against a scratch git repo, and posted a raw
`POST /api/runs` DAG (agent-task with `agent: "dsh"` + a `check` step) directly rather than
through `eval-instruction-ab-trial.yaml` — its `agent` parameter enum is deliberately left
unchanged per #88's scope, so `dsh` isn't reachable through that recipe yet (the follow-up recipe
issue carries its own options). Two things came out of that run:

- **`doctor`/`/api/health` correctly listed `dsh` as available**, with the right pinned version,
  confirming `listAgentAdapters()`'s existing generic iteration in `doctor.ts`/`api.ts` needed no
  adapter-specific change to pick it up.
- **A shared-tmux-server gotcha, not a bug in this adapter**: the launching process's own env
  having `DEEPSEEK_API_KEY` isn't enough — `tmux new-session` on an already-running tmux server
  uses environment captured at *that server's* startup, not the client's current env, unless the
  var was propagated via `tmux set-environment -g` (or the session is started fresh). The first
  live run correctly hit `findFatalError`'s `dsh_missing_credential` path end-to-end (worktree
  created, session launched, tmux killed, task/step/run all correctly marked `failed` with the
  adapter's exact message) even though the key was genuinely set in the server process's
  environment — because the shared tmux server on this host predated that env var. After
  `tmux set-environment -g DEEPSEEK_API_KEY ...`, a second run completed the full pipeline
  end-to-end: dsh wrote a correct `fizzbuzz.py`/`test_fizzbuzz.py`, the diff was harvested, the
  `check` step's `pytest` gate passed, and the run reached `succeeded`. Whoever deploys this
  adapter for real needs `DEEPSEEK_API_KEY` in the tmux server's environment specifically, not
  just wherever HoneyRail itself is started — worth a callout in deployment docs if that isn't
  already the pattern operators expect from the other CLI-wrapping adapters (codex/claude/hermes
  hit the same tmux-inheritance constraint for their own credentials, so this isn't dsh-specific,
  but it's easy to trip over the first time).
