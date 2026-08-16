import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { recoverLegacyTaskWorktrees } from "../server/project-helpers.js";
import { JsonStore } from "../server/store.js";
import { runCommandSafe } from "../server/utils.js";
import { WorktreeManager } from "../server/worktrees.js";

async function withServer(t: TestContext, { worktrees, run, tmux }: { worktrees?: any; run?: any; tmux?: any } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-worktree-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));

  const app = createApp({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      startSession: async () => {},
      sendInput: async () => {},
      killSession: async () => {},
      capture: async () => "",
      ...(tmux || {})
    },
    worktrees: {
      create: async ({ project, title, agent }: any) => ({
        projectId: project.id,
        path: join(tempDir, "worktree"),
        branch: `${agent}/${title}`,
        title,
        agent
      }),
      merge: async () => ({ branch: "codex/task", targetBranch: "main" }),
      commit: async () => ({ message: "complete task", headRevision: "abc123", stdout: "", stderr: "" }),
      runChecks: async () => ({ ok: true, runs: [{ command: "npm test", status: "passed", stdout: "ok", stderr: "", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }] }),
      discard: async () => ({ path: join(tempDir, "worktree"), branch: "codex/task", branchDeleted: true }),
      diff: async () => ({ diff: "", diffStat: "", status: "", commits: "" }),
      ...(worktrees || {})
    },
    run: run || (async () => ({ ok: true, stdout: "main\n", stderr: "" })),
    token: null,
    attachmentRoot: join(tempDir, "attachments")
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { store, events, baseUrl };
}

async function readJson(response: Response) {
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
  const mergeCalls: any[] = [];
  const { store, events, baseUrl } = await withServer(t, {
    worktrees: {
      merge: async (input: any) => {
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
  assert.equal(updatedTask!.status, "merged");
  assert.equal(updatedWorktree!.status, "merged");
  assert.equal(events.at(-1).type, "worktree.merged");
});

test("POST /api/worktrees/:id/commit commits changes and marks task ready to merge", async (t) => {
  const commitCalls: any[] = [];
  const { store, events, baseUrl } = await withServer(t, {
    worktrees: {
      commit: async (input: any) => {
        commitCalls.push(input);
        return { message: input.message || "complete task", headRevision: "abc123", stdout: "committed", stderr: "" };
      }
    }
  });
  const project = await store.createProject({ name: "demo", repoPath: "/repo/demo", defaultBranch: "main", defaultAgent: "codex" });
  const task = await store.createTask({ projectId: project.id, title: "ready", prompt: "done", agent: "codex", status: "agent_running" });
  const worktree = await store.createWorktree({ projectId: project.id, taskId: task.id, path: "/tmp/worktree-demo", branch: "codex/ready", title: task.title, agent: task.agent });
  await store.updateTask(task.id, { worktreeId: worktree.id });

  const response = await fetch(`${baseUrl}/api/worktrees/${worktree.id}/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "finish task" })
  });
  const body = await readJson(response);
  const updatedTask = await store.getTask(task.id);
  const updatedWorktree = await store.getWorktree(worktree.id);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(commitCalls[0].message, "finish task");
  assert.equal(updatedWorktree!.status, "committed");
  assert.equal(updatedWorktree!.headRevision, "abc123");
  assert.equal(updatedTask!.status, "ready_to_merge");
  assert.equal(events.at(-1).type, "worktree.committed");
});

test("POST /api/worktrees/:id/checks records check runs and updates task status", async (t) => {
  const { store, events, baseUrl } = await withServer(t, {
    worktrees: {
      runChecks: async () => ({ ok: false, runs: [{ command: "npm test", status: "failed", exitCode: 1, stdout: "", stderr: "failed", startedAt: "s", finishedAt: "f" }] })
    }
  });
  const project = await store.createProject({ name: "demo", repoPath: "/repo/demo", defaultBranch: "main", defaultAgent: "codex", testCommands: ["npm test"] });
  const task = await store.createTask({ projectId: project.id, title: "checks", prompt: "test", agent: "codex", status: "ready_to_merge" });
  const worktree = await store.createWorktree({ projectId: project.id, taskId: task.id, path: "/tmp/worktree-demo", branch: "codex/checks", title: task.title, agent: task.agent });
  await store.updateTask(task.id, { worktreeId: worktree.id });

  const response = await fetch(`${baseUrl}/api/worktrees/${worktree.id}/checks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const body = await readJson(response);
  const updatedTask = await store.getTask(task.id);
  const updatedWorktree = await store.getWorktree(worktree.id);

  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(updatedWorktree!.status, "checks_failed");
  assert.equal(updatedTask!.status, "checks_failed");
  assert.equal(updatedTask!.checkRuns!.length, 1);
  assert.equal(events.at(-1).type, "worktree.checks_failed");
});

test("POST /api/worktrees/:id/discard discards worktree and cancels task", async (t) => {
  const discardCalls: any[] = [];
  const { store, events, baseUrl } = await withServer(t, {
    worktrees: {
      discard: async (input: any) => {
        discardCalls.push(input);
        return { path: input.worktree.path, branch: input.worktree.branch, branchDeleted: true };
      }
    }
  });
  const project = await store.createProject({ name: "demo", repoPath: "/repo/demo", defaultBranch: "main", defaultAgent: "codex" });
  const task = await store.createTask({ projectId: project.id, title: "discard", prompt: "drop", agent: "codex", status: "agent_running" });
  const worktree = await store.createWorktree({ projectId: project.id, taskId: task.id, path: "/tmp/worktree-demo", branch: "codex/discard", title: task.title, agent: task.agent });
  await store.updateTask(task.id, { worktreeId: worktree.id });

  const response = await fetch(`${baseUrl}/api/worktrees/${worktree.id}/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force: true })
  });
  const body = await readJson(response);
  const updatedTask = await store.getTask(task.id);
  const updatedWorktree = await store.getWorktree(worktree.id);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(discardCalls[0].force, true);
  assert.equal(updatedWorktree!.status, "discarded");
  assert.equal(updatedTask!.status, "cancelled");
  assert.equal(events.at(-1).type, "worktree.discarded");
});

test("startup recovery migrates legacy task worktrees from session cwd", async (t) => {
  const branchQueries: string[] = [];
  const run = async (cmd: string, args: string[], options: any) => {
    if (cmd === "git" && args.join(" ") === "branch --show-current") {
      branchQueries.push(options.cwd);
      return { ok: true, stdout: "codex/refactor-legacy\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const { store, baseUrl } = await withServer(t, { run });
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

  await recoverLegacyTaskWorktrees(store, run as any);

  const response = await fetch(`${baseUrl}/api/dashboard`);
  const body = await readJson(response);
  const recoveredTask = body.tasks.find((item: any) => item.id === task.id);
  const recoveredWorktree = body.worktrees.find((item: any) => item.taskId === task.id);

  assert.equal(response.status, 200);
  assert.ok(recoveredTask.worktreeId);
  assert.ok(recoveredWorktree);
  assert.equal(recoveredWorktree.id, recoveredTask.worktreeId);
  assert.equal(recoveredWorktree.path, "/tmp/demo-worktree");
  assert.equal(recoveredWorktree.branch, "codex/refactor-legacy");
  assert.deepEqual(branchQueries, ["/tmp/demo-worktree"]);
});

test("POST /api/tasks marks task and worktree failed when tmux start fails", async (t) => {
  const { store, events, baseUrl } = await withServer(t, {
    tmux: {
      startSession: async () => {
        throw new Error("tmux start failed");
      }
    }
  });
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
      title: "fix task startup",
      prompt: "start the task",
      agent: "codex"
    })
  });
  const body = await readJson(response);
  const [task] = await store.listTasks();
  const [worktree] = await store.listWorktrees(project.id);

  assert.equal(response.status, 500);
  assert.equal(body.error, "tmux start failed");
  assert.equal(task.status, "failed");
  assert.equal(task.error, "tmux start failed");
  assert.equal(task.worktreeId, worktree.id);
  assert.equal(worktree.status, "failed");
  assert.equal(worktree.error, "tmux start failed");
  assert.equal(events.at(-1).type, "task.failed");
});

test("GET /api/sessions/:id/output cascades missing tmux pane failure to task and worktree", async (t) => {
  const { store, events, baseUrl } = await withServer(t, {
    tmux: {
      capture: async () => {
        throw new Error("can't find pane: agw_task_missing");
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
    title: "lost pane",
    prompt: "run",
    agent: "codex",
    status: "agent_running"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    taskId: task.id,
    path: "/tmp/lost-pane",
    branch: "codex/lost-pane",
    title: task.title,
    agent: task.agent
  });
  const session = await store.createSession({
    projectId: project.id,
    worktreeId: worktree.id,
    name: task.title,
    agent: task.agent,
    prompt: task.prompt,
    tmuxSessionName: "agw_task_missing",
    cwd: worktree.path,
    status: "running"
  });
  await store.updateTask(task.id, { worktreeId: worktree.id, sessionId: session.id });

  const response = await fetch(`${baseUrl}/api/sessions/${session.id}/output`);
  const body = await readJson(response);
  const updatedTask = (await store.listTasks()).find((item) => item.id === task.id);
  const updatedWorktree = await store.getWorktree(worktree.id);
  const updatedSession = await store.getSession(session.id);

  assert.equal(response.status, 200);
  assert.match(body.output, /capture unavailable: can't find pane/);
  assert.equal(updatedSession!.status, "failed");
  assert.equal(updatedTask!.status, "failed");
  assert.equal(updatedWorktree!.status, "failed");
  assert.equal(events.at(-1).type, "session.status_changed");
  assert.equal(events.at(-1).taskId, task.id);
});

test("WorktreeManager.diff uses base revision when available", async () => {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const manager = new WorktreeManager({
    root: "/tmp/worktrees",
    run: async (cmd, args = [], options = {}) => {
      calls.push({ cmd, args, cwd: options.cwd });
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  await manager.diff({ path: "/repo/worktree", branch: "codex/test", baseRevision: "base123" });

  // Single-ref form (no "..HEAD") so the diff includes uncommitted working
  // tree changes, not just commits - see the comment in WorktreeManager.diff.
  assert.ok(calls.some((call) => call.args.join(" ") === "diff base123"));
  assert.ok(calls.some((call) => call.args.join(" ") === "diff --stat base123"));
});

test("WorktreeManager.diff reports uncommitted changes against a real repo, not just commits", async (t) => {
  // Regression test for the underlying bug: a task's changes are almost
  // always left uncommitted (the agent doesn't commit on its own), so a
  // diff scoped to "baseRevision..HEAD" was always empty - agent-task's
  // completion artifact (server/executors/agent-task.ts) never had a diff
  // to record, and every StepContract `produces: [diff]` recipe failed on
  // its very first attempt.
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-diff-uncommitted-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const repoPath = join(tempDir, "repo");
  await mkdir(repoPath, { recursive: true });
  await runCommandSafe("git", ["init"], { cwd: repoPath });
  await runCommandSafe("git", ["checkout", "-B", "main"], { cwd: repoPath });
  await runCommandSafe("git", ["config", "user.email", "e2e@example.com"], { cwd: repoPath });
  await runCommandSafe("git", ["config", "user.name", "E2E"], { cwd: repoPath });
  await writeFile(join(repoPath, "README.md"), "# fixture\n");
  await runCommandSafe("git", ["add", "-A"], { cwd: repoPath });
  await runCommandSafe("git", ["commit", "-m", "initial"], { cwd: repoPath });
  const baseRevision = (await runCommandSafe("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();

  // Uncommitted change, mirroring how an agent leaves its work.
  await writeFile(join(repoPath, "fizzbuzz.py"), "def fizzbuzz(n):\n    return str(n)\n");

  const manager = new WorktreeManager({ root: tempDir, run: runCommandSafe });
  const result = await manager.diff({ path: repoPath, branch: "main", baseRevision });

  assert.match(result.diff, /fizzbuzz\.py/);
  assert.match(result.diff, /\+def fizzbuzz\(n\)/);
  assert.match(result.diffStat, /fizzbuzz\.py/);
});

test("WorktreeManager.merge ignores untracked files in the project repo", async () => {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const manager = new WorktreeManager({
    root: "/tmp/worktrees",
    run: async (cmd, args = [], options = {}) => {
      calls.push({ cmd, args, cwd: options.cwd });
      if (cmd === "git" && args[0] === "status" && options.cwd === "/repo/project") {
        if (args.includes("--untracked-files=no")) {
          return { ok: true, stdout: "", stderr: "" };
        }
        return { ok: true, stdout: "?? .omc/\n?? .remember/\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "status" && options.cwd === "/repo/worktree") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "branch --show-current") {
        return { ok: true, stdout: "main\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "merge") {
        return { ok: true, stdout: "merged\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  const result = await manager.merge({
    project: { repoPath: "/repo/project" } as any,
    worktree: { path: "/repo/worktree", branch: "codex/refactor" }
  });

  assert.equal(result.targetBranch, "main");
  assert.ok(calls.some((call) => call.cwd === "/repo/project" && call.args.includes("--untracked-files=no")));
});

test("WorktreeManager.merge restores the original project branch when merge fails", async () => {
  const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const manager = new WorktreeManager({
    root: "/tmp/worktrees",
    run: async (cmd, args = [], options = {}) => {
      calls.push({ cmd, args, cwd: options.cwd });
      if (cmd === "git" && args.join(" ") === "branch --show-current") {
        return { ok: true, stdout: "feature/current\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "status") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "merge" && args[1] !== "--abort") {
        return { ok: false, stdout: "", stderr: "conflict", code: 1 };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  await assert.rejects(
    manager.merge({
      project: { repoPath: "/repo/project" } as any,
      worktree: { path: "/repo/worktree", branch: "codex/conflict" },
      targetBranch: "main"
    }),
    /conflict/
  );

  assert.ok(calls.some((call) => call.cwd === "/repo/project" && call.args.join(" ") === "checkout main"));
  assert.ok(calls.some((call) => call.cwd === "/repo/project" && call.args.join(" ") === "merge --abort"));
  assert.ok(calls.some((call) => call.cwd === "/repo/project" && call.args.join(" ") === "checkout feature/current"));
});

test("WorktreeManager.merge serializes merges for the same project repository", async () => {
  let activeMerges = 0;
  let maxActiveMerges = 0;
  const manager = new WorktreeManager({
    root: "/tmp/worktrees",
    run: async (cmd, args = [], options = {}) => {
      if (cmd === "git" && args[0] === "status") {
        return { ok: true, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args.join(" ") === "branch --show-current") {
        return { ok: true, stdout: "main\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "merge") {
        activeMerges += 1;
        maxActiveMerges = Math.max(maxActiveMerges, activeMerges);
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeMerges -= 1;
        return { ok: true, stdout: "merged\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    }
  });

  await Promise.all([
    manager.merge({ project: { repoPath: "/repo/project" } as any, worktree: { path: "/repo/worktree-a", branch: "codex/a" } }),
    manager.merge({ project: { repoPath: "/repo/project" } as any, worktree: { path: "/repo/worktree-b", branch: "codex/b" } })
  ]);

  assert.equal(maxActiveMerges, 1);
});
