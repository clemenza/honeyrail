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
