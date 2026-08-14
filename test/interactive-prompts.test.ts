import assert from "node:assert/strict";
import { test } from "node:test";

import { getAgentAdapter } from "../server/agents/registry.js";

const CLAUDE_TRUST_DIALOG = `
 Accessing workspace:

 /private/tmp/trust-test-VAOr

 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

const CODEX_UPDATE_DIALOG = `
  ✨ Update available! 0.141.0 -> 0.142.5

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue
`;

const CODEX_TRUST_DIALOG = `
> You are in /private/tmp/trust-test-codex-4Yk5

  Do you trust the contents of this directory? Working with untrusted contents
  comes with higher risk of prompt injection. Trusting the directory allows
  project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
`;

const CODEX_CLI_TOO_OLD = `
■ {"type":"error","status":400,"error":
{"type":"invalid_request_error","message":"The 'gpt-5.6-sol' model requires a
newer version of Codex. Please upgrade to the latest app or CLI and try
again."}}
`;

test("detects the claude workspace trust dialog and answers with 1+Enter", () => {
  const result = getAgentAdapter("claude").findInteractivePromptResponse?.(CLAUDE_TRUST_DIALOG);
  assert.deepEqual(result, { label: "claude_trust_folder", keys: ["1", "Enter"] });
});

test("detects the codex update-available dialog and skips without triggering an update", () => {
  const result = getAgentAdapter("codex").findInteractivePromptResponse?.(CODEX_UPDATE_DIALOG);
  assert.deepEqual(result, { label: "codex_update_available", keys: ["3"] });
});

test("detects the codex directory trust dialog and answers with 1", () => {
  const result = getAgentAdapter("codex").findInteractivePromptResponse?.(CODEX_TRUST_DIALOG);
  assert.deepEqual(result, { label: "codex_trust_directory", keys: ["1"] });
});

test("does not match ordinary conversation text that merely mentions trust or updates", () => {
  const chatter = "I trust this codebase and there's an update to the docs, please review it.";
  assert.equal(getAgentAdapter("codex").findInteractivePromptResponse?.(chatter), null);
  assert.equal(getAgentAdapter("claude").findInteractivePromptResponse?.(chatter), null);
});

test("does not match a normal ready prompt after a dialog has been dismissed", () => {
  const readyPrompt = "❯ \nbranch:main\n⏵⏵ bypass permissions on (shift+tab to cycle)";
  assert.equal(getAgentAdapter("codex").findInteractivePromptResponse?.(readyPrompt), null);
});

test("prompt rules are scoped to the owning adapter", () => {
  assert.equal(getAgentAdapter("claude").findInteractivePromptResponse?.(CODEX_TRUST_DIALOG), null);
  assert.equal(getAgentAdapter("codex").findInteractivePromptResponse?.(CLAUDE_TRUST_DIALOG), null);
});

test("detects when the Codex CLI is too old for the selected model", () => {
  const result = getAgentAdapter("codex").findFatalError?.(CODEX_CLI_TOO_OLD);
  assert.deepEqual(result, {
    code: "codex_cli_upgrade_required",
    message: "Codex CLI is too old for model gpt-5.6-sol. Upgrade it with `npm install -g @openai/codex@latest`, then start a new task."
  });
});

test("does not classify ordinary Codex output as a fatal error", () => {
  assert.equal(getAgentAdapter("codex").findFatalError?.("Working on the requested changes."), null);
});

test("detects a completed Codex task only after the final response returns to the prompt", () => {
  const completed = "Added the requested note.\n\n─ Worked for 1m 29s ─────────\n\n› Use /skills to list available skills";
  const stillWorking = `${completed}\n\n• Working (2s - esc to interrupt)`;
  assert.equal(getAgentAdapter("codex").hasCompletedTask?.(completed), true);
  assert.equal(getAgentAdapter("codex").hasCompletedTask?.(stillWorking), false);
});

// Captured verbatim from a real `claude` CLI session (v2.1.227) driven
// through honeyrail's agent-task executor.
const CLAUDE_JUST_STARTED = `❯ Create a file named done.txt in the repository root containing exactly the
  text: hello from claude. Then stop, do not ask any follow-up questions.

✳ Beboppin'…

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  branch:main
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;

const CLAUDE_MID_WORK = `❯ Write a detailed 400-word essay about lighthouses to essay.txt, thinking
  carefully. Then stop, do not ask follow-up questions.

✢ Moseying… (9s · ↓ 233 tokens)

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  branch:main
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;

const CLAUDE_COMPLETED = `⏺ File created at repository root with the exact content "hello from claude".

✻ Brewed for 6s

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  branch:claude/write-done-marker-20260814-112137
  [OMC#4.6.7] | 5h:[###-----]38%(3h48m) wk:[--------]4%(1d8h) | thinking | se…
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;

test("detects a completed Claude task only after the final response returns to the prompt", () => {
  assert.equal(getAgentAdapter("claude").hasCompletedTask?.(CLAUDE_COMPLETED), true);
  assert.equal(getAgentAdapter("claude").hasCompletedTask?.(CLAUDE_JUST_STARTED), false);
  assert.equal(getAgentAdapter("claude").hasCompletedTask?.(CLAUDE_MID_WORK), false);
});

test("Claude completion detection uses the most recent status line, not a stale one from an earlier turn", () => {
  const secondTurnStillWorking = `${CLAUDE_COMPLETED}\n\n❯ do one more thing\n\n✢ Pondering… (3s · ↓ 40 tokens)\n\n────\n❯\n────`;
  assert.equal(getAgentAdapter("claude").hasCompletedTask?.(secondTurnStillWorking), false);
});

test("does not classify ordinary Claude output that merely mentions a duration as completed", () => {
  const chatter = "⏺ Keepers historically worked for long hours in harsh coastal conditions.\n\n✢ Moseying… (9s · ↓ 233 tokens)\n\n❯";
  assert.equal(getAgentAdapter("claude").hasCompletedTask?.(chatter), false);
});
