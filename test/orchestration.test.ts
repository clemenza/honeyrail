import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { ExecutorRegistry } from "../server/executors/registry.js";
import { AgentTaskExecutor } from "../server/executors/agent-task.js";
import { CheckExecutor } from "../server/executors/check.js";
import { ShellExecutor } from "../server/executors/shell.js";
import type { ExecutionHandle, ExecutionState, Executor, StepExecutionContext } from "../server/executors/types.js";
import { EventBus, publishEvent } from "../server/events.js";
import { validateStepGraph } from "../server/orchestration/dag.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import { assertStepTransition, deriveRunStatus } from "../server/orchestration/state-machine.js";
import { JsonStore } from "../server/store.js";
import { runCommandSafe } from "../server/utils.js";

class MemoryExecutor implements Executor {
  type: string;
  starts = 0;
  states: ExecutionState[];

  constructor(type: string, states: ExecutionState[] = [{ status: "succeeded", output: { ok: true } }]) {
    this.type = type;
    this.states = [...states];
  }

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    this.starts += 1;
    return { executor: this.type, stepId: ctx.step.id, worktreeId: ctx.step.input.worktreeId };
  }

  async inspect(): Promise<ExecutionState> {
    return this.states.shift() || { status: "succeeded", output: { ok: true } };
  }
}

class ApprovalTestExecutor implements Executor {
  type = "approval";
  starts = 0;
  async start(): Promise<ExecutionHandle> {
    this.starts += 1;
    return { waitingApproval: true };
  }
  async inspect(): Promise<ExecutionState> {
    return { status: "waiting_approval" };
  }
}

class RestartCompletesExecutor implements Executor {
  type = "agent";
  starts = 0;
  complete = false;
  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    this.starts += 1;
    return { executor: this.type, stepId: ctx.step.id, worktreeId: "wt_running" };
  }
  async inspect(): Promise<ExecutionState> {
    if (!this.complete) return { status: "running" };
    return { status: "succeeded", output: { worktreeId: "wt_done" } };
  }
}

async function waitForTerminalShell(executor: ShellExecutor, ctx: StepExecutionContext, handle: ExecutionHandle) {
  let state: ExecutionState = { status: "running" };
  for (let i = 0; i < 100; i += 1) {
    state = await executor.inspect(ctx, handle);
    if (state.status !== "running") return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return state;
}

async function withService(t: TestContext, registry?: ExecutorRegistry) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-orchestration-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new OrchestrationService({
    store,
    bus,
    tmux: { listSessions: async () => [], startSession: async () => {}, killSession: async () => {}, capture: async () => "", sendInput: async () => {} } as any,
    worktrees: { create: async () => ({}), runChecks: async () => ({ ok: true, runs: [] }) } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: join(tempDir, "sessions"),
    attachmentRoot: join(tempDir, "attachments"),
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: ["npm test"], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  return { store, service, project, events };
}

test("state machine rejects invalid step transitions and derives terminal run state", () => {
  assert.doesNotThrow(() => assertStepTransition("pending", "ready"));
  assert.throws(() => assertStepTransition("succeeded", "running"), /Invalid step transition/);
  assert.equal(deriveRunStatus([{ id: "a", runId: "r", name: "A", executor: "x", input: {}, dependsOn: [], status: "succeeded", attempt: 1, maxAttempts: 1, createdAt: "now" }]), "succeeded");
  assert.equal(deriveRunStatus([{ id: "a", runId: "r", name: "A", executor: "x", input: {}, dependsOn: [], status: "waiting_approval", attempt: 1, maxAttempts: 1, createdAt: "now" }]), "waiting_approval");
});

test("DAG validation rejects unknown dependencies, duplicate ids, cycles, and unknown executors", () => {
  const registry = new ExecutorRegistry([new MemoryExecutor("ok")]);
  assert.throws(() => validateStepGraph([{ id: "a", executor: "ok" }, { id: "a", executor: "ok" }], registry), /Duplicate step id/);
  assert.throws(() => validateStepGraph([{ id: "a", executor: "ok", dependsOn: ["missing"] }], registry), /unknown step/);
  assert.throws(() => validateStepGraph([{ id: "a", executor: "ok", dependsOn: ["b"] }, { id: "b", executor: "ok", dependsOn: ["a"] }], registry), /cycle/);
  assert.throws(() => validateStepGraph([{ id: "a", executor: "missing" }], registry), /Unknown executor/);
});

test("scheduler executes a linear DAG, a branched DAG, and blocks downstream on failure", async (t) => {
  const ok = new MemoryExecutor("ok");
  const fail = new MemoryExecutor("fail", [{ status: "failed", error: "boom" }]);
  const registry = new ExecutorRegistry([ok, fail]);
  const { service, project } = await withService(t, registry);

  const linear = await service.createRun({
    projectId: project.id,
    goal: "linear",
    steps: [
      { id: "a", executor: "ok" },
      { id: "b", executor: "ok", dependsOn: ["a"] }
    ]
  });
  assert.equal(linear.run.status, "succeeded");
  assert.deepEqual(linear.steps.map((step) => step.status), ["succeeded", "succeeded"]);

  const branched = await service.createRun({
    projectId: project.id,
    goal: "branched",
    steps: [
      { id: "a", executor: "ok" },
      { id: "b", executor: "ok", dependsOn: ["a"] },
      { id: "c", executor: "ok", dependsOn: ["a"] }
    ]
  });
  assert.equal(branched.run.status, "succeeded");
  assert.equal(branched.steps.filter((step) => step.status === "succeeded").length, 3);

  const failed = await service.createRun({
    projectId: project.id,
    goal: "failure",
    steps: [
      { id: "a", executor: "fail" },
      { id: "b", executor: "ok", dependsOn: ["a"] }
    ]
  });
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.steps.find((step) => step.id === "b")!.status, "skipped");
});

test("bounded retry retries failures without rerunning successful steps", async (t) => {
  const flaky = new MemoryExecutor("flaky", [{ status: "failed", error: "first" }, { status: "succeeded", output: { ok: true } }]);
  const registry = new ExecutorRegistry([flaky]);
  const { service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "retry",
    steps: [{ id: "a", executor: "flaky", maxAttempts: 2 }]
  });

  assert.equal(result.run.status, "succeeded");
  assert.equal(result.steps[0].attempt, 2);
  assert.equal(flaky.starts, 2);
});

test("approval survives recovery and continues only after explicit approval", async (t) => {
  const approval = new ApprovalTestExecutor();
  const ok = new MemoryExecutor("ok");
  const registry = new ExecutorRegistry([approval, ok]);
  const { store, service, project } = await withService(t, registry);

  const created = await service.createRun({
    projectId: project.id,
    goal: "approval",
    steps: [
      { id: "approve", executor: "approval" },
      { id: "after", executor: "ok", dependsOn: ["approve"] }
    ]
  });
  assert.equal(created.run.status, "waiting_approval");
  assert.equal(created.steps.find((step) => step.id === "approve")!.status, "waiting_approval");

  const restarted = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  await restarted.recover();
  assert.equal((await store.getStep(created.run.id, "approve"))!.status, "waiting_approval");
  await restarted.approveStep(created.run.id, "approve");
  assert.equal((await store.getRun(created.run.id))!.status, "succeeded");
  assert.equal((await store.getStep(created.run.id, "after"))!.status, "succeeded");
});

test("recovery does not duplicate running agent task steps and schedules successors after completion", async (t) => {
  const agent = new RestartCompletesExecutor();
  const shell = new MemoryExecutor("shell");
  const registry = new ExecutorRegistry([agent, shell]);
  const { store, service, project } = await withService(t, registry);
  const created = await service.createRun({
    projectId: project.id,
    goal: "recover",
    steps: [
      { id: "agent", executor: "agent" },
      { id: "shell", executor: "shell", dependsOn: ["agent"] }
    ]
  });
  assert.equal((await store.getStep(created.run.id, "agent"))!.status, "running");
  assert.equal(agent.starts, 1);

  agent.complete = true;
  const restarted = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  await restarted.recover();
  assert.equal(agent.starts, 1);
  assert.equal((await store.getStep(created.run.id, "agent"))!.status, "succeeded");
  assert.equal((await store.getStep(created.run.id, "shell"))!.status, "succeeded");
});

test("required M1 demonstration workflow composes agent, shell, agent, check, and approval steps", async (t) => {
  const agent = new MemoryExecutor("agent-task", [{ status: "succeeded", output: { worktreeId: "wt_a" } }, { status: "succeeded", output: { worktreeId: "wt_c" } }]);
  const shell = new MemoryExecutor("shell");
  const check = new MemoryExecutor("check");
  const approval = new ApprovalTestExecutor();
  const registry = new ExecutorRegistry([agent, shell, check, approval]);
  const { service, project } = await withService(t, registry);

  const created = await service.createRun({
    projectId: project.id,
    goal: "demo",
    steps: [
      { id: "a", name: "Agent A", executor: "agent-task" },
      { id: "b", name: "Shell B", executor: "shell", dependsOn: ["a"] },
      { id: "c", name: "Agent C", executor: "agent-task", dependsOn: ["b"] },
      { id: "d", name: "Check D", executor: "check", dependsOn: ["c"] },
      { id: "e", name: "Approval E", executor: "approval", dependsOn: ["d"] }
    ]
  });

  assert.equal(created.run.status, "waiting_approval");
  assert.deepEqual(created.steps.map((step) => step.status), ["succeeded", "succeeded", "succeeded", "succeeded", "waiting_approval"]);
  await service.approveStep(created.run.id, "e");
  assert.equal((await service.getRunDetail(created.run.id))!.run.status, "succeeded");
});

test("AgentTaskExecutor creates one task, links execution refs, and recovery inspect does not duplicate it", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-executor-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      startSession: async () => {},
      killSession: async () => {},
      capture: async () => "",
      sendInput: async () => {}
    } as any,
    worktrees: {
      create: async ({ project, title, agent }: any) => ({
        projectId: project.id,
        path: join(tempDir, "wt"),
        branch: `${agent}/${title}`,
        baseBranch: "main",
        baseRevision: "base",
        title,
        agent
      })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: join(tempDir, "sessions"),
    attachmentRoot: join(tempDir, "attachments"),
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "agent",
    steps: [{ id: "agent", executor: "agent-task", input: { agent: "shell", prompt: "do work" } }]
  });
  const step = (await store.getStep(created.run.id, "agent"))!;
  assert.equal(step.status, "running");
  assert.ok(step.executionRef?.taskId);
  assert.ok(step.executionRef?.sessionId);
  assert.ok(step.executionRef?.worktreeId);
  assert.equal((await store.listTasks()).length, 1);

  await store.updateTask(String(step.executionRef.taskId), { status: "ready_to_merge" });
  const restarted = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  await restarted.recover();
  assert.equal((await store.listTasks()).length, 1);
  assert.equal((await store.getStep(created.run.id, "agent"))!.status, "succeeded");
});

test("task.failed immediately fails the linked agent step and run without a restart", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor(), new MemoryExecutor("check")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-failure-event-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {
      startSession: async () => {},
      killSession: async () => {}
    } as any,
    worktrees: {
      create: async ({ project, title, agent }: any) => ({
        projectId: project.id,
        path: join(tempDir, "wt"),
        branch: `${agent}/${title}`,
        baseBranch: "main",
        baseRevision: "base",
        title,
        agent
      })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: join(tempDir, "sessions"),
    attachmentRoot: join(tempDir, "attachments"),
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "propagate agent failure",
    steps: [
      { id: "implement", executor: "agent-task", input: { agent: "codex", prompt: "do work" } },
      { id: "verify", executor: "check", dependsOn: ["implement"] }
    ]
  });
  const implement = (await store.getStep(created.run.id, "implement"))!;
  const taskId = String(implement.executionRef?.taskId);
  const reason = "Codex CLI is too old. Upgrade it, then start a new task.";
  await store.updateTask(taskId, { status: "failed", failedAt: new Date().toISOString(), error: reason });
  await publishEvent(store, bus, {
    type: "task.failed",
    projectId: project.id,
    taskId,
    payload: { reason }
  });

  for (let attempt = 0; attempt < 50 && (await store.getRun(created.run.id))?.status !== "failed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal((await store.getRun(created.run.id))!.status, "failed");
  assert.equal((await store.getStep(created.run.id, "implement"))!.status, "failed");
  assert.equal((await store.getStep(created.run.id, "implement"))!.error, reason);
  assert.equal((await store.getStep(created.run.id, "verify"))!.status, "skipped");
});

test("task.completed immediately advances the linked agent step to approval", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor(), new MemoryExecutor("check"), new ApprovalTestExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-completion-event-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: { startSession: async () => {}, killSession: async () => {} } as any,
    worktrees: {
      create: async ({ project, title, agent }: any) => ({
        projectId: project.id,
        path: join(tempDir, "wt"),
        branch: `${agent}/${title}`,
        baseBranch: "main",
        baseRevision: "base",
        title,
        agent
      })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: join(tempDir, "sessions"),
    attachmentRoot: join(tempDir, "attachments"),
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "propagate agent completion",
    steps: [
      { id: "implement", executor: "agent-task", input: { agent: "codex", prompt: "do work" } },
      { id: "verify", executor: "check", dependsOn: ["implement"] },
      { id: "approve", executor: "approval", dependsOn: ["verify"] }
    ]
  });
  const implement = (await store.getStep(created.run.id, "implement"))!;
  const taskId = String(implement.executionRef?.taskId);
  await store.updateTask(taskId, { status: "done" });
  await publishEvent(store, bus, {
    type: "task.completed",
    projectId: project.id,
    taskId,
    payload: { status: "done" }
  });

  for (let attempt = 0; attempt < 50 && (await store.getRun(created.run.id))?.status !== "waiting_approval"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal((await store.getStep(created.run.id, "implement"))!.status, "succeeded");
  assert.equal((await store.getStep(created.run.id, "verify"))!.status, "succeeded");
  assert.equal((await store.getStep(created.run.id, "approve"))!.status, "waiting_approval");
  assert.equal((await store.getRun(created.run.id))!.status, "waiting_approval");
});

test("ShellExecutor captures success, non-zero failure, timeout, and restart disappearance semantics", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-shell-executor-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: [], runCommands: [] });
  const executor = new ShellExecutor();
  const baseStep = await store.createStep({ id: "shell", runId: "run_test", name: "Shell", executor: "shell", input: { command: "printf ok", cwd: tempDir }, status: "running" });
  const ctx = { store, bus: new EventBus(), tmux: {} as any, worktrees: {} as any, runCommand: runCommandSafe, project, runId: "run_test", step: baseStep, sessionLogRoot: "", attachmentRoot: "" };

  const successHandle = await executor.start(ctx);
  const success = await waitForTerminalShell(executor, ctx, successHandle);
  assert.equal(success.status, "succeeded");
  assert.equal(success.output?.stdout, "ok");

  const failedStep = { ...baseStep, id: "fail", input: { command: "echo nope >&2; exit 3", cwd: tempDir } };
  const failHandle = await executor.start({ ...ctx, step: failedStep });
  const failed = await waitForTerminalShell(executor, { ...ctx, step: failedStep }, failHandle);
  assert.equal(failed.status, "failed");
  assert.equal((failed.output?.exitCode as number), 3);

  const timeoutStep = { ...baseStep, id: "timeout", input: { command: "sleep 2", cwd: tempDir, timeoutMs: 20 } };
  const timeoutHandle = await executor.start({ ...ctx, step: timeoutStep });
  const timedOut = await waitForTerminalShell(executor, { ...ctx, step: timeoutStep }, timeoutHandle);
  assert.equal(timedOut.status, "failed");
  assert.match(String(timedOut.error), /timed out|SIGTERM|failed/i);

  const disappeared = await executor.inspect(ctx, { processId: "missing" });
  assert.equal(disappeared.status, "failed");
  assert.match(String(disappeared.error), /not attached/);
});

test("CheckExecutor reuses worktree check flow and updates linked task/worktree state", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-check-executor-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: ["npm test"], runCommands: [] });
  const task = await store.createTask({ projectId: project.id, title: "task", agent: "shell", status: "agent_running" });
  const worktree = await store.createWorktree({ projectId: project.id, taskId: task.id, path: tempDir, branch: "shell/task", baseBranch: "main", baseRevision: "base", title: "task", agent: "shell" });
  const step = await store.createStep({ id: "check", runId: "run_check", name: "Check", executor: "check", input: { worktreeId: worktree.id }, status: "running" });
  const executor = new CheckExecutor();
  const ctx = {
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {
      runChecks: async () => ({ ok: true, runs: [{ command: "npm test", status: "passed", stdout: "ok", stderr: "", startedAt: "s", finishedAt: "f" }] })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project,
    runId: "run_check",
    step,
    sessionLogRoot: "",
    attachmentRoot: ""
  };

  const handle = await executor.start(ctx);
  const state = await executor.inspect(ctx, handle);
  assert.equal(state.status, "succeeded");
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_passed");
  assert.equal((await store.getTask(task.id))!.status, "ready_to_merge");
});

async function withHttpServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-runs-api-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: new ExecutorRegistry([new MemoryExecutor("ok"), new ApprovalTestExecutor()])
  });
  const app = createApp({
    store,
    bus,
    tmux: { listSessions: async () => [] } as any,
    worktrees: {} as any,
    run: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    token: null,
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions"),
    orchestration: service
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project };
}

test("REST API creates, gets, approves, rejects, cancels, and validates runs", async (t) => {
  const { baseUrl, project } = await withHttpServer(t);
  const invalid = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, goal: "bad", steps: [{ id: "a", executor: "missing" }] })
  });
  assert.equal(invalid.status, 400);

  const createdRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, goal: "api", steps: [{ id: "approve", executor: "approval" }] })
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();
  assert.equal(created.run.status, "waiting_approval");

  const getRes = await fetch(`${baseUrl}/api/runs/${created.run.id}`);
  assert.equal(getRes.status, 200);
  assert.equal((await getRes.json()).steps[0].status, "waiting_approval");

  const approveRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/steps/approve/approve`, { method: "POST" });
  assert.equal(approveRes.status, 200);
  assert.equal((await approveRes.json()).run.status, "succeeded");

  const cancelCreated = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, goal: "cancel", steps: [{ id: "approve", executor: "approval" }] })
  });
  const cancelRun = await cancelCreated.json();
  const cancelRes = await fetch(`${baseUrl}/api/runs/${cancelRun.run.id}/cancel`, { method: "POST" });
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json()).run.status, "cancelled");

  const rejectCreated = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, goal: "reject", steps: [{ id: "approve", executor: "approval" }] })
  });
  const rejectRun = await rejectCreated.json();
  const rejectRes = await fetch(`${baseUrl}/api/runs/${rejectRun.run.id}/steps/approve/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "not ready" })
  });
  assert.equal(rejectRes.status, 200);
  assert.equal((await rejectRes.json()).run.status, "failed");
});
