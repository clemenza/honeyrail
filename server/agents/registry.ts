import type { AgentType } from "../types.js";
import type { AgentAdapter } from "./types.js";
import { shellAdapter } from "./shell.js";
import { codexAdapter } from "./codex.js";
import { claudeAdapter } from "./claude.js";
import { hermesAdapter } from "./hermes.js";

const adapters = [shellAdapter, codexAdapter, claudeAdapter, hermesAdapter] as const;
const adapterById = new Map<string, AgentAdapter>(adapters.map((adapter) => [adapter.id, adapter]));

export class UnknownAgentError extends Error {
  status = 400;

  constructor(agent: unknown) {
    super(`Unknown agent backend: ${String(agent || "(empty)")}`);
    this.name = "UnknownAgentError";
  }
}

export function listAgentAdapters(): AgentAdapter[] {
  return [...adapters];
}

export function knownAgentIds(): AgentType[] {
  return adapters.map((adapter) => adapter.id);
}

export function getAgentAdapter(agent: unknown): AgentAdapter {
  const adapter = adapterById.get(String(agent || ""));
  if (!adapter) throw new UnknownAgentError(agent);
  return adapter;
}

export function isKnownAgent(agent: unknown): agent is AgentType {
  return adapterById.has(String(agent || ""));
}
