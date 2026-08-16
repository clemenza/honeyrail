import type { ContractLevel, OnBlockedPolicy, QualityGate, Step } from "../types.js";

export type StepDefinition = {
  id: string;
  name?: string;
  executor: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  maxAttempts?: number;
  qualityGate?: QualityGate;
  onBlocked?: OnBlockedPolicy;
  produces?: string[];
  consumes?: string[];
};

export type ExecutorLookup = {
  has(type: string): boolean;
  get(type: string): { producesTypes?: string[]; impliedQualityGate?: QualityGate };
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

/**
 * StepContract dataflow lint: upgrades the DAG from a bare dependency graph
 * to an artifact dataflow graph. For every step, each declared `consumes`
 * entry must be satisfiable by some step reachable via dependsOn ancestry -
 * either that upstream step's own declared `produces`, or an artifact type
 * its executor unconditionally auto-harvests (Executor.producesTypes).
 * Assumes validateStepGraph has already run (ids unique, dependsOn resolved,
 * no cycles) so ancestry traversal here can't infinite-loop.
 */
export function validateStepContracts(steps: StepDefinition[], executors: ExecutorLookup) {
  const byId = new Map(steps.map((step) => [step.id, step]));

  function ancestorIds(id: string, seen = new Set<string>()): Set<string> {
    for (const dep of byId.get(id)?.dependsOn || []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        ancestorIds(dep, seen);
      }
    }
    return seen;
  }

  function effectiveProduces(step: StepDefinition): string[] {
    const inherent = executors.has(step.executor) ? executors.get(step.executor).producesTypes || [] : [];
    return [...inherent, ...(step.produces || [])];
  }

  for (const step of steps) {
    if (!step.consumes?.length) continue;
    const available = new Set<string>();
    for (const ancestorId of ancestorIds(step.id)) {
      for (const type of effectiveProduces(byId.get(ancestorId)!)) available.add(type);
    }
    for (const type of step.consumes) {
      if (!available.has(type)) {
        throw new Error(`Step ${step.id} consumes "${type}", which no upstream step (via dependsOn) produces`);
      }
    }
  }
}

/**
 * A step "verifies" upstream work if it's the canonical check executor, or
 * it declares it needs an upstream artifact to look at. Shared with
 * evals/metrics.ts (#54) so the "verify-runnable rate" metric segments
 * steps identically to what L2 contract lint considers a verifying step.
 */
export function isVerifyingStep(step: StepDefinition): boolean {
  return step.executor === "check" || Boolean(step.consumes?.length);
}

function hasEffectiveEvaluator(step: StepDefinition, executors: ExecutorLookup): boolean {
  if (step.qualityGate?.evaluators?.length) return true;
  if (!executors.has(step.executor)) return false;
  return Boolean(executors.get(step.executor).impliedQualityGate?.evaluators?.length);
}

/**
 * StepContract strictness profile lint (see ContractLevel in types.ts).
 * Cumulative: each level runs all lower levels' checks plus its own.
 *
 * - L0: no contract enforcement at all - a plain execution DAG is left alone.
 * - L1: validateStepContracts above (#51's dataflow lint).
 * - L2: L1 + every "verifying" step (executor "check", or one that declares
 *   `consumes` - it exists to look at an upstream step's output) must have
 *   an evaluator, either declared on the step or implied by its executor
 *   (e.g. CheckExecutor.impliedQualityGate).
 * - L3: L2 + at least one dedicated "approval" step must be present
 *   somewhere in the run.
 */
export function validateContractLevel(level: ContractLevel, steps: StepDefinition[], executors: ExecutorLookup) {
  if (level === "L0") return;
  validateStepContracts(steps, executors);
  if (level === "L1") return;

  for (const step of steps) {
    if (!isVerifyingStep(step)) continue;
    if (!hasEffectiveEvaluator(step, executors)) {
      throw new Error(
        `Contract level L2 requires an evaluator on verifying step "${step.id}" (executor "${step.executor}"): declare a qualityGate.evaluators entry, or use an executor with an implicit default`
      );
    }
  }
  if (level === "L2") return;

  if (!steps.some((step) => step.executor === "approval")) {
    throw new Error('Contract level L3 requires at least one "approval" step in the run, but none is declared');
  }
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
