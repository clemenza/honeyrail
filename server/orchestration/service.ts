import type { EventBus } from "../events.js";
import { createDefaultEvaluatorRegistry, type EvaluatorRegistry } from "../evaluators/registry.js";
import { createDefaultExecutorRegistry } from "../executors/index.js";
import type { ExecutorRegistry } from "../executors/registry.js";
import type { ExecutionState, StepExecutionContext } from "../executors/types.js";
import type { Artifact, Evaluation, Evidence, Project, Run, Step, Store, VerificationSummary } from "../types.js";
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
  evaluators?: EvaluatorRegistry;
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
  private evaluators: EvaluatorRegistry;
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
    this.evaluators = runtime.evaluators || createDefaultEvaluatorRegistry();
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
        status: "pending",
        qualityGate: definition.qualityGate
      }));
    }
    await publishRunEvent(this.eventContext(), "run.created", run, { stepCount: steps.length });
    await this.scheduleRun(run.id);
    return { run: (await this.store.getRun(run.id)) || run, steps: await this.store.listSteps(run.id) };
  }

  async getRunDetail(runId: string): Promise<{ run: Run & { verification: VerificationSummary }; steps: Array<Step & { verification: VerificationSummary & { artifactItems: Artifact[]; evidenceItems: Evidence[]; evaluationItems: Evaluation[] } }> } | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    return this.enrichRun(run);
  }

  async listRuns(projectId?: string): Promise<Array<Run & { steps: Array<Step & { verification: VerificationSummary & { artifactItems: Artifact[]; evidenceItems: Evidence[]; evaluationItems: Evaluation[] } }>; verification: VerificationSummary }>> {
    const runs = await this.store.listRuns(projectId);
    const details = await Promise.all(runs.map((run) => this.enrichRun(run)));
    return details.map((detail) => ({ ...detail.run, steps: detail.steps }));
  }

  async listArtifacts(runId: string, stepId?: string) {
    return this.store.listArtifacts(runId, stepId);
  }

  async getArtifact(artifactId: string) {
    return this.store.getArtifact(artifactId);
  }

  async listEvidence(runId: string, stepId?: string) {
    return this.store.listEvidence(runId, stepId);
  }

  async listEvaluations(runId: string, stepId?: string) {
    return this.store.listEvaluations(runId, stepId);
  }

  private async enrichRun(run: Run) {
    const steps = await this.store.listSteps(run.id);
    const [artifacts, evidence, evaluations] = await Promise.all([
      this.store.listArtifacts(run.id),
      this.store.listEvidence(run.id),
      this.store.listEvaluations(run.id)
    ]);
    const stepDetails = steps.map((step) => {
      const artifactItems = artifacts.filter((item) => item.stepId === step.id);
      const evidenceItems = evidence.filter((item) => item.stepId === step.id);
      const evaluationItems = evaluations.filter((item) => item.stepId === step.id);
      return {
        ...step,
        verification: {
          ...this.verificationSummary(artifactItems, evidenceItems, evaluationItems),
          artifactItems,
          evidenceItems,
          evaluationItems
        }
      };
    });
    return {
      run: {
        ...run,
        verification: this.verificationSummary(artifacts, evidence, evaluations)
      },
      steps: stepDetails
    };
  }

  private verificationSummary(artifacts: Artifact[], evidence: Evidence[], evaluations: Evaluation[]): VerificationSummary {
    return {
      artifacts: artifacts.length,
      evidence: evidence.length,
      evaluations: {
        passed: evaluations.filter((item) => item.status === "passed").length,
        failed: evaluations.filter((item) => item.status === "failed").length,
        error: evaluations.filter((item) => item.status === "error").length
      }
    };
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
      if (this.isQualityGateWaiting(step)) continue;
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

  private isQualityGateWaiting(step: Step) {
    return step.status === "waiting_approval" && (step.output?.qualityGate as { status?: string } | undefined)?.status === "waiting_approval";
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
      const gateResult = await this.applyQualityGate(run, step, state);
      if (gateResult === "waiting_approval" || gateResult === "failed") return;
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

  private async applyQualityGate(run: Run, step: Step, state: ExecutionState): Promise<"passed" | "failed" | "waiting_approval"> {
    const gate = step.qualityGate;
    if (!gate?.evaluators?.length) return "passed";
    const [evidence, artifacts] = await Promise.all([
      this.store.listEvidence(run.id, step.id),
      this.store.listArtifacts(run.id, step.id)
    ]);
    const evaluations: Evaluation[] = [];
    for (const definition of gate.evaluators) {
      let evaluationInput: Partial<Evaluation> & Pick<Evaluation, "runId" | "evaluator" | "status">;
      try {
        const result = this.evaluators.get(definition.type).evaluate({
          definition,
          step,
          output: state.output,
          evidence,
          artifacts
        });
        evaluationInput = { ...result, runId: run.id, stepId: step.id };
      } catch (error) {
        evaluationInput = {
          runId: run.id,
          stepId: step.id,
          evaluator: definition.id || definition.type,
          status: "error",
          reason: (error as Error).message || "Evaluator error",
          evidenceIds: evidence.map((item) => item.id),
          artifactIds: artifacts.map((item) => item.id),
          metadata: { type: definition.type, source: definition.source }
        };
      }
      const evaluation = await this.store.createEvaluation(evaluationInput);
      evaluations.push(evaluation);
      await publishStepEvent(this.eventContext(), "evaluation.completed", run, step, {
        evaluationId: evaluation.id,
        evaluator: evaluation.evaluator,
        evaluationStatus: evaluation.status,
        reason: evaluation.reason
      });
    }

    const passed = evaluations.every((evaluation) => evaluation.status === "passed");
    if (passed) {
      await publishStepEvent(this.eventContext(), "quality_gate.passed", run, step, { evaluations: evaluations.map((item) => item.id) });
      return "passed";
    }
    const reason = evaluations.find((evaluation) => evaluation.status !== "passed")?.reason || "Quality gate failed";
    if (gate.onFail === "wait_approval") {
      const updated = await transitionStep(this.store, step, {
        status: "waiting_approval",
        output: {
          ...(state.output || {}),
          qualityGate: { status: "waiting_approval", reason, evaluations: evaluations.map((item) => item.id) }
        },
        executionRef: state.executionRef || step.executionRef,
        error: reason
      });
      await publishStepEvent(this.eventContext(), "quality_gate.waiting_approval", run, updated, { reason });
      await publishStepEvent(this.eventContext(), "step.waiting_approval", run, updated);
      return "waiting_approval";
    }
    await publishStepEvent(this.eventContext(), "quality_gate.failed", run, step, { reason });
    await this.handleStepFailure(run, step, reason, {
      ...(state.output || {}),
      qualityGate: { status: "failed", reason, evaluations: evaluations.map((item) => item.id) }
    });
    return "failed";
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
      output: { ...(step.output || {}), approved: true, approvedAt: new Date().toISOString() },
      error: undefined
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
      output: { ...(step.output || {}), approved: false },
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
