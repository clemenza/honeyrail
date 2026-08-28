export type ViewId = "dashboard" | "projects" | "sessions" | "worktrees" | "runs" | "approvals" | "evals";

export type ProjectData = {
  id: string;
  name: string;
  repoPath: string;
  defaultAgent: string;
  defaultBranch: string;
  git?: { branch: string; dirtyFiles: number | null; status: string; remoteUrl: string };
};

export type SessionData = {
  id: string;
  projectId: string | null;
  worktreeId?: string | null;
  name: string;
  agent: string;
  model?: string | null;
  prompt?: string;
  tmuxSessionName: string;
  cwd: string;
  status: string;
  createdAt: string;
  error?: string;
  summary?: { text: string; model: string; generatedAt: string } | null;
};

export type TaskData = {
  id: string;
  projectId: string;
  worktreeId?: string;
  sessionId?: string;
  title: string;
  agent: string;
  status: string;
  error?: string;
};

export type WorktreeData = {
  id: string;
  projectId: string;
  taskId?: string;
  path: string;
  branch: string;
  title?: string;
  agent?: string;
  status: string;
  error?: string;
};

export type OnBlockedPolicyData = {
  action?: "mark_blocked" | "auto_retry" | "auto_answer" | "wait_approval";
  timeoutMs?: number;
  onTimeout?: "auto_answer" | "auto_retry";
  maxAutoAnswers?: number;
};

export type StepData = {
  id: string;
  runId: string;
  name: string;
  executor: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  status: string;
  attempt: number;
  maxAttempts: number;
  qualityGate?: {
    evaluators: Array<Record<string, unknown>>;
    onFail?: string;
  };
  onBlocked?: OnBlockedPolicyData;
  blockedSince?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  executionRef?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  failureKind?: "config_error" | "execution_failed" | "verification_failed";
  verification?: VerificationData;
};

export type ArtifactData = {
  id: string;
  runId: string;
  stepId?: string;
  attempt?: number;
  kind: string;
  name: string;
  uri?: string;
  path?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type EvidenceData = {
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

export type EvaluationData = {
  id: string;
  runId: string;
  stepId?: string;
  attempt?: number;
  evaluator: string;
  status: string;
  score?: number;
  threshold?: number;
  reason?: string;
  evidenceIds?: string[];
  artifactIds?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type QualityGateDecisionData = {
  id: string;
  runId: string;
  stepId: string;
  attempt: number;
  status: string;
  evaluationIds: string[];
  reason?: string;
  decidedBy: string;
  createdAt: string;
};

export type VerificationData = {
  artifacts: number;
  evidence: number;
  latestAttempt?: number;
  evaluations: {
    passed: number;
    failed: number;
    error: number;
  };
  artifactItems?: ArtifactData[];
  evidenceItems?: EvidenceData[];
  evaluationItems?: EvaluationData[];
  gateDecisionItems?: QualityGateDecisionData[];
};

export type RunData = {
  id: string;
  projectId: string;
  goal: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelledAt?: string;
  error?: string;
  steps: StepData[];
  verification?: VerificationData;
  gateDecisions?: QualityGateDecisionData[];
};

export type EventAttachment = {
  id?: string;
  fileName?: string;
  name?: string;
  type?: string;
  size?: number;
  url?: string;
  thumbnailDataUrl?: string;
};

export type EventPayload = {
  preview?: string;
  attachments?: EventAttachment[];
  [key: string]: unknown;
};

export type EventData = {
  id: string;
  type: string;
  sessionId?: string;
  createdAt: string;
  payload?: EventPayload;
};

export type GatewayState = {
  projects: ProjectData[];
  sessions: SessionData[];
  tasks: TaskData[];
  worktrees: WorktreeData[];
  runs: RunData[];
  events: EventData[];
  tmuxSessions: unknown[];
};

export type HealthData = {
  ok: boolean;
  tmux: string;
  agents: { codex: boolean; claude: boolean; hermes: boolean };
};

export type AuthUser = { username: string; permissions: string[] };

export type ImageAttachmentLocal = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

export type DiffData = {
  diff: string;
  diffStat: string;
  status: string;
  commits: string;
};

export type AppRoute =
  | { kind: "session"; sessionId: string }
  | { kind: "management"; view: string };

export type SummaryBlock =
  | { type: "heading"; text: string }
  | { type: "section"; title: string; text: string }
  | { type: "list"; items: string[] }
  | { type: "paragraph"; text: string };

export type SummaryData = { text: string; model: string; generatedAt: string };

export type DirectoryListing = {
  path: string;
  parentPath: string | null;
  roots: Array<{ label: string; path: string }>;
  directories: Array<{ name: string; path: string }>;
  isGitRepo: boolean;
};

export type WorktreeItem = {
  id: string;
  taskId?: string;
  title?: string;
  agent?: string;
  status?: string;
  branch?: string;
  path?: string;
  projectId?: string;
  error?: string;
};

export type RecipeParameterType = "string" | "number" | "boolean" | "enum";

export type RecipeParameterData = {
  key: string;
  label: string;
  type: RecipeParameterType;
  default?: unknown;
  required?: boolean;
  options?: string[];
};

export type RecipeSummaryData = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  parameters: RecipeParameterData[];
  // #109: true for a recipe class (e.g. dsh-testengineer-trial, #103) whose
  // only safe launch path is a dedicated isolated driver script, never a
  // HoneyRail run sharing a real project's repo filesystem with the agent.
  launchDisabled?: boolean;
  launchDisabledReason?: string;
};

export type RecipeDetailData = RecipeSummaryData & { steps: unknown[] };

// A materialized-but-not-yet-created step, as returned by POST /api/recipes/:id/preview.
// Deliberately looser than StepData (no runId/status/attempt/createdAt - it doesn't exist as a run yet).
export type RecipePreviewStepData = {
  id: string;
  name?: string;
  executor: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  maxAttempts?: number;
  qualityGate?: { evaluators: Array<Record<string, unknown>>; onFail?: string };
};

export type RecipePreviewData = {
  projectId: string;
  goal: string;
  steps: RecipePreviewStepData[];
};

export type RateStatData = { satisfied: number; total: number; rate: number | null };

export type EvalMetricsFilterData = {
  projectId?: string;
  recipeId?: string;
  contractLevel?: "L0" | "L1" | "L2" | "L3";
  promptVersion?: string;
};

export type EvalMetricsData = {
  filter: EvalMetricsFilterData;
  runCount: number;
  contractCompliance: RateStatData;
  manifestEmission: RateStatData;
  verifyRunnable: RateStatData;
  qualityGatePass: RateStatData;
  humanOverride: RateStatData;
  blockedStep: RateStatData;
};

// #118: read-only view onto a scripts/dsh-evals-demo.ts (#93) --out
// directory - never a HoneyRail run (#103/#109), so these mirror
// server/evals/dsh-report.ts's own types/summaries rather than RunData.
export type DshTrialOutcomeData = "passed" | "task_failed" | "verify_failed" | "invalidated" | "blocked" | "driver_error";

export type DshTranscriptAuditHitData = { pattern: string; excerpt: string; confidence: "high" | "low" };

export type DshTrialRecordData = {
  fixture: string;
  profile: string;
  trial: number;
  trialId: string;
  artifactsDir: string;
  killed: boolean | null;
  falseAlarms: number | null;
  contractOk: boolean | null;
  integrityOk: boolean;
  transcriptAuditHits: DshTranscriptAuditHitData[];
  killRate: number | null;
  killedByKind: { assertion: number; invariant: number } | null;
  blockedReason?: string;
  wallTimeMs?: number;
  error?: string;
  outcome: DshTrialOutcomeData;
};

export type DshProfileSummaryData = {
  profile: string;
  trials: number;
  passed: number;
  taskFailed: number;
  verifyFailed: number;
  invalidated: number;
  blocked: number;
  driverError: number;
  passRate: number | null;
  meanWallTimeMs: number | null;
};

export type DshFixtureCellSummaryData = {
  fixture: string;
  profile: string;
  trials: number;
  killRate: number | null;
  falseAlarmRate: number | null;
  contractComplianceRate: number | null;
  medianWallTimeMs: number | null;
  meanKillRate: number | null;
  killedByKind: { assertion: number; invariant: number } | null;
};

export type DshEvalsStateData = {
  outDir: string;
  config: { image: string; smoke: boolean; dshVersion: string };
  profiles: Array<{ label: string; sha256: string }>;
  fixtures: string[];
  profileSummaries: DshProfileSummaryData[];
  fixtureCells: DshFixtureCellSummaryData[];
  trials: DshTrialRecordData[];
};

export type DshTrialArtifactsData = {
  trial: DshTrialRecordData;
  scoreJson: unknown | null;
  containerLog: string | null;
  /** #140: dsh's raw session-event log, one JSON line per event - see server/evals/dsh-transcript.ts. Non-null (and non-empty) even for a trial container.log has nothing for, since it timed out mid-run. */
  transcript: string | null;
};
