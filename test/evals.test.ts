import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { computeEvalMetrics } from "../server/evals/metrics.js";
import { JsonStore } from "../server/store.js";

async function makeStore(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-evals-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  return new JsonStore(join(tempDir, "store.json"));
}

/**
 * Builds a fixture spanning three runs, hand-crafted directly against the
 * Store (rather than driven through OrchestrationService) so each of the
 * five #54 metrics can be pinned to an exact, independently-verifiable
 * numerator/denominator:
 *
 * - Run A (project "proj1", recipe "recipe-x", contractLevel L2, prompt v1):
 *   an agent-task step that fully satisfies its produces contract and
 *   leaves a manifest artifact, a "check" step that ran to completion, and
 *   a passed/system-decided quality gate.
 * - Run B (project "proj1", recipe "recipe-x", contractLevel L2, prompt v2):
 *   an agent-task step that fails its produces contract, a "check" step
 *   skipped because its upstream failed, an agent-task step that got
 *   blocked once, and a failed/operator-decided quality gate (a rejection).
 * - Run C (project "proj2", recipe "recipe-y", contractLevel L0): no steps
 *   at all - exists purely to prove project/recipe/level filters exclude it.
 */
async function buildFixture(store: JsonStore) {
  const runA = await store.createRun({ projectId: "proj1", goal: "run A", status: "succeeded", recipeId: "recipe-x", contractLevel: "L2" });
  await store.createStep({
    id: "implement", runId: runA.id, name: "Implement", executor: "agent-task",
    input: {}, status: "succeeded", produces: ["diff", "changed_files"]
  });
  await store.createStep({ id: "check", runId: runA.id, name: "Check", executor: "check", input: {}, status: "succeeded", consumes: ["diff"] });
  await store.createEvidence({ runId: runA.id, stepId: "implement", kind: "agent.completion", claim: "done", value: { harnessPromptVersion: "1" } });
  await store.createEvidence({ runId: runA.id, stepId: "implement", kind: "agent.manifest", claim: "coverage.json" });
  await store.createQualityGateDecision({ runId: runA.id, stepId: "check", attempt: 1, status: "passed", evaluationIds: [], decidedBy: "system" });

  const runB = await store.createRun({ projectId: "proj1", goal: "run B", status: "failed", recipeId: "recipe-x", contractLevel: "L2" });
  await store.createStep({
    id: "implement2", runId: runB.id, name: "Implement", executor: "agent-task",
    input: {}, status: "failed", failureKind: "contract_violation", produces: ["diff"]
  });
  await store.createStep({ id: "check2", runId: runB.id, name: "Check", executor: "check", input: {}, status: "skipped", consumes: ["diff"] });
  await store.createStep({ id: "flaky-agent", runId: runB.id, name: "Flaky", executor: "agent-task", input: {}, status: "failed" });
  await store.createEvidence({ runId: runB.id, stepId: "implement2", kind: "agent.completion", claim: "done", value: { harnessPromptVersion: "2" } });
  await store.createEvidence({ runId: runB.id, stepId: "flaky-agent", kind: "step.blocked", claim: "which framework?" });
  await store.createQualityGateDecision({ runId: runB.id, stepId: "check2", attempt: 1, status: "failed", evaluationIds: [], decidedBy: "operator" });

  const runC = await store.createRun({ projectId: "proj2", goal: "run C", status: "succeeded", recipeId: "recipe-y", contractLevel: "L0" });

  return { runA, runB, runC };
}

test("computeEvalMetrics: unfiltered aggregate across all five metrics matches the hand-verified fixture", async (t) => {
  const store = await makeStore(t);
  await buildFixture(store);

  const metrics = await computeEvalMetrics(store);
  assert.equal(metrics.runCount, 3);
  assert.deepEqual(metrics.contractCompliance, { satisfied: 1, total: 2, rate: 0.5 });
  assert.deepEqual(metrics.manifestEmission, { satisfied: 1, total: 1, rate: 1 });
  assert.deepEqual(metrics.verifyRunnable, { satisfied: 1, total: 2, rate: 0.5 });
  assert.deepEqual(metrics.qualityGatePass, { satisfied: 1, total: 2, rate: 0.5 });
  assert.deepEqual(metrics.humanOverride, { satisfied: 1, total: 2, rate: 0.5 });
  assert.deepEqual(metrics.blockedStep, { satisfied: 1, total: 3, rate: 1 / 3 });
});

test("computeEvalMetrics: recipeId and contractLevel filters both include runs A/B and exclude run C", async (t) => {
  const store = await makeStore(t);
  await buildFixture(store);

  const byRecipe = await computeEvalMetrics(store, { recipeId: "recipe-x" });
  assert.equal(byRecipe.runCount, 2);

  const byLevel = await computeEvalMetrics(store, { contractLevel: "L2" });
  assert.equal(byLevel.runCount, 2);

  const byProject = await computeEvalMetrics(store, { projectId: "proj2" });
  assert.equal(byProject.runCount, 1);
  assert.equal(byProject.contractCompliance.rate, null, "run C has no produces-declaring steps, so the rate is not-applicable rather than 0");
});

test("computeEvalMetrics: promptVersion filter isolates a single run so two harness prompt versions can be compared on compliance rate", async (t) => {
  const store = await makeStore(t);
  await buildFixture(store);

  const v1 = await computeEvalMetrics(store, { promptVersion: "1" });
  assert.equal(v1.runCount, 1);
  assert.deepEqual(v1.contractCompliance, { satisfied: 1, total: 1, rate: 1 });

  const v2 = await computeEvalMetrics(store, { promptVersion: "2" });
  assert.equal(v2.runCount, 1);
  assert.deepEqual(v2.contractCompliance, { satisfied: 0, total: 1, rate: 0 });

  assert.notEqual(v1.contractCompliance.rate, v2.contractCompliance.rate);
});

test("computeEvalMetrics: an unmatched filter returns zero runs and every rate is null, not NaN or zero", async (t) => {
  const store = await makeStore(t);
  await buildFixture(store);

  const metrics = await computeEvalMetrics(store, { recipeId: "does-not-exist" });
  assert.equal(metrics.runCount, 0);
  for (const stat of [metrics.contractCompliance, metrics.manifestEmission, metrics.verifyRunnable, metrics.qualityGatePass, metrics.humanOverride, metrics.blockedStep]) {
    assert.equal(stat.total, 0);
    assert.equal(stat.rate, null);
  }
});

test("GET /api/evals/metrics serves the same computation over REST, filterable by recipeId/contractLevel/promptVersion/projectId, and rejects an invalid contractLevel", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-evals-rest-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  await buildFixture(store);

  const app = createApp({
    store,
    bus: new EventBus(),
    tmux: { listSessions: async () => [] } as any,
    worktrees: {} as any,
    run: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    token: null,
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions")
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const all = await fetch(`${baseUrl}/api/evals/metrics`);
  assert.equal(all.status, 200);
  const allBody = await all.json();
  assert.equal(allBody.runCount, 3);

  const filtered = await fetch(`${baseUrl}/api/evals/metrics?recipeId=recipe-x&contractLevel=L2&promptVersion=1`);
  assert.equal(filtered.status, 200);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.runCount, 1);
  assert.deepEqual(filteredBody.contractCompliance, { satisfied: 1, total: 1, rate: 1 });

  const invalid = await fetch(`${baseUrl}/api/evals/metrics?contractLevel=L9`);
  assert.equal(invalid.status, 400);
});
