import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";

async function withServer(t, { worktrees, run } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-worktree-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events = [];
  bus.subscribe((event) => events.push(event));

  const app = createApp({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      startSession: async () => {},
      killSession: async () => {}
    },
    worktrees: {
      create: async ({ project, title, agent }) => ({
        projectId: project.id,
        path: join(tempDir, "worktree"),
        branch: `${agent}/${title}`,
        title,
        agent
      }),
      merge: async () => ({ branch: "codex/task", targetBranch: "main" }),
      ...(worktrees || {})
    },
    run: run || (async () => ({ ok: true, stdout: "main\n", stderr: "" })),
    token: null,
    attachmentRoot: join(tempDir, "attachments")
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { store, events, baseUrl };
}

async function readJson(response) {
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  return response.json();
}

test("POST /api/tasks persists a worktree record and links it to the task", async (t) => {
  const { store, baseUrl } = await withServer(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      title: "fix merge entry",
      prompt: "implement worktree merge",
      agent: "codex"
    })
  });
  const body = await readJson(response);
  const worktrees = await store.listWorktrees(project.id);

  assert.equal(response.status, 201);
  assert.ok(body.worktree.id);
  assert.equal(body.task.worktreeId, body.worktree.id);
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].id, body.worktree.id);
  assert.equal(worktrees[0].taskId, body.task.id);
});

test("POST /api/worktrees/:id/merge merges into the project repo and marks the task", async (t) => {
  const mergeCalls = [];
  const { store, events, baseUrl } = await withServer(t, {
    worktrees: {
      merge: async (input) => {
        mergeCalls.push(input);
        return { branch: input.worktree.branch, targetBranch: "main" };
      }
    }
  });
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });
  const task = await store.createTask({
    projectId: project.id,
    title: "fix merge entry",
    prompt: "implement worktree merge",
    agent: "codex",
    status: "agent_running"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    taskId: task.id,
    path: "/tmp/worktree-demo",
    branch: "codex/fix-merge-entry",
    title: task.title,
    agent: task.agent
  });
  await store.updateTask(task.id, { worktreeId: worktree.id });

  const response = await fetch(`${baseUrl}/api/worktrees/${worktree.id}/merge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const body = await readJson(response);
  const updatedTask = (await store.listTasks()).find((item) => item.id === task.id);
  const updatedWorktree = (await store.listWorktrees(project.id)).find((item) => item.id === worktree.id);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0].project.id, project.id);
  assert.equal(mergeCalls[0].worktree.id, worktree.id);
  assert.equal(updatedTask.status, "merged");
  assert.equal(updatedWorktree.status, "merged");
  assert.equal(events.at(-1).type, "worktree.merged");
});

test("GET /api/dashboard recovers legacy task worktrees from session cwd", async (t) => {
  const branchQueries = [];
  const { store, baseUrl } = await withServer(t, {
    run: async (cmd, args, options) => {
      if (cmd === "git" && args.join(" ") === "branch --show-current") {
        branchQueries.push(options.cwd);
        return { ok: true, stdout: "codex/refactor-legacy\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
  });
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });
  const task = await store.createTask({
    projectId: project.id,
    title: "legacy refactor",
    prompt: "refactor",
    agent: "codex",
    status: "agent_running",
    sessionId: "sess_legacy"
  });
  await store.createSession({
    id: "sess_legacy",
    projectId: project.id,
    name: task.title,
    agent: task.agent,
    prompt: task.prompt,
    tmuxSessionName: "agw_task_legacy",
    cwd: "/tmp/demo-worktree",
    status: "running"
  });

  const response = await fetch(`${baseUrl}/api/dashboard`);
  const body = await readJson(response);
  const recoveredTask = body.tasks.find((item) => item.id === task.id);
  const recoveredWorktree = body.worktrees.find((item) => item.taskId === task.id);

  assert.equal(response.status, 200);
  assert.ok(recoveredTask.worktreeId);
  assert.ok(recoveredWorktree);
  assert.equal(recoveredWorktree.id, recoveredTask.worktreeId);
  assert.equal(recoveredWorktree.path, "/tmp/demo-worktree");
  assert.equal(recoveredWorktree.branch, "codex/refactor-legacy");
  assert.deepEqual(branchQueries, ["/tmp/demo-worktree"]);
});
