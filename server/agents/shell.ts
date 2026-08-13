import { detectCli, formatGenericInput } from "./common.js";
import type { AgentAdapter } from "./types.js";

export const shellAdapter: AgentAdapter = {
  id: "shell",
  displayName: "Shell",
  stability: "stable",
  capabilities: {
    modelSelection: false,
    attachments: true,
    images: true,
    interactivePrompts: false
  },

  buildLaunchCommand() {
    return "$SHELL";
  },

  formatInput: formatGenericInput,

  async detectInstallation(run) {
    const shell = process.env.SHELL || "sh";
    return detectCli(this, run, shell, ["--version"]);
  }
};
