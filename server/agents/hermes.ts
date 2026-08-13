import { formatGenericInput, modelFlag, normalizedPrompt, detectCli } from "./common.js";
import type { AgentAdapter } from "./types.js";
import { quoteShellArg } from "../utils.js";

export function hermesArchPrefix(platform = process.platform) {
  return platform === "darwin" ? "arch -arm64 " : "";
}

export const hermesAdapter: AgentAdapter = {
  id: "hermes",
  displayName: "Hermes",
  stability: "experimental",
  capabilities: {
    modelSelection: true,
    attachments: true,
    images: true,
    interactivePrompts: false,
    resume: true
  },

  buildLaunchCommand(input = {}) {
    const prompt = normalizedPrompt(input.prompt);
    const modelArg = modelFlag("-m", input.model);
    const archPrefix = hermesArchPrefix();
    return prompt
      ? `${archPrefix}hermes -z ${quoteShellArg(prompt)}${modelArg} && exec ${archPrefix}hermes chat${modelArg} --continue --accept-hooks --yolo`
      : `${archPrefix}hermes chat${modelArg} --accept-hooks --yolo`;
  },

  formatInput: formatGenericInput,

  async detectInstallation(run) {
    return detectCli(this, run, "hermes");
  }
};
