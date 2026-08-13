export type ViewId = "dashboard" | "projects" | "sessions" | "worktrees" | "runs" | "approvals";

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
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  executionRef?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
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
};
