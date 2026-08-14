import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { createDefaultExecutorRegistry } from "../server/executors/index.js";
import { EventBus } from "../server/events.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import { JsonStore } from "../server/store.js";
import { WorktreeManager } from "../server/worktrees.js";
import { runCommandSafe } from "../server/utils.js";
import type { Project, Worktree } from "../server/types.js";

// This suite exercises the M1 DAG scheduler and M2 evidence/quality-gate
// features end-to-end: a real HTTP server, a real git repository, a real
// WorktreeManager, and the real shell/check/approval executors (no mocks).
// AgentTaskExecutor is intentionally not exercised here because it launches
// a real tmux-backed coding agent CLI, which is out of scope for a
// deterministic evidence/quality e2e pass.

async function initGitRepo(path: string) {
  await mkdir(path, { recursive: true });
  await runCommandSafe("git", ["init"], { cwd: path });
  await runCommandSafe("git", ["config", "user.email", "e2e@example.com"], { cwd: path });
  await runCommandSafe("git", ["config", "user.name", "E2E"], { cwd: path });
  await writeFile(join(path, "README.md"), "# e2e fixture\n");
  await runCommandSafe("git", ["add", "-A"], { cwd: path });
  await runCommandSafe("git", ["commit", "-m", "initial"], { cwd: path });
}

async function withE2EServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-e2e-"));
  const repoPath = join(tempDir, "repo");
  await initGitRepo(repoPath);
  const worktreeRoot = join(tempDir, "worktrees");

  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const worktrees = new WorktreeManager({ root: worktreeRoot, run: runCommandSafe });
  const executors = createDefaultExecutorRegistry();
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
    worktrees,
    runCommand: runCommandSafe,
    sessionLogRoot: join(tempDir, "sessions"),
    attachmentRoot: join(tempDir, "attachments"),
    executors
  });
  const app = createApp({
    store,
    bus,
    tmux: { listSessions: async () => [] } as any,
    worktrees,
    run: runCommandSafe,
    token: null,
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions"),
    orchestration: service
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const project = await store.createProject({
    name: "e2e-project",
    repoPath,
    defaultBranch: "main",
    defaultAgent: "shell",
    testCommands: [],
    runCommands: []
  });

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  return { baseUrl, store, service, worktrees, project, repoPath };
}

async function createFixtureWorktree(worktrees: WorktreeManager, store: JsonStore, project: Project, title: string): Promise<Worktree> {
  const created = await worktrees.create({ project, title, agent: "shell" });
  return store.createWorktree({ ...created, agent: "shell" } as Partial<Worktree>);
}

async function getRun(baseUrl: string, runId: string) {
  const res = await fetch(`${baseUrl}/api/runs/${runId}`);
  assert.equal(res.status, 200);
  return res.json();
}

/**
 * Production has no background poller for detached-completion executors
 * (see the dedicated gap test below): nothing re-invokes the scheduler for
 * a `shell` step once it starts, unless another step's approve/reject call
 * happens to touch the same run. This harness calls scheduleRun() directly
 * (the in-process service instance) to advance the run the way a future
 * poller would, so the rest of this suite can validate downstream DAG,
 * evidence, and quality-gate behavior instead of being blocked by that gap.
 */
async function pollRun(
  service: OrchestrationService,
  baseUrl: string,
  runId: string,
  predicate: (detail: any) => boolean,
  { timeoutMs = 10000, intervalMs = 50, reschedule = true } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    if (reschedule) await service.scheduleRun(runId);
    last = await getRun(baseUrl, runId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`pollRun timed out waiting for predicate. Last run status=${last?.run?.status}, steps=${JSON.stringify(last?.steps?.map((s: any) => [s.id, s.status]))}`);
}

test("GAP: a shell step never advances without an external reschedule trigger (pure REST client, no manual scheduleRun)", async (t) => {
  const { baseUrl, project } = await withE2EServer(t);
  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "gap probe",
      steps: [{ id: "a", executor: "shell", input: { command: "sleep 0.2 && echo done" } }]
    })
  });
  const created = await createRes.json();
  assert.equal(created.steps[0].status, "running");

  // Give the background shell command ample time to actually finish...
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // ...then poll purely via REST GET, exactly as an external client would.
  // No scheduleRun trigger exists on this path (no approve/reject/cancel
  // call, no agent-task event) so the step/run must still read "running".
  const stillRunning = await getRun(baseUrl, created.run.id);
  assert.equal(stillRunning.steps[0].status, "running", "documents current gap: shell step should have completed by now but nothing repolled it");
  assert.equal(stillRunning.run.status, "running");
});

test("simple linear DAG: shell prepare -> check verify -> approval gate, with real artifact/evidence generation", async (t) => {
  const { baseUrl, store, service, worktrees, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "simple-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "simple linear dag",
      steps: [
        { id: "prepare", executor: "shell", input: { command: "echo hello > note.txt", cwd: worktree.path } },
        { id: "verify", executor: "check", dependsOn: ["prepare"], input: { worktreeId: worktree.id, commands: ["test -f note.txt", "grep -q hello note.txt"] } },
        { id: "approve", executor: "approval", dependsOn: ["verify"] }
      ]
    })
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  const waiting = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "waiting_approval");
  assert.deepEqual(waiting.steps.map((s: any) => s.status), ["succeeded", "succeeded", "waiting_approval"]);

  const artifactsRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/artifacts?stepId=verify`);
  const { artifacts } = await artifactsRes.json();
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].kind, "log");
  assert.equal(artifacts[0].metadata.command, "test -f note.txt");
  assert.equal(artifacts[0].metadata.status, "passed");
  assert.equal(artifacts[0].metadata.exitCode, 0);

  const evidenceRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/evidence?stepId=verify`);
  const { evidence } = await evidenceRes.json();
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].kind, "check.command");
  assert.deepEqual(evidence[0].artifactIds, [artifacts[0].id]);
  assert.equal((evidence[0].value as any).exitCode, 0);
  assert.equal((evidence[0].value as any).status, "passed");

  // Direct artifact fetch by id matches the list entry.
  const directArtifact = await (await fetch(`${baseUrl}/api/artifacts/${artifacts[1].id}`)).json();
  assert.equal(directArtifact.artifact.id, artifacts[1].id);
  assert.equal(directArtifact.artifact.metadata.command, "grep -q hello note.txt");

  // No quality gate was declared on "verify", so zero evaluations exist for it.
  const evalRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`);
  assert.equal((await evalRes.json()).evaluations.length, 0);
  assert.equal(waiting.run.verification.artifacts, 2);
  assert.equal(waiting.run.verification.evidence, 2);

  // Real worktree/store state was updated by the real CheckExecutor.
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_passed");

  const approveRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/steps/approve/approve`, { method: "POST" });
  assert.equal(approveRes.status, 200);
  assert.equal((await approveRes.json()).run.status, "succeeded");
});

test("branched (diamond) DAG: two parallel quality-gated check branches join into a downstream step", async (t) => {
  const { baseUrl, store, service, worktrees, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "diamond-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "diamond dag",
      steps: [
        { id: "a", executor: "shell", input: { command: "echo start > marker.txt", cwd: worktree.path } },
        {
          id: "b",
          executor: "check",
          dependsOn: ["a"],
          input: { worktreeId: worktree.id, commands: ["test -f marker.txt"] },
          qualityGate: { evaluators: [{ type: "check" }] }
        },
        {
          id: "c",
          executor: "check",
          dependsOn: ["a"],
          input: { worktreeId: worktree.id, commands: ["true"] },
          qualityGate: { evaluators: [{ type: "numeric-threshold", source: "check.exitCode", operator: "<=", threshold: 0 }] }
        },
        { id: "d", executor: "shell", dependsOn: ["b", "c"], input: { command: "echo joined", cwd: worktree.path } }
      ]
    })
  });
  const created = await createRes.json();

  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "succeeded" || detail.run.status === "failed");
  assert.equal(done.run.status, "succeeded");
  const statuses = Object.fromEntries(done.steps.map((s: any) => [s.id, s.status]));
  assert.deepEqual(statuses, { a: "succeeded", b: "succeeded", c: "succeeded", d: "succeeded" });

  // Join semantics: "d" must not start before both "b" and "c" finished.
  const byId = Object.fromEntries(done.steps.map((s: any) => [s.id, s]));
  assert.ok(new Date(byId.d.startedAt) >= new Date(byId.b.finishedAt));
  assert.ok(new Date(byId.d.startedAt) >= new Date(byId.c.finishedAt));

  const evalB = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=b`)).json();
  const evalC = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=c`)).json();
  assert.equal(evalB.evaluations[0].status, "passed");
  assert.equal(evalC.evaluations[0].status, "passed");
  assert.equal(done.run.verification.evaluations.passed, 2);
});

test("GAP: a failing check command fails the step at execution time and bypasses its quality gate entirely", async (t) => {
  // CheckExecutor.inspect() ties execution status directly to whether every
  // check command passed (result.ok). OrchestrationService only calls
  // applyQualityGate() when the execution state is "succeeded"
  // (completeStepFromState). So for a `check` step, any failing command
  // fails the step immediately with a generic "Checks failed" error -
  // the qualityGate (including onFail: "wait_approval", meant to let an
  // operator override a failing gate) is never reached, and zero
  // Evaluation records are created. This also means the `check` evaluator
  // type can never itself observe/report a "failed" status: by the time it
  // would run, the executor has already guaranteed every command passed.
  const { baseUrl, store, service, worktrees, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "gate-unreachable-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "gate unreachable on command failure",
      steps: [
        {
          id: "verify",
          executor: "check",
          input: { worktreeId: worktree.id, commands: ["exit 1"] },
          qualityGate: { evaluators: [{ type: "check" }], onFail: "wait_approval" }
        },
        { id: "after", executor: "shell", dependsOn: ["verify"], input: { command: "echo should-not-run" } }
      ]
    })
  });
  const created = await createRes.json();

  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "failed");
  const statuses = Object.fromEntries(done.steps.map((s: any) => [s.id, s.status]));
  assert.deepEqual(statuses, { verify: "failed", after: "skipped" }, "onFail:wait_approval was configured but the run failed outright");
  assert.equal(done.steps.find((s: any) => s.id === "verify").error, "Checks failed", "generic executor error, not the quality-gate reason");

  const evalRes = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json();
  assert.equal(evalRes.evaluations.length, 0, "no Evaluation record was ever created for the configured quality gate");

  // Evidence/artifacts for the failing command are still recorded correctly -
  // only the quality-gate layer is bypassed.
  assert.equal((await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evidence?stepId=verify`)).json()).evidence.length, 1);
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_failed");
});

test("quality gate onFail=fail blocks and skips downstream steps (gate rejects an otherwise-succeeded check step)", async (t) => {
  const { baseUrl, store, service, worktrees, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "gate-fail-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "gate fail",
      steps: [
        {
          id: "verify",
          executor: "check",
          // All commands pass, so the executor reports "succeeded" and the
          // quality gate is actually reached; the gate itself is what fails
          // the step, independent of the check exit codes.
          input: { worktreeId: worktree.id, commands: ["true"] },
          qualityGate: { evaluators: [{ type: "boolean", source: "output.releaseApproved", expected: true }] }
        },
        { id: "after", executor: "shell", dependsOn: ["verify"], input: { command: "echo should-not-run" } }
      ]
    })
  });
  const created = await createRes.json();

  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "failed");
  const statuses = Object.fromEntries(done.steps.map((s: any) => [s.id, s.status]));
  assert.deepEqual(statuses, { verify: "failed", after: "skipped" });

  const evalRes = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json();
  assert.equal(evalRes.evaluations[0].status, "failed");
  assert.match(evalRes.evaluations[0].reason, /output\.releaseApproved expected true and was false/);

  // The underlying check command itself passed - worktree state reflects that -
  // it's the quality gate, not the checks, that failed the step.
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_passed");
});

test("quality gate onFail=wait_approval blocks then unblocks via operator approval (gate rejects an otherwise-succeeded check step)", async (t) => {
  const { baseUrl, service, worktrees, store, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "gate-wait-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "gate wait approval",
      steps: [
        {
          id: "verify",
          executor: "check",
          input: { worktreeId: worktree.id, commands: ["true"] },
          qualityGate: { evaluators: [{ type: "boolean", source: "output.releaseApproved", expected: true }], onFail: "wait_approval" }
        },
        { id: "after", executor: "shell", dependsOn: ["verify"], input: { command: "echo unblocked" } }
      ]
    })
  });
  const created = await createRes.json();

  const waiting = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "waiting_approval");
  assert.equal(waiting.steps.find((s: any) => s.id === "verify").status, "waiting_approval");
  assert.equal(waiting.steps.find((s: any) => s.id === "after").status, "pending");
  const evalRes = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json();
  assert.equal(evalRes.evaluations[0].status, "failed");

  const approveRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/steps/verify/approve`, { method: "POST" });
  assert.equal(approveRes.status, 200);

  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "succeeded" || detail.run.status === "failed");
  assert.equal(done.run.status, "succeeded");
  assert.equal(done.steps.find((s: any) => s.id === "after").status, "succeeded");
});

test("operator rejection fails the run with the given reason", async (t) => {
  const { baseUrl, project } = await withE2EServer(t);
  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, goal: "reject flow", steps: [{ id: "approve", executor: "approval" }] })
  });
  const created = await createRes.json();
  assert.equal(created.run.status, "waiting_approval");

  const rejectRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/steps/approve/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "not ready for release" })
  });
  assert.equal(rejectRes.status, 200);
  const rejected = await rejectRes.json();
  assert.equal(rejected.run.status, "failed");
  assert.equal(rejected.step.error, "not ready for release");
});

test("cancelling a run in waiting_approval marks the run and step cancelled", async (t) => {
  const { baseUrl, project } = await withE2EServer(t);
  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, goal: "cancel flow", steps: [{ id: "approve", executor: "approval" }] })
  });
  const created = await createRes.json();
  const cancelRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/cancel`, { method: "POST" });
  assert.equal(cancelRes.status, 200);
  assert.equal((await cancelRes.json()).run.status, "cancelled");
  const detail = await getRun(baseUrl, created.run.id);
  assert.equal(detail.steps[0].status, "cancelled");
});

test("DAG validation rejects cycles, duplicate ids, unknown executors, and unknown dependencies via REST (400)", async (t) => {
  const { baseUrl, project } = await withE2EServer(t);
  const cases: Array<{ name: string; steps: unknown[] }> = [
    { name: "cycle", steps: [{ id: "a", executor: "shell", dependsOn: ["b"] }, { id: "b", executor: "shell", dependsOn: ["a"] }] },
    { name: "duplicate id", steps: [{ id: "a", executor: "shell" }, { id: "a", executor: "shell" }] },
    { name: "unknown executor", steps: [{ id: "a", executor: "not-a-real-executor" }] },
    { name: "unknown dependency", steps: [{ id: "a", executor: "shell", dependsOn: ["missing"] }] }
  ];
  for (const testCase of cases) {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, goal: testCase.name, steps: testCase.steps })
    });
    assert.equal(res.status, 400, `expected 400 for ${testCase.name}`);
  }
});

test("check quality gate cross-links evidence and artifact ids on the evaluation across multiple commands", async (t) => {
  // Both commands must pass for this scenario to even reach the gate (see
  // the "GAP" test above documenting why a failing command never does).
  const { baseUrl, service, worktrees, store, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "linkage-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "linkage",
      steps: [
        {
          id: "verify",
          executor: "check",
          input: { worktreeId: worktree.id, commands: ["true", "echo second"] },
          qualityGate: { evaluators: [{ type: "check" }] }
        }
      ]
    })
  });
  const created = await createRes.json();
  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "succeeded" || detail.run.status === "failed");
  assert.equal(done.run.status, "succeeded");

  const artifacts = (await (await fetch(`${baseUrl}/api/runs/${created.run.id}/artifacts?stepId=verify`)).json()).artifacts;
  const evidence = (await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evidence?stepId=verify`)).json()).evidence;
  const evaluation = (await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json()).evaluations[0];

  assert.equal(artifacts.length, 2);
  assert.equal(evidence.length, 2);
  assert.equal(evaluation.status, "passed");
  assert.equal(evaluation.score, 2, "both commands passed");
  assert.equal(evaluation.threshold, 2);
  assert.deepEqual([...evaluation.evidenceIds].sort(), evidence.map((e: any) => e.id).sort());
  assert.deepEqual([...evaluation.artifactIds].sort(), artifacts.map((a: any) => a.id).sort());
  assert.equal(done.steps[0].status, "succeeded");
});

test("GAP: WorktreeManager.runChecks leaves CheckRun.exitCode undefined on success, unlike the normalized Evidence.value.exitCode", async (t) => {
  // CheckExecutor.start() normalizes exitCode when building check.command
  // Evidence (`run.exitCode ?? (status === "passed" ? 0 : 1)`), but the raw
  // `checkRuns` array attached to the step's own `output` (and to the
  // worktree/task checkRuns) is not normalized: runCommandSafe only sets
  // `code` on the error path, so a passing command's CheckRun.exitCode is
  // `undefined`. A quality-gate evaluator reading `output.checkRuns.N.exitCode`
  // directly (a natural-looking source path) will get `Number(undefined)` =
  // NaN, which numeric-threshold treats as a hard evaluator *error*, failing
  // the gate for a command that actually passed. The correct/safe source
  // path is `check.exitCode` (reads the normalized Evidence value).
  const { baseUrl, service, worktrees, store, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "raw-exitcode-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "raw exitCode inconsistency",
      steps: [
        {
          id: "verify",
          executor: "check",
          input: { worktreeId: worktree.id, commands: ["true"] },
          qualityGate: { evaluators: [{ type: "numeric-threshold", source: "output.checkRuns.0.exitCode", operator: "<=", threshold: 0 }] }
        }
      ]
    })
  });
  const created = await createRes.json();
  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "succeeded" || detail.run.status === "failed");

  assert.equal(done.run.status, "failed", "the underlying check command actually passed, but the gate errors out on NaN");
  const evalRes = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json();
  assert.equal(evalRes.evaluations[0].status, "error");
  assert.match(evalRes.evaluations[0].reason, /finite/);
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_passed", "worktree state correctly shows the check passed, contradicting the gate's error-driven failure");
});
