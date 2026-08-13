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
  assert.equal(readSchemaVersion(dbPath), 2);

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

  assert.equal(readSchemaVersion(dbPath), 2);
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

  assert.equal(readSchemaVersion(dbPath), 2);
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
