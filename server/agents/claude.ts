import { normalizedModel, normalizedPrompt, detectCli } from "./common.js";
import type { AgentAdapter, AgentInputContext, InteractivePromptResponse } from "./types.js";
import { quoteShellArg } from "../utils.js";

export const claudeSubscriptionEnvOverrides = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX"
];

const claudeCommandPrefix = `env ${claudeSubscriptionEnvOverrides.map((name) => `-u ${name}`).join(" ")} claude`;

const promptRules: Array<InteractivePromptResponse & { match: (output: string) => boolean }> = [
  {
    label: "claude_trust_folder",
    match: (output) =>
      /is this a project you created or one you trust/i.test(output) &&
      /yes, i trust this folder/i.test(output),
    keys: ["1", "Enter"]
  }
];

// Claude Code's status line uses a randomized verb while working (e.g.
// "Moseying… (9s · ↓ 233 tokens)") and a randomized past-tense verb once
// done (e.g. "Cogitated for 21s", "Brewed for 6s"), so unlike Codex's fixed
// "Worked for " string, completion is detected by the *shape* of the line
// rather than fixed text: the working line always ends in an ellipsis
// followed by a "(...)" elapsed/token marker, and the completed line always
// ends in "for <duration>" with no such marker. Comparing the last
// occurrence of each (mirroring codexAdapter.hasCompletedTask's
// "Worked for " vs "Working (" position check) avoids reacting to a stale
// completion line from an earlier turn while a new one is in progress.
const workingStatusLine = /^.*…\s*\(.*\)\s*$/;
const completedStatusLine = /^.*\bfor\s+(?:\d+m)?\d+s\s*$/;

function lastLineMatchIndex(output: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, "gm");
  let lastIndex = -1;
  for (const found of output.matchAll(global)) lastIndex = found.index;
  return lastIndex;
}

function formatClaudeInput({ text, attachments }: AgentInputContext) {
  const prompt = String(text || "").replace(/\s+/g, " ").trim();
  if (!attachments.length) return prompt;
  const filePaths = attachments.map((attachment) => attachment.path).join(" ");
  return prompt ? `${prompt} ${filePaths}` : filePaths;
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  displayName: "Claude Code",
  stability: "stable",
  capabilities: {
    modelSelection: true,
    attachments: true,
    images: true,
    interactivePrompts: true
  },

  buildLaunchCommand(input = {}) {
    const prompt = normalizedPrompt(input.prompt);
    const model = normalizedModel(input.model);
    const modelArg = model ? ` --model ${quoteShellArg(model)}` : "";
    // In unattended (run-launched) mode, don't load user-level settings —
    // a user-level skill (e.g. superpowers:brainstorming) can show an
    // AskUserQuestion menu that nothing is watching to answer. Project
    // settings still load so repo-scoped config/skills keep working.
    const settingSources = input.unattended ? "project" : "user";
    return prompt
      ? `${claudeCommandPrefix} --dangerously-skip-permissions --setting-sources ${settingSources}${modelArg} ${quoteShellArg(prompt)}`
      : `${claudeCommandPrefix} --dangerously-skip-permissions --setting-sources ${settingSources}${modelArg}`;
  },

  formatInput: formatClaudeInput,

  findInteractivePromptResponse(output) {
    const rule = promptRules.find((entry) => entry.match(output));
    return rule ? { label: rule.label, keys: rule.keys } : null;
  },

  hasCompletedTask(output) {
    const completedAt = lastLineMatchIndex(output, completedStatusLine);
    if (completedAt === -1) return false;
    const workingAt = lastLineMatchIndex(output, workingStatusLine);
    if (completedAt <= workingAt) return false;
    const recentTail = output.split("\n").slice(-12).join("\n");
    return /(?:^|\n)❯\s*$/m.test(recentTail);
  },

  async detectInstallation(run) {
    return detectCli(this, run, "claude");
  }
};
