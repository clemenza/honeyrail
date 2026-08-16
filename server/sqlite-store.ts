import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Artifact, Evaluation, EventInput, Evidence, GatewayEvent, Project, QualityGateDecision, Run, Session, Step, Store, Task, Worktree } from "./types.js";
import { makeId } from "./utils.js";

type StoreData = {
  settings: Record<string, unknown>;
  projects: Project[];
  runs: Run[];
  steps: Step[];
  artifacts: Artifact[];
  evidence: Evidence[];
  evaluations: Evaluation[];
  qualityGateDecisions: QualityGateDecision[];
  sessions: Session[];
  tasks: Task[];
  worktrees: Worktree[];
  events: GatewayEvent[];
};

const EMPTY_DATA: StoreData = {
  settings: {},
  projects: [],
  runs: [],
  steps: [],
  artifacts: [],
  evidence: [],
  evaluations: [],
  qualityGateDecisions: [],
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

const SCHEMA_VERSION_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );
`;

const GATE_DECISION_SCHEMA_SQL = `
  ALTER TABLE artifacts ADD COLUMN attempt INTEGER;
  ALTER TABLE evidence ADD COLUMN attempt INTEGER;
  ALTER TABLE evaluations ADD COLUMN attempt INTEGER;

  CREATE TABLE IF NOT EXISTS quality_gate_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,
    evaluation_ids TEXT NOT NULL DEFAULT '[]',
    reason TEXT,
    decided_by TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quality_gate_decisions_run ON quality_gate_decisions(run_id);
  CREATE INDEX IF NOT EXISTS idx_quality_gate_decisions_step ON quality_gate_decisions(step_id);
  CREATE INDEX IF NOT EXISTS idx_quality_gate_decisions_attempt ON quality_gate_decisions(attempt);
  CREATE INDEX IF NOT EXISTS idx_quality_gate_decisions_created ON quality_gate_decisions(created_at);
`;

const BLOCKED_STEP_SCHEMA_SQL = `
  ALTER TABLE steps ADD COLUMN on_blocked TEXT;
  ALTER TABLE steps ADD COLUMN blocked_since TEXT;
`;

const STEP_FAILURE_KIND_SCHEMA_SQL = `
  ALTER TABLE steps ADD COLUMN failure_kind TEXT;
`;

const STEP_CONTRACT_SCHEMA_SQL = `
  ALTER TABLE steps ADD COLUMN produces TEXT;
  ALTER TABLE steps ADD COLUMN consumes TEXT;
  ALTER TABLE artifacts ADD COLUMN artifact_type TEXT;
`;

const CONTRACT_LEVEL_SCHEMA_SQL = `
  ALTER TABLE runs ADD COLUMN contract_level TEXT;
`;

const LEGACY_RECORDS_SQL = `
  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  );
`;

const STRUCTURED_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS kv_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
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

const ORCHESTRATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cancelled_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

  CREATE TABLE IF NOT EXISTS steps (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    executor TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    depends_on TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    execution_ref TEXT,
    output TEXT,
    error TEXT,
    PRIMARY KEY (run_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);
  CREATE INDEX IF NOT EXISTS idx_steps_status ON steps(status);
`;

const VERIFICATION_SCHEMA_SQL = `
  ALTER TABLE steps ADD COLUMN quality_gate TEXT;

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT,
    kind TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    uri TEXT,
    path TEXT,
    media_type TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_step ON artifacts(step_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at);

  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT,
    kind TEXT NOT NULL,
    claim TEXT,
    value TEXT,
    source TEXT,
    artifact_ids TEXT NOT NULL DEFAULT '[]',
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
  CREATE INDEX IF NOT EXISTS idx_evidence_step ON evidence(step_id);
  CREATE INDEX IF NOT EXISTS idx_evidence_created ON evidence(created_at);

  CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT,
    evaluator TEXT NOT NULL,
    status TEXT NOT NULL,
    score REAL,
    threshold REAL,
    reason TEXT,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    artifact_ids TEXT NOT NULL DEFAULT '[]',
    metadata TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evaluations_run ON evaluations(run_id);
  CREATE INDEX IF NOT EXISTS idx_evaluations_step ON evaluations(step_id);
  CREATE INDEX IF NOT EXISTS idx_evaluations_status ON evaluations(status);
  CREATE INDEX IF NOT EXISTS idx_evaluations_created ON evaluations(created_at);
`;

type SchemaMigration = {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
};

const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    name: "legacy-records-compatibility",
    up: (db) => db.exec(LEGACY_RECORDS_SQL)
  },
  {
    version: 2,
    name: "structured-execution-state",
    up: (db) => db.exec(STRUCTURED_SCHEMA_SQL)
  },
  {
    version: 3,
    name: "orchestration-runs-steps",
    up: (db) => db.exec(ORCHESTRATION_SCHEMA_SQL)
  },
  {
    version: 4,
    name: "verification-artifacts-evidence-evaluations",
    up: (db) => db.exec(VERIFICATION_SCHEMA_SQL)
  },
  {
    version: 5,
    name: "attempt-aware-verification-and-gate-decisions",
    up: (db) => db.exec(GATE_DECISION_SCHEMA_SQL)
  },
  {
    version: 6,
    name: "blocked-step-policy-and-timeout",
    up: (db) => db.exec(BLOCKED_STEP_SCHEMA_SQL)
  },
  {
    version: 7,
    name: "step-failure-kind",
    up: (db) => db.exec(STEP_FAILURE_KIND_SCHEMA_SQL)
  },
  {
    version: 8,
    name: "step-contracts",
    up: (db) => db.exec(STEP_CONTRACT_SCHEMA_SQL)
  },
  {
    version: 9,
    name: "run-contract-level",
    up: (db) => db.exec(CONTRACT_LEVEL_SCHEMA_SQL)
  }
];

const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1)!.version;

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
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_VERSION_SQL);

    this.assertSequentialMigrations();
    const currentVersion = this.readSchemaVersion();
    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(`SQLite schema version ${currentVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`);
    }

    for (const migration of SCHEMA_MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      this.runInTransaction(() => {
        migration.up(this.db);
        this.setSchemaVersion(migration.version);
      });
    }
  }

  private assertSequentialMigrations() {
    for (const [index, migration] of SCHEMA_MIGRATIONS.entries()) {
      const expected = index + 1;
      if (migration.version !== expected) {
        throw new Error(`SQLite migration ${migration.name} has version ${migration.version}; expected ${expected}`);
      }
    }
  }

  private readSchemaVersion() {
    const versionRow = this.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number } | undefined;
    if (!versionRow) return 0;
    const version = Number(versionRow.version);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`Invalid SQLite schema version: ${String(versionRow.version)}`);
    }
    return version;
  }

  private setSchemaVersion(version: number) {
    this.db.prepare("INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)").run(version);
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

  private upsertRunRow(run: Run, createdAt: string) {
    this.db.prepare(`INSERT OR REPLACE INTO runs (id, project_id, goal, status, contract_level, created_at, started_at, finished_at, cancelled_at, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.id, run.projectId, run.goal || "", run.status || "pending", run.contractLevel ?? null, createdAt,
      run.startedAt ?? null, run.finishedAt ?? null, run.cancelledAt ?? null, run.error ?? null
    );
  }

  private upsertStepRow(step: Step, createdAt: string) {
    this.db.prepare(`INSERT OR REPLACE INTO steps (id, run_id, name, executor, input, depends_on, status, attempt, max_attempts, created_at, started_at, finished_at, execution_ref, output, error, quality_gate, on_blocked, blocked_since, failure_kind, produces, consumes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      step.id, step.runId, step.name || "", step.executor,
      JSON.stringify(step.input || {}), JSON.stringify(step.dependsOn || []),
      step.status || "pending", step.attempt ?? 0, step.maxAttempts ?? 1,
      createdAt, step.startedAt ?? null, step.finishedAt ?? null,
      step.executionRef ? JSON.stringify(step.executionRef) : null,
      step.output ? JSON.stringify(step.output) : null,
      step.error ?? null,
      step.qualityGate ? JSON.stringify(step.qualityGate) : null,
      step.onBlocked ? JSON.stringify(step.onBlocked) : null,
      step.blockedSince ?? null,
      step.failureKind ?? null,
      step.produces ? JSON.stringify(step.produces) : null,
      step.consumes ? JSON.stringify(step.consumes) : null
    );
  }

  private upsertArtifactRow(artifact: Artifact) {
    this.db.prepare(`INSERT OR REPLACE INTO artifacts (id, run_id, step_id, attempt, kind, name, uri, path, media_type, artifact_type, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artifact.id, artifact.runId, artifact.stepId ?? null, artifact.attempt ?? null, artifact.kind, artifact.name || "",
      artifact.uri ?? null, artifact.path ?? null, artifact.mediaType ?? null, artifact.artifactType ?? null,
      artifact.metadata ? JSON.stringify(artifact.metadata) : null,
      artifact.createdAt
    );
  }

  private upsertEvidenceRow(evidence: Evidence) {
    this.db.prepare(`INSERT OR REPLACE INTO evidence (id, run_id, step_id, attempt, kind, claim, value, source, artifact_ids, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      evidence.id, evidence.runId, evidence.stepId ?? null, evidence.attempt ?? null, evidence.kind, evidence.claim ?? null,
      evidence.value !== undefined ? JSON.stringify(evidence.value) : null,
      evidence.source ?? null, JSON.stringify(evidence.artifactIds || []),
      evidence.metadata ? JSON.stringify(evidence.metadata) : null,
      evidence.createdAt
    );
  }

  private upsertEvaluationRow(evaluation: Evaluation) {
    this.db.prepare(`INSERT OR REPLACE INTO evaluations (id, run_id, step_id, attempt, evaluator, status, score, threshold, reason, evidence_ids, artifact_ids, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      evaluation.id, evaluation.runId, evaluation.stepId ?? null, evaluation.attempt ?? null, evaluation.evaluator, evaluation.status,
      evaluation.score ?? null, evaluation.threshold ?? null, evaluation.reason ?? null,
      JSON.stringify(evaluation.evidenceIds || []), JSON.stringify(evaluation.artifactIds || []),
      evaluation.metadata ? JSON.stringify(evaluation.metadata) : null,
      evaluation.createdAt
    );
  }

  private upsertQualityGateDecisionRow(decision: QualityGateDecision) {
    this.db.prepare(`INSERT OR REPLACE INTO quality_gate_decisions (id, run_id, step_id, attempt, status, evaluation_ids, reason, decided_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      decision.id, decision.runId, decision.stepId, decision.attempt, decision.status,
      JSON.stringify(decision.evaluationIds || []), decision.reason ?? null, decision.decidedBy,
      decision.createdAt
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

  private rowToRun(row: Record<string, unknown>): Run {
    return {
      id: String(row.id),
      projectId: String(row.project_id || ""),
      goal: String(row.goal || ""),
      status: (String(row.status || "pending")) as Run["status"],
      contractLevel: row.contract_level as Run["contractLevel"],
      createdAt: String(row.created_at || ""),
      startedAt: row.started_at as string | undefined,
      finishedAt: row.finished_at as string | undefined,
      cancelledAt: row.cancelled_at as string | undefined,
      error: row.error as string | undefined
    };
  }

  private rowToStep(row: Record<string, unknown>): Step {
    return {
      id: String(row.id),
      runId: String(row.run_id || ""),
      name: String(row.name || ""),
      executor: String(row.executor || ""),
      input: parseJson<Record<string, unknown>>(row.input as string, {}),
      dependsOn: parseJson<string[]>(row.depends_on as string, []),
      status: (String(row.status || "pending")) as Step["status"],
      attempt: Number(row.attempt || 0),
      maxAttempts: Number(row.max_attempts || 1),
      createdAt: String(row.created_at || ""),
      startedAt: row.started_at as string | undefined,
      finishedAt: row.finished_at as string | undefined,
      executionRef: row.execution_ref ? parseJson<Record<string, unknown>>(row.execution_ref as string, {}) : undefined,
      output: row.output ? parseJson<Record<string, unknown>>(row.output as string, {}) : undefined,
      qualityGate: row.quality_gate ? parseJson<Step["qualityGate"]>(row.quality_gate as string, undefined) : undefined,
      onBlocked: row.on_blocked ? parseJson<Step["onBlocked"]>(row.on_blocked as string, undefined) : undefined,
      blockedSince: row.blocked_since as string | undefined,
      error: row.error as string | undefined,
      failureKind: row.failure_kind as Step["failureKind"],
      produces: row.produces ? parseJson<Step["produces"]>(row.produces as string, undefined) : undefined,
      consumes: row.consumes ? parseJson<Step["consumes"]>(row.consumes as string, undefined) : undefined
    };
  }

  private rowToArtifact(row: Record<string, unknown>): Artifact {
    return {
      id: String(row.id),
      runId: String(row.run_id || ""),
      stepId: row.step_id as string | undefined,
      attempt: row.attempt === null || row.attempt === undefined ? undefined : Number(row.attempt),
      kind: String(row.kind || "text") as Artifact["kind"],
      name: String(row.name || ""),
      uri: row.uri as string | undefined,
      path: row.path as string | undefined,
      mediaType: row.media_type as string | undefined,
      artifactType: row.artifact_type as string | undefined,
      metadata: row.metadata ? parseJson<Record<string, unknown>>(row.metadata as string, {}) : undefined,
      createdAt: String(row.created_at || "")
    };
  }

  private rowToEvidence(row: Record<string, unknown>): Evidence {
    return {
      id: String(row.id),
      runId: String(row.run_id || ""),
      stepId: row.step_id as string | undefined,
      attempt: row.attempt === null || row.attempt === undefined ? undefined : Number(row.attempt),
      kind: String(row.kind || ""),
      claim: row.claim as string | undefined,
      value: row.value ? parseJson<unknown>(row.value as string, undefined) : undefined,
      source: row.source as string | undefined,
      artifactIds: parseJson<string[]>(row.artifact_ids as string, []),
      metadata: row.metadata ? parseJson<Record<string, unknown>>(row.metadata as string, {}) : undefined,
      createdAt: String(row.created_at || "")
    };
  }

  private rowToEvaluation(row: Record<string, unknown>): Evaluation {
    return {
      id: String(row.id),
      runId: String(row.run_id || ""),
      stepId: row.step_id as string | undefined,
      attempt: row.attempt === null || row.attempt === undefined ? undefined : Number(row.attempt),
      evaluator: String(row.evaluator || ""),
      status: String(row.status || "error") as Evaluation["status"],
      score: row.score === null || row.score === undefined ? undefined : Number(row.score),
      threshold: row.threshold === null || row.threshold === undefined ? undefined : Number(row.threshold),
      reason: row.reason as string | undefined,
      evidenceIds: parseJson<string[]>(row.evidence_ids as string, []),
      artifactIds: parseJson<string[]>(row.artifact_ids as string, []),
      metadata: row.metadata ? parseJson<Record<string, unknown>>(row.metadata as string, {}) : undefined,
      createdAt: String(row.created_at || "")
    };
  }

  private rowToQualityGateDecision(row: Record<string, unknown>): QualityGateDecision {
    return {
      id: String(row.id),
      runId: String(row.run_id || ""),
      stepId: String(row.step_id || ""),
      attempt: Number(row.attempt || 0),
      status: String(row.status || "failed") as QualityGateDecision["status"],
      evaluationIds: parseJson<string[]>(row.evaluation_ids as string, []),
      reason: row.reason as string | undefined,
      decidedBy: String(row.decided_by || "system") as QualityGateDecision["decidedBy"],
      createdAt: String(row.created_at || "")
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

  async listRuns(projectId?: string): Promise<Run[]> {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at ASC").all(projectId) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM runs ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToRun(row));
  }

  async createRun(input: Partial<Run> & Pick<Run, "projectId" | "goal">): Promise<Run> {
    const now = nowIso();
    const run: Run = {
      ...input,
      id: input.id || makeId("run"),
      projectId: input.projectId,
      goal: input.goal,
      status: input.status || "pending",
      createdAt: input.createdAt || now
    } as Run;
    this.upsertRunRow(run, run.createdAt);
    return run;
  }

  async getRun(id: string): Promise<Run | undefined> {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : undefined;
  }

  async updateRun(id: string, updates: Partial<Run>): Promise<Run | undefined> {
    const run = await this.getRun(id);
    if (!run) return undefined;
    const merged = { ...run, ...updates };
    this.upsertRunRow(merged, run.createdAt);
    return merged;
  }

  async createStep(input: Partial<Step> & Pick<Step, "id" | "runId" | "name" | "executor">): Promise<Step> {
    const now = nowIso();
    const step: Step = {
      input: {},
      dependsOn: [],
      status: "pending",
      attempt: 0,
      maxAttempts: 1,
      createdAt: now,
      ...input
    } as Step;
    this.upsertStepRow(step, step.createdAt);
    return step;
  }

  async listSteps(runId: string): Promise<Step[]> {
    const rows = this.db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToStep(row));
  }

  async getStep(runId: string, stepId: string): Promise<Step | undefined> {
    const row = this.db.prepare("SELECT * FROM steps WHERE run_id = ? AND id = ?").get(runId, stepId) as Record<string, unknown> | undefined;
    return row ? this.rowToStep(row) : undefined;
  }

  async updateStep(runId: string, stepId: string, updates: Partial<Step>): Promise<Step | undefined> {
    const step = await this.getStep(runId, stepId);
    if (!step) return undefined;
    const merged = { ...step, ...updates };
    this.upsertStepRow(merged, step.createdAt);
    return merged;
  }

  async createArtifact(input: Partial<Artifact> & Pick<Artifact, "runId" | "kind" | "name">): Promise<Artifact> {
    const artifact: Artifact = {
      id: input.id || makeId("art"),
      createdAt: input.createdAt || nowIso(),
      ...input
    } as Artifact;
    this.upsertArtifactRow(artifact);
    return artifact;
  }

  async listArtifacts(runId: string, stepId?: string): Promise<Artifact[]> {
    const rows = stepId
      ? this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? AND step_id = ? ORDER BY created_at ASC").all(runId, stepId) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToArtifact(row));
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToArtifact(row) : undefined;
  }

  async createEvidence(input: Partial<Evidence> & Pick<Evidence, "runId" | "kind">): Promise<Evidence> {
    const evidence: Evidence = {
      id: input.id || makeId("evd"),
      createdAt: input.createdAt || nowIso(),
      artifactIds: [],
      ...input
    } as Evidence;
    this.upsertEvidenceRow(evidence);
    return evidence;
  }

  async listEvidence(runId: string, stepId?: string): Promise<Evidence[]> {
    const rows = stepId
      ? this.db.prepare("SELECT * FROM evidence WHERE run_id = ? AND step_id = ? ORDER BY created_at ASC").all(runId, stepId) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM evidence WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEvidence(row));
  }

  async createEvaluation(input: Partial<Evaluation> & Pick<Evaluation, "runId" | "evaluator" | "status">): Promise<Evaluation> {
    const evaluation: Evaluation = {
      id: input.id || makeId("eval"),
      createdAt: input.createdAt || nowIso(),
      evidenceIds: [],
      artifactIds: [],
      ...input
    } as Evaluation;
    this.upsertEvaluationRow(evaluation);
    return evaluation;
  }

  async listEvaluations(runId: string, stepId?: string): Promise<Evaluation[]> {
    const rows = stepId
      ? this.db.prepare("SELECT * FROM evaluations WHERE run_id = ? AND step_id = ? ORDER BY created_at ASC").all(runId, stepId) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM evaluations WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEvaluation(row));
  }

  async createQualityGateDecision(input: Partial<QualityGateDecision> & Pick<QualityGateDecision, "runId" | "stepId" | "attempt" | "status" | "evaluationIds" | "decidedBy">): Promise<QualityGateDecision> {
    const decision: QualityGateDecision = {
      id: input.id || makeId("qgd"),
      createdAt: input.createdAt || nowIso(),
      ...input
    } as QualityGateDecision;
    this.upsertQualityGateDecisionRow(decision);
    return decision;
  }

  async listQualityGateDecisions(runId: string, stepId?: string): Promise<QualityGateDecision[]> {
    const rows = stepId
      ? this.db.prepare("SELECT * FROM quality_gate_decisions WHERE run_id = ? AND step_id = ? ORDER BY created_at ASC").all(runId, stepId) as Record<string, unknown>[]
      : this.db.prepare("SELECT * FROM quality_gate_decisions WHERE run_id = ? ORDER BY created_at ASC").all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.rowToQualityGateDecision(row));
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
