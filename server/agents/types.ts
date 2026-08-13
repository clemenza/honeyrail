import type { ImageAttachment } from "../attachments.js";
import type { AgentType } from "../types.js";
import type { SafeCommandOutput } from "../utils.js";

export type AgentStability = "stable" | "experimental";

export type AgentCapabilities = {
  modelSelection: boolean;
  attachments: boolean;
  images: boolean;
  interactivePrompts: boolean;
  resume?: boolean;
};

export type AgentLaunchInput = {
  prompt?: string;
  model?: string | null;
};

export type AgentInputContext = {
  text?: unknown;
  attachments: ImageAttachment[];
};

export type InteractivePromptResponse = {
  label: string;
  keys: string[];
};

export type AgentInstallationStatus = {
  id: AgentType;
  displayName: string;
  stability: AgentStability;
  available: boolean;
  version?: string;
  path?: string;
  detail?: string;
};

export type AgentCommandRunner = (
  cmd: string,
  args?: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }
) => Promise<SafeCommandOutput>;

export interface AgentAdapter {
  id: AgentType;
  displayName: string;
  stability: AgentStability;
  capabilities: AgentCapabilities;

  buildLaunchCommand(input?: AgentLaunchInput): string;
  formatInput(input: AgentInputContext): string;
  findInteractivePromptResponse?(output: string): InteractivePromptResponse | null;
  detectInstallation?(run: AgentCommandRunner): Promise<AgentInstallationStatus>;
}
