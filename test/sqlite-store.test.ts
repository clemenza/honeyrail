import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import { SQLiteStore } from "../server/sqlite-store.js";

async function tempPath(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-sqlite-store-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  return tempDir;
}

function inspectDatabase<T>(dbPath: string, inspect: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return inspect(db);
  } finally {
    db.close();
  }
}

function readSchemaVersion(dbPath: string): number {
  return inspectDatabase(dbPath, (db) => {
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
    return Number(row.version);
  });
}

function tableExists(dbPath: string, name: string): boolean {
  return inspectDatabase(dbPath, (db) => {
    const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { count: number };
    return Number(row.count) > 0;
  });
}

test("SQLiteStore persists projects, sessions, tasks, worktrees, events, and settings", async (t) => {
  const tempDir = await tempPath(t);
  const dbPath = join(tempDir, "gateway.sqlite");
  const store = new SQLiteStore(dbPath);
  t.after(() => store.close());

  const settings = await store.updateSettings({ defaultWorkspace: "/workspace" });
  const project = await store.createProject({ name: "demo", repoPath: "/repo/demo" });
  const session = await store.createSession({ projectId: project.id, name: "agent", tmuxSessionName: "agw_demo", status: "running" });
  const task = await store.createTask({ projectId: project.id, title: "fix", status: "agent_running", sessionId: session.id });
  const worktree = await store.createWorktree({ projectId: project.id, taskId: task.id, path: "/tmp/wt", branch: "codex/fix" });
  const event = await store.appendEvent({ type: "task.started", projectId: project.id, taskId: task.id });

  assert.equal(settings.defaultWorkspace, "/workspace");
  assert.equal((await store.getProject(project.id))!.name, "demo");
  assert.equal((await store.getSession(session.id))!.tmuxSessionName, "agw_demo");
  assert.equal((await store.getTask(task.id))!.title, "fix");
  assert.equal((await store.getWorktree(worktree.id))!.branch, "codex/fix");
  assert.equal((await store.listEvents()).at(-1)!.id, event.id);
  assert.equal(readSchemaVersion(dbPath), 8);

  await store.updateTask(task.id, { status: "ready_to_merge" });
  await store.updateWorktree(worktree.id, { status: "committed" });
  await store.updateSession(session.id, { status: "waiting_approval" });

  assert.equal((await store.getTask(task.id))!.status, "ready_to_merge");
  assert.equal((await store.getWorktree(worktree.id))!.status, "committed");
  assert.equal((await store.getSession(session.id))!.status, "waiting_approval");
});

test("SQLiteStore schema migrations are idempotent on repeated startup", async (t) => {
  const tempDir = await tempPath(t);
  const dbPath = join(tempDir, "gateway.sqlite");
  const first = new SQLiteStore(dbPath);
  const project = await first.createProject({ name: "stable", repoPath: "/repo/stable" });
  first.close();

  const second = new SQLiteStore(dbPath);
  t.after(() => second.close());

  assert.equal(readSchemaVersion(dbPath), 8);
  assert.equal((await second.getProject(project.id))!.name, "stable");
  assert.equal((await second.listProjects()).length, 1);
});

test("SQLiteStore upgrades v1 records schema to the structured schema without losing state", async (t) => {
  const tempDir = await tempPath(t);
  const dbPath = join(tempDir, "gateway.sqlite");
  inspectDatabase(dbPath, (db) => {
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (1, 1);
      CREATE TABLE records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );
    `);
    const insert = db.prepare("INSERT INTO records (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    insert.run("projects", "proj_v1", JSON.stringify({ id: "proj_v1", name: "legacy project", repoPath: "/repo/v1" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run("sessions", "sess_v1", JSON.stringify({ id: "sess_v1", projectId: "proj_v1", taskId: "task_v1", worktreeId: "wt_v1", name: "legacy session", agent: "codex", status: "running", tmuxSessionName: "agw_task_v1", cwd: "/tmp/wt-v1", createdAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run("tasks", "task_v1", JSON.stringify({ id: "task_v1", projectId: "proj_v1", worktreeId: "wt_v1", sessionId: "sess_v1", title: "legacy task", agent: "codex", status: "agent_running", createdAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run("worktrees", "wt_v1", JSON.stringify({ id: "wt_v1", projectId: "proj_v1", taskId: "task_v1", path: "/tmp/wt-v1", branch: "codex/legacy-task", baseBranch: "main", baseRevision: "base-v1", title: "legacy task", agent: "codex", status: "created", createdAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run("events", "evt_v1", JSON.stringify({ id: "evt_v1", type: "task.started", projectId: "proj_v1", taskId: "task_v1", payload: { source: "v1" }, createdAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  });

  const store = new SQLiteStore(dbPath);
  t.after(() => store.close());

  assert.equal(readSchemaVersion(dbPath), 8);
  assert.equal((await store.getProject("proj_v1"))!.repoPath, "/repo/v1");
  assert.equal((await store.getSession("sess_v1"))!.worktreeId, "wt_v1");
  assert.equal((await store.getTask("task_v1"))!.sessionId, "sess_v1");
  assert.equal((await store.getWorktree("wt_v1"))!.taskId, "task_v1");
  assert.equal((await store.listEvents()).at(-1)!.type, "task.started");
  assert.equal(inspectDatabase(dbPath, (db) => (db.prepare("SELECT COUNT(*) AS count FROM records").get() as { count: number }).count), 0);
});

test("SQLiteStore migration failure rolls back partial schema changes and leaves version unchanged", async (t) => {
  const tempDir = await tempPath(t);
  const dbPath = join(tempDir, "gateway.sqlite");
  inspectDatabase(dbPath, (db) => {
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (1, 1);
      CREATE INDEX projects ON schema_version(version);
    `);
  });

  assert.throws(() => new SQLiteStore(dbPath), /projects/);
  assert.equal(readSchemaVersion(dbPath), 1);
  assert.equal(tableExists(dbPath, "kv_settings"), false);
});

test("SQLiteStore upgrades v2 execution schema to v5 attempt-aware verification schema and preserves existing state", async (t) => {
  const tempDir = await tempPath(t);
  const dbPath = join(tempDir, "gateway.sqlite");
  inspectDatabase(dbPath, (db) => {
    db.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (1, 2);
      CREATE TABLE kv_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE projects (
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
      CREATE TABLE sessions (
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
      CREATE TABLE tasks (
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
      CREATE TABLE worktrees (
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
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        project_id TEXT,
        session_id TEXT,
        task_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO projects (id, name, repo_path, created_at, updated_at) VALUES ('proj_v2', 'v2', '/repo/v2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
  });

  const store = new SQLiteStore(dbPath);
  const run = await store.createRun({ projectId: "proj_v2", goal: "persist m1" });
  await store.createStep({ id: "step_a", runId: run.id, name: "A", executor: "shell", input: { command: "true" }, dependsOn: [], status: "pending", qualityGate: { evaluators: [{ type: "boolean", source: "output.ok" }] } });
  const artifact = await store.createArtifact({ runId: run.id, stepId: "step_a", kind: "log", name: "check.log", metadata: { command: "true" } });
  const evidence = await store.createEvidence({ runId: run.id, stepId: "step_a", kind: "check.command", claim: "true passed", artifactIds: [artifact.id], value: { exitCode: 0 } });
  await store.createEvaluation({ runId: run.id, stepId: "step_a", attempt: 1, evaluator: "check", status: "passed", evidenceIds: [evidence.id], artifactIds: [artifact.id], reason: "ok" });
  await store.createQualityGateDecision({ runId: run.id, stepId: "step_a", attempt: 1, status: "passed", evaluationIds: ["eval_a"], decidedBy: "system", reason: "ok" });
  store.close();

  const reopened = new SQLiteStore(dbPath);
  t.after(() => reopened.close());

  assert.equal(readSchemaVersion(dbPath), 8);
  assert.equal((await reopened.getProject("proj_v2"))!.name, "v2");
  assert.equal((await reopened.getRun(run.id))!.goal, "persist m1");
  assert.equal((await reopened.getStep(run.id, "step_a"))!.input.command, "true");
  assert.equal((await reopened.getStep(run.id, "step_a"))!.qualityGate?.evaluators[0].type, "boolean");
  assert.equal((await reopened.listArtifacts(run.id, "step_a"))[0].metadata?.command, "true");
  assert.equal((await reopened.listEvidence(run.id, "step_a"))[0].artifactIds?.[0], artifact.id);
  assert.equal((await reopened.listEvaluations(run.id, "step_a"))[0].status, "passed");
  assert.equal((await reopened.listEvaluations(run.id, "step_a"))[0].attempt, 1);
  assert.equal((await reopened.listQualityGateDecisions(run.id, "step_a"))[0].status, "passed");
  assert.equal((await reopened.listQualityGateDecisions(run.id, "step_a"))[0].attempt, 1);
});

test("SQLiteStore migrates legacy gateway.json once and writes a backup", async (t) => {
  const tempDir = await tempPath(t);
  const legacyPath = join(tempDir, "gateway.json");
  const dbPath = join(tempDir, "gateway.sqlite");
  await mkdir(tempDir, { recursive: true });
  await writeFile(legacyPath, JSON.stringify({
    settings: { defaultWorkspace: "/legacy" },
    projects: [{ id: "proj_legacy", name: "legacy", repoPath: "/repo/legacy" }],
    sessions: [{ id: "sess_legacy", name: "legacy session", status: "running" }],
    tasks: [{ id: "task_legacy", title: "legacy task", status: "agent_running" }],
    worktrees: [{ id: "wt_legacy", projectId: "proj_legacy", path: "/tmp/wt", branch: "codex/legacy" }],
    events: [{ id: "evt_legacy", type: "legacy.event", createdAt: "2026-01-01T00:00:00.000Z" }]
  }, null, 2));

  const store = new SQLiteStore(dbPath, { legacyJsonPath: legacyPath });
  t.after(() => store.close());

  assert.equal((await store.getSettings()).defaultWorkspace, "/legacy");
  assert.equal((await store.getProject("proj_legacy"))!.name, "legacy");
  assert.equal((await store.getSession("sess_legacy"))!.name, "legacy session");
  assert.equal((await store.getTask("task_legacy"))!.title, "legacy task");
  assert.equal((await store.getWorktree("wt_legacy"))!.branch, "codex/legacy");
  assert.equal((await store.listEvents()).at(-1)!.type, "legacy.event");
  assert.equal(existsSync(legacyPath), false);
  assert.equal(existsSync(`${legacyPath}.bak`), true);
  assert.match(await readFile(`${legacyPath}.bak`, "utf8"), /proj_legacy/);
});

test("SQLiteStore does not re-import legacy JSON when database already has data", async (t) => {
  const tempDir = await tempPath(t);
  const legacyPath = join(tempDir, "gateway.json");
  const dbPath = join(tempDir, "gateway.sqlite");
  await writeFile(legacyPath, JSON.stringify({ projects: [{ id: "proj_legacy", name: "legacy" }] }));

  const first = new SQLiteStore(dbPath, { legacyJsonPath: legacyPath });
  await first.createProject({ id: "proj_current", name: "current", repoPath: "/repo/current" });
  first.close();
  await writeFile(legacyPath, JSON.stringify({ projects: [{ id: "proj_second", name: "second" }] }));

  const second = new SQLiteStore(dbPath, { legacyJsonPath: legacyPath });
  t.after(() => second.close());

  assert.equal(await second.getProject("proj_second"), undefined);
  assert.equal((await second.getProject("proj_current"))!.name, "current");
});
