import type { EventBus } from "../events.js";
import { createDefaultExecutorRegistry } from "../executors/index.js";
import type { ExecutorRegistry } from "../executors/registry.js";
import type { ExecutionState, StepExecutionContext } from "../executors/types.js";
import type { Project, Run, Step, Store } from "../types.js";
import type { TmuxManager } from "../tmux.js";
import type { runCommandSafe } from "../utils.js";
import type { WorktreeManager } from "../worktrees.js";
import { blockedStepsAfterFailure, readySteps, type StepDefinition, validateStepGraph } from "./dag.js";
import { publishRunEvent, publishStepEvent } from "./events.js";
import { deriveRunStatus, isRunTerminal, isStepTerminal, transitionRun, transitionStep } from "./state-machine.js";

export type OrchestrationRuntime = {
  store: Store;
  bus: EventBus;
  tmux: TmuxManager;
  worktrees: WorktreeManager;
  runCommand: typeof runCommandSafe;
  sessionLogRoot: string;
  attachmentRoot: string;
  executors?: ExecutorRegistry;
};

export type CreateRunInput = {
  projectId: string;
  goal: string;
  steps: StepDefinition[];
};

export class OrchestrationService {
  private store: Store;
  private bus: EventBus;
  private tmux: TmuxManager;
  private worktrees: WorktreeManager;
  private runCommand: typeof runCommandSafe;
  private sessionLogRoot: string;
  private attachmentRoot: string;
  private executors: ExecutorRegistry;
  private scheduling = new Set<string>();

  constructor(runtime: OrchestrationRuntime) {
    this.store = runtime.store;
    this.bus = runtime.bus;
    this.tmux = runtime.tmux;
    this.worktrees = runtime.worktrees;
    this.runCommand = runtime.runCommand;
    this.sessionLogRoot = runtime.sessionLogRoot;
    this.attachmentRoot = runtime.attachmentRoot;
    this.executors = runtime.executors || createDefaultExecutorRegistry();
    this.bus.subscribe((event) => {
      if (!["task.failed", "task.completed"].includes(event.type) || !event.taskId) return;
      this.scheduleRunsForTask(event.taskId).catch((error) => {
        console.error(`Failed to reschedule runs for task ${event.taskId}:`, error);
      });
    });
  }

  executorRegistry() {
    return this.executors;
  }

  private eventContext() {
    return { store: this.store, bus: this.bus };
  }

  async createRun(input: CreateRunInput): Promise<{ run: Run; steps: Step[] }> {
    const project = await this.store.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    validateStepGraph(input.steps, this.executors);
    const run = await this.store.createRun({
      projectId: project.id,
      goal: input.goal,
      status: "pending"
    });
    const steps: Step[] = [];
    for (const definition of input.steps) {
      steps.push(await this.store.createStep({
        id: definition.id,
        runId: run.id,
        name: definition.name || definition.id,
        executor: definition.executor,
        input: definition.input || {},
        dependsOn: definition.dependsOn || [],
        maxAttempts: definition.maxAttempts || 1,
        status: "pending"
      }));
    }
    await publishRunEvent(this.eventContext(), "run.created", run, { stepCount: steps.length });
    await this.scheduleRun(run.id);
    return { run: (await this.store.getRun(run.id)) || run, steps: await this.store.listSteps(run.id) };
  }

  async getRunDetail(runId: string): Promise<{ run: Run; steps: Step[] } | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    return { run, steps: await this.store.listSteps(run.id) };
  }

  async listRuns(projectId?: string): Promise<Array<Run & { steps: Step[] }>> {
    const runs = await this.store.listRuns(projectId);
    return Promise.all(runs.map(async (run) => ({ ...run, steps: await this.store.listSteps(run.id) })));
  }

  async recover() {
    const runs = await this.store.listRuns();
    for (const run of runs.filter((item) => !isRunTerminal(item.status))) {
      await this.scheduleRun(run.id);
    }
  }

  async scheduleRun(runId: string): Promise<void> {
    if (this.scheduling.has(runId)) return;
    this.scheduling.add(runId);
    try {
      await this.scheduleLoop(runId);
    } finally {
      this.scheduling.delete(runId);
    }
  }

  private async scheduleRunsForTask(taskId: string) {
    const runs = await this.store.listRuns();
    for (const run of runs.filter((item) => !isRunTerminal(item.status))) {
      const steps = await this.store.listSteps(run.id);
      const linkedActiveStep = steps.some((step) =>
        step.executor === "agent-task" &&
        step.executionRef?.taskId === taskId &&
        ["running", "waiting_input", "waiting_approval"].includes(step.status)
      );
      if (linkedActiveStep) await this.scheduleRun(run.id);
    }
  }

  private async scheduleLoop(runId: string) {
    let changed = true;
    while (changed) {
      changed = false;
      const run = await this.store.getRun(runId);
      if (!run || isRunTerminal(run.status)) return;
      const project = await this.store.getProject(run.projectId);
      if (!project) {
        await this.failRun(run, "Project not found");
        return;
      }

      let steps = await this.store.listSteps(run.id);
      changed = await this.inspectActiveSteps(run, project, steps) || changed;
      steps = await this.store.listSteps(run.id);
      changed = await this.skipBlockedSteps(run, steps) || changed;
      steps = await this.store.listSteps(run.id);
      changed = await this.markReadySteps(run, steps) || changed;
      steps = await this.store.listSteps(run.id);

      for (const step of steps.filter((item) => item.status === "ready")) {
        await this.startStep(run, project, step);
        changed = true;
      }

      steps = await this.store.listSteps(run.id);
      changed = await this.skipBlockedSteps(run, steps) || changed;
      const terminalChanged = await this.updateRunStatus(run.id);
      changed = terminalChanged || changed;
    }
  }

  private async inspectActiveSteps(run: Run, project: Project, steps: Step[]) {
    let changed = false;
    for (const step of steps.filter((item) => item.status === "running" || item.status === "waiting_input" || item.status === "waiting_approval")) {
      if (!step.executionRef && step.executor !== "approval") continue;
      const executor = this.executors.get(step.executor);
      const state = await executor.inspect(this.context(project, run, step), step.executionRef || {});
      if (state.status === "running" || state.status === "waiting_input" || state.status === "waiting_approval") {
        if (state.status !== step.status) {
          const updated = await transitionStep(this.store, step, { status: state.status });
          await publishStepEvent(this.eventContext(), `step.${state.status}`, run, updated);
          changed = true;
        }
        continue;
      }
      await this.completeStepFromState(run, step, state);
      changed = true;
    }
    return changed;
  }

  private async skipBlockedSteps(run: Run, steps: Step[]) {
    let changed = false;
    for (const step of blockedStepsAfterFailure(steps)) {
      const updated = await transitionStep(this.store, step, {
        status: "skipped",
        finishedAt: new Date().toISOString(),
        error: "Skipped because an upstream dependency failed"
      });
      await publishStepEvent(this.eventContext(), "step.skipped", run, updated);
      changed = true;
    }
    return changed;
  }

  private async markReadySteps(run: Run, steps: Step[]) {
    let changed = false;
    for (const step of readySteps(steps)) {
      const updated = await transitionStep(this.store, step, { status: "ready" });
      await publishStepEvent(this.eventContext(), "step.ready", run, updated);
      changed = true;
    }
    return changed;
  }

  private async startStep(run: Run, project: Project, step: Step) {
    const now = new Date().toISOString();
    const started = await transitionStep(this.store, step, {
      status: "running",
      startedAt: step.startedAt || now,
      attempt: step.attempt + 1,
      error: undefined,
      input: await this.resolveStepInput(run, step)
    });
    if (run.status === "pending") {
      const startedRun = await transitionRun(this.store, run, { status: "running", startedAt: run.startedAt || now });
      await publishRunEvent(this.eventContext(), "run.started", startedRun);
    }
    await publishStepEvent(this.eventContext(), "step.started", run, started);

    try {
      const executor = this.executors.get(started.executor);
      const handle = await executor.start(this.context(project, run, started));
      const withRef = await this.store.updateStep(run.id, started.id, { executionRef: handle }) || started;
      const state = await executor.inspect(this.context(project, run, withRef), handle);
      if (state.status === "running" || state.status === "waiting_input" || state.status === "waiting_approval") {
        if (state.status !== withRef.status) {
          const updated = await transitionStep(this.store, withRef, { status: state.status });
          await publishStepEvent(this.eventContext(), `step.${state.status}`, run, updated);
        }
        return;
      }
      await this.completeStepFromState(run, withRef, state);
    } catch (error) {
      await this.handleStepFailure(run, started, (error as Error).message || "Step failed");
    }
  }

  private async completeStepFromState(run: Run, step: Step, state: ExecutionState) {
    const finishedAt = new Date().toISOString();
    if (state.status === "succeeded") {
      const updated = await transitionStep(this.store, step, {
        status: "succeeded",
        finishedAt,
        output: state.output,
        executionRef: state.executionRef || step.executionRef,
        error: undefined
      });
      await publishStepEvent(this.eventContext(), "step.succeeded", run, updated);
      return;
    }
    if (state.status === "cancelled") {
      const updated = await transitionStep(this.store, step, {
        status: "cancelled",
        finishedAt,
        output: state.output,
        error: state.error
      });
      await publishStepEvent(this.eventContext(), "step.cancelled", run, updated);
      return;
    }
    await this.handleStepFailure(run, step, state.error || "Step failed", state.output);
  }

  private async handleStepFailure(run: Run, step: Step, error: string, output?: Record<string, unknown>) {
    if (step.attempt < step.maxAttempts) {
      const retrying = await transitionStep(this.store, step, {
        status: "pending",
        error,
        output,
        executionRef: undefined,
        startedAt: undefined,
        finishedAt: undefined
      });
      await publishStepEvent(this.eventContext(), "step.retrying", run, retrying, { error });
      return;
    }
    const updated = await transitionStep(this.store, step, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      output,
      error
    });
    await publishStepEvent(this.eventContext(), "step.failed", run, updated, { error });
  }

  async approveStep(runId: string, stepId: string): Promise<{ run: Run; step: Step }> {
    const run = await this.requireRun(runId);
    const step = await this.requireStep(run.id, stepId);
    if (step.status !== "waiting_approval") throw new Error(`Step is not waiting approval: ${step.status}`);
    const updated = await transitionStep(this.store, step, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      output: { approved: true, approvedAt: new Date().toISOString() }
    });
    await publishStepEvent(this.eventContext(), "step.succeeded", run, updated, { approved: true });
    await this.scheduleRun(run.id);
    return { run: (await this.store.getRun(run.id)) || run, step: updated };
  }

  async rejectStep(runId: string, stepId: string, reason = "Rejected by operator"): Promise<{ run: Run; step: Step }> {
    const run = await this.requireRun(runId);
    const step = await this.requireStep(run.id, stepId);
    if (step.status !== "waiting_approval") throw new Error(`Step is not waiting approval: ${step.status}`);
    const updated = await transitionStep(this.store, step, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      output: { approved: false },
      error: reason
    });
    await publishStepEvent(this.eventContext(), "step.failed", run, updated, { rejected: true, error: reason });
    await this.scheduleRun(run.id);
    return { run: (await this.store.getRun(run.id)) || run, step: updated };
  }

  async cancelRun(runId: string): Promise<Run> {
    const run = await this.requireRun(runId);
    if (run.status === "cancelled") return run;
    if (isRunTerminal(run.status)) throw new Error(`Run is already terminal: ${run.status}`);
    const steps = await this.store.listSteps(run.id);
    for (const step of steps) {
      if (step.status === "succeeded" || step.status === "skipped" || step.status === "cancelled") continue;
      if ((step.status === "running" || step.status === "waiting_input" || step.status === "waiting_approval") && step.executionRef) {
        const project = await this.store.getProject(run.projectId);
        if (project) await this.executors.get(step.executor).cancel?.(this.context(project, run, step), step.executionRef);
      }
      const updated = await transitionStep(this.store, step, {
        status: "cancelled",
        finishedAt: step.finishedAt || new Date().toISOString(),
        error: "Run cancelled"
      });
      await publishStepEvent(this.eventContext(), "step.cancelled", run, updated);
    }
    const cancelled = await transitionRun(this.store, run, { status: "cancelled", cancelledAt: new Date().toISOString() });
    await publishRunEvent(this.eventContext(), "run.cancelled", cancelled);
    return cancelled;
  }

  private async updateRunStatus(runId: string): Promise<boolean> {
    const run = await this.store.getRun(runId);
    if (!run || isRunTerminal(run.status)) return false;
    const steps = await this.store.listSteps(run.id);
    const next = deriveRunStatus(steps);
    if (next === run.status) return false;
    const updates: Partial<Run> = { status: next };
    if (next === "succeeded" || next === "failed") updates.finishedAt = new Date().toISOString();
    const updated = await transitionRun(this.store, run, updates as Partial<Run> & { status: Run["status"] });
    await publishRunEvent(this.eventContext(), `run.${next}`, updated);
    return true;
  }

  private async failRun(run: Run, error: string) {
    const updated = await transitionRun(this.store, run, { status: "failed", finishedAt: new Date().toISOString(), error });
    await publishRunEvent(this.eventContext(), "run.failed", updated, { error });
  }

  private async resolveStepInput(run: Run, step: Step) {
    const input = { ...step.input };
    for (const depId of step.dependsOn) {
      const dep = await this.store.getStep(run.id, depId);
      if (!dep) continue;
      if (dep.executionRef) {
        for (const [key, value] of Object.entries(dep.executionRef)) {
          if (input[key] === undefined) input[key] = value;
        }
      }
      if (dep.output) {
        for (const [key, value] of Object.entries(dep.output)) {
          if (input[key] === undefined) input[key] = value;
        }
      }
    }
    return input;
  }

  private context(project: Project, run: Run, step: Step): StepExecutionContext {
    return {
      store: this.store,
      bus: this.bus,
      tmux: this.tmux,
      worktrees: this.worktrees,
      runCommand: this.runCommand,
      project,
      runId: run.id,
      step,
      sessionLogRoot: this.sessionLogRoot,
      attachmentRoot: this.attachmentRoot
    };
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    return run;
  }

  private async requireStep(runId: string, stepId: string): Promise<Step> {
    const step = await this.store.getStep(runId, stepId);
    if (!step) throw new Error("Step not found");
    return step;
  }
}
