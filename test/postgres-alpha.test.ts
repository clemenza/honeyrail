import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createDefaultExecutorRegistry } from "../server/executors/index.js";
import { EventBus } from "../server/events.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import { JsonStore } from "../server/store.js";
import { runCommandSafe } from "../server/utils.js";

async function hasLocalPostgres() {
  const result = await runCommandSafe("sh", ["-lc", [
    "command -v initdb >/dev/null",
    "command -v pg_ctl >/dev/null",
    "command -v psql >/dev/null",
    "command -v postgres >/dev/null",
    "initdb --version >/dev/null",
    "pg_ctl --version >/dev/null",
    "psql --version >/dev/null",
    "postgres --version >/dev/null"
  ].join(" && ")]);
  return result.ok;
}

async function withPostgresHarness(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-postgres-alpha-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const service = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: { listSessions: async () => [], startSession: async () => {}, killSession: async () => {}, capture: async () => "", sendInput: async () => {} } as any,
    worktrees: { create: async () => ({}), runChecks: async () => ({ ok: true, runs: [] }) } as any,
    runCommand: runCommandSafe,
    sessionLogRoot: join(tempDir, "sessions"),
    attachmentRoot: join(tempDir, "attachments"),
    executors: createDefaultExecutorRegistry()
  });
  const project = await store.createProject({ name: "postgres-alpha", repoPath: tempDir, defaultBranch: "main", defaultAgent: "shell", testCommands: [], runCommands: [] });
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  return { store, service, project };
}

function alphaSteps(expectedCommittedRows = 1) {
  return [
    {
      id: "verify",
      name: "PostgreSQL transaction and restart validation",
      executor: "postgres",
      input: { operation: "transaction-restart-alpha", expectedCommittedRows },
      qualityGate: {
        evaluators: [
          { type: "db-assertions" },
          { type: "boolean", source: "output.databaseReady", expected: true }
        ],
        onFail: "wait_approval" as const
      }
    },
    {
      id: "report",
      name: "Generate DB alpha report",
      executor: "postgres",
      dependsOn: ["verify"],
      input: { operation: "report", sourceStepId: "verify" }
    }
  ];
}

test("optional local PostgreSQL alpha passing scenario persists DB artifacts, evidence, evaluations, gate decision, and final report", async (t) => {
  if (!(await hasLocalPostgres())) {
    t.skip("local PostgreSQL binaries are not installed");
    return;
  }
  const { store, service, project } = await withPostgresHarness(t);

  const result = await service.createRun({
    projectId: project.id,
    goal: "postgres alpha pass",
    steps: alphaSteps()
  });

  assert.equal(result.run.status, "succeeded");
  assert.equal((await store.getStep(result.run.id, "verify"))!.status, "succeeded");
  assert.equal((await store.getStep(result.run.id, "report"))!.status, "succeeded");
  const artifacts = await store.listArtifacts(result.run.id, "verify");
  const evidence = await store.listEvidence(result.run.id, "verify");
  const evaluations = await store.listEvaluations(result.run.id, "verify");
  const decisions = await store.listQualityGateDecisions(result.run.id, "verify");
  assert.ok(artifacts.some((item) => item.name === "environment.json"));
  assert.ok(artifacts.some((item) => item.name === "query-results.json"));
  assert.ok(evidence.some((item) => item.kind === "db.server.ready"));
  assert.ok(evidence.some((item) => item.kind === "db.restart"));
  assert.ok(evidence.filter((item) => item.kind === "db.assertion").length >= 4);
  assert.deepEqual(evaluations.map((item) => [item.evaluator, item.status, item.attempt]), [["db-assertions", "passed", 1], ["boolean", "passed", 1]]);
  assert.deepEqual(decisions.map((item) => [item.status, item.decidedBy, item.attempt]), [["passed", "system", 1]]);

  const reportStep = (await store.getStep(result.run.id, "report"))!;
  const reportArtifact = await store.getArtifact(String(reportStep.output?.reportArtifactId));
  assert.equal(reportStep.output?.finalStatus, "VERIFIED");
  assert.match(await readFile(String(reportArtifact?.path), "utf8"), /Result\nVERIFIED/);
});

test("optional local PostgreSQL alpha failing scenario waits for approval, override continues, and reject fails", async (t) => {
  if (!(await hasLocalPostgres())) {
    t.skip("local PostgreSQL binaries are not installed");
    return;
  }
  const { store, service, project } = await withPostgresHarness(t);

  const overrideRun = await service.createRun({
    projectId: project.id,
    goal: "postgres alpha override",
    steps: alphaSteps(2)
  });
  assert.equal(overrideRun.run.status, "waiting_approval");
  assert.equal((await store.getStep(overrideRun.run.id, "report"))!.status, "pending");
  assert.deepEqual((await store.listQualityGateDecisions(overrideRun.run.id, "verify")).map((item) => [item.status, item.decidedBy]), [["failed", "system"]]);

  await service.approveStep(overrideRun.run.id, "verify");
  assert.equal((await store.getRun(overrideRun.run.id))!.status, "succeeded");
  const overrideDecisions = await store.listQualityGateDecisions(overrideRun.run.id, "verify");
  assert.deepEqual(overrideDecisions.map((item) => [item.status, item.decidedBy]), [["failed", "system"], ["overridden", "operator"]]);
  assert.equal((await store.getStep(overrideRun.run.id, "report"))!.output?.finalStatus, "OVERRIDDEN BY OPERATOR");

  const rejectRun = await service.createRun({
    projectId: project.id,
    goal: "postgres alpha reject",
    steps: alphaSteps(2)
  });
  assert.equal(rejectRun.run.status, "waiting_approval");
  await service.rejectStep(rejectRun.run.id, "verify", "operator rejected failed DB assertion");
  assert.equal((await store.getRun(rejectRun.run.id))!.status, "failed");
  assert.equal((await store.getStep(rejectRun.run.id, "report"))!.status, "skipped");
  assert.deepEqual((await store.listQualityGateDecisions(rejectRun.run.id, "verify")).map((item) => [item.status, item.decidedBy]), [["failed", "system"], ["failed", "operator"]]);
});
