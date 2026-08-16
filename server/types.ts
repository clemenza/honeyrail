export type SessionStatus =
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "idle"
  | "stale"
  | "failed"
  | "killed"
  | "completed";

export type WorktreeStatus =
  | "created"
  | "committed"
  | "checks_passed"
  | "checks_failed"
  | "merged"
  | "discarded"
  | "failed";

export type TaskStatus =
  | "worktree_preparing"
  | "agent_running"
  | "ready_to_merge"
  | "checks_failed"
  | "done"
  | "failed"
  | "cancelled"
  | "merged";

export type AgentType = "shell" | "codex" | "claude" | "hermes";

export type RunStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

/**
 * Distinguishes *why* a step is in status "failed": a config error means the
 * step could never have succeeded as configured (e.g. no check commands, an
 * agent CLI that isn't installed) as opposed to execution_failed (the step
 * ran but its process/executor reported failure), verification_failed (the
 * step's own work completed but its quality gate rejected the result), or
 * contract_violation (the step succeeded but omitted an artifact its recipe
 * declared it `produces` - see StepContract validation in orchestration/dag.ts).
 */
export type StepFailureKind = "config_error" | "execution_failed" | "verification_failed" | "contract_violation";

/**
 * Closed vocabulary of artifact types with dataflow-lint semantics for
 * StepContract `produces`/`consumes` declarations. A step may also declare a
 * custom string type outside this list; it's still checked for dataflow
 * satisfiability, just has no dedicated auto-harvest behind it.
 */
export const KNOWN_ARTIFACT_TYPES = ["diff", "changed_files", "test_files", "test_command", "report", "manifest"] as const;

export type CheckRun = {
  command: string;
  status: "passed" | "failed";
  exitCode?: number | string;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
};

export type ArtifactKind = "file" | "directory" | "text" | "json" | "log";

export type Artifact = {
  id: string;
  runId: string;
  stepId?: string;
  attempt?: number;
  kind: ArtifactKind;
  name: string;
  uri?: string;
  path?: string;
  mediaType?: string;
  /** StepContract dataflow type (e.g. "diff", "changed_files") this artifact satisfies, if any. See KNOWN_ARTIFACT_TYPES. */
  artifactType?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type Evidence = {
  id: string;
  runId: string;
  stepId?: string;
  attempt?: number;
  kind: string;
  claim?: string;
  value?: unknown;
  source?: string;
  artifactIds?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type EvaluationStatus = "passed" | "failed" | "error";

export type Evaluation = {
  id: string;
  runId: string;
  stepId?: string;
  attempt?: number;
  evaluator: string;
  status: EvaluationStatus;
  score?: number;
  threshold?: number;
  reason?: string;
  evidenceIds?: string[];
  artifactIds?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type EvaluationOperator = "==" | "!=" | ">" | ">=" | "<" | "<=";

export type EvaluatorDefinition = {
  id?: string;
  type: string;
  source?: string;
  expected?: boolean | string | number;
  operator?: EvaluationOperator;
  threshold?: number;
  reason?: string;
};

export type QualityGate = {
  evaluators: EvaluatorDefinition[];
  onFail?: "fail" | "wait_approval";
};

export type OnBlockedAction = "wait_approval" | "auto_answer" | "fail";
export type OnBlockedTimeoutAction = "auto_answer" | "fail";

export type OnBlockedPolicy = {
  action?: OnBlockedAction;
  timeoutMs?: number;
  onTimeout?: OnBlockedTimeoutAction;
  maxAutoAnswers?: number;
};

export type ResolvedOnBlockedPolicy = Required<OnBlockedPolicy>;

export type QualityGateDecisionStatus = "passed" | "failed" | "overridden";

export type QualityGateDecision = {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  status: QualityGateDecisionStatus;
  evaluationIds: string[];
  reason?: string;
  decidedBy: "system" | "operator";
  createdAt: string;
};

export type VerificationSummary = {
  artifacts: number;
  evidence: number;
  latestAttempt?: number;
  evaluations: {
    passed: number;
    failed: number;
    error: number;
  };
};

export type Project = {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  defaultAgent: AgentType;
  testCommands: string[];
  runCommands: string[];
};

/**
 * StepContract strictness profile for a run, from lightest to strictest:
 * L0 execution only (no contract enforcement); L1 artifact dataflow
 * contracts enforced (validateStepContracts); L2 = L1 + every "verifying"
 * step (executor "check", or one that declares `consumes`) needs an
 * evaluator, explicit or implied by its executor; L3 = L2 + at least one
 * dedicated "approval" step. See validateContractLevel in orchestration/dag.ts.
 * Defaults to "L1" when a run/recipe doesn't declare one, preserving the
 * StepContract dataflow lint's original unconditional behavior.
 */
export type ContractLevel = "L0" | "L1" | "L2" | "L3";

export type Run = {
  id: string;
  projectId: string;
  goal: string;
  status: RunStatus;
  /** Recorded for filtering/eval segmentation - see ContractLevel. */
  contractLevel?: ContractLevel;
  /** id of the Recipe this run was created from, if any - for eval metrics filtering (see evals/metrics.ts). */
  recipeId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  error?: string;
};

export type Step = {
  id: string;
  runId: string;
  name: string;
  executor: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  status: StepStatus;
  attempt: number;
  maxAttempts: number;
  qualityGate?: QualityGate;
  onBlocked?: OnBlockedPolicy;
  blockedSince?: string;
  /** Artifact types this step's recipe declares it produces, beyond what its executor auto-harvests. Checked at run creation (StepContract lint) and at step completion (contract_violation on omission). */
  produces?: string[];
  /** Artifact types this step's recipe declares it needs from an upstream step. Checked at run creation (StepContract lint); satisfiability is by dependsOn ancestry. */
  consumes?: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  executionRef?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  failureKind?: StepFailureKind;
};

export type Session = {
  id: string;
  projectId: string | null;
  worktreeId?: string | null;
  taskId?: string | null;
  name: string;
  agent: AgentType;
  model?: string | null;
  prompt?: string;
  tmuxSessionName: string;
  cwd: string;
  logPath?: string;
  status: SessionStatus;
  createdAt: string;
  lastOutputAt?: string;
  lastHealthCheckAt?: string;
  error?: string;
  summary?: SessionSummary | null;
  summaryUpdatedAt?: string;
};

export type SessionSummary = {
  text: string;
  model: string;
  generatedAt: string;
};

export type Task = {
  id: string;
  projectId: string;
  worktreeId?: string;
  sessionId?: string;
  title: string;
  prompt?: string;
  agent: AgentType;
  status: TaskStatus;
  createdAt: string;
  failedAt?: string;
  committedAt?: string;
  cancelledAt?: string;
  mergedAt?: string;
  checkedAt?: string;
  headRevision?: string;
  error?: string;
  checkRuns?: CheckRun[];
};

export type Worktree = {
  id: string;
  projectId: string;
  taskId?: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseRevision: string;
  title: string;
  agent: AgentType;
  status: WorktreeStatus;
  createdAt: string;
  committedAt?: string;
  checkedAt?: string;
  mergedAt?: string;
  discardedAt?: string;
  failedAt?: string;
  headRevision?: string;
  error?: string;
  checkRuns?: CheckRun[];
  commit?: Record<string, unknown>;
  merge?: Record<string, unknown>;
  discard?: Record<string, unknown>;
};

export type GatewayEvent = {
  id: string;
  type: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type EventInput = Omit<GatewayEvent, "id" | "createdAt" | "payload"> & {
  id?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
};

export interface Store {
  getSettings(): Promise<Record<string, unknown>>;
  updateSettings(updates: Record<string, unknown>): Promise<Record<string, unknown>>;

  listProjects(): Promise<Project[]>;
  createProject(input: Partial<Project> & Pick<Project, "name" | "repoPath">): Promise<Project>;
  getProject(id: string): Promise<Project | undefined>;
  deleteProject(id: string): Promise<Project | null>;

  listRuns(projectId?: string): Promise<Run[]>;
  createRun(input: Partial<Run> & Pick<Run, "projectId" | "goal">): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  updateRun(id: string, updates: Partial<Run>): Promise<Run | undefined>;
  createStep(input: Partial<Step> & Pick<Step, "id" | "runId" | "name" | "executor">): Promise<Step>;
  listSteps(runId: string): Promise<Step[]>;
  getStep(runId: string, stepId: string): Promise<Step | undefined>;
  updateStep(runId: string, stepId: string, updates: Partial<Step>): Promise<Step | undefined>;

  createArtifact(input: Partial<Artifact> & Pick<Artifact, "runId" | "kind" | "name">): Promise<Artifact>;
  listArtifacts(runId: string, stepId?: string): Promise<Artifact[]>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  createEvidence(input: Partial<Evidence> & Pick<Evidence, "runId" | "kind">): Promise<Evidence>;
  listEvidence(runId: string, stepId?: string): Promise<Evidence[]>;
  createEvaluation(input: Partial<Evaluation> & Pick<Evaluation, "runId" | "evaluator" | "status">): Promise<Evaluation>;
  listEvaluations(runId: string, stepId?: string): Promise<Evaluation[]>;
  createQualityGateDecision(input: Partial<QualityGateDecision> & Pick<QualityGateDecision, "runId" | "stepId" | "attempt" | "status" | "evaluationIds" | "decidedBy">): Promise<QualityGateDecision>;
  listQualityGateDecisions(runId: string, stepId?: string): Promise<QualityGateDecision[]>;

  listSessions(): Promise<Session[]>;
  createSession(input: Partial<Session> & { id?: string }): Promise<Session>;
  getSession(id: string): Promise<Session | undefined>;
  updateSession(id: string, updates: Partial<Session>): Promise<Session | undefined>;
  deleteSession(id: string): Promise<Session | null>;

  listTasks(): Promise<Task[]>;
  createTask(input: Partial<Task> & { id?: string }): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  updateTask(id: string, updates: Partial<Task>): Promise<Task | undefined>;

  listWorktrees(projectId?: string): Promise<Worktree[]>;
  createWorktree(input: Partial<Worktree> & { id?: string; project_id?: string }): Promise<Worktree>;
  getWorktree(id: string): Promise<Worktree | undefined>;
  updateWorktree(id: string, updates: Partial<Worktree>): Promise<Worktree | undefined>;

  appendEvent(input: EventInput): Promise<GatewayEvent>;
  listEvents(limit?: number): Promise<GatewayEvent[]>;
}
