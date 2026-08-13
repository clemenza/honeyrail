import { getAgentAdapter } from "./agents/registry.js";
import type { InteractivePromptResponse } from "./agents/types.js";

export type { InteractivePromptResponse };

export function findInteractivePromptResponse(agent: unknown, output: string): InteractivePromptResponse | null {
  const adapter = getAgentAdapter(agent);
  return adapter.findInteractivePromptResponse?.(output) || null;
}
