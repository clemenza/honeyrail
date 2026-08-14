import { formatGenericInput, modelFlag, normalizedPrompt, detectCli } from "./common.js";
import type { AgentAdapter, InteractivePromptResponse } from "./types.js";
import { quoteShellArg } from "../utils.js";

const promptRules: Array<InteractivePromptResponse & { match: (output: string) => boolean }> = [
  {
    label: "codex_update_available",
    match: (output) =>
      /update available/i.test(output) &&
      /skip until next version/i.test(output),
    keys: ["3"]
  },
  {
    label: "codex_trust_directory",
    match: (output) =>
      /do you trust the contents of this directory/i.test(output) &&
      /yes, continue/i.test(output),
    keys: ["1"]
  }
];

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  stability: "stable",
  capabilities: {
    modelSelection: true,
    attachments: true,
    images: true,
    interactivePrompts: true
  },

  buildLaunchCommand(input = {}) {
    const prompt = normalizedPrompt(input.prompt);
    const modelArg = modelFlag("--model", input.model);
    return prompt ? `codex${modelArg} ${quoteShellArg(prompt)}` : `codex${modelArg}`;
  },

  formatInput: formatGenericInput,

  findInteractivePromptResponse(output) {
    const rule = promptRules.find((entry) => entry.match(output));
    return rule ? { label: rule.label, keys: rule.keys } : null;
  },

  findFatalError(output) {
    const versionError = output.match(/The ['‘’"]([^'‘’"]+)['‘’"] model requires\s+a\s+newer version of Codex\.\s+Please upgrade to the latest app or CLI and try\s+again\./i);
    if (!versionError) return null;
    const model = versionError[1];
    return {
      code: "codex_cli_upgrade_required",
      message: `Codex CLI is too old for model ${model}. Upgrade it with \`npm install -g @openai/codex@latest\`, then start a new task.`
    };
  },

  hasCompletedTask(output) {
    const completedAt = output.lastIndexOf("Worked for ");
    if (completedAt === -1) return false;
    const workingAt = output.lastIndexOf("Working (");
    const recentTail = output.split("\n").slice(-12).join("\n");
    return completedAt > workingAt && /(?:^|\n)›\s+/m.test(recentTail);
  },

  async detectInstallation(run) {
    return detectCli(this, run, "codex");
  }
};
