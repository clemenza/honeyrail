import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpContext } from "../server/mcp-server.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";

function stubTmux(overrides: Record<string, Function> = {}) {
  return {
    listSessions: async () => [],
    startSession: async () => {},
    sendInput: async () => {},
    sendKey: async () => {},
    sendLiteral: async () => {},
    killSession: async () => {},
    capture: async () => "session output here",
    stream: () => ({ stdout: { on() {} }, stderr: { on() {} }, kill() {} }),
    ...overrides
  };
}

function stubWorktrees(overrides: Record<string, Function> = {}) {
  return {
    create: async ({ project, title, agent }: any) => ({
      projectId: project.id,
      path: "/tmp/worktree-test",
      branch: `${agent}/${title}`,
      baseBranch: "main",
      baseRevision: "abc000",
      title,
      agent
    }),
    diff: async () => ({
      diff: "+added line",
      diffStat: " 1 file changed, 1 insertion(+)",
      status: "M  src/index.ts",
      commits: "abc123 initial commit"
    }),
    commit: async () => ({
      message: "complete task",
      headRevision: "abc123",
      stdout: "committed",
      stderr: ""
    }),
    runChecks: async () => ({
      ok: true,
      runs: [{
        command: "npm test",
        status: "passed",
        stdout: "ok",
        stderr: "",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      }]
    }),
    merge: async () => ({
      branch: "codex/task",
      targetBranch: "main",
      stdout: "merged",
      stderr: ""
    }),
    discard: async () => ({
      path: "/tmp/worktree-test",
      branch: "codex/task",
      branchDeleted: true
    }),
    ...overrides
  };
}

async function withMcp(t: TestContext, overrides: { tmux?: Record<string, Function>; worktrees?: Record<string, Function>; run?: Function } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-mcp-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));

  const ctx: McpContext = {
    store,
    bus,
    tmux: stubTmux(overrides.tmux) as any,
    worktrees: stubWorktrees(overrides.worktrees) as any,
    run: (overrides.run || (async () => ({ ok: true, stdout: "main\n", stderr: "" }))) as any,
    sessionLogRoot: join(tempDir, "sessions"),
    attachmentRoot: join(tempDir, "attachments")
  };

  const server = createMcpServer(ctx);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  t.after(async () => {
    await client.close();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  return { store, events, client };
}

function resultText(result: any): string {
  return result.content.map((c: any) => c.text).join("");
}

function resultJson(result: any): any {
  return JSON.parse(resultText(result));
}

test("list_projects returns empty list initially", async (t) => {
  const { client } = await withMcp(t);
  const result = await client.callTool({ name: "list_projects", arguments: {} });
  const body = resultJson(result);
  assert.deepEqual(body.projects, []);
});

test("create_project and list_projects round-trip", async (t) => {
  const { client, events } = await withMcp(t);
  const createResult = await client.callTool({
    name: "create_project",
    arguments: {
      name: "demo",
      repoPath: "/repo/demo",
      defaultAgent: "codex",
      testCommands: ["npm test"]
    }
  });
  const created = resultJson(createResult);
  assert.ok(created.project.id);
  assert.equal(created.project.name, "demo");
  assert.equal(created.project.repoPath, "/repo/demo");
  assert.equal(created.project.defaultAgent, "codex");

  const listResult = await client.callTool({ name: "list_projects", arguments: {} });
  const listed = resultJson(listResult);
  assert.equal(listed.projects.length, 1);
  assert.equal(listed.projects[0].id, created.project.id);
  assert.ok(events.some((e: any) => e.type === "project.created"));
});

test("create_session starts a tmux session and records it", async (t) => {
  const startCalls: any[] = [];
  const { client, store, events } = await withMcp(t, {
    tmux: {
      startSession: async (opts: any) => { startCalls.push(opts); }
    }
  });
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });

  const result = await client.callTool({
    name: "create_session",
    arguments: {
      projectId: project.id,
      agent: "claude",
      prompt: "fix the bug",
      name: "bug-fix session"
    }
  });
  const body = resultJson(result);
  assert.ok(body.session.id);
  assert.equal(body.session.agent, "claude");
  assert.equal(body.session.status, "running");
  assert.equal(body.session.prompt, "fix the bug");
  assert.equal(startCalls.length, 1);
  assert.match(startCalls[0].command, /claude --dangerously-skip-permissions --setting-sources user 'fix the bug'/);
  assert.ok(events.some((e: any) => e.type === "session.created"));
});

test("create_session rejects unknown persisted project default agents", async (t) => {
  const { client, store } = await withMcp(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "future-agent" as any
  });

  const result = await client.callTool({ name: "create_session", arguments: { projectId: project.id } });
  assert.match(resultText(result), /Unknown agent backend: future-agent/);
});

test("get_session_output returns terminal capture", async (t) => {
  const { client, store } = await withMcp(t, {
    tmux: {
      capture: async () => "$ npm test\nAll tests passed!"
    }
  });
  const session = await store.createSession({
    projectId: null,
    name: "test",
    agent: "shell",
    tmuxSessionName: "agw_test",
    cwd: "/tmp",
    status: "running"
  });

  const result = await client.callTool({
    name: "get_session_output",
    arguments: { sessionId: session.id }
  });
  assert.match(resultText(result), /All tests passed/);
});

test("send_session_input sends text to session", async (t) => {
  const inputCalls: any[] = [];
  const { client, store } = await withMcp(t, {
    tmux: {
      sendInput: async (_name: string, text: string) => { inputCalls.push(text); }
    }
  });
  const session = await store.createSession({
    projectId: null,
    name: "test",
    agent: "claude",
    tmuxSessionName: "agw_test",
    cwd: "/tmp",
    status: "waiting_input"
  });

  const result = await client.callTool({
    name: "send_session_input",
    arguments: { sessionId: session.id, text: "yes, proceed" }
  });
  const body = resultJson(result);
  assert.equal(body.ok, true);
  assert.deepEqual(inputCalls, ["yes, proceed"]);
});

test("send_session_input rejects when session is not accepting input", async (t) => {
  const { client, store } = await withMcp(t);
  const session = await store.createSession({
    projectId: null,
    name: "test",
    agent: "shell",
    tmuxSessionName: "agw_test",
    cwd: "/tmp",
    status: "failed"
  });

  const result = await client.callTool({
    name: "send_session_input",
    arguments: { sessionId: session.id, text: "hello" }
  });
  assert.match(resultText(result), /not accepting input/);
});

test("stop_session kills tmux and marks session killed", async (t) => {
  const killCalls: string[] = [];
  const { client, store, events } = await withMcp(t, {
    tmux: {
      killSession: async (name: string) => { killCalls.push(name); }
    }
  });
  const session = await store.createSession({
    projectId: null,
    name: "test",
    agent: "shell",
    tmuxSessionName: "agw_test_kill",
    cwd: "/tmp",
    status: "running"
  });

  const result = await client.callTool({
    name: "stop_session",
    arguments: { sessionId: session.id }
  });
  const body = resultJson(result);
  assert.equal(body.session.status, "killed");
  assert.deepEqual(killCalls, ["agw_test_kill"]);
  assert.ok(events.some((e: any) => e.type === "session.status_changed"));
});

test("create_agent_task provisions worktree, session, and starts agent", async (t) => {
  const startCalls: any[] = [];
  const { client, store, events } = await withMcp(t, {
    tmux: {
      startSession: async (opts: any) => { startCalls.push(opts); }
    }
  });
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex",
    testCommands: ["npm test"]
  });

  const result = await client.callTool({
    name: "create_agent_task",
    arguments: {
      projectId: project.id,
      prompt: "implement feature X",
      title: "feature-x",
      agent: "codex"
    }
  });
  const body = resultJson(result);
  assert.ok(body.task.id);
  assert.equal(body.task.status, "agent_running");
  assert.ok(body.worktree.id);
  assert.ok(body.session.id);
  assert.equal(body.task.worktreeId, body.worktree.id);
  assert.equal(body.task.sessionId, body.session.id);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].command, "codex 'implement feature X'");
  assert.ok(events.some((e: any) => e.type === "task.started"));
});

test("get_task_status returns task with linked session and worktree", async (t) => {
  const { client, store } = await withMcp(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });
  const task = await store.createTask({
    projectId: project.id,
    title: "status check",
    prompt: "check",
    agent: "codex",
    status: "agent_running"
  });
  const session = await store.createSession({
    projectId: project.id,
    name: "status check",
    agent: "codex",
    tmuxSessionName: "agw_test",
    cwd: "/tmp",
    status: "running"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    taskId: task.id,
    path: "/tmp/wt",
    branch: "codex/status-check",
    title: "status check",
    agent: "codex"
  });
  await store.updateTask(task.id, { sessionId: session.id, worktreeId: worktree.id });

  const result = await client.callTool({
    name: "get_task_status",
    arguments: { taskId: task.id }
  });
  const body = resultJson(result);
  assert.equal(body.task.id, task.id);
  assert.equal(body.task.status, "agent_running");
  assert.ok(body.session);
  assert.ok(body.worktree);
});

test("get_worktree_diff returns diff information", async (t) => {
  const { client, store } = await withMcp(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    path: "/tmp/wt",
    branch: "codex/diff-test",
    title: "diff test",
    agent: "codex"
  });

  const result = await client.callTool({
    name: "get_worktree_diff",
    arguments: { worktreeId: worktree.id }
  });
  const body = resultJson(result);
  assert.equal(body.worktreeId, worktree.id);
  assert.equal(body.branch, "codex/diff-test");
  assert.ok(body.diff !== undefined);
  assert.ok(body.diffStat !== undefined);
});

test("run_checks executes commands and updates worktree status", async (t) => {
  const { client, store, events } = await withMcp(t, {
    worktrees: {
      runChecks: async () => ({
        ok: false,
        runs: [{
          command: "npm test",
          status: "failed",
          exitCode: 1,
          stdout: "",
          stderr: "1 test failed",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString()
        }]
      })
    }
  });
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex",
    testCommands: ["npm test"]
  });
  const task = await store.createTask({
    projectId: project.id,
    title: "check test",
    prompt: "test",
    agent: "codex",
    status: "ready_to_merge"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    taskId: task.id,
    path: "/tmp/wt",
    branch: "codex/checks",
    title: "check test",
    agent: "codex"
  });
  await store.updateTask(task.id, { worktreeId: worktree.id });

  const result = await client.callTool({
    name: "run_checks",
    arguments: { worktreeId: worktree.id }
  });
  const body = resultJson(result);
  assert.equal(body.ok, false);
  assert.equal(body.checkRuns[0].status, "failed");
  const updated = await store.getWorktree(worktree.id);
  assert.equal(updated!.status, "checks_failed");
  assert.ok(events.some((e: any) => e.type === "worktree.checks_failed"));
});

test("propose_merge returns diff summary without merging", async (t) => {
  const mergeCalls: any[] = [];
  const { client, store } = await withMcp(t, {
    worktrees: {
      merge: async (input: any) => { mergeCalls.push(input); return { branch: "x", targetBranch: "main" }; }
    }
  });
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    path: "/tmp/wt",
    branch: "codex/propose",
    baseBranch: "main",
    title: "propose test",
    agent: "codex",
    status: "committed"
  });

  const result = await client.callTool({
    name: "propose_merge",
    arguments: { worktreeId: worktree.id }
  });
  const body = resultJson(result);
  assert.ok(body.proposal);
  assert.equal(body.proposal.branch, "codex/propose");
  assert.equal(body.proposal.targetBranch, "main");
  assert.ok(body.proposal.diffStat !== undefined);
  assert.equal(mergeCalls.length, 0, "propose_merge must NOT call merge");
});

test("approve_merge performs the actual merge", async (t) => {
  const mergeCalls: any[] = [];
  const { client, store, events } = await withMcp(t, {
    worktrees: {
      merge: async (input: any) => {
        mergeCalls.push(input);
        return { branch: input.worktree.branch, targetBranch: "main", stdout: "ok", stderr: "" };
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
    title: "merge test",
    prompt: "merge",
    agent: "codex",
    status: "ready_to_merge"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    taskId: task.id,
    path: "/tmp/wt",
    branch: "codex/merge-test",
    title: "merge test",
    agent: "codex"
  });
  await store.updateTask(task.id, { worktreeId: worktree.id });

  const result = await client.callTool({
    name: "approve_merge",
    arguments: { worktreeId: worktree.id }
  });
  const body = resultJson(result);
  assert.equal(body.ok, true);
  assert.equal(mergeCalls.length, 1);
  const updatedTask = await store.getTask(task.id);
  assert.equal(updatedTask!.status, "merged");
  const updatedWorktree = await store.getWorktree(worktree.id);
  assert.equal(updatedWorktree!.status, "merged");
  assert.ok(events.some((e: any) => e.type === "worktree.merged"));
});

test("commit_worktree stages and commits changes", async (t) => {
  const commitCalls: any[] = [];
  const { client, store, events } = await withMcp(t, {
    worktrees: {
      commit: async (input: any) => {
        commitCalls.push(input);
        return { message: input.message || "auto", headRevision: "def456", stdout: "", stderr: "" };
      }
    }
  });
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });
  const worktree = await store.createWorktree({
    projectId: project.id,
    path: "/tmp/wt",
    branch: "codex/commit-test",
    title: "commit test",
    agent: "codex"
  });

  const result = await client.callTool({
    name: "commit_worktree",
    arguments: { worktreeId: worktree.id, message: "feat: add feature" }
  });
  const body = resultJson(result);
  assert.equal(body.ok, true);
  assert.equal(commitCalls[0].message, "feat: add feature");
  const updated = await store.getWorktree(worktree.id);
  assert.equal(updated!.status, "committed");
  assert.equal(updated!.headRevision, "def456");
  assert.ok(events.some((e: any) => e.type === "worktree.committed"));
});

test("get_dashboard returns full gateway state", async (t) => {
  const { client, store } = await withMcp(t);
  await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });

  const result = await client.callTool({
    name: "get_dashboard",
    arguments: {}
  });
  const body = resultJson(result);
  assert.ok(Array.isArray(body.projects));
  assert.ok(Array.isArray(body.sessions));
  assert.ok(Array.isArray(body.tasks));
  assert.ok(Array.isArray(body.worktrees));
  assert.ok(Array.isArray(body.events));
  assert.equal(body.projects.length, 1);
});

test("list_sessions filters by projectId", async (t) => {
  const { client, store } = await withMcp(t);
  const p1 = await store.createProject({ name: "p1", repoPath: "/p1", defaultBranch: "main", defaultAgent: "shell" });
  const p2 = await store.createProject({ name: "p2", repoPath: "/p2", defaultBranch: "main", defaultAgent: "shell" });
  await store.createSession({ projectId: p1.id, name: "s1", agent: "shell", tmuxSessionName: "t1", cwd: "/p1", status: "running" });
  await store.createSession({ projectId: p2.id, name: "s2", agent: "shell", tmuxSessionName: "t2", cwd: "/p2", status: "running" });

  const result = await client.callTool({
    name: "list_sessions",
    arguments: { projectId: p1.id }
  });
  const body = resultJson(result);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].name, "s1");
});

test("list_tasks filters by projectId", async (t) => {
  const { client, store } = await withMcp(t);
  const p1 = await store.createProject({ name: "p1", repoPath: "/p1", defaultBranch: "main", defaultAgent: "codex" });
  await store.createTask({ projectId: p1.id, title: "t1", agent: "codex", status: "agent_running" });
  await store.createTask({ projectId: "other_proj", title: "t2", agent: "codex", status: "agent_running" });

  const result = await client.callTool({
    name: "list_tasks",
    arguments: { projectId: p1.id }
  });
  const body = resultJson(result);
  assert.equal(body.tasks.length, 1);
  assert.equal(body.tasks[0].title, "t1");
});

test("server advertises all tools via listTools", async (t) => {
  const { client } = await withMcp(t);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "approve_merge",
    "commit_worktree",
    "create_agent_task",
    "create_project",
    "create_session",
    "delete_session",
    "get_dashboard",
    "get_session_output",
    "get_task_status",
    "get_worktree_diff",
    "list_projects",
    "list_sessions",
    "list_tasks",
    "propose_merge",
    "run_checks",
    "send_session_input",
    "stop_session"
  ]);
});
