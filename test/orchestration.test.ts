import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { ExecutorRegistry } from "../server/executors/registry.js";
import { AgentTaskExecutor } from "../server/executors/agent-task.js";
import { CheckExecutor } from "../server/executors/check.js";
import { ShellExecutor } from "../server/executors/shell.js";
import { ConfigError, type ExecutionHandle, type ExecutionState, type Executor, type PreflightContext, type StepExecutionContext } from "../server/executors/types.js";
import { EvaluatorRegistry, type Evaluator, type EvaluatorInput, type EvaluatorResult } from "../server/evaluators/registry.js";
import { EventBus, publishEvent } from "../server/events.js";
import { validateContractLevel, validateStepContracts, validateStepGraph } from "../server/orchestration/dag.js";
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

class AlwaysWaitingExecutor implements Executor {
  type: string;
  waitStatus: "waiting_input" | "waiting_approval";
  question: string;
  starts = 0;

  constructor(type: string, waitStatus: "waiting_input" | "waiting_approval" = "waiting_input", question = "which option?") {
    this.type = type;
    this.waitStatus = waitStatus;
    this.question = question;
  }

  async start(): Promise<ExecutionHandle> {
    this.starts += 1;
    return { sessionId: "sess_always_waiting" };
  }

  async inspect(): Promise<ExecutionState> {
    return { status: this.waitStatus, output: { question: this.question, sessionId: "sess_always_waiting" } };
  }
}

class ToggleWaitingExecutor implements Executor {
  type: string;
  waiting = true;
  question: string;
  sessionId: string;

  constructor(type: string, sessionId: string, question = "which framework?") {
    this.type = type;
    this.sessionId = sessionId;
    this.question = question;
  }

  async start(): Promise<ExecutionHandle> {
    return { sessionId: this.sessionId };
  }

  async inspect(): Promise<ExecutionState> {
    if (this.waiting) return { status: "waiting_input", output: { question: this.question, sessionId: this.sessionId } };
    return { status: "running" };
  }
}

class StaysRunningExecutor implements Executor {
  type: string;
  sessionId: string;

  constructor(type: string, sessionId: string) {
    this.type = type;
    this.sessionId = sessionId;
  }

  async start(): Promise<ExecutionHandle> {
    return { sessionId: this.sessionId };
  }

  async inspect(): Promise<ExecutionState> {
    return { status: "running" };
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

class AsyncPassEvaluator implements Evaluator {
  type = "async-pass";

  async evaluate(input: EvaluatorInput): Promise<EvaluatorResult> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return {
      evaluator: input.definition.id || this.type,
      status: "passed",
      score: 1,
      threshold: 1,
      reason: "async evaluator passed"
    };
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

async function withService(t: TestContext, registry?: ExecutorRegistry, evaluators?: EvaluatorRegistry) {
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
    executors: registry,
    evaluators
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

test("StepContract lint rejects a consumes entry no upstream step produces, and accepts one satisfied via declared produces or executor-inherent producesTypes", () => {
  const plain = new MemoryExecutor("ok");
  class ProducingExecutor extends MemoryExecutor {
    producesTypes = ["diff"];
  }
  const registry = new ExecutorRegistry([plain, new ProducingExecutor("agent-task")]);

  // No upstream step declares or auto-harvests "diff".
  assert.throws(
    () => validateStepContracts([
      { id: "a", executor: "ok" },
      { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
    ], registry),
    /Step b consumes "diff", which no upstream step \(via dependsOn\) produces/
  );

  // Satisfied via an explicitly declared `produces` on the upstream step.
  assert.doesNotThrow(() => validateStepContracts([
    { id: "a", executor: "ok", produces: ["diff"] },
    { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
  ], registry));

  // Satisfied via the upstream step's executor-inherent producesTypes, with
  // no explicit `produces` declaration needed on the step itself.
  assert.doesNotThrow(() => validateStepContracts([
    { id: "a", executor: "agent-task" },
    { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
  ], registry));

  // A sibling step (not a dependsOn ancestor) producing the type doesn't count.
  assert.throws(
    () => validateStepContracts([
      { id: "a", executor: "agent-task" },
      { id: "b", executor: "ok", consumes: ["diff"] }
    ], registry),
    /consumes "diff"/
  );
});

test("validateContractLevel: L0 skips contract enforcement entirely; L1 is the same as validateStepContracts", () => {
  const registry = new ExecutorRegistry([new MemoryExecutor("ok")]);
  const unsatisfiable = [
    { id: "a", executor: "ok" },
    { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
  ];

  assert.doesNotThrow(() => validateContractLevel("L0", unsatisfiable, registry));
  assert.throws(() => validateContractLevel("L1", unsatisfiable, registry), /consumes "diff"/);
});

test("validateContractLevel: L2 requires an evaluator on every verifying step (executor 'check', or one that declares consumes), satisfied by an explicit qualityGate or an executor's implicit default", () => {
  const registry = new ExecutorRegistry([new MemoryExecutor("ok"), new CheckExecutor()]);

  // A non-check step that consumes an upstream artifact but declares no
  // evaluator, and whose executor has no implicit default.
  assert.throws(
    () => validateContractLevel("L2", [
      { id: "a", executor: "ok", produces: ["diff"] },
      { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
    ], registry),
    /Contract level L2 requires an evaluator on verifying step "b"/
  );

  // Same shape, but "b" declares its own evaluator explicitly.
  assert.doesNotThrow(() => validateContractLevel("L2", [
    { id: "a", executor: "ok", produces: ["diff"] },
    { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"], qualityGate: { evaluators: [{ type: "boolean" }] } }
  ], registry));

  // A "check" step is a verifying step by executor type alone, even with no
  // consumes declared and no explicit qualityGate - CheckExecutor's
  // impliedQualityGate satisfies L2 on its own.
  assert.doesNotThrow(() => validateContractLevel("L2", [
    { id: "check", executor: "check" }
  ], registry));

  // A plain non-verifying step (no consumes, not "check") needs nothing.
  assert.doesNotThrow(() => validateContractLevel("L2", [
    { id: "a", executor: "ok" }
  ], registry));
});

test("validateContractLevel: L3 additionally requires at least one dedicated 'approval' step in the run", () => {
  const registry = new ExecutorRegistry([new CheckExecutor(), new ApprovalTestExecutor()]);

  assert.throws(
    () => validateContractLevel("L3", [{ id: "check", executor: "check" }], registry),
    /Contract level L3 requires at least one "approval" step/
  );

  assert.doesNotThrow(() => validateContractLevel("L3", [
    { id: "check", executor: "check" },
    { id: "gate", executor: "approval", dependsOn: ["check"] }
  ], registry));
});

test("scheduleRun: a caller racing an already in-flight schedule waits for it instead of reading a mid-transition run status", async (t) => {
  // Regression for a race between OrchestrationService.createRun()'s own
  // scheduleRun() call and the background poller's concurrent
  // scheduleNonTerminalRuns() tick picking up the same freshly-created run.
  // The old guard (a bare Set) let a second concurrent caller no-op
  // immediately instead of waiting, so it (and callers awaiting it, like
  // createRun) could observe the run mid-transition - e.g. "running" - a
  // few milliseconds before the in-flight pass finished settling it to
  // "waiting_approval".
  class DelayedApprovalExecutor implements Executor {
    type = "approval";
    starts = 0;
    async start(): Promise<ExecutionHandle> {
      this.starts += 1;
      // Long enough that a second scheduleRun() call issued right after the
      // first reliably lands while this pass is still in progress.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { waitingApproval: true };
    }
    async inspect(): Promise<ExecutionState> {
      return { status: "waiting_approval" };
    }
  }

  const gate = new DelayedApprovalExecutor();
  const registry = new ExecutorRegistry([gate]);
  const { store, service, project } = await withService(t, registry);

  const run = await store.createRun({ projectId: project.id, goal: "race", status: "pending" });
  await store.createStep({ id: "gate", runId: run.id, name: "gate", executor: "approval" });

  const first = service.scheduleRun(run.id);
  const second = service.scheduleRun(run.id);
  await second;

  assert.equal(gate.starts, 1, "the racing caller must join the in-flight scheduling pass, not trigger a second one");
  const settled = await store.getRun(run.id);
  assert.equal(settled!.status, "waiting_approval", "a caller that awaits scheduleRun must observe the fully-settled run status, not a mid-transition one");

  await first;
});

test("scheduler executes a linear DAG, a branched DAG, and blocks downstream on failure", async (t) => {
  const ok = new MemoryExecutor("ok");
  const fail = new MemoryExecutor("fail", [{ status: "failed", error: "boom" }]);
  const registry = new ExecutorRegistry([ok, fail]);
  const { store, service, project } = await withService(t, registry);

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
  assert.equal(failed.steps.find((step) => step.id === "a")!.status, "failed");
  assert.equal((await store.getStep(failed.run.id, "a"))!.failureKind, "execution_failed");
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

test("quality gate pass allows downstream scheduling and records evaluation", async (t) => {
  const ok = new MemoryExecutor("ok", [{ status: "succeeded", output: { ok: true } }, { status: "succeeded", output: { downstream: true } }]);
  const registry = new ExecutorRegistry([ok]);
  const { store, service, project, events } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "gate pass",
    steps: [
      { id: "a", executor: "ok", qualityGate: { evaluators: [{ type: "boolean", source: "output.ok" }] } },
      { id: "b", executor: "ok", dependsOn: ["a"] }
    ]
  });

  assert.equal(result.run.status, "succeeded");
  assert.equal((await store.getStep(result.run.id, "b"))!.status, "succeeded");
  assert.equal((await store.listEvaluations(result.run.id, "a"))[0].status, "passed");
  assert.equal(events.some((event) => event.type === "quality_gate.passed"), true);
});

test("quality gate fail blocks downstream scheduling", async (t) => {
  const ok = new MemoryExecutor("ok", [{ status: "succeeded", output: { ok: false } }]);
  const registry = new ExecutorRegistry([ok]);
  const { store, service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "gate fail",
    steps: [
      { id: "a", executor: "ok", qualityGate: { evaluators: [{ type: "boolean", source: "output.ok" }] } },
      { id: "b", executor: "ok", dependsOn: ["a"] }
    ]
  });

  assert.equal(result.run.status, "failed");
  assert.equal((await store.getStep(result.run.id, "a"))!.status, "failed");
  assert.equal((await store.getStep(result.run.id, "a"))!.failureKind, "verification_failed");
  assert.equal((await store.getStep(result.run.id, "b"))!.status, "skipped");
  assert.equal((await store.listEvaluations(result.run.id, "a"))[0].status, "failed");
});

test("quality gate wait_approval uses existing approval flow", async (t) => {
  const ok = new MemoryExecutor("ok", [{ status: "succeeded", output: { score: 0.5 } }, { status: "succeeded", output: { downstream: true } }]);
  const registry = new ExecutorRegistry([ok]);
  const { store, service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "gate approval",
    steps: [
      { id: "a", executor: "ok", qualityGate: { evaluators: [{ type: "numeric-threshold", source: "output.score", operator: ">=", threshold: 1 }], onFail: "wait_approval" } },
      { id: "b", executor: "ok", dependsOn: ["a"] }
    ]
  });

  assert.equal(result.run.status, "waiting_approval");
  assert.equal((await store.getStep(result.run.id, "a"))!.status, "waiting_approval");
  assert.equal((await store.getStep(result.run.id, "b"))!.status, "pending");
  assert.equal((await store.listEvaluations(result.run.id, "a"))[0].status, "failed");

  await service.approveStep(result.run.id, "a");
  assert.equal((await store.getStep(result.run.id, "b"))!.status, "succeeded");
  assert.equal((await store.getRun(result.run.id))!.status, "succeeded");
});

test("quality gate evaluations are attempt-aware and summaries use the latest attempt", async (t) => {
  const flaky = new MemoryExecutor("flaky", [
    { status: "succeeded", output: { ok: false } },
    { status: "succeeded", output: { ok: true } }
  ]);
  const registry = new ExecutorRegistry([flaky]);
  const { store, service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "attempt-aware gate",
    steps: [{ id: "verify", executor: "flaky", maxAttempts: 2, qualityGate: { evaluators: [{ type: "boolean", source: "output.ok" }] } }]
  });

  assert.equal(result.run.status, "succeeded");
  const evaluations = await store.listEvaluations(result.run.id, "verify");
  assert.equal(evaluations.length, 2);
  assert.deepEqual(evaluations.map((item) => [item.attempt, item.status]), [[1, "failed"], [2, "passed"]]);
  const detail = await service.getRunDetail(result.run.id);
  assert.equal(detail!.steps[0].verification.latestAttempt, 2);
  assert.deepEqual(detail!.steps[0].verification.evaluations, { passed: 1, failed: 0, error: 0 });
});

test("quality gate decisions persist pass, fail, operator override, and operator rejection", async (t) => {
  const ok = new MemoryExecutor("ok", [
    { status: "succeeded", output: { ok: true } },
    { status: "succeeded", output: { ok: false } },
    { status: "succeeded", output: { ok: false } }
  ]);
  const registry = new ExecutorRegistry([ok]);
  const { store, service, project } = await withService(t, registry);

  const passed = await service.createRun({
    projectId: project.id,
    goal: "decision pass",
    steps: [{ id: "verify", executor: "ok", qualityGate: { evaluators: [{ type: "boolean", source: "output.ok" }] } }]
  });
  assert.equal((await store.listQualityGateDecisions(passed.run.id, "verify"))[0].status, "passed");

  const override = await service.createRun({
    projectId: project.id,
    goal: "decision override",
    steps: [{ id: "verify", executor: "ok", qualityGate: { evaluators: [{ type: "boolean", source: "output.ok" }], onFail: "wait_approval" } }]
  });
  assert.equal(override.run.status, "waiting_approval");
  await service.approveStep(override.run.id, "verify");
  const overrideDecisions = await store.listQualityGateDecisions(override.run.id, "verify");
  assert.deepEqual(overrideDecisions.map((item) => [item.status, item.decidedBy]), [["failed", "system"], ["overridden", "operator"]]);

  const rejected = await service.createRun({
    projectId: project.id,
    goal: "decision reject",
    steps: [{ id: "verify", executor: "ok", qualityGate: { evaluators: [{ type: "boolean", source: "output.ok" }], onFail: "wait_approval" } }]
  });
  await service.rejectStep(rejected.run.id, "verify", "operator rejected");
  const rejectedDecisions = await store.listQualityGateDecisions(rejected.run.id, "verify");
  assert.deepEqual(rejectedDecisions.map((item) => [item.status, item.decidedBy]), [["failed", "system"], ["failed", "operator"]]);
  assert.equal((await store.getRun(rejected.run.id))!.status, "failed");
});

test("async registered evaluators work and unknown evaluator types are rejected by the registry-backed service validation", async (t) => {
  const ok = new MemoryExecutor("ok");
  const executors = new ExecutorRegistry([ok]);
  const evaluators = new EvaluatorRegistry([new AsyncPassEvaluator()]);
  const { store, service, project } = await withService(t, executors, evaluators);

  const result = await service.createRun({
    projectId: project.id,
    goal: "async evaluator",
    steps: [{ id: "verify", executor: "ok", qualityGate: { evaluators: [{ type: "async-pass" }] } }]
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal((await store.listEvaluations(result.run.id, "verify"))[0].reason, "async evaluator passed");

  await assert.rejects(
    () => service.createRun({
      projectId: project.id,
      goal: "unknown evaluator",
      steps: [{ id: "bad", executor: "ok", qualityGate: { evaluators: [{ type: "missing-evaluator" }] } }]
    }),
    /Unknown evaluator type: missing-evaluator/
  );
});

test("evaluator input errors are recorded as evaluation errors and fail the gate", async (t) => {
  const ok = new MemoryExecutor("ok", [{ status: "succeeded", output: {} }]);
  const registry = new ExecutorRegistry([ok]);
  const { store, service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "gate error",
    steps: [{ id: "a", executor: "ok", qualityGate: { evaluators: [{ type: "numeric-threshold", source: "output.missing", operator: ">=", threshold: 1 }] } }]
  });

  assert.equal(result.run.status, "failed");
  const evaluation = (await store.listEvaluations(result.run.id, "a"))[0];
  assert.equal(evaluation.status, "error");
  assert.match(String(evaluation.reason), /finite/);
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
  // Named "verify" (not "check") so it doesn't pick up the real "check"
  // executor's implicit default quality gate, which expects check.command
  // evidence this mock never produces; this test only exercises generic
  // DAG scheduling mechanics.
  const check = new MemoryExecutor("verify");
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
      { id: "d", name: "Check D", executor: "verify", dependsOn: ["c"] },
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

test("AgentTaskExecutor.start() defaults to unattended and prepends the UNATTENDED_PREAMBLE, opting out via interaction: 'interactive'", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-unattended-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const startedCommands: string[] = [];
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      startSession: async ({ command }: any) => { startedCommands.push(command); },
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
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  await service.createRun({
    projectId: project.id,
    goal: "unattended-default",
    steps: [{ id: "auto", executor: "agent-task", input: { agent: "codex", prompt: "implement the feature" } }]
  });
  await service.createRun({
    projectId: project.id,
    goal: "unattended-opt-out",
    steps: [{ id: "manual", executor: "agent-task", input: { agent: "codex", prompt: "implement the feature", interaction: "interactive" } }]
  });

  assert.equal(startedCommands.length, 2);
  assert.match(startedCommands[0], /--full-auto/);
  assert.ok(startedCommands[0].includes("You are running unattended"));
  assert.ok(startedCommands[0].includes("implement the feature"));

  assert.doesNotMatch(startedCommands[1], /--full-auto/);
  assert.ok(!startedCommands[1].includes("You are running unattended"));

  const autoTask = (await store.listTasks()).find((task) => task.title === "auto");
  assert.equal(autoTask?.prompt, "implement the feature");
});

test("AgentTaskExecutor.start() provisions $HR_STEP_DIR/artifacts on disk, exports it to the launched session, and injects the versioned harness conventions ahead of the task prompt", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-step-dir-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const startedCommands: string[] = [];
  const attachmentRoot = join(tempDir, "attachments");
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      startSession: async ({ command }: any) => { startedCommands.push(command); },
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
    attachmentRoot,
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "step dir",
    steps: [{ id: "implement", executor: "agent-task", produces: ["diff"], input: { agent: "codex", prompt: "implement the feature" } }]
  });

  assert.equal(startedCommands.length, 1);
  const stepDir = join(attachmentRoot, "runs", created.run.id, "implement", "attempt-1", "step");
  assert.ok(startedCommands[0].includes(`HR_STEP_DIR='${stepDir}'`), "the launch command must export HR_STEP_DIR to the session's shell");
  assert.ok(startedCommands[0].includes("Harness runtime conventions (prompt v1)"), "the versioned harness conventions block must be injected");
  assert.ok(startedCommands[0].includes("must produce: diff"), "the step's produces contract must be surfaced to the agent");
  assert.ok(startedCommands[0].indexOf("Harness runtime conventions") < startedCommands[0].indexOf("implement the feature"), "conventions must precede the task prompt");

  const artifactsDirStat = await stat(join(stepDir, "artifacts"));
  assert.ok(artifactsDirStat.isDirectory(), "artifacts/ must be provisioned before the agent starts, not created lazily on harvest");
});

test("agent-written manifest.json entries under $HR_STEP_DIR/artifacts/ are harvested as step artifacts on completion, and completion evidence records the harness prompt version", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-manifest-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const attachmentRoot = join(tempDir, "attachments");
  const service = new OrchestrationService({
    store,
    bus,
    tmux: { listSessions: async () => [], startSession: async () => {}, killSession: async () => {}, capture: async () => "", sendInput: async () => {} } as any,
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
    attachmentRoot,
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "manifest harvest",
    steps: [{ id: "implement", executor: "agent-task", input: { agent: "shell", prompt: "do work" } }]
  });
  const step = (await store.getStep(created.run.id, "implement"))!;
  assert.equal(step.status, "running");

  // Simulate the agent following the harness convention: writing a file
  // under artifacts/ and describing it in manifest.json (start() already
  // provisioned the artifacts/ directory).
  const stepDir = join(attachmentRoot, "runs", created.run.id, "implement", "attempt-1", "step");
  await writeFile(join(stepDir, "artifacts", "coverage.json"), JSON.stringify({ lines: 92 }));
  await writeFile(join(stepDir, "manifest.json"), JSON.stringify({
    artifacts: [{ name: "coverage.json", path: "artifacts/coverage.json", type: "report", claim: "Coverage after the new tests" }]
  }));

  await store.updateTask(String(step.executionRef!.taskId), { status: "ready_to_merge" });
  await service.scheduleRun(created.run.id);

  const artifacts = await store.listArtifacts(created.run.id, "implement");
  const manifestArtifact = artifacts.find((item) => item.name === "coverage.json")!;
  assert.ok(manifestArtifact, "manifest-described artifact must be harvested");
  assert.equal(manifestArtifact.kind, "json");
  assert.equal(manifestArtifact.artifactType, "report");
  assert.equal(manifestArtifact.path, join(stepDir, "artifacts", "coverage.json"), "must reference the file in place, not a copy");

  const evidence = await store.listEvidence(created.run.id, "implement");
  const manifestEvidence = evidence.find((item) => item.kind === "agent.manifest")!;
  assert.ok(manifestEvidence, "manifest artifact must have matching evidence");
  assert.equal(manifestEvidence.claim, "Coverage after the new tests");
  assert.deepEqual(manifestEvidence.artifactIds, [manifestArtifact.id]);

  const completionEvidence = evidence.find((item) => item.kind === "agent.completion")!;
  assert.equal((completionEvidence.value as Record<string, unknown>).harnessPromptVersion, "1");
});

test("a file dropped under $HR_STEP_DIR/artifacts/ with no manifest.json entry is still harvested, with a default name/kind and no artifactType", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-manifest-default-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const attachmentRoot = join(tempDir, "attachments");
  const service = new OrchestrationService({
    store,
    bus,
    tmux: { listSessions: async () => [], startSession: async () => {}, killSession: async () => {}, capture: async () => "", sendInput: async () => {} } as any,
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
    attachmentRoot,
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "manifest-less harvest",
    steps: [{ id: "implement", executor: "agent-task", input: { agent: "shell", prompt: "do work" } }]
  });
  const step = (await store.getStep(created.run.id, "implement"))!;

  const stepDir = join(attachmentRoot, "runs", created.run.id, "implement", "attempt-1", "step");
  await writeFile(join(stepDir, "artifacts", "notes.txt"), "no manifest describes this file");

  await store.updateTask(String(step.executionRef!.taskId), { status: "ready_to_merge" });
  await service.scheduleRun(created.run.id);

  const artifacts = await store.listArtifacts(created.run.id, "implement");
  const notesArtifact = artifacts.find((item) => item.name === "notes.txt")!;
  assert.ok(notesArtifact, "an undeclared file under artifacts/ must still be harvested");
  assert.equal(notesArtifact.kind, "file");
  assert.equal(notesArtifact.artifactType, undefined);
});

test("AgentTaskExecutor.inspect() maps a waiting_input session onto the step state", async () => {
  const executor = new AgentTaskExecutor();
  const task = { id: "task_1", status: "agent_running", sessionId: "sess_1", worktreeId: "wt_1" };
  const session = { id: "sess_1", status: "waiting_input", tmuxSessionName: "honeyrail_test" };
  const store = {
    getTask: async (id: string) => (id === task.id ? task : undefined),
    getSession: async (id: string) => (id === session.id ? session : undefined)
  } as any;
  const ctx = {
    store,
    tmux: { capture: async () => "What kind of app? 1. CLI 2. Web\nEnter to select · ↑/↓ to navigate" } as any
  } as StepExecutionContext;

  const state = await executor.inspect(ctx, { taskId: task.id });
  assert.equal(state.status, "waiting_input");
  assert.equal(state.output?.taskId, task.id);
  assert.match(String(state.output?.question), /CLI/);
});

test("AgentTaskExecutor.inspect() maps a waiting_approval session onto the step state", async () => {
  const executor = new AgentTaskExecutor();
  const task = { id: "task_2", status: "agent_running", sessionId: "sess_2", worktreeId: "wt_2" };
  const session = { id: "sess_2", status: "waiting_approval", tmuxSessionName: "honeyrail_test" };
  const store = {
    getTask: async () => task,
    getSession: async () => session
  } as any;
  const ctx = { store, tmux: { capture: async () => "Do you want to continue?" } as any } as StepExecutionContext;

  const state = await executor.inspect(ctx, { taskId: task.id });
  assert.equal(state.status, "waiting_approval");
});

test("onBlocked action 'fail' immediately fails a blocked step and skips its dependents", async (t) => {
  const registry = new ExecutorRegistry([new AlwaysWaitingExecutor("agent-task"), new MemoryExecutor("check")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-blocked-fail-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "blocked-fail",
    steps: [
      { id: "ask", executor: "agent-task", input: { prompt: "do work" }, onBlocked: { action: "fail" } },
      { id: "after", executor: "check", dependsOn: ["ask"] }
    ]
  });

  const askStep = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(askStep.status, "failed");
  assert.match(askStep.error || "", /Agent requested clarification: which option\?/);
  const afterStep = (await store.getStep(created.run.id, "after"))!;
  assert.equal(afterStep.status, "skipped");
  assert.ok(events.some((event) => event.type === "step.blocked"));
});

test("onBlocked wait_approval times out and fails once timeoutMs elapses", async (t) => {
  const registry = new ExecutorRegistry([new AlwaysWaitingExecutor("agent-task", "waiting_approval", "should I proceed?")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-blocked-timeout-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "blocked-timeout",
    steps: [{ id: "ask", executor: "agent-task", input: { prompt: "do work" }, onBlocked: { action: "wait_approval", timeoutMs: 30, onTimeout: "fail" } }]
  });
  let step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "waiting_approval");
  assert.ok(step.blockedSince);

  await new Promise((resolve) => setTimeout(resolve, 200));
  await service.scheduleRun(created.run.id);
  step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "failed");
  assert.match(step.error || "", /timed out/);
});

test("a blocked step retried under maxAttempts gets an enriched prompt telling it not to ask again", async (t) => {
  const registry = new ExecutorRegistry([new AlwaysWaitingExecutor("agent-task", "waiting_input", "which framework?")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-blocked-retry-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "blocked-retry",
    steps: [{ id: "ask", executor: "agent-task", input: { prompt: "build the app" }, maxAttempts: 2, onBlocked: { action: "fail" } }]
  });

  const step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "failed");
  assert.equal(step.attempt, 2);
  assert.equal(step.input.prompt, "build the app");
  assert.match(String(step.input.effectivePrompt), /^build the app\n\nPrevious attempt stopped to ask: "which framework\?"/);
});

test("the stall watchdog blocks a running step with no fresh session output and times it out", async (t) => {
  const registry = new ExecutorRegistry([new StaysRunningExecutor("agent-task", "sess_stall")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-stalled-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry,
    stalledThresholdMs: 10
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  await store.createSession({
    id: "sess_stall",
    projectId: project.id,
    name: "stall",
    agent: "shell",
    tmuxSessionName: "honeyrail_stall",
    cwd: "/tmp",
    status: "running",
    lastOutputAt: new Date(Date.now() - 1000).toISOString()
  });

  const created = await service.createRun({
    projectId: project.id,
    goal: "stalled",
    steps: [{ id: "ask", executor: "agent-task", input: {}, onBlocked: { timeoutMs: 30, onTimeout: "fail" } }]
  });
  let step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "waiting_input");
  assert.ok(step.blockedSince);
  assert.ok(events.some((event) => event.type === "step.stalled"));

  await new Promise((resolve) => setTimeout(resolve, 200));
  await service.scheduleRun(created.run.id);
  step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "failed");
  assert.match(step.error || "", /timed out/i);
});

test("dedicated approval executor steps are not subject to the onBlocked timeout policy", async (t) => {
  const registry = new ExecutorRegistry([new ApprovalTestExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-approval-untimed-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "approval-untimed",
    steps: [{ id: "approve", executor: "approval", onBlocked: { timeoutMs: 30, onTimeout: "fail" } }]
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  await service.scheduleRun(created.run.id);
  const step = (await store.getStep(created.run.id, "approve"))!;
  assert.equal(step.status, "waiting_approval");
  assert.equal(step.blockedSince, undefined);
});

test("answerStep sends the operator's text into the blocked session and unblocks the step", async (t) => {
  const executor = new ToggleWaitingExecutor("agent-task", "sess_toggle");
  const registry = new ExecutorRegistry([executor]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-answer-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const sentInputs: Array<{ target: string; text: string }> = [];
  const service = new OrchestrationService({
    store,
    bus,
    tmux: { sendInput: async (target: string, text: string) => { sentInputs.push({ target, text }); } } as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  await store.createSession({ id: "sess_toggle", projectId: project.id, name: "ask", agent: "codex", tmuxSessionName: "honeyrail_ask", cwd: "/tmp", status: "waiting_input" });

  const created = await service.createRun({
    projectId: project.id,
    goal: "answer",
    steps: [{ id: "ask", executor: "agent-task", input: { prompt: "build the app" }, onBlocked: { timeoutMs: 60_000 } }]
  });
  let step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "waiting_input");
  assert.ok(step.blockedSince);

  // Simulate the underlying agent having resolved the question by the time
  // the answer is delivered, so the poll triggered by answerStep observes
  // "running" instead of asking again.
  executor.waiting = false;
  const result = await service.answerStep(created.run.id, "ask", "use React");

  assert.deepEqual(sentInputs, [{ target: "honeyrail_ask", text: "use React" }]);
  assert.equal(result.step.status, "running");
  assert.equal(result.step.blockedSince, undefined);

  step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "running");
});

test("answerStep rejects a step that isn't waiting for input", async (t) => {
  const registry = new ExecutorRegistry([new MemoryExecutor("ok")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-answer-invalid-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({ projectId: project.id, goal: "answer-invalid", steps: [{ id: "ok", executor: "ok" }] });
  await assert.rejects(() => service.answerStep(created.run.id, "ok", "text"), /not waiting for input/);
});

test("onBlocked auto_answer calls the configured LLM, types its answer, records evidence, and caps retries", async (t) => {
  const registry = new ExecutorRegistry([new AlwaysWaitingExecutor("agent-task", "waiting_input", "which framework?")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-auto-answer-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const sentInputs: Array<{ target: string; text: string }> = [];
  const service = new OrchestrationService({
    store,
    bus,
    tmux: { sendInput: async (target: string, text: string) => { sentInputs.push({ target, text }); } } as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry,
    autoAnswerClient: { summarize: async () => "React" },
    autoAnswerModel: "test-model"
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  await store.createSession({ id: "sess_always_waiting", projectId: project.id, name: "ask", agent: "codex", tmuxSessionName: "honeyrail_ask", cwd: "/tmp", status: "waiting_input" });

  const created = await service.createRun({
    projectId: project.id,
    goal: "auto-answer",
    steps: [{ id: "ask", executor: "agent-task", input: { prompt: "build the app" }, onBlocked: { action: "auto_answer", maxAutoAnswers: 1, timeoutMs: 60_000 } }]
  });

  assert.equal(sentInputs.length, 1);
  assert.deepEqual(sentInputs[0], { target: "honeyrail_ask", text: "React" });

  const evidence = await store.listEvidence(created.run.id, "ask");
  const autoAnswerEvidence = evidence.filter((item) => item.kind === "auto_answer");
  assert.equal(autoAnswerEvidence.length, 1);
  assert.equal(autoAnswerEvidence[0].claim, "which framework?");
  assert.equal(autoAnswerEvidence[0].value, "React");

  // AlwaysWaitingExecutor keeps asking, so once the single allowed
  // auto-answer is spent the step stays blocked instead of looping forever.
  const step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "waiting_input");
  assert.ok(step.blockedSince);
});

test("onBlocked auto_answer falls through to onTimeout when no client is configured", async (t) => {
  const registry = new ExecutorRegistry([new AlwaysWaitingExecutor("agent-task", "waiting_input", "which framework?")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-auto-answer-unconfigured-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: runCommandSafe,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));

  const created = await service.createRun({
    projectId: project.id,
    goal: "auto-answer-unconfigured",
    steps: [{ id: "ask", executor: "agent-task", input: { prompt: "build" }, onBlocked: { action: "auto_answer", timeoutMs: 30, onTimeout: "fail" } }]
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  await service.scheduleRun(created.run.id);
  const step = (await store.getStep(created.run.id, "ask"))!;
  assert.equal(step.status, "failed");
  assert.match(step.error || "", /timed out/);
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
  // Named "verify" (not "check") - see comment on the demonstration workflow
  // test above for why this mock must not collide with the real "check"
  // executor's implicit default quality gate.
  const registry = new ExecutorRegistry([new AgentTaskExecutor(), new MemoryExecutor("verify"), new ApprovalTestExecutor()]);
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
      { id: "verify", executor: "verify", dependsOn: ["implement"] },
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
  const attachmentRoot = join(tempDir, "attachments");
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
    attachmentRoot
  };

  const handle = await executor.start(ctx);
  const state = await executor.inspect(ctx, handle);
  assert.equal(state.status, "succeeded");
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_passed");
  assert.equal((await store.getTask(task.id))!.status, "ready_to_merge");
  const artifacts = await store.listArtifacts("run_check", "check");
  const evidence = await store.listEvidence("run_check", "check");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "log");
  assert.equal(artifacts[0].metadata?.command, "npm test");
  // Regression check: the artifact must point at a real file GET
  // /api/artifacts/:id/content can stream, not just a metadata preview.
  assert.ok(artifacts[0].path, "check artifact must have a file path");
  const logContent = await readFile(artifacts[0].path!, "utf8");
  assert.match(logContent, /\$ npm test/);
  assert.match(logContent, /--- stdout ---\nok/);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "check.command");
  assert.equal((evidence[0].value as any).exitCode, 0);
  assert.deepEqual(evidence[0].artifactIds, [artifacts[0].id]);
  assert.equal(evidence[0].metadata?.commandsSource, "project");
  assert.equal((handle as any).commandsSource, "project");
});

test("CheckExecutor evidence records 'step' as the commands source when the step overrides them", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-check-executor-override-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: ["npm test"], runCommands: [] });
  const worktree = await store.createWorktree({ projectId: project.id, path: tempDir, branch: "shell/task", baseBranch: "main", baseRevision: "base", title: "task", agent: "shell" });
  const step = await store.createStep({ id: "check", runId: "run_check_override", name: "Check", executor: "check", input: { worktreeId: worktree.id, commands: ["echo override"] }, status: "running" });
  const executor = new CheckExecutor();
  const ctx = {
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {
      runChecks: async () => ({ ok: true, runs: [{ command: "echo override", status: "passed", stdout: "override", stderr: "", startedAt: "s", finishedAt: "f" }] })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project,
    runId: "run_check_override",
    step,
    sessionLogRoot: "",
    attachmentRoot: ""
  };

  const handle = await executor.start(ctx);
  const evidence = await store.listEvidence("run_check_override", "check");
  assert.equal(evidence[0].metadata?.commandsSource, "step");
  assert.equal((handle as any).commandsSource, "step");
});

test("CheckExecutor.preflight rejects a step whose commands resolve to empty, and passes once the project or step provides them", () => {
  const executor = new CheckExecutor();
  const projectNoCommands = { id: "proj_1", name: "demo", repoPath: "/repo", defaultBranch: "main", defaultAgent: "shell", testCommands: [], runCommands: [] };
  const projectWithCommands = { ...projectNoCommands, testCommands: ["npm test"] };

  assert.throws(
    () => executor.preflight!({ project: projectNoCommands, step: { id: "check", input: {} }, runCommand: runCommandSafe } as PreflightContext),
    (error: unknown) => error instanceof ConfigError && /no check commands/.test(error.message)
  );

  assert.doesNotThrow(() => executor.preflight!({ project: projectWithCommands, step: { id: "check", input: {} }, runCommand: runCommandSafe } as PreflightContext));
  assert.doesNotThrow(() => executor.preflight!({ project: projectNoCommands, step: { id: "check", input: { commands: ["echo hi"] } }, runCommand: runCommandSafe } as PreflightContext));
});

test("AgentTaskExecutor.preflight rejects an unknown agent and an agent doctor-style detection can't find", async () => {
  const executor = new AgentTaskExecutor();
  const project = { id: "proj_1", name: "demo", repoPath: "/repo", defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] } as any;
  const notFound = (async () => ({ ok: false, stdout: "", stderr: "" })) as any;
  const found = (async () => ({ ok: true, stdout: "1.0.0", stderr: "" })) as any;

  await assert.rejects(
    () => Promise.resolve(executor.preflight!({ project, step: { id: "implement", input: { agent: "bogus" } }, runCommand: found })),
    (error: unknown) => error instanceof ConfigError && /unknown agent backend/.test(error.message)
  );
  await assert.rejects(
    () => Promise.resolve(executor.preflight!({ project, step: { id: "implement", input: { agent: "codex" } }, runCommand: notFound })),
    (error: unknown) => error instanceof ConfigError && /doctor-style detection could not find/.test(error.message)
  );
  await assert.doesNotReject(() => Promise.resolve(executor.preflight!({ project, step: { id: "implement", input: { agent: "codex" } }, runCommand: found })));
});

test("createRun rejects at the service layer when a check step's commands resolve to empty, and no run is persisted", async (t) => {
  const registry = new ExecutorRegistry([new CheckExecutor(), new MemoryExecutor("agent-task")]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-preflight-check-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  const service = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: [], runCommands: [] });

  await assert.rejects(
    () => service.createRun({
      projectId: project.id,
      goal: "implement, check",
      steps: [
        { id: "implement", executor: "agent-task" },
        { id: "check", executor: "check", dependsOn: ["implement"] }
      ]
    }),
    /check.*no check commands|resolves to no check commands/
  );
  assert.deepEqual(await store.listRuns(), []);
});

test("createRun rejects at the service layer when an agent-task step's agent CLI can't be found by doctor-style detection", async (t) => {
  const registry = new ExecutorRegistry([new AgentTaskExecutor()]);
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-preflight-agent-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  const service = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: false, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: registry
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });

  await assert.rejects(
    () => service.createRun({
      projectId: project.id,
      goal: "implement",
      steps: [{ id: "implement", executor: "agent-task", input: { agent: "codex" } }]
    }),
    /doctor-style detection could not find/
  );
  assert.deepEqual(await store.listRuns(), []);
});

test("a step that fails via a thrown ConfigError is tagged failureKind config_error, distinct from a plain execution failure", async (t) => {
  class ThrowsConfigError implements Executor {
    type = "boom";
    async start(): Promise<ExecutionHandle> {
      throw new ConfigError("cannot possibly run");
    }
    async inspect(): Promise<ExecutionState> {
      return { status: "running" };
    }
  }
  const registry = new ExecutorRegistry([new ThrowsConfigError()]);
  const { store, service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "config error",
    steps: [{ id: "a", executor: "boom" }]
  });

  assert.equal(result.run.status, "failed");
  assert.equal((await store.getStep(result.run.id, "a"))!.status, "failed");
  assert.equal((await store.getStep(result.run.id, "a"))!.failureKind, "config_error");
});

test("createRun rejects at the service layer when a step consumes an artifact type no upstream step produces, and no run is persisted", async (t) => {
  const registry = new ExecutorRegistry([new MemoryExecutor("ok")]);
  const { store, service, project } = await withService(t, registry);

  await assert.rejects(
    () => service.createRun({
      projectId: project.id,
      goal: "unsatisfiable dataflow",
      steps: [
        { id: "a", executor: "ok" },
        { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
      ]
    }),
    /Step b consumes "diff", which no upstream step \(via dependsOn\) produces/
  );
  assert.deepEqual(await store.listRuns(), []);
});

test("createRun defaults to contract level L1 when unspecified, persists the run's contractLevel, and an explicit L0 run bypasses the dataflow lint L1 would reject", async (t) => {
  const registry = new ExecutorRegistry([new MemoryExecutor("ok")]);
  const { store, service, project } = await withService(t, registry);

  const unsatisfiableDataflow = {
    projectId: project.id,
    goal: "shell-only maintenance",
    steps: [
      { id: "a", executor: "ok" },
      { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
    ]
  };

  // No contractLevel given - defaults to L1, so the same unsatisfiable
  // dataflow that L0 tolerates below is rejected here.
  await assert.rejects(() => service.createRun(unsatisfiableDataflow), /consumes "diff"/);

  // A plain execution DAG at L0 runs with no contract errors even though its
  // dataflow would fail L1's lint - "execution only" per the L0 definition.
  const result = await service.createRun({ ...unsatisfiableDataflow, contractLevel: "L0" });
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.contractLevel, "L0");

  // A run that declares a level explicitly gets it recorded verbatim.
  const explicitL1 = await service.createRun({
    projectId: project.id,
    goal: "explicit L1",
    contractLevel: "L1",
    steps: [{ id: "solo", executor: "ok" }]
  });
  assert.equal((await store.getRun(explicitL1.run.id))!.contractLevel, "L1");
});

test("createRun rejects an L2 run whose verifying step declares no evaluator, and no run is persisted; a 'check' step satisfies L2 via its implicit default gate", async (t) => {
  const registry = new ExecutorRegistry([new MemoryExecutor("ok"), new CheckExecutor()]);
  const { store, service, project } = await withService(t, registry);

  await assert.rejects(
    () => service.createRun({
      projectId: project.id,
      goal: "unverified consumer",
      contractLevel: "L2",
      steps: [
        { id: "a", executor: "ok", produces: ["diff"] },
        { id: "b", executor: "ok", dependsOn: ["a"], consumes: ["diff"] }
      ]
    }),
    /Contract level L2 requires an evaluator on verifying step "b"/
  );
  assert.deepEqual(await store.listRuns(), []);

  const result = await service.createRun({
    projectId: project.id,
    goal: "check step satisfies L2 implicitly",
    contractLevel: "L2",
    steps: [{ id: "check", executor: "check", input: { commands: ["true"] } }]
  });
  assert.equal(result.run.contractLevel, "L2");
});

test("createRun accepts a consumes entry satisfied by an upstream step's executor-inherent producesTypes, with no explicit produces declared", async (t) => {
  class ProducingExecutor extends MemoryExecutor {
    producesTypes = ["diff"];
  }
  const registry = new ExecutorRegistry([new ProducingExecutor("implement-like"), new MemoryExecutor("ok")]);
  const { service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "satisfied via inherent producesTypes",
    steps: [
      { id: "implement", executor: "implement-like" },
      { id: "check", executor: "ok", dependsOn: ["implement"], consumes: ["diff"] }
    ]
  });
  assert.equal(result.run.status, "succeeded");
});

test("a step that declares produces but never creates a matching artifact is failed with failureKind contract_violation, distinct from execution_failed", async (t) => {
  const registry = new ExecutorRegistry([new MemoryExecutor("silent")]);
  const { store, service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "unmet contract",
    steps: [{ id: "a", executor: "silent", produces: ["diff"] }]
  });

  assert.equal(result.run.status, "failed");
  const step = await store.getStep(result.run.id, "a");
  assert.equal(step!.status, "failed");
  assert.equal(step!.failureKind, "contract_violation");
  assert.match(step!.error || "", /declares produces \[diff\] but did not produce: diff/);
});

test("a step that declares produces and creates a matching artifactType-tagged artifact succeeds normally", async (t) => {
  class ArtifactProducingExecutor implements Executor {
    type = "artifact-producer";
    async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
      await ctx.store.createArtifact({
        runId: ctx.runId,
        stepId: ctx.step.id,
        attempt: ctx.step.attempt,
        kind: "text",
        name: "changes.diff",
        artifactType: "diff"
      });
      return {};
    }
    async inspect(): Promise<ExecutionState> {
      return { status: "succeeded", output: {} };
    }
  }
  const registry = new ExecutorRegistry([new ArtifactProducingExecutor()]);
  const { store, service, project } = await withService(t, registry);

  const result = await service.createRun({
    projectId: project.id,
    goal: "met contract",
    steps: [{ id: "a", executor: "artifact-producer", produces: ["diff"] }]
  });

  assert.equal(result.run.status, "succeeded");
  const step = await store.getStep(result.run.id, "a");
  assert.equal(step!.status, "succeeded");
  assert.equal(step!.failureKind, undefined);
});

async function withHttpServer(t: TestContext, evaluators?: EvaluatorRegistry) {
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
    executors: new ExecutorRegistry([new MemoryExecutor("ok"), new ApprovalTestExecutor()]),
    evaluators
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
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project, store, attachmentRoot: join(tempDir, "attachments") };
}

test("REST API creates, gets, approves, rejects, cancels, and validates runs", async (t) => {
  const { baseUrl, project, store } = await withHttpServer(t);
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
  const getBody = await getRes.json();
  assert.equal(getBody.steps[0].status, "waiting_approval");
  assert.equal(getBody.run.verification.artifacts, 0);

  const artifact = await store.createArtifact({ runId: created.run.id, stepId: "approve", kind: "json", name: "result.json", metadata: { ok: true } });
  const evidence = await store.createEvidence({ runId: created.run.id, stepId: "approve", kind: "manual.fact", claim: "operator inspected result", artifactIds: [artifact.id], value: { ok: true } });
  await store.createEvaluation({ runId: created.run.id, stepId: "approve", evaluator: "boolean", status: "passed", evidenceIds: [evidence.id], artifactIds: [artifact.id], reason: "ok" });
  assert.equal((await (await fetch(`${baseUrl}/api/runs/${created.run.id}/artifacts?stepId=approve`)).json()).artifacts[0].id, artifact.id);
  assert.equal((await (await fetch(`${baseUrl}/api/artifacts/${artifact.id}`)).json()).artifact.metadata.ok, true);
  assert.equal((await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evidence?stepId=approve`)).json()).evidence[0].claim, "operator inspected result");
  assert.equal((await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=approve`)).json()).evaluations[0].status, "passed");

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

test("REST POST /api/runs/:runId/steps/:stepId/answer sends input and unblocks a waiting step", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-answer-rest-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const executor = new ToggleWaitingExecutor("agent-task", "sess_rest_answer");
  const sentInputs: Array<{ target: string; text: string }> = [];
  const service = new OrchestrationService({
    store,
    bus,
    tmux: { sendInput: async (target: string, text: string) => { sentInputs.push({ target, text }); } } as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors: new ExecutorRegistry([executor])
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
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  await store.createSession({ id: "sess_rest_answer", projectId: project.id, name: "ask", agent: "codex", tmuxSessionName: "honeyrail_rest_ask", cwd: "/tmp", status: "waiting_input" });

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, goal: "answer over REST", steps: [{ id: "ask", executor: "agent-task", input: { prompt: "build" } }] })
  });
  const created = await createRes.json();
  assert.equal(created.steps[0].status, "waiting_input");

  const emptyAnswer = await fetch(`${baseUrl}/api/runs/${created.run.id}/steps/ask/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" })
  });
  assert.equal(emptyAnswer.status, 400);

  executor.waiting = false;
  const answerRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/steps/ask/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "use React" })
  });
  assert.equal(answerRes.status, 200);
  const answerBody = await answerRes.json();
  assert.equal(answerBody.step.status, "running");
  assert.deepEqual(sentInputs, [{ target: "honeyrail_rest_ask", text: "use React" }]);
});

test("REST run creation accepts registered custom evaluator types and rejects unknown evaluator types", async (t) => {
  const evaluators = new EvaluatorRegistry([new AsyncPassEvaluator()]);
  const { baseUrl, project } = await withHttpServer(t, evaluators);

  const custom = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "custom evaluator over REST",
      steps: [{ id: "verify", executor: "ok", qualityGate: { evaluators: [{ type: "async-pass" }] } }]
    })
  });
  assert.equal(custom.status, 201);
  assert.equal((await custom.json()).run.status, "succeeded");

  const unknown = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "unknown evaluator over REST",
      steps: [{ id: "verify", executor: "ok", qualityGate: { evaluators: [{ type: "missing-evaluator" }] } }]
    })
  });
  assert.equal(unknown.status, 400);
  assert.match(((await unknown.json()) as { error: string }).error, /Unknown evaluator type: missing-evaluator/);
});

test("GET /api/artifacts/:id/content streams real file content with the artifact's mediaType", async (t) => {
  const { baseUrl, project, store, attachmentRoot } = await withHttpServer(t);
  const created = await store.createRun({ projectId: project.id, goal: "content", status: "succeeded" });
  const dir = join(attachmentRoot, "runs", created.id, "verify", "attempt-1");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "final-report.md");
  await writeFile(filePath, "# Report\n\n- ok\n");
  const artifact = await store.createArtifact({
    runId: created.id,
    stepId: "verify",
    kind: "text",
    name: "final-report.md",
    path: filePath,
    mediaType: "text/markdown"
  });

  const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/markdown");
  assert.equal(res.headers.get("x-artifact-truncated"), "false");
  assert.equal(await res.text(), "# Report\n\n- ok\n");
});

test("GET /api/artifacts/:id/content returns 404 for an unknown artifact id", async (t) => {
  const { baseUrl } = await withHttpServer(t);
  const res = await fetch(`${baseUrl}/api/artifacts/missing/content`);
  assert.equal(res.status, 404);
});

test("GET /api/artifacts/:id/content returns 404 for an artifact with no file path", async (t) => {
  const { baseUrl, project, store } = await withHttpServer(t);
  const created = await store.createRun({ projectId: project.id, goal: "no path", status: "succeeded" });
  const artifact = await store.createArtifact({
    runId: created.id,
    stepId: "verify",
    kind: "log",
    name: "check-1.log",
    mediaType: "text/plain",
    metadata: { stdoutPreview: "ok" }
  });

  const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content`);
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /no file content/i);
});

test("GET /api/artifacts/:id/content rejects an artifact path outside attachmentRoot", async (t) => {
  const { baseUrl, project, store } = await withHttpServer(t);
  const created = await store.createRun({ projectId: project.id, goal: "escape", status: "succeeded" });
  const outsideDir = await mkdtemp(join(tmpdir(), "honeyrail-outside-"));
  t.after(async () => rm(outsideDir, { recursive: true, force: true }));
  const outsidePath = join(outsideDir, "secret.txt");
  await writeFile(outsidePath, "should not be servable");
  const artifact = await store.createArtifact({
    runId: created.id,
    stepId: "verify",
    kind: "text",
    name: "secret.txt",
    path: outsidePath,
    mediaType: "text/plain"
  });

  const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content`);
  assert.equal(res.status, 404);
});

test("GET /api/artifacts/:id/content truncates files larger than the size cap and reports it", async (t) => {
  const { baseUrl, project, store, attachmentRoot } = await withHttpServer(t);
  const created = await store.createRun({ projectId: project.id, goal: "truncate", status: "succeeded" });
  const dir = join(attachmentRoot, "runs", created.id, "verify", "attempt-1");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "big.log");
  const MAX_ARTIFACT_CONTENT_BYTES = 2 * 1024 * 1024;
  await writeFile(filePath, "a".repeat(MAX_ARTIFACT_CONTENT_BYTES + 1024));
  const artifact = await store.createArtifact({
    runId: created.id,
    stepId: "verify",
    kind: "log",
    name: "big.log",
    path: filePath,
    mediaType: "text/plain"
  });

  const res = await fetch(`${baseUrl}/api/artifacts/${artifact.id}/content`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-artifact-truncated"), "true");
  const body = await res.text();
  assert.equal(body.length, MAX_ARTIFACT_CONTENT_BYTES);
});
