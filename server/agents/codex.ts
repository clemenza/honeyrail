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

  async detectInstallation(run) {
    return detectCli(this, run, "codex");
  }
};
