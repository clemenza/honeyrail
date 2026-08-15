import type { OnBlockedPolicy, QualityGate, Step } from "../types.js";

export type StepDefinition = {
  id: string;
  name?: string;
  executor: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  maxAttempts?: number;
  qualityGate?: QualityGate;
  onBlocked?: OnBlockedPolicy;
};

export type ExecutorLookup = {
  has(type: string): boolean;
};

export function validateStepGraph(steps: StepDefinition[], executors: ExecutorLookup) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("Run requires at least one step");
  }
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || typeof step.id !== "string") throw new Error("Step id is required");
    if (ids.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (!step.executor || typeof step.executor !== "string") throw new Error(`Step ${step.id} requires an executor`);
    if (!executors.has(step.executor)) throw new Error(`Unknown executor type: ${step.executor}`);
    if (step.maxAttempts !== undefined && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1)) {
      throw new Error(`Step ${step.id} maxAttempts must be a positive integer`);
    }
  }

  for (const step of steps) {
    for (const dep of step.dependsOn || []) {
      if (dep === step.id) throw new Error(`Step ${step.id} cannot depend on itself`);
      if (!ids.has(dep)) throw new Error(`Step ${step.id} depends on unknown step ${dep}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Step dependency cycle detected at ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn || []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }

  for (const step of steps) visit(step.id);
}

export function readySteps(steps: Step[]): Step[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.filter((step) => {
    if (step.status !== "pending") return false;
    return step.dependsOn.every((dep) => byId.get(dep)?.status === "succeeded");
  });
}

export function blockedStepsAfterFailure(steps: Step[]): Step[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const failedOrBlocked = new Set(steps.filter((step) => step.status === "failed" || step.status === "skipped").map((step) => step.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.status !== "pending" && step.status !== "ready") continue;
      if (step.dependsOn.some((dep) => failedOrBlocked.has(dep) || !byId.has(dep))) {
        if (!failedOrBlocked.has(step.id)) {
          failedOrBlocked.add(step.id);
          changed = true;
        }
      }
    }
  }
  return steps.filter((step) => (step.status === "pending" || step.status === "ready") && failedOrBlocked.has(step.id));
}
