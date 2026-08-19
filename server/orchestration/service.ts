import type { EventBus } from "../events.js";
import { createDefaultEvaluatorRegistry, type EvaluatorRegistry } from "../evaluators/registry.js";
import { createDefaultExecutorRegistry } from "../executors/index.js";
import type { ExecutorRegistry } from "../executors/registry.js";
import { ConfigError, type ExecutionState, type StepExecutionContext } from "../executors/types.js";
import type { SessionSummaryClient } from "../session-helpers.js";
import type { Artifact, ContractLevel, Evaluation, Evidence, OnBlockedAction, OnBlockedPolicy, Project, QualityGate, QualityGateDecision, ResolvedOnBlockedPolicy, Run, Step, StepFailureKind, Store, VerificationSummary } from "../types.js";
import type { TmuxManager } from "../tmux.js";
import type { runCommandSafe } from "../utils.js";
import type { WorktreeManager } from "../worktrees.js";
import { generateAutoAnswer } from "./auto-answer.js";
import { blockedStepsAfterFailure, readySteps, type StepDefinition, validateContractLevel, validateStepGraph } from "./dag.js";
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

// #70: the resolved default action depends on whether anyone is actually
// watching the step (see resolveOnBlocked below) - these are the shared
// defaults for everything else in the policy.
const DEFAULT_ON_BLOCKED_SHARED: Omit<ResolvedOnBlockedPolicy, "action"> = {
  timeoutMs: 30 * 60_000,
  onTimeout: "auto_retry",
  maxAutoAnswers: 2
};

const DEFAULT_STALLED_THRESHOLD_MS = 20 * 60_000;

// Preserves validateStepContracts' original unconditional behavior (#51) for
// any run/recipe that doesn't declare a level.
const DEFAULT_CONTRACT_LEVEL: ContractLevel = "L1";

export type CreateRunInput = {
  projectId: string;
  goal: string;
  steps: StepDefinition[];
  contractLevel?: ContractLevel;
  /** id of the Recipe this run was created from, if any - see evals/metrics.ts. */
  recipeId?: string;
  /** Concurrency ceiling for this run's steps - see Run.maxParallel (#78). */
  maxParallel?: number;
};

/** Step statuses that occupy one of the run's maxParallel "slots" (#78) - ready to start or already active, not yet terminal. */
const ACTIVE_STEP_STATUSES = new Set<Step["status"]>(["ready", "running", "waiting_input", "waiting_approval"]);

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
  private scheduling = new Map<string, Promise<void>>();

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

  /**
   * Validates a run's step graph and preflight-checks each step's resolved
   * configuration without persisting anything - shared by createRun and by
   * the recipe preview route, so a recipe's wizard preview can reject a
   * statically-unrunnable run (e.g. a check step with no commands) before
   * the operator ever reaches the submit button.
   */
  async preflightRun(input: CreateRunInput): Promise<Project> {
    const project = await this.store.getProject(input.projectId);
    if (!project) throw new Error("Project not found");
    validateStepGraph(input.steps, this.executors);
    validateContractLevel(input.contractLevel || DEFAULT_CONTRACT_LEVEL, input.steps, this.executors);
    this.validateQualityGateEvaluators(input.steps);
    await this.runPreflightChecks(input.steps, project);
    return project;
  }

  async createRun(input: CreateRunInput): Promise<{ run: Run; steps: Step[] }> {
    const project = await this.preflightRun(input);
    const run = await this.store.createRun({
      projectId: project.id,
      goal: input.goal,
      status: "pending",
      contractLevel: input.contractLevel || DEFAULT_CONTRACT_LEVEL,
      recipeId: input.recipeId,
      maxParallel: input.maxParallel
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
        onBlocked: definition.onBlocked,
        produces: definition.produces,
        consumes: definition.consumes
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

  /**
   * Rejects a run before any Step/Run records are created if a step is
   * statically unrunnable given its resolved configuration - e.g. a "check"
   * step with no commands, or an "agent-task" step whose agent CLI
   * doctor-style detection can't find. Delegates to each executor's optional
   * preflight() so the check lives with the executor that knows what
   * "runnable" means for it; executors without one are skipped.
   */
  private async runPreflightChecks(steps: StepDefinition[], project: Project) {
    for (const step of steps) {
      const executor = this.executors.get(step.executor);
      if (!executor.preflight) continue;
      try {
        await executor.preflight({ project, step: { id: step.id, input: step.input }, runCommand: this.runCommand });
      } catch (error) {
        throw new Error((error as Error).message || `Step ${step.id} failed preflight validation`);
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
    // A caller (e.g. createRun) that finds scheduling already in flight for
    // this run - typically the background poller having won a race to start
    // it first - must wait for that pass to finish rather than no-op and
    // immediately read back a state mid-transition (e.g. a run briefly
    // "running" before the same pass marks it "waiting_approval").
    const inFlight = this.scheduling.get(runId);
    if (inFlight) return inFlight;
    const promise = this.scheduleLoop(runId).finally(() => {
      this.scheduling.delete(runId);
    });
    this.scheduling.set(runId, promise);
    return promise;
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

  /**
   * #70: an agent-task step defaults to "autonomous" (see agent-task.ts) -
   * nobody is watching its terminal - so the default policy is to mark it
   * blocked immediately rather than sit in wait_approval hoping a human
   * shows up. A step explicitly opted into interaction: "interactive" keeps
   * the original wait_approval default, since a human genuinely is expected
   * there. Either default is still overridden by whatever the step/recipe
   * declares in onBlocked.
   */
  private defaultOnBlockedAction(step: Step): OnBlockedAction {
    return step.input?.interaction === "interactive" ? "wait_approval" : "mark_blocked";
  }

  private resolveOnBlocked(step: Step): ResolvedOnBlockedPolicy {
    return { ...DEFAULT_ON_BLOCKED_SHARED, action: this.defaultOnBlockedAction(step), ...(step.onBlocked || {}) };
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
        // The event log above is capacity-pruned (see SQLiteStore.appendEvent),
        // so it can't be relied on to compute the "blocked-step rate" eval
        // metric (#54) after the fact - especially for the wait_approval path,
        // where a human answering via answerStep() leaves no other durable
        // trace once the step unblocks. Evidence has no such cap.
        await this.store.createEvidence({
          runId: run.id,
          stepId: updated.id,
          attempt: updated.attempt,
          kind: "step.blocked",
          claim: question || "Agent stopped to ask a clarifying question",
          source: "orchestrator",
          value: { action: policy.action, timeoutMs: policy.timeoutMs, sessionId }
        });
      }
      current = updated;
      changed = true;
    }

    if (policy.action === "mark_blocked") {
      await this.handleStepFailure(
        run, current, `Agent requested clarification: ${question || "no question captured"}`, current.output, question, "execution_failed", "blocked", true
      );
      return true;
    }

    if (policy.action === "auto_retry") {
      await this.handleStepFailure(run, current, `Agent requested clarification: ${question || "no question captured"}`, current.output, question, "execution_failed", "blocked");
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
    await this.handleStepFailure(run, current, `Blocked step timed out after ${Math.round(policy.timeoutMs / 60000)}m waiting for input`, current.output, question, "execution_failed", "blocked");
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
        error: "Skipped because an upstream dependency failed or was blocked"
      });
      await publishStepEvent(this.eventContext(), "step.skipped", run, updated);
      changed = true;
    }
    return changed;
  }

  /**
   * How many more steps this run may promote to "ready" right now, given
   * its maxParallel ceiling (#78) and how many steps already occupy a slot
   * (ready/running/waiting_input/waiting_approval). Undefined/<=0
   * maxParallel means no ceiling, preserving the original
   * unlimited-parallelism behavior.
   */
  private remainingParallelCapacity(run: Run, steps: Step[]): number | undefined {
    if (!run.maxParallel || run.maxParallel <= 0) return undefined;
    const active = steps.filter((step) => ACTIVE_STEP_STATUSES.has(step.status)).length;
    return Math.max(0, run.maxParallel - active);
  }

  private async markReadySteps(run: Run, steps: Step[]) {
    let changed = false;
    for (const step of readySteps(steps, this.remainingParallelCapacity(run, steps))) {
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
      failureKind: undefined,
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
      const failureKind: StepFailureKind = error instanceof ConfigError ? "config_error" : "execution_failed";
      await this.handleStepFailure(run, started, (error as Error).message || "Step failed", undefined, undefined, failureKind);
    }
  }

  private async completeStepFromState(run: Run, step: Step, state: ExecutionState) {
    const finishedAt = new Date().toISOString();
    if (state.status === "succeeded") {
      const contractViolation = await this.checkStepContract(run, step);
      if (contractViolation) {
        await this.handleStepFailure(run, step, contractViolation, state.output, undefined, "contract_violation");
        return;
      }
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

  /**
   * StepContract runtime enforcement: a step that declares `produces` types
   * must actually have created an artifact tagged with each one for the
   * current attempt by the time it reports success - fail-fast with correct
   * attribution to the *producing* step, rather than letting a downstream
   * `consumes` step discover the gap later. Returns a failure message, or
   * null if the step declares nothing or satisfied everything it declared.
   */
  private async checkStepContract(run: Run, step: Step): Promise<string | null> {
    const declared = step.produces || [];
    if (!declared.length) return null;
    const artifacts = await this.store.listArtifacts(run.id, step.id);
    const produced = new Set(
      artifacts.filter((artifact) => artifact.attempt === step.attempt && artifact.artifactType).map((artifact) => artifact.artifactType)
    );
    const missing = declared.filter((type) => !produced.has(type));
    if (!missing.length) return null;
    return `Step "${step.id}" declares produces [${declared.join(", ")}] but did not produce: ${missing.join(", ")}`;
  }

  // Delegates to the step's executor for its static default gate (e.g.
  // CheckExecutor.impliedQualityGate) instead of hardcoding by executor
  // type here - single source of truth shared with contract level L2 lint
  // (validateContractLevel in orchestration/dag.ts).
  private defaultQualityGate(step: Step): QualityGate | undefined {
    return this.executors.has(step.executor) ? this.executors.get(step.executor).impliedQualityGate : undefined;
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
    }, undefined, "verification_failed");
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

  /**
   * @param terminalStatus "blocked" (default "failed") when the step never
   * got a chance to succeed or fail on its own merits - the onBlocked policy
   * gave up on an unresolved clarification prompt or a stalled session, once
   * retries are exhausted. failureKind is meaningless in that case (there's
   * no execution/verification outcome to classify) so it's dropped. See the
   * StepStatus "blocked" doc comment (#69).
   * @param skipRetry #70's "mark_blocked" policy: go straight to
   * `terminalStatus` even if attempts remain, instead of the usual
   * auto-retry-while-attempts-remain behavior below - the point of
   * mark_blocked is to stop and wait for a human/script to look at it
   * (or retry it explicitly via retryStep), not to keep guessing.
   */
  private async handleStepFailure(
    run: Run,
    step: Step,
    error: string,
    output?: Record<string, unknown>,
    blockedQuestion?: string,
    failureKind: StepFailureKind = "execution_failed",
    terminalStatus: "failed" | "blocked" = "failed",
    skipRetry = false
  ) {
    const cleanOutput = this.withoutStalledMarker(output);
    if (!skipRetry && step.attempt < step.maxAttempts) {
      const retrying = await transitionStep(this.store, step, {
        status: "pending",
        error,
        output: cleanOutput,
        input: blockedQuestion ? this.enrichRetryInput(step, blockedQuestion) : step.input,
        executionRef: undefined,
        startedAt: undefined,
        finishedAt: undefined,
        blockedSince: undefined,
        failureKind: undefined
      });
      await publishStepEvent(this.eventContext(), "step.retrying", run, retrying, { error });
      return;
    }
    const resolvedFailureKind = terminalStatus === "blocked" ? undefined : failureKind;
    const updated = await transitionStep(this.store, step, {
      status: terminalStatus,
      finishedAt: new Date().toISOString(),
      output: cleanOutput,
      error,
      blockedSince: undefined,
      failureKind: resolvedFailureKind
    });
    await publishStepEvent(this.eventContext(), `step.${terminalStatus}`, run, updated, { error, failureKind: resolvedFailureKind });
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
      error: reason,
      failureKind: "verification_failed"
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

  /**
   * Manually resumes a step terminated "blocked" (#69/#70) - most notably
   * one that hit the "mark_blocked" onBlocked policy, which deliberately
   * never retries itself (see handleStepFailure's skipRetry) so an
   * operator/script decides instead. Resets the step to "pending" for the
   * next scheduling pass and un-terminals the run if it was "blocked" only
   * because of this step, so scheduleRun can act on it again.
   */
  async retryStep(runId: string, stepId: string): Promise<{ run: Run; step: Step }> {
    const run = await this.requireRun(runId);
    const step = await this.requireStep(run.id, stepId);
    if (step.status !== "blocked") throw new Error(`Step is not blocked: ${step.status}`);
    const retried = await transitionStep(this.store, step, {
      status: "pending",
      error: undefined,
      output: this.withoutStalledMarker(step.output),
      executionRef: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      blockedSince: undefined
    });
    await publishStepEvent(this.eventContext(), "step.retrying", run, retried, { manual: true });
    if (run.status === "blocked") {
      const resumed = await transitionRun(this.store, run, { status: "running", finishedAt: undefined });
      await publishRunEvent(this.eventContext(), "run.running", resumed);
    }
    await this.scheduleRun(run.id);
    return { run: (await this.store.getRun(run.id)) || run, step: retried };
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
    if (next === "succeeded" || next === "failed" || next === "blocked") updates.finishedAt = new Date().toISOString();
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
