import type { EventBus } from "../events.js";
import { createDefaultEvaluatorRegistry, type EvaluatorRegistry } from "../evaluators/registry.js";
import { createDefaultExecutorRegistry } from "../executors/index.js";
import type { ExecutorRegistry } from "../executors/registry.js";
import type { ExecutionState, StepExecutionContext } from "../executors/types.js";
import type { SessionSummaryClient } from "../session-helpers.js";
import type { Artifact, Evaluation, Evidence, OnBlockedPolicy, Project, QualityGate, QualityGateDecision, ResolvedOnBlockedPolicy, Run, Step, Store, VerificationSummary } from "../types.js";
import type { TmuxManager } from "../tmux.js";
import type { runCommandSafe } from "../utils.js";
import type { WorktreeManager } from "../worktrees.js";
import { generateAutoAnswer } from "./auto-answer.js";
import { blockedStepsAfterFailure, readySteps, type StepDefinition, validateStepGraph } from "./dag.js";
import { publishRunEvent, publishStepEvent } from "./events.js";
import { deriveRunStatus, isRunTerminal, isStepTerminal, transitionRun, transitionStep } from "./state-machine.js";

function latestEvaluationAttempt(evaluations: Evaluation[]): number | undefined {
  const attempts = evaluations
    .map((item) => item.attempt)
    .filter((attempt): attempt is number => Number.isInteger(attempt));
  if (!attempts.length) return undefined;
  return Math.max(...attempts);
}

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
  /** How long a running agent-task step can go without new session output before it's treated as stalled/blocked. Default 20 minutes. */
  stalledThresholdMs?: number;
  /** LLM client used to answer blocked steps under onBlocked action/onTimeout "auto_answer". Auto-answering is a no-op (falls through to onTimeout) when omitted. */
  autoAnswerClient?: SessionSummaryClient;
  autoAnswerModel?: string;
};

const DEFAULT_ON_BLOCKED: ResolvedOnBlockedPolicy = {
  action: "wait_approval",
  timeoutMs: 30 * 60_000,
  onTimeout: "fail",
  maxAutoAnswers: 2
};

const DEFAULT_STALLED_THRESHOLD_MS = 20 * 60_000;

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
  private stalledThresholdMs: number;
  private autoAnswerClient?: SessionSummaryClient;
  private autoAnswerModel: string;
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
    this.stalledThresholdMs = runtime.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS;
    this.autoAnswerClient = runtime.autoAnswerClient;
    this.autoAnswerModel = runtime.autoAnswerModel || "deepseek-v4-flash";
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
    this.validateQualityGateEvaluators(input.steps);
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
        qualityGate: definition.qualityGate,
        onBlocked: definition.onBlocked
      }));
    }
    await publishRunEvent(this.eventContext(), "run.created", run, { stepCount: steps.length });
    await this.scheduleRun(run.id);
    return { run: (await this.store.getRun(run.id)) || run, steps: await this.store.listSteps(run.id) };
  }

  async getRunDetail(runId: string): Promise<{ run: Run & { verification: VerificationSummary; gateDecisions: QualityGateDecision[] }; steps: Array<Step & { verification: VerificationSummary & { artifactItems: Artifact[]; evidenceItems: Evidence[]; evaluationItems: Evaluation[]; gateDecisionItems: QualityGateDecision[] } }> } | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    return this.enrichRun(run);
  }

  async listRuns(projectId?: string): Promise<Array<Run & { steps: Array<Step & { verification: VerificationSummary & { artifactItems: Artifact[]; evidenceItems: Evidence[]; evaluationItems: Evaluation[]; gateDecisionItems: QualityGateDecision[] } }>; verification: VerificationSummary; gateDecisions: QualityGateDecision[] }>> {
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

  async listQualityGateDecisions(runId: string, stepId?: string) {
    return this.store.listQualityGateDecisions(runId, stepId);
  }

  private validateQualityGateEvaluators(steps: StepDefinition[]) {
    for (const step of steps) {
      for (const definition of step.qualityGate?.evaluators || []) {
        if (!this.evaluators.has(definition.type)) {
          throw new Error(`Unknown evaluator type: ${definition.type}`);
        }
      }
    }
  }

  private async enrichRun(run: Run) {
    const steps = await this.store.listSteps(run.id);
    const [artifacts, evidence, evaluations, gateDecisions] = await Promise.all([
      this.store.listArtifacts(run.id),
      this.store.listEvidence(run.id),
      this.store.listEvaluations(run.id),
      this.store.listQualityGateDecisions(run.id)
    ]);
    const stepDetails = steps.map((step) => {
      const artifactItems = artifacts.filter((item) => item.stepId === step.id);
      const evidenceItems = evidence.filter((item) => item.stepId === step.id);
      const evaluationItems = evaluations.filter((item) => item.stepId === step.id);
      const gateDecisionItems = gateDecisions.filter((item) => item.stepId === step.id);
      return {
        ...step,
        verification: {
          ...this.verificationSummary(artifactItems, evidenceItems, evaluationItems, step),
          artifactItems,
          evidenceItems,
          evaluationItems,
          gateDecisionItems
        }
      };
    });
    return {
      run: {
        ...run,
        verification: this.runVerificationSummary(stepDetails),
        gateDecisions
      },
      steps: stepDetails
    };
  }

  private verificationSummary(artifacts: Artifact[], evidence: Evidence[], evaluations: Evaluation[], step?: Step): VerificationSummary {
    const latestAttempt = step?.attempt ?? latestEvaluationAttempt(evaluations);
    const latestEvaluations = evaluations.filter((item) => item.attempt === undefined || latestAttempt === undefined || item.attempt === latestAttempt);
    return {
      artifacts: artifacts.length,
      evidence: evidence.length,
      latestAttempt,
      evaluations: {
        passed: latestEvaluations.filter((item) => item.status === "passed").length,
        failed: latestEvaluations.filter((item) => item.status === "failed").length,
        error: latestEvaluations.filter((item) => item.status === "error").length
      }
    };
  }

  private runVerificationSummary(steps: Array<Step & { verification: VerificationSummary }>): VerificationSummary {
    return steps.reduce<VerificationSummary>((summary, step) => ({
      artifacts: summary.artifacts + (step.verification.artifacts || 0),
      evidence: summary.evidence + (step.verification.evidence || 0),
      latestAttempt: undefined,
      evaluations: {
        passed: summary.evaluations.passed + step.verification.evaluations.passed,
        failed: summary.evaluations.failed + step.verification.evaluations.failed,
        error: summary.evaluations.error + step.verification.evaluations.error
      }
    }), { artifacts: 0, evidence: 0, evaluations: { passed: 0, failed: 0, error: 0 } });
  }

  async recover() {
    await this.scheduleNonTerminalRuns();
  }

  private async scheduleNonTerminalRuns() {
    const runs = await this.store.listRuns();
    for (const run of runs.filter((item) => !isRunTerminal(item.status))) {
      await this.scheduleRun(run.id);
    }
  }

  /**
   * Some executors (e.g. `shell`) complete a detached background process and
   * have no event that re-invokes the scheduler for their run. Without a
   * poller those steps stay "running" forever even after the underlying
   * work finishes. This mirrors session-monitor.ts's polling pattern.
   */
  startPolling(intervalMs: number): () => void {
    let stopped = false;
    let running = false;
    let rerunRequested = false;
    const tick = () => {
      if (stopped) return;
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      this.scheduleNonTerminalRuns()
        .catch((error) => console.error("Orchestration poller failed:", error))
        .finally(() => {
          running = false;
          if (rerunRequested && !stopped) {
            rerunRequested = false;
            tick();
          }
        });
    };
    const timer = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
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
      changed = await this.checkStalledSteps(run, project, steps) || changed;
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

  private isStalledMarked(step: Step): boolean {
    return Boolean((step.output as Record<string, unknown> | undefined)?.stalledWatchdog);
  }

  private withoutStalledMarker(output?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!output || !("stalledWatchdog" in output)) return output;
    const { stalledWatchdog: _drop, ...rest } = output;
    return rest;
  }

  private async inspectActiveSteps(run: Run, project: Project, steps: Step[]) {
    let changed = false;
    for (const step of steps.filter((item) => item.status === "running" || item.status === "waiting_input" || item.status === "waiting_approval")) {
      if (this.isQualityGateWaiting(step)) continue;
      // Steps flagged by the stall watchdog are owned by checkStalledSteps
      // until it observes fresh session output and releases them, so a
      // normal inspect() here can't immediately undo the stalled marking.
      if (this.isStalledMarked(step)) continue;
      if (!step.executionRef && step.executor !== "approval") continue;
      const executor = this.executors.get(step.executor);
      const state = await executor.inspect(this.context(project, run, step), step.executionRef || {});
      if (state.status === "running") {
        changed = (await this.markStepUnblocked(run, step)) || changed;
        continue;
      }
      if (state.status === "waiting_input" || state.status === "waiting_approval") {
        if (step.executor === "approval") {
          // Dedicated human-approval steps wait indefinitely by design; the
          // onBlocked policy below is only for agent clarification prompts.
          if (state.status !== step.status) {
            const updated = await transitionStep(this.store, step, { status: state.status });
            await publishStepEvent(this.eventContext(), `step.${state.status}`, run, updated);
            changed = true;
          }
          continue;
        }
        changed = (await this.markStepBlocked(run, project, step, state)) || changed;
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

  private resolveOnBlocked(step: Step): ResolvedOnBlockedPolicy {
    return { ...DEFAULT_ON_BLOCKED, ...(step.onBlocked || {}) };
  }

  private async markStepUnblocked(run: Run, step: Step, opts: { clearStalledMarker?: boolean } = {}): Promise<boolean> {
    if (step.status === "running" && !step.blockedSince && !opts.clearStalledMarker) return false;
    const output = opts.clearStalledMarker ? this.withoutStalledMarker(step.output) : step.output;
    const updated = await transitionStep(this.store, step, { status: "running", blockedSince: undefined, output });
    await publishStepEvent(this.eventContext(), "step.running", run, updated);
    return true;
  }

  /**
   * Applies the onBlocked policy to a step whose executor reported
   * waiting_input/waiting_approval (an agent asking a clarifying question),
   * as opposed to the dedicated "approval" executor or a quality-gate wait,
   * neither of which are timed out by this policy.
   */
  private async markStepBlocked(run: Run, project: Project, step: Step, state: ExecutionState): Promise<boolean> {
    const policy = this.resolveOnBlocked(step);
    const question = String(state.output?.question || step.output?.question || "");
    const sessionId = (state.output?.sessionId ?? step.executionRef?.sessionId) as string | undefined;
    let current = step;
    let changed = false;

    // Stores may mutate and return the same object reference passed into
    // transitionStep (JsonStore does), so capture these before the call —
    // reading them off `current` afterward would always see the new values.
    const wasAlreadyBlocked = Boolean(current.blockedSince);
    const statusChanged = current.status !== state.status;
    if (!wasAlreadyBlocked || statusChanged) {
      const blockedSince = current.blockedSince || new Date().toISOString();
      const updated = await transitionStep(this.store, current, {
        status: state.status,
        blockedSince,
        output: { ...(current.output || {}), ...(state.output || {}) }
      });
      await publishStepEvent(this.eventContext(), `step.${state.status}`, run, updated);
      if (!wasAlreadyBlocked) {
        await publishStepEvent(this.eventContext(), "step.blocked", run, updated, { question, sessionId, timeoutMs: policy.timeoutMs, action: policy.action });
      }
      current = updated;
      changed = true;
    }

    if (policy.action === "fail") {
      await this.handleStepFailure(run, current, `Agent requested clarification: ${question || "no question captured"}`, current.output, question);
      return true;
    }

    if (policy.action === "auto_answer") {
      const answered = await this.tryAutoAnswer(run, project, current, question, policy);
      if (answered) return true;
    }

    const blockedAt = current.blockedSince ? new Date(current.blockedSince).getTime() : Date.now();
    const elapsed = Date.now() - blockedAt;
    if (elapsed <= policy.timeoutMs) return changed;

    if (policy.onTimeout === "auto_answer") {
      const answered = await this.tryAutoAnswer(run, project, current, question, policy);
      if (answered) return true;
    }
    await this.handleStepFailure(run, current, `Blocked step timed out after ${Math.round(policy.timeoutMs / 60000)}m waiting for input`, current.output, question);
    return true;
  }

  /**
   * Asks the configured LLM to answer on the operator's behalf and, if it
   * produces one, types it into the blocked step's session. Returns false
   * (never throws) whenever auto-answering isn't possible — no client
   * configured, no linked session, the attempt cap was hit, or the LLM call
   * itself failed — so callers fall through to the onBlocked.onTimeout
   * handling.
   */
  private async tryAutoAnswer(run: Run, project: Project, step: Step, question: string, policy: ResolvedOnBlockedPolicy): Promise<boolean> {
    if (!this.autoAnswerClient || !question) return false;
    const attempts = await this.countAutoAnswerAttempts(run.id, step.id, step.attempt);
    if (attempts >= policy.maxAutoAnswers) return false;

    const answer = await generateAutoAnswer({
      client: this.autoAnswerClient,
      model: this.autoAnswerModel,
      question,
      prompt: String(step.input?.prompt ?? ""),
      projectName: project.name,
      goal: run.goal
    });
    if (!answer) return false;

    const sessionId = (step.executionRef?.sessionId ?? step.output?.sessionId) as string | undefined;
    const session = sessionId ? await this.store.getSession(sessionId) : undefined;
    if (!session) return false;
    try {
      await this.tmux.sendInput(session.tmuxSessionName, answer);
    } catch {
      return false;
    }

    await this.store.createEvidence({
      runId: run.id,
      stepId: step.id,
      attempt: step.attempt,
      kind: "auto_answer",
      claim: question,
      value: answer,
      source: "auto-answer"
    });
    await publishStepEvent(this.eventContext(), "step.auto_answered", run, step, { question, answer, attempt: attempts + 1 });
    await this.markStepUnblocked(run, step);
    return true;
  }

  private async countAutoAnswerAttempts(runId: string, stepId: string, attempt: number): Promise<number> {
    const evidence = await this.store.listEvidence(runId, stepId);
    return evidence.filter((item) => item.kind === "auto_answer" && item.attempt === attempt).length;
  }

  /**
   * Mirrors session-monitor.ts's staleness check but applies the run's
   * onBlocked policy: an agent-task step whose linked session has produced
   * no new output for stalledThresholdMs is treated as blocked so it can be
   * timed out instead of holding the run open forever.
   */
  private async checkStalledSteps(run: Run, project: Project, steps: Step[]) {
    let changed = false;
    for (const step of steps.filter((item) =>
      item.executor !== "approval" &&
      (item.status === "running" || (this.isStalledMarked(item) && (item.status === "waiting_input" || item.status === "waiting_approval")))
    )) {
      const sessionId = step.executionRef?.sessionId as string | undefined;
      if (!sessionId) continue;
      const session = await this.store.getSession(sessionId);
      if (!session?.lastOutputAt) continue;
      const elapsed = Date.now() - new Date(session.lastOutputAt).getTime();
      const stalledMarked = this.isStalledMarked(step);

      if (elapsed <= this.stalledThresholdMs) {
        if (stalledMarked) changed = (await this.markStepUnblocked(run, step, { clearStalledMarker: true })) || changed;
        continue;
      }

      if (!stalledMarked) {
        await publishStepEvent(this.eventContext(), "step.stalled", run, step, { elapsedMs: elapsed, thresholdMs: this.stalledThresholdMs });
      }
      const minutes = Math.round(elapsed / 60_000);
      changed = (await this.markStepBlocked(run, project, step, {
        status: "waiting_input",
        output: { ...(step.output || {}), question: `No session output for ${minutes}m (stalled)`, sessionId, stalledWatchdog: true }
      })) || changed;
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
      if (state.status === "running") {
        if (state.status !== withRef.status) {
          const updated = await transitionStep(this.store, withRef, { status: state.status });
          await publishStepEvent(this.eventContext(), "step.running", run, updated);
        }
        return;
      }
      if (state.status === "waiting_input" || state.status === "waiting_approval") {
        if (withRef.executor === "approval") {
          const updated = await transitionStep(this.store, withRef, { status: state.status });
          await publishStepEvent(this.eventContext(), `step.${state.status}`, run, updated);
          return;
        }
        await this.markStepBlocked(run, project, withRef, state);
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
        error: undefined,
        blockedSince: undefined
      });
      await publishStepEvent(this.eventContext(), "step.succeeded", run, updated);
      return;
    }
    if (state.status === "cancelled") {
      const updated = await transitionStep(this.store, step, {
        status: "cancelled",
        finishedAt,
        output: state.output,
        error: state.error,
        blockedSince: undefined
      });
      await publishStepEvent(this.eventContext(), "step.cancelled", run, updated);
      return;
    }
    await this.handleStepFailure(run, step, state.error || "Step failed", state.output);
  }

  private defaultQualityGate(step: Step): QualityGate | undefined {
    // "check" steps historically failed outright whenever a command failed
    // (see CheckExecutor.inspect). That executor now always reports
    // "succeeded" and defers pass/fail to the quality gate instead, so a
    // check step without an explicit gate gets this default to preserve
    // that observed behavior instead of silently succeeding on failed checks.
    if (step.executor === "check") return { evaluators: [{ type: "check" }], onFail: "fail" };
    return undefined;
  }

  private async applyQualityGate(run: Run, step: Step, state: ExecutionState): Promise<"passed" | "failed" | "waiting_approval"> {
    const gate = step.qualityGate || this.defaultQualityGate(step);
    if (!gate?.evaluators?.length) return "passed";
    const [evidence, artifacts] = await Promise.all([
      this.store.listEvidence(run.id, step.id),
      this.store.listArtifacts(run.id, step.id)
    ]);
    const evaluations: Evaluation[] = [];
    for (const definition of gate.evaluators) {
      let evaluationInput: Partial<Evaluation> & Pick<Evaluation, "runId" | "evaluator" | "status">;
      try {
        const result = await this.evaluators.get(definition.type).evaluate({
          definition,
          step,
          output: state.output,
          evidence,
          artifacts
        });
        evaluationInput = { ...result, runId: run.id, stepId: step.id, attempt: step.attempt };
      } catch (error) {
        evaluationInput = {
          runId: run.id,
          stepId: step.id,
          attempt: step.attempt,
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
      const decision = await this.createGateDecision(run, step, "passed", evaluations, "system", "All evaluations passed");
      await publishStepEvent(this.eventContext(), "quality_gate.passed", run, step, { evaluations: evaluations.map((item) => item.id), decisionId: decision.id });
      return "passed";
    }
    const reason = evaluations.find((evaluation) => evaluation.status !== "passed")?.reason || "Quality gate failed";
    const failedDecision = await this.createGateDecision(run, step, "failed", evaluations, "system", reason);
    if (gate.onFail === "wait_approval") {
      const updated = await transitionStep(this.store, step, {
        status: "waiting_approval",
        output: {
          ...(state.output || {}),
          qualityGate: { status: "waiting_approval", reason, evaluations: evaluations.map((item) => item.id), decisionId: failedDecision.id }
        },
        executionRef: state.executionRef || step.executionRef,
        error: reason
      });
      await publishStepEvent(this.eventContext(), "quality_gate.waiting_approval", run, updated, { reason, decisionId: failedDecision.id });
      await publishStepEvent(this.eventContext(), "step.waiting_approval", run, updated);
      return "waiting_approval";
    }
    await publishStepEvent(this.eventContext(), "quality_gate.failed", run, step, { reason, decisionId: failedDecision.id });
    await this.handleStepFailure(run, step, reason, {
      ...(state.output || {}),
      qualityGate: { status: "failed", reason, evaluations: evaluations.map((item) => item.id), decisionId: failedDecision.id }
    });
    return "failed";
  }

  private async createGateDecision(run: Run, step: Step, status: QualityGateDecision["status"], evaluations: Evaluation[], decidedBy: QualityGateDecision["decidedBy"], reason?: string) {
    const decision = await this.store.createQualityGateDecision({
      runId: run.id,
      stepId: step.id,
      attempt: step.attempt,
      status,
      evaluationIds: evaluations.map((item) => item.id),
      reason,
      decidedBy
    });
    await publishStepEvent(this.eventContext(), "quality_gate.decision", run, step, {
      decisionId: decision.id,
      decisionStatus: decision.status,
      decidedBy: decision.decidedBy,
      evaluationIds: decision.evaluationIds
    });
    return decision;
  }

  private async handleStepFailure(run: Run, step: Step, error: string, output?: Record<string, unknown>, blockedQuestion?: string) {
    const cleanOutput = this.withoutStalledMarker(output);
    if (step.attempt < step.maxAttempts) {
      const retrying = await transitionStep(this.store, step, {
        status: "pending",
        error,
        output: cleanOutput,
        input: blockedQuestion ? this.enrichRetryInput(step, blockedQuestion) : step.input,
        executionRef: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        blockedSince: undefined
      });
      await publishStepEvent(this.eventContext(), "step.retrying", run, retrying, { error });
      return;
    }
    const updated = await transitionStep(this.store, step, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      output: cleanOutput,
      error,
      blockedSince: undefined
    });
    await publishStepEvent(this.eventContext(), "step.failed", run, updated, { error });
  }

  /**
   * When a step is retried after being blocked on a clarifying question,
   * append an instruction to stop it from asking again. The original prompt
   * in step.input.prompt is left untouched; the enriched version is stored
   * separately so the UI can show both and the executor can prefer it.
   */
  private enrichRetryInput(step: Step, question: string): Record<string, unknown> {
    const prompt = String(step.input?.prompt ?? "").trim();
    if (!prompt) return step.input;
    const enrichment = `\n\nPrevious attempt stopped to ask: "${question}". Do not ask again — choose the most reasonable option, state the assumption in your final summary, and proceed.`;
    return { ...step.input, effectivePrompt: `${prompt}${enrichment}` };
  }

  async approveStep(runId: string, stepId: string): Promise<{ run: Run; step: Step }> {
    const run = await this.requireRun(runId);
    const step = await this.requireStep(run.id, stepId);
    if (step.status !== "waiting_approval") throw new Error(`Step is not waiting approval: ${step.status}`);
    const gate = step.output?.qualityGate as { evaluations?: string[]; reason?: string } | undefined;
    if (gate?.evaluations?.length) {
      await this.store.createQualityGateDecision({
        runId: run.id,
        stepId: step.id,
        attempt: step.attempt,
        status: "overridden",
        evaluationIds: gate.evaluations,
        reason: gate.reason || "Operator approved failed quality gate",
        decidedBy: "operator"
      });
    }
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
    const gate = step.output?.qualityGate as { evaluations?: string[] } | undefined;
    if (gate?.evaluations?.length) {
      await this.store.createQualityGateDecision({
        runId: run.id,
        stepId: step.id,
        attempt: step.attempt,
        status: "failed",
        evaluationIds: gate.evaluations,
        reason,
        decidedBy: "operator"
      });
    }
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

  /**
   * Answers a step blocked on an agent clarification prompt without opening
   * its tmux session: types the operator's (or an LLM's, via the REST
   * caller) text into the session and clears the block so the next poll
   * picks the step back up. Distinct from approveStep/rejectStep, which
   * resolve the dedicated "approval" executor and quality-gate waits.
   */
  async answerStep(runId: string, stepId: string, text: string): Promise<{ run: Run; step: Step }> {
    const run = await this.requireRun(runId);
    const step = await this.requireStep(run.id, stepId);
    if (step.executor === "approval") throw new Error("Use approve/reject for a dedicated approval step");
    if (this.isQualityGateWaiting(step)) throw new Error("Use approve/reject for a quality-gate wait_approval step");
    if (step.status !== "waiting_input" && step.status !== "waiting_approval") {
      throw new Error(`Step is not waiting for input: ${step.status}`);
    }
    const sessionId = (step.executionRef?.sessionId ?? step.output?.sessionId) as string | undefined;
    const session = sessionId ? await this.store.getSession(sessionId) : undefined;
    if (!session) throw new Error("Blocked step has no linked session to answer");

    await this.tmux.sendInput(session.tmuxSessionName, text);
    const updated = await transitionStep(this.store, step, {
      status: "running",
      blockedSince: undefined,
      output: this.withoutStalledMarker(step.output)
    });
    await publishStepEvent(this.eventContext(), "step.answered", run, updated, { text });
    await publishStepEvent(this.eventContext(), "step.running", run, updated);
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
