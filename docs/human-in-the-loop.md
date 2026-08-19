# Human-in-the-loop & timeouts

An `agent-task` step can hit a point where the underlying CLI (Claude Code, Codex, …) wants to ask a clarifying question. Before this, a run had no way to detect that and no timeout, so it could stay `running` forever. This page documents the pieces that close that gap: how run-launched agents are told to avoid asking in the first place, what happens when one asks anyway, how an operator (or an LLM) answers without opening a tmux session, and the escape hatch an agent uses when it's genuinely stuck.

## `interaction`: autonomous vs interactive

Every `agent-task` step accepts an `interaction` field on its `input`:

```json
{
  "id": "implement",
  "executor": "agent-task",
  "input": {
    "agent": "codex",
    "prompt": "Implement the feature",
    "interaction": "autonomous"
  }
}
```

- `"autonomous"` (the default — `agent-task` steps are always run-launched, so nothing is watching the terminal): the executor prepends an `UNATTENDED_PREAMBLE` to the prompt telling the agent not to ask clarifying questions, to pick the simplest reasonable interpretation and list assumptions instead, and launches the CLI in its least-interactive mode (`codex --ask-for-approval never --sandbox workspace-write`; Claude Code with `--setting-sources project` instead of `user`, so a user-level skill like `superpowers:brainstorming` can't surface an `AskUserQuestion` menu).
- `"interactive"` opts a step out of all of the above, for the rare case where a run-launched step genuinely needs a human at the terminal.

This only applies to `agent-task` steps created by a run. Sessions launched from the UI or MCP directly are unaffected.

## The `onBlocked` policy

If an agent asks a question anyway, the step's status becomes `waiting_input` or `waiting_approval` (the executor detects this from the linked session's status, which in turn comes from pattern-matching the terminal output — see [docs/agent-adapters.md](agent-adapters.md)). What happens next is controlled by the step's `onBlocked` policy — HoneyRail's unattended-execution contract (#70):

```json
{
  "id": "implement",
  "executor": "agent-task",
  "input": { "...": "..." },
  "onBlocked": {
    "action": "mark_blocked",
    "timeoutMs": 1800000,
    "onTimeout": "auto_retry",
    "maxAutoAnswers": 2
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `action` | `"mark_blocked"` for `interaction: "autonomous"` steps (the common case — see above), `"wait_approval"` for `"interactive"` ones | What to do as soon as the step is detected as blocked. `"mark_blocked"` gives up immediately, no attempt consumed — the step (and run) goes straight to terminal `blocked` for a human/script to inspect or [retry](#retrying-a-blocked-step) explicitly; nothing is auto-retried, since nobody unattended is watching to judge whether retrying makes sense. `"auto_retry"` gives up on the current attempt and retries immediately, respecting `maxAttempts` (see below) — once attempts are exhausted the step's terminal status is `blocked`, not `failed` (it never got a chance to succeed or fail on its own merits — see [Terminal states](#terminal-states) below). `"auto_answer"` asks the configured LLM to answer on the operator's behalf. `"wait_approval"` escalates to a human via the [Answer](#answering-a-blocked-step) UI/endpoint, surfacing the block until `timeoutMs` elapses — the sensible default for an `interaction: "interactive"` step, where a human genuinely is expected at the terminal, but a poor default for an unattended one (see the Background this issue was filed against: a run with nobody watching sitting on `wait_approval` for 30 minutes before finally giving up). |
| `timeoutMs` | `1800000` (30 minutes) | How long a `"wait_approval"` (or an unresolved `"auto_answer"`) block is allowed to sit before `onTimeout` applies. Irrelevant to `"mark_blocked"`/`"auto_retry"`, which never wait. |
| `onTimeout` | `"auto_retry"` | `"auto_retry"` or `"auto_answer"` — what happens once `timeoutMs` elapses without resolution. `"auto_retry"` retries respecting `maxAttempts`, terminating `blocked` (not `failed`) once exhausted, same as the `action` of the same name. |
| `maxAutoAnswers` | `2` | Caps how many times `"auto_answer"` will answer for a single step attempt before falling through to `onTimeout`. |

Any policy still bounds how long a step can sit blocked before reaching a terminal state — `"mark_blocked"` and `"auto_retry"` act immediately, `"wait_approval"`/`"auto_answer"` are bounded by `timeoutMs` — so a run can never hang indefinitely regardless of which one is configured.

A step whose linked session goes quiet — no new terminal output for a while (default 20 minutes) — is treated the same way: flagged as blocked and run through the same policy, so a wedged CLI can't hold a run open indefinitely either.

This policy is deliberately scoped to agent clarification prompts. It does **not** change:

- the dedicated `approval` executor (a human-approval step waits indefinitely by design), or
- a quality gate's `onFail: "wait_approval"` (unchanged semantics, resolved via the existing approve/reject endpoints).

### Terminal states

A step (and the run it belongs to) that exhausts `maxAttempts` while blocked terminates as `blocked`, a status distinct from `failed`. This matters for eval scoring: a rate-limit prompt, a stalled session, or any other unresolved clarification is operational noise, not a signal that the agent's work was actually wrong - conflating the two corrupted pass-rate comparisons before this distinction existed (see the harness A/B eval smoke test writeup). `blocked` steps still cascade a `skipped` status to their dependents exactly like `failed` ones do. The eval report (`server/evals/ab-report.ts`) classifies every trial into one of four buckets - `passed` / `task_failed` / `verify_failed` / `blocked` - and excludes `blocked` from pass-rate denominators.

### Retrying with what the agent already tried

When a blocked step retries under its `maxAttempts`, the retry isn't a blind repeat: the executor sends an enriched prompt appending

> Previous attempt stopped to ask: "\<the question\>". Do not ask again — choose the most reasonable option, state the assumption in your final summary, and proceed.

The original prompt in `step.input.prompt` is left untouched; the enriched version lives in `step.input.effectivePrompt` so the UI can show both and the retry actually runs with it.

## Answering a blocked step

An operator (or an LLM, or a script) can answer a blocked step directly, without attaching to its tmux session:

```
POST /api/runs/:runId/steps/:stepId/answer
{ "text": "use React" }
```

This types `text` (+ Enter) into the step's session through the same path as `POST /api/sessions/:id/input`, clears the block, and publishes a `step.answered` event. It only works for a step actually blocked on an agent clarification (`waiting_input`/`waiting_approval`, not the dedicated `approval` executor or a quality-gate wait — use approve/reject for those).

The Runs UI shows this inline: a blocked step's card displays the agent's question (last 20 lines), a text input with an Answer button, and a countdown to the `onBlocked` timeout. The Runs list shows a `blocked` badge on any run with a step in this state.

### Retrying a blocked step

A step terminated `blocked` (most commonly by the default `"mark_blocked"` policy, which never retries itself) can be resumed explicitly:

```
POST /api/runs/:runId/steps/:stepId/retry
```

This resets the step to `pending` for the next scheduling pass and, if the run itself was `blocked` only because of this step, resumes the run to `running` too. It works for any step whose status is `blocked`, regardless of which `onBlocked` action put it there. The Runs UI shows a Retry button on a blocked step's card.

### `onBlocked: "auto_answer"`

When configured, a blocked step can be answered automatically: the orchestrator asks a configured LLM to pick an answer given the question, the step's original prompt, the project name, and the run's goal, then types the answer into the session exactly like the REST endpoint above. Each attempt is recorded as an `Evidence` item (`kind: "auto_answer"`) on the step, so it shows up in the run's audit trail, and capped by `maxAutoAnswers`.

Auto-answering reuses the same LLM client configured for session summaries (`DEEPSEEK_API_KEY` / `AGENT_SESSION_SUMMARY_API_KEY`, optionally overridden with `HONEYRAIL_AUTO_ANSWER_MODEL`). If no client is configured, `"auto_answer"` is a no-op and the step falls through to `onTimeout` — it never hangs waiting for a provider that isn't there.

## `BLOCKED:` — the escape hatch for unattended agents

An unattended agent told not to ask questions still needs a clean way to say "I actually can't continue." The `UNATTENDED_PREAMBLE` instructs it to print a single line:

```
BLOCKED: the target database is unreachable from this sandbox
```

and then stop. The session monitor detects this line in the terminal's recent output and fails the step with that message — a clean, structured stop rather than a hang or a `WAITING_INPUT_PATTERNS` false positive.

## What's next

`WAITING_INPUT_PATTERNS`-style detection — pattern-matching terminal output to infer that a CLI is waiting on input — is inherently fragile. A first-class `honeyrail.ask_operator` MCP tool, letting an agent declare "I'm blocked, here's my question" explicitly instead of relying on screen-scraping, is the intended longer-term replacement. It's tracked separately and not implemented here.
