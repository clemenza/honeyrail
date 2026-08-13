import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { SQLiteStore } from "../server/sqlite-store.js";

async function tempPath(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-sqlite-store-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  return tempDir;
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

  await store.updateTask(task.id, { status: "ready_to_merge" });
  await store.updateWorktree(worktree.id, { status: "committed" });
  await store.updateSession(session.id, { status: "waiting_approval" });

  assert.equal((await store.getTask(task.id))!.status, "ready_to_merge");
  assert.equal((await store.getWorktree(worktree.id))!.status, "committed");
  assert.equal((await store.getSession(session.id))!.status, "waiting_approval");
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
