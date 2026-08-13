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

export type CheckRun = {
  command: string;
  status: "passed" | "failed";
  exitCode?: number | string;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
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
