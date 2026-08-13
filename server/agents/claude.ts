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
    return prompt
      ? `${claudeCommandPrefix} --dangerously-skip-permissions --setting-sources user${modelArg} ${quoteShellArg(prompt)}`
      : `${claudeCommandPrefix} --dangerously-skip-permissions --setting-sources user${modelArg}`;
  },

  formatInput: formatClaudeInput,

  findInteractivePromptResponse(output) {
    const rule = promptRules.find((entry) => entry.match(output));
    return rule ? { label: rule.label, keys: rule.keys } : null;
  },

  async detectInstallation(run) {
    return detectCli(this, run, "claude");
  }
};
