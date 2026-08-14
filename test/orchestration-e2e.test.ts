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
  // git's default initial branch name depends on the runner's git version/
  // config (e.g. differs between local dev and CI); pin it explicitly,
  // matching ensureNewProjectRepo's own `git checkout -B <branch>` pattern.
  await runCommandSafe("git", ["checkout", "-B", "main"], { cwd: path });
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
 * Production now advances detached-completion executors (like `shell`) via
 * OrchestrationService.startPolling() (wired in server/index.ts) - see the
 * dedicated tests below for both the poller-off baseline and the fix. This
 * harness calls scheduleRun() directly (the in-process service instance)
 * instead of starting a real poller, so the rest of this suite can
 * validate downstream DAG, evidence, and quality-gate behavior on its own
 * schedule rather than waiting on interval-based polling.
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

test("without an explicit poller, a shell step does not advance on its own (pure REST client, no manual scheduleRun)", async (t) => {
  // OrchestrationService.startPolling() is what fixes this in production
  // (wired in server/index.ts); it is intentionally opt-in rather than
  // automatic in the constructor, so this test documents the baseline
  // behavior when nothing has enabled it. See the next test for the fix.
  const { baseUrl, project } = await withE2EServer(t);
  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "no poller probe",
      steps: [{ id: "a", executor: "shell", input: { command: "sleep 0.2 && echo done" } }]
    })
  });
  const created = await createRes.json();
  assert.equal(created.steps[0].status, "running");

  // Give the background shell command ample time to actually finish...
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // ...then poll purely via REST GET, exactly as an external client would.
  // No scheduleRun trigger exists on this path (no approve/reject/cancel
  // call, no agent-task event, no poller) so the step/run must still read
  // "running".
  const stillRunning = await getRun(baseUrl, created.run.id);
  assert.equal(stillRunning.steps[0].status, "running", "shell step finished in the background but nothing repolled it");
  assert.equal(stillRunning.run.status, "running");
});

test("service.startPolling() advances a shell step to completion via pure REST polling (no manual scheduleRun)", async (t) => {
  const { baseUrl, project, service } = await withE2EServer(t);
  const stopPolling = service.startPolling(50);
  t.after(() => stopPolling());

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "poller probe",
      steps: [{ id: "a", executor: "shell", input: { command: "sleep 0.2 && echo done" } }]
    })
  });
  const created = await createRes.json();
  assert.equal(created.steps[0].status, "running");

  // Poll purely via REST GET - no manual scheduleRun() call, no approve/
  // reject/cancel, relying entirely on the background poller.
  const deadline = Date.now() + 5000;
  let detail = created;
  while (Date.now() < deadline && detail.run.status !== "succeeded") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    detail = await getRun(baseUrl, created.run.id);
  }
  assert.equal(detail.run.status, "succeeded");
  assert.equal(detail.steps[0].status, "succeeded");
  assert.equal(detail.steps[0].output.stdout.trim(), "done");
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

  // No qualityGate was declared on "verify", so the service applies its
  // default check-type gate; both commands passed, so it's a single
  // passing evaluation covering both check.command evidence records.
  const evalRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`);
  const evaluations = (await evalRes.json()).evaluations;
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].status, "passed");
  assert.equal(waiting.run.verification.artifacts, 2);
  assert.equal(waiting.run.verification.evidence, 2);
  assert.equal(waiting.run.verification.evaluations.passed, 1);

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

test("a failing check command reaches its quality gate: onFail=wait_approval lets an operator override it", async (t) => {
  // Regression test for the fixed gap: CheckExecutor.inspect() used to tie
  // execution status directly to whether every check command passed, which
  // meant a failing command failed the step before its qualityGate (and
  // onFail: "wait_approval" in particular) ever ran. CheckExecutor now
  // always reports "succeeded" (the checks ran without an infrastructure
  // error) and lets the quality gate - explicit, or the service's implicit
  // default `{ evaluators: [{ type: "check" }], onFail: "fail" }` for
  // check steps with none declared - decide pass/fail.
  const { baseUrl, store, service, worktrees, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "gate-reachable-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "gate reachable on command failure",
      steps: [
        {
          id: "verify",
          executor: "check",
          input: { worktreeId: worktree.id, commands: ["exit 1"] },
          qualityGate: { evaluators: [{ type: "check" }], onFail: "wait_approval" }
        },
        { id: "after", executor: "shell", dependsOn: ["verify"], input: { command: "echo unblocked" } }
      ]
    })
  });
  const created = await createRes.json();

  const waiting = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "waiting_approval");
  const statuses = Object.fromEntries(waiting.steps.map((s: any) => [s.id, s.status]));
  assert.deepEqual(statuses, { verify: "waiting_approval", after: "pending" });

  const evalRes = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json();
  assert.equal(evalRes.evaluations.length, 1);
  assert.equal(evalRes.evaluations[0].status, "failed");
  assert.match(evalRes.evaluations[0].reason, /One or more check commands failed/);

  // Evidence/artifacts for the failing command were recorded and are
  // linked to the (now real) evaluation.
  const evidence = (await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evidence?stepId=verify`)).json()).evidence;
  assert.equal(evidence.length, 1);
  assert.deepEqual(evalRes.evaluations[0].evidenceIds, [evidence[0].id]);
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_failed");

  const approveRes = await fetch(`${baseUrl}/api/runs/${created.run.id}/steps/verify/approve`, { method: "POST" });
  assert.equal(approveRes.status, 200);
  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "succeeded" || detail.run.status === "failed");
  assert.equal(done.run.status, "succeeded");
  assert.equal(done.steps.find((s: any) => s.id === "after").status, "succeeded");
});

test("a check step with no declared qualityGate still fails on a failing command (implicit default check gate)", async (t) => {
  const { baseUrl, store, service, worktrees, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "gate-default-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "default gate preserves prior no-gate behavior",
      steps: [
        { id: "verify", executor: "check", input: { worktreeId: worktree.id, commands: ["exit 1"] } },
        { id: "after", executor: "shell", dependsOn: ["verify"], input: { command: "echo should-not-run" } }
      ]
    })
  });
  const created = await createRes.json();

  const done = await pollRun(service, baseUrl, created.run.id, (detail) => detail.run.status === "failed");
  const statuses = Object.fromEntries(done.steps.map((s: any) => [s.id, s.status]));
  assert.deepEqual(statuses, { verify: "failed", after: "skipped" });

  const evalRes = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json();
  assert.equal(evalRes.evaluations.length, 1, "the implicit default check gate still produces an Evaluation record");
  assert.equal(evalRes.evaluations[0].status, "failed");
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

test("WorktreeManager.runChecks normalizes CheckRun.exitCode to 0 on success, so raw output.checkRuns[i].exitCode is usable", async (t) => {
  // Regression test for the fixed gap: runCommandSafe only set `code` on
  // the failure path, so a passing command's raw CheckRun.exitCode used to
  // be `undefined`, and a numeric-threshold gate reading
  // `output.checkRuns.0.exitCode` directly would see Number(undefined) =
  // NaN and error out even though the check passed. runChecks now
  // normalizes exitCode to 0/1 based on status, matching the already
  // normalized `check.exitCode` evidence path.
  const { baseUrl, service, worktrees, store, project } = await withE2EServer(t);
  const worktree = await createFixtureWorktree(worktrees, store, project, "raw-exitcode-dag");

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "raw exitCode is normalized",
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

  assert.equal(done.run.status, "succeeded");
  const evalRes = await (await fetch(`${baseUrl}/api/runs/${created.run.id}/evaluations?stepId=verify`)).json();
  assert.equal(evalRes.evaluations[0].status, "passed");
  assert.equal(evalRes.evaluations[0].score, 0);
  assert.equal((await store.getWorktree(worktree.id))!.status, "checks_passed");
});
