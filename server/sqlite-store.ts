import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventInput, GatewayEvent, Project, Session, Store, Task, Worktree } from "./types.js";
import { makeId } from "./utils.js";

type StoreData = {
  settings: Record<string, unknown>;
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  worktrees: Worktree[];
  events: GatewayEvent[];
};

const EMPTY_DATA: StoreData = {
  settings: {},
  projects: [],
  sessions: [],
  tasks: [],
  worktrees: [],
  events: []
};

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeData(input: Partial<StoreData>): StoreData {
  return { ...EMPTY_DATA, ...input };
}

const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS kv_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    default_agent TEXT NOT NULL DEFAULT 'codex',
    test_commands TEXT NOT NULL DEFAULT '[]',
    run_commands TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    worktree_id TEXT,
    task_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    agent TEXT NOT NULL DEFAULT 'shell',
    model TEXT,
    prompt TEXT,
    tmux_session_name TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    log_path TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_output_at TEXT,
    last_health_check_at TEXT,
    error TEXT,
    summary TEXT,
    summary_updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_worktree ON sessions(worktree_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worktree_id TEXT,
    session_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    prompt TEXT,
    agent TEXT NOT NULL DEFAULT 'codex',
    status TEXT NOT NULL DEFAULT 'agent_running',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    failed_at TEXT,
    committed_at TEXT,
    cancelled_at TEXT,
    merged_at TEXT,
    checked_at TEXT,
    head_revision TEXT,
    error TEXT,
    check_runs TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_worktree ON tasks(worktree_id);

  CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT,
    path TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    base_branch TEXT NOT NULL DEFAULT '',
    base_revision TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    agent TEXT NOT NULL DEFAULT 'codex',
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    committed_at TEXT,
    checked_at TEXT,
    merged_at TEXT,
    discarded_at TEXT,
    failed_at TEXT,
    head_revision TEXT,
    error TEXT,
    check_runs TEXT,
    commit_data TEXT,
    merge_data TEXT,
    discard_data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);
  CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);
  CREATE INDEX IF NOT EXISTS idx_worktrees_task ON worktrees(task_id);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    project_id TEXT,
    session_id TEXT,
    task_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
`;

const CURRENT_SCHEMA_VERSION = 2;

export class SQLiteStore implements Store {
  private filePath: string;
  private legacyJsonPath?: string;
  private db: DatabaseSync;

  constructor(filePath: string, { legacyJsonPath }: { legacyJsonPath?: string } = {}) {
    this.filePath = filePath;
    this.legacyJsonPath = legacyJsonPath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.initialize();
    this.migrateFromRecordsTable();
    this.migrateLegacyJsonIfNeeded();
  }

  close() {
    this.db.close();
  }

  private runInTransaction(callback: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      callback();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize() {
    this.db.exec(SCHEMA_SQL);
    const versionRow = this.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number } | undefined;
    if (!versionRow) {
      this.db.prepare("INSERT INTO schema_version (id, version) VALUES (1, ?)").run(CURRENT_SCHEMA_VERSION);
    }
  }

  private tableExists(name: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { count: number };
    return Number(row.count) > 0;
  }

  private recordsTableHasData(): boolean {
    if (!this.tableExists("records")) return false;
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM records").get() as { count: number };
    return Number(row.count) > 0;
  }

  private migrateFromRecordsTable() {
    if (!this.recordsTableHasData()) return;

    const rows = this.db.prepare("SELECT collection, id, data, created_at, updated_at FROM records ORDER BY created_at ASC").all() as Array<{
      collection: string; id: string; data: string; created_at: string; updated_at: string;
    }>;

    this.runInTransaction(() => {
      for (const row of rows) {
        const record = parseJson<Record<string, unknown>>(row.data, {});
        if (!record.id) continue;
        switch (row.collection) {
          case "projects":
            this.upsertProjectRow(record as unknown as Project, row.created_at, row.updated_at);
            break;
          case "sessions":
            this.upsertSessionRow(record as unknown as Session, row.created_at, row.updated_at);
            break;
          case "tasks":
            this.upsertTaskRow(record as unknown as Task, row.created_at, row.updated_at);
            break;
          case "worktrees":
            this.upsertWorktreeRow(record as unknown as Worktree, row.created_at, row.updated_at);
            break;
          case "events":
            this.upsertEventRow(record as unknown as GatewayEvent, row.created_at);
            break;
        }
      }
      this.db.exec("DELETE FROM records");
    });
  }

  private upsertProjectRow(p: Project, createdAt: string, updatedAt: string) {
    this.db.prepare(`INSERT OR REPLACE INTO projects (id, name, repo_path, default_branch, default_agent, test_commands, run_commands, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      p.id, p.name || "", p.repoPath || "", p.defaultBranch || "main", p.defaultAgent || "codex",
      JSON.stringify(p.testCommands || []), JSON.stringify(p.runCommands || []),
      createdAt, updatedAt
    );
  }

  private upsertSessionRow(s: Session, createdAt: string, updatedAt: string) {
    this.db.prepare(`INSERT OR REPLACE INTO sessions (id, project_id, worktree_id, task_id, name, agent, model, prompt, tmux_session_name, cwd, log_path, status, created_at, updated_at, last_output_at, last_health_check_at, error, summary, summary_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      s.id, s.projectId ?? null, s.worktreeId ?? null, s.taskId ?? null,
      s.name || "", s.agent || "shell", s.model ?? null, s.prompt ?? null,
      s.tmuxSessionName || "", s.cwd || "", s.logPath ?? null,
      s.status || "running", createdAt, updatedAt,
      s.lastOutputAt ?? null, s.lastHealthCheckAt ?? null, s.error ?? null,
      s.summary ? JSON.stringify(s.summary) : null, s.summaryUpdatedAt ?? null
    );
  }

  private upsertTaskRow(t: Task, createdAt: string, updatedAt: string) {
    this.db.prepare(`INSERT OR REPLACE INTO tasks (id, project_id, worktree_id, session_id, title, prompt, agent, status, created_at, updated_at, failed_at, committed_at, cancelled_at, merged_at, checked_at, head_revision, error, check_runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      t.id, t.projectId || "", t.worktreeId ?? null, t.sessionId ?? null,
      t.title || "", t.prompt ?? null, t.agent || "codex", t.status || "agent_running",
      createdAt, updatedAt,
      t.failedAt ?? null, t.committedAt ?? null, t.cancelledAt ?? null,
      t.mergedAt ?? null, t.checkedAt ?? null, t.headRevision ?? null,
      t.error ?? null, t.checkRuns ? JSON.stringify(t.checkRuns) : null
    );
  }

  private upsertWorktreeRow(w: Worktree, createdAt: string, updatedAt: string) {
    this.db.prepare(`INSERT OR REPLACE INTO worktrees (id, project_id, task_id, path, branch, base_branch, base_revision, title, agent, status, created_at, updated_at, committed_at, checked_at, merged_at, discarded_at, failed_at, head_revision, error, check_runs, commit_data, merge_data, discard_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      w.id, w.projectId || "", w.taskId ?? null, w.path || "", w.branch || "",
      w.baseBranch || "", w.baseRevision || "", w.title || "", w.agent || "codex",
      w.status || "created", createdAt, updatedAt,
      w.committedAt ?? null, w.checkedAt ?? null, w.mergedAt ?? null,
      w.discardedAt ?? null, w.failedAt ?? null, w.headRevision ?? null,
      w.error ?? null, w.checkRuns ? JSON.stringify(w.checkRuns) : null,
      w.commit ? JSON.stringify(w.commit) : null,
      w.merge ? JSON.stringify(w.merge) : null,
      w.discard ? JSON.stringify(w.discard) : null
    );
  }

  private upsertEventRow(e: GatewayEvent, createdAt: string) {
    this.db.prepare(`INSERT OR REPLACE INTO events (id, type, project_id, session_id, task_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      e.id, e.type || "", e.projectId ?? null, e.sessionId ?? null,
      e.taskId ?? null, JSON.stringify(e.payload || {}), createdAt
    );
  }

  private rowToProject(row: Record<string, unknown>): Project {
    return {
      id: String(row.id),
      name: String(row.name || ""),
      repoPath: String(row.repo_path || ""),
      defaultBranch: String(row.default_branch || "main"),
      defaultAgent: (String(row.default_agent || "codex")) as Project["defaultAgent"],
      testCommands: parseJson<string[]>(row.test_commands as string, []),
      runCommands: parseJson<string[]>(row.run_commands as string, [])
    };
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: String(row.id),
      projectId: row.project_id as string | null,
      worktreeId: row.worktree_id as string | null | undefined,
      taskId: row.task_id as string | null | undefined,
      name: String(row.name || ""),
      agent: (String(row.agent || "shell")) as Session["agent"],
      model: row.model as string | null | undefined,
      prompt: row.prompt as string | undefined,
      tmuxSessionName: String(row.tmux_session_name || ""),
      cwd: String(row.cwd || ""),
      logPath: row.log_path as string | undefined,
      status: (String(row.status || "running")) as Session["status"],
      createdAt: String(row.created_at || ""),
      lastOutputAt: row.last_output_at as string | undefined,
      lastHealthCheckAt: row.last_health_check_at as string | undefined,
      error: row.error as string | undefined,
      summary: row.summary ? parseJson<Session["summary"]>(row.summary as string, null) : undefined,
      summaryUpdatedAt: row.summary_updated_at as string | undefined
    };
  }

  private rowToTask(row: Record<string, unknown>): Task {
    return {
      id: String(row.id),
      projectId: String(row.project_id || ""),
      worktreeId: row.worktree_id as string | undefined,
      sessionId: row.session_id as string | undefined,
      title: String(row.title || ""),
      prompt: row.prompt as string | undefined,
      agent: (String(row.agent || "codex")) as Task["agent"],
      status: (String(row.status || "agent_running")) as Task["status"],
      createdAt: String(row.created_at || ""),
      failedAt: row.failed_at as string | undefined,
      committedAt: row.committed_at as string | undefined,
      cancelledAt: row.cancelled_at as string | undefined,
      mergedAt: row.merged_at as string | undefined,
      checkedAt: row.checked_at as string | undefined,
      headRevision: row.head_revision as string | undefined,
      error: row.error as string | undefined,
      checkRuns: row.check_runs ? parseJson<Task["checkRuns"]>(row.check_runs as string, undefined) : undefined
    };
  }

  private rowToWorktree(row: Record<string, unknown>): Worktree {
    return {
      id: String(row.id),
      projectId: String(row.project_id || ""),
      taskId: row.task_id as string | undefined,
      path: String(row.path || ""),
      branch: String(row.branch || ""),
      baseBranch: String(row.base_branch || ""),
      baseRevision: String(row.base_revision || ""),
      title: String(row.title || ""),
      agent: (String(row.agent || "codex")) as Worktree["agent"],
      status: (String(row.status || "created")) as Worktree["status"],
      createdAt: String(row.created_at || ""),
      committedAt: row.committed_at as string | undefined,
      checkedAt: row.checked_at as string | undefined,
      mergedAt: row.merged_at as string | undefined,
      discardedAt: row.discarded_at as string | undefined,
      failedAt: row.failed_at as string | undefined,
      headRevision: row.head_revision as string | undefined,
      error: row.error as string | undefined,
      checkRuns: row.check_runs ? parseJson<Worktree["checkRuns"]>(row.check_runs as string, []) : undefined,
      commit: row.commit_data ? parseJson(row.commit_data as string, {} as Record<string, unknown>) : undefined,
      merge: row.merge_data ? parseJson(row.merge_data as string, {} as Record<string, unknown>) : undefined,
      discard: row.discard_data ? parseJson(row.discard_data as string, {} as Record<string, unknown>) : undefined
    };
  }

  private rowToEvent(row: Record<string, unknown>): GatewayEvent {
    return {
      id: String(row.id),
      type: String(row.type || ""),
      projectId: row.project_id as string | undefined,
      sessionId: row.session_id as string | undefined,
      taskId: row.task_id as string | undefined,
      payload: parseJson<Record<string, unknown>>(row.payload as string, {}),
      createdAt: String(row.created_at || "")
    };
  }

  private databaseHasStructuredData() {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
    const sessions = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    return Number(row.count) > 0 || Number(sessions.count) > 0;
  }

  private migrateLegacyJsonIfNeeded() {
    if (!this.legacyJsonPath || !existsSync(this.legacyJsonPath)) return;
    if (this.databaseHasStructuredData() || this.recordsTableHasData()) return;

    const content = readFileSync(this.legacyJsonPath, "utf8");
    const data = normalizeData(parseJson<Partial<StoreData>>(content, EMPTY_DATA));

    const insertSetting = this.db.prepare("INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)");

    this.runInTransaction(() => {
      for (const [key, value] of Object.entries(data.settings || {})) {
        insertSetting.run(key, JSON.stringify(value));
      }
      for (const p of data.projects) {
        if (!p?.id) continue;
        this.upsertProjectRow(p, nowIso(), nowIso());
      }
      for (const s of data.sessions) {
        if (!s?.id) continue;
        this.upsertSessionRow(s, s.createdAt || nowIso(), nowIso());
      }
      for (const t of data.tasks) {
        if (!t?.id) continue;
        this.upsertTaskRow(t, t.createdAt || nowIso(), nowIso());
      }
      for (const w of data.worktrees) {
        if (!w?.id) continue;
        this.upsertWorktreeRow(w, w.createdAt || nowIso(), nowIso());
      }
      for (const e of data.events) {
        if (!e?.id) continue;
        this.upsertEventRow(e, e.createdAt || nowIso());
      }
    });

    const backupPath = `${this.legacyJsonPath}.bak`;
    if (!existsSync(backupPath)) {
      renameSync(this.legacyJsonPath, backupPath);
    }
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const rows = this.db.prepare("SELECT key, value FROM kv_settings ORDER BY key ASC").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, parseJson(row.value, null)]));
  }

  async updateSettings(updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    const statement = this.db.prepare("INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)");
    this.runInTransaction(() => {
      for (const [key, value] of Object.entries(updates)) {
        statement.run(key, JSON.stringify(value));
      }
    });
    return this.getSettings();
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToProject(row));
  }

  async createProject(input: Partial<Project> & Pick<Project, "name" | "repoPath">): Promise<Project> {
    const now = nowIso();
    const project: Project = {
      id: makeId("proj"),
      defaultBranch: "main",
      defaultAgent: "codex",
      testCommands: [],
      runCommands: [],
      ...input
    } as Project;
    this.upsertProjectRow(project, now, now);
    return project;
  }

  async getProject(id: string): Promise<Project | undefined> {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToProject(row) : undefined;
  }

  async deleteProject(id: string): Promise<Project | null> {
    const project = await this.getProject(id);
    if (!project) return null;
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return project;
  }

  async listSessions(): Promise<Session[]> {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToSession(row));
  }

  async createSession(input: Partial<Session> & { id?: string }): Promise<Session> {
    const now = nowIso();
    const session: Session = {
      id: input.id || makeId("sess"),
      projectId: input.projectId ?? null,
      name: input.name || "",
      agent: input.agent || "shell",
      tmuxSessionName: input.tmuxSessionName || "",
      cwd: input.cwd || "",
      status: input.status || "running",
      createdAt: input.createdAt || now,
      ...input
    } as Session;
    this.upsertSessionRow(session, session.createdAt, now);
    return session;
  }

  async getSession(id: string): Promise<Session | undefined> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : undefined;
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<Session | undefined> {
    const session = await this.getSession(id);
    if (!session) return undefined;
    const merged = { ...session, ...updates };
    this.upsertSessionRow(merged, session.createdAt, nowIso());
    return merged;
  }

  async deleteSession(id: string): Promise<Session | null> {
    const session = await this.getSession(id);
    if (!session) return null;
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return session;
  }

  async listTasks(): Promise<Task[]> {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToTask(row));
  }

  async createTask(input: Partial<Task> & { id?: string }): Promise<Task> {
    const now = nowIso();
    const task: Task = {
      id: input.id || makeId("task"),
      projectId: input.projectId || "",
      title: input.title || "",
      agent: input.agent || "codex",
      status: input.status || "agent_running",
      createdAt: input.createdAt || now,
      ...input
    } as Task;
    this.upsertTaskRow(task, task.createdAt, now);
    return task;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToTask(row) : undefined;
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | undefined> {
    const task = await this.getTask(id);
    if (!task) return undefined;
    const merged = { ...task, ...updates };
    this.upsertTaskRow(merged, task.createdAt, nowIso());
    return merged;
  }

  async listWorktrees(projectId?: string): Promise<Worktree[]> {
    if (projectId) {
      const rows = this.db.prepare("SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as Record<string, unknown>[];
      return rows.map((row) => this.rowToWorktree(row));
    }
    const rows = this.db.prepare("SELECT * FROM worktrees ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToWorktree(row));
  }

  async createWorktree(input: Partial<Worktree> & { id?: string; project_id?: string }): Promise<Worktree> {
    const now = nowIso();
    const { project_id, ...rest } = input;
    const worktree: Worktree = {
      id: rest.id || makeId("wt"),
      projectId: rest.projectId || project_id || "",
      path: rest.path || "",
      branch: rest.branch || "",
      baseBranch: rest.baseBranch || "",
      baseRevision: rest.baseRevision || "",
      title: rest.title || "",
      agent: rest.agent || "codex",
      status: rest.status || "created",
      createdAt: rest.createdAt || now,
      ...rest
    } as Worktree;
    if (!worktree.projectId && project_id) worktree.projectId = project_id;
    this.upsertWorktreeRow(worktree, worktree.createdAt, now);
    return worktree;
  }

  async getWorktree(id: string): Promise<Worktree | undefined> {
    const row = this.db.prepare("SELECT * FROM worktrees WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToWorktree(row) : undefined;
  }

  async updateWorktree(id: string, updates: Partial<Worktree>): Promise<Worktree | undefined> {
    const worktree = await this.getWorktree(id);
    if (!worktree) return undefined;
    const merged = { ...worktree, ...updates };
    this.upsertWorktreeRow(merged, worktree.createdAt, nowIso());
    return merged;
  }

  async appendEvent(input: EventInput): Promise<GatewayEvent> {
    const now = nowIso();
    const event: GatewayEvent = {
      id: input.id || makeId("evt"),
      type: input.type,
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      payload: input.payload || {},
      createdAt: input.createdAt || now
    };
    this.upsertEventRow(event, event.createdAt);

    const excess = this.db.prepare(
      "SELECT id FROM events ORDER BY created_at DESC LIMIT -1 OFFSET 200"
    ).all() as Array<{ id: string }>;
    if (excess.length) {
      const deleteStmt = this.db.prepare("DELETE FROM events WHERE id = ?");
      this.runInTransaction(() => {
        for (const row of excess) deleteStmt.run(row.id);
      });
    }
    return event;
  }

  async listEvents(limit = 50): Promise<GatewayEvent[]> {
    const rows = this.db.prepare(
      "SELECT * FROM events ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as Record<string, unknown>[];
    return rows.reverse().map((row) => this.rowToEvent(row));
  }
}
