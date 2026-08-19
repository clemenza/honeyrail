import { fileURLToPath } from "node:url";
import { formatGenericInput, hasCompletedByTailMarker, normalizedModel, normalizedPrompt } from "./common.js";
import type { AgentAdapter, AgentInstallationStatus } from "./types.js";
import { quoteShellArg } from "../utils.js";

const DONE_MARKER = "MINIMAL_AGENT_DONE";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TEMPERATURE = 0;

// Resolved once, relative to this module's own location - robust regardless
// of the worktree cwd the launched process runs in (which has no relation
// to HoneyRail's own installation). See scripts/minimal-agent.mjs's header
// comment for why that script is plain dependency-free JS rather than TS.
const scriptPath = fileURLToPath(new URL("../../scripts/minimal-agent.mjs", import.meta.url));

function minimalAgentApiKey(): string | undefined {
  return process.env.MINIMAL_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.AGENT_SESSION_SUMMARY_API_KEY || undefined;
}

function buildLaunchCommand(input: { prompt?: string; model?: string | null; temperature?: number } = {}): string {
  const model = normalizedModel(input.model) || DEFAULT_MODEL;
  const temperature = typeof input.temperature === "number" && Number.isFinite(input.temperature) ? input.temperature : DEFAULT_TEMPERATURE;
  const prompt = normalizedPrompt(input.prompt);
  return [
    "node", quoteShellArg(scriptPath),
    "--prompt", quoteShellArg(prompt),
    "--model", quoteShellArg(model),
    "--temperature", quoteShellArg(String(temperature))
  ].join(" ");
}

/**
 * A minimal ReAct loop (scripts/minimal-agent.mjs) that calls a model API
 * directly - no third-party CLI, so no TUI or interactive prompt of any
 * kind can appear (interactivePrompts: false is a real guarantee here, not
 * just an unimplemented capability). A calibration probe: low enough
 * capability to expose a task's ceiling effect, not marketed as a
 * production-grade agent. See docs/agent-adapters.md for intended use.
 */
export const minimalAgentAdapter: AgentAdapter = {
  id: "minimal",
  displayName: "Minimal Agent",
  stability: "experimental",
  capabilities: {
    modelSelection: true,
    attachments: false,
    images: false,
    interactivePrompts: false
  },

  buildLaunchCommand,

  formatInput: formatGenericInput,

  hasCompletedTask(output) {
    return hasCompletedByTailMarker(output, DONE_MARKER);
  },

  async detectInstallation(): Promise<AgentInstallationStatus> {
    const available = Boolean(minimalAgentApiKey());
    return {
      id: "minimal",
      displayName: "Minimal Agent",
      stability: "experimental",
      available,
      detail: available ? undefined : "No API key configured - set DEEPSEEK_API_KEY, AGENT_SESSION_SUMMARY_API_KEY, or MINIMAL_AGENT_API_KEY"
    };
  }
};
