import type { Run, RunStatus, Step, StepStatus, Store } from "../types.js";

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);
export const TERMINAL_STEP_STATUSES = new Set<StepStatus>(["succeeded", "failed", "skipped", "cancelled"]);

const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["running", "waiting_approval", "failed", "cancelled"],
  running: ["pending", "succeeded", "failed", "waiting_input", "waiting_approval", "cancelled"],
  waiting_input: ["running", "succeeded", "failed", "cancelled"],
  waiting_approval: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: ["pending", "cancelled"],
  skipped: [],
  cancelled: []
};

const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "waiting_input", "waiting_approval", "succeeded", "failed", "cancelled"],
  running: ["waiting_input", "waiting_approval", "succeeded", "failed", "cancelled"],
  waiting_input: ["running", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: []
};

export function assertStepTransition(from: StepStatus, to: StepStatus) {
  if (from === to) return;
  if (!STEP_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid step transition: ${from} -> ${to}`);
  }
}

export function assertRunTransition(from: RunStatus, to: RunStatus) {
  if (from === to) return;
  if (!RUN_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}

export async function transitionStep(store: Store, step: Step, updates: Partial<Step> & { status: StepStatus }): Promise<Step> {
  assertStepTransition(step.status, updates.status);
  const updated = await store.updateStep(step.runId, step.id, updates);
  if (!updated) throw new Error(`Step not found: ${step.runId}/${step.id}`);
  return updated;
}

export async function transitionRun(store: Store, run: Run, updates: Partial<Run> & { status: RunStatus }): Promise<Run> {
  assertRunTransition(run.status, updates.status);
  const updated = await store.updateRun(run.id, updates);
  if (!updated) throw new Error(`Run not found: ${run.id}`);
  return updated;
}

export function deriveRunStatus(steps: Step[]): RunStatus {
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "waiting_input")) return "waiting_input";
  if (steps.some((step) => step.status === "waiting_approval")) return "waiting_approval";
  if (steps.length > 0 && steps.every((step) => step.status === "succeeded" || step.status === "skipped")) return "succeeded";
  return "running";
}

export function isRunTerminal(status: RunStatus) {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isStepTerminal(status: StepStatus) {
  return TERMINAL_STEP_STATUSES.has(status);
}
