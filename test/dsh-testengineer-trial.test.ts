import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { createDefaultExecutorRegistry } from "../server/executors/index.js";
import { EventBus } from "../server/events.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import { loadRecipesFromDirectory, materializeRecipe } from "../server/recipes/registry.js";
import { JsonStore } from "../server/store.js";
import { WorktreeManager } from "../server/worktrees.js";
import { runCommandSafe } from "../server/utils.js";

// #92: dsh-testengineer-trial.yaml wires the DSH adapter (#88) and score.py
// (#91) into a single trial's "score" step. A live agent=dsh run needs a
// real dsh install + DEEPSEEK_API_KEY (neither available in CI - see
// docs/dsh-adapter-notes.md's own precedent of live-verifying the adapter
// itself in a separate manual spike, and orchestration-e2e.test.ts's own
// note that AgentTaskExecutor isn't exercised with a real tmux-backed CLI
// in automated e2e tests). What *is* fully testable here, end to end
// through the real OrchestrationService/WorktreeManager/CheckExecutor (no
// mocks) and the real score.py, is the half of the acceptance criteria
// that doesn't require a live agent: "the score step's quality gate
// correctly reflects score.py's exit code" - exercised on the actual
// materialized "score" step from the shipped recipe, against a real
// tinytable-eval mutant fixture, standing in for what a completed
// test-engineer step would have left in the worktree.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const shippedRecipesDir = join(repoRoot, "server", "recipes");
const tinytableEvalDir = join(repoRoot, "examples", "tinytable-eval");
const scorePy = join(tinytableEvalDir, "score.py");
const cleanRoot = join(tinytableEvalDir, "clean");
const mutantM01 = join(tinytableEvalDir, "mutants", "m01");
const goldenM01 = join(tinytableEvalDir, "golden", "m01.test");

function scoreCommand() {
  return `python3 ${scorePy} --worktree . --clean ${cleanRoot} --out score.json`;
}

async function initFixtureRepo(repoPath: string) {
  await mkdir(repoPath, { recursive: true });
  await cp(join(mutantM01, "tinytable"), join(repoPath, "tinytable"), { recursive: true });
  await cp(join(mutantM01, "sql-tests", "official"), join(repoPath, "sql-tests", "official"), { recursive: true });
  await runCommandSafe("git", ["init"], { cwd: repoPath });
  await runCommandSafe("git", ["checkout", "-B", "main"], { cwd: repoPath });
  await runCommandSafe("git", ["config", "user.email", "e2e@example.com"], { cwd: repoPath });
  await runCommandSafe("git", ["config", "user.name", "E2E"], { cwd: repoPath });
  await runCommandSafe("git", ["add", "-A"], { cwd: repoPath });
  await runCommandSafe("git", ["commit", "-m", "seed"], { cwd: repoPath });
}

async function withServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-dsh-trial-"));
  const repoPath = join(tempDir, "repo");
  await initFixtureRepo(repoPath);
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
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const project = await store.createProject({
    name: "tinytable-m01",
    repoPath,
    defaultBranch: "main",
    defaultAgent: "dsh",
    testCommands: [],
    runCommands: []
  });

  t.after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await rm(tempDir, { recursive: true, force: true });
  });
  return { baseUrl, store, service, worktrees, project };
}

async function getRun(baseUrl: string, runId: string) {
  const res = await fetch(`${baseUrl}/api/runs/${runId}`);
  assert.equal(res.status, 200);
  return res.json();
}

async function pollRun(
  service: OrchestrationService,
  baseUrl: string,
  runId: string,
  predicate: (detail: any) => boolean,
  { timeoutMs = 20000, intervalMs = 50 } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    await service.scheduleRun(runId);
    last = await getRun(baseUrl, runId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollRun timed out. run.status=${last?.run?.status} steps=${JSON.stringify(last?.steps?.map((s: any) => [s.id, s.status]))}`
  );
}

async function materializedScoreStep(projectId: string) {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("dsh-testengineer-trial")!;
  const materialized = materializeRecipe(recipe, { projectId, parameters: { scoreCommand: scoreCommand() } });
  return materialized.steps.find((step) => step.id === "score")!;
}

test("dsh-testengineer-trial's score step: quality gate passes when sql-tests/agent/ kills the seeded mutant", async (t) => {
  const { baseUrl, store, service, worktrees, project } = await withServer(t);
  const scoreStep = await materializedScoreStep(project.id);

  const created = await worktrees.create({ project, title: "m01-killed", agent: "dsh" });
  const worktree = await store.createWorktree({ ...created, agent: "dsh" } as any);

  // Stands in for what a completed "test-engineer" step would have left in
  // the worktree: a real .test file that kills this fixture's seeded
  // defect (golden/m01.test - see #90), plus findings.json, as uncommitted
  // worktree edits (agents don't commit on their own - see
  // WorktreeManager.diff's own comment).
  await mkdir(join(worktree.path, "sql-tests", "agent"), { recursive: true });
  await cp(goldenM01, join(worktree.path, "sql-tests", "agent", "m01.test"));
  await writeFile(
    join(worktree.path, "findings.json"),
    JSON.stringify(
      [
        {
          id: "m01",
          summary: "`x = NULL` incorrectly matches a NULL row instead of never matching.",
          spec_section: "NULL semantics (three-valued logic)",
          repro_test: "sql-tests/agent/m01.test"
        }
      ],
      null,
      2
    )
  );

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "dsh-testengineer-trial score step (mutant killed)",
      steps: [{ ...scoreStep, dependsOn: [], input: { ...scoreStep.input, worktreeId: worktree.id } }]
    })
  });
  assert.equal(createRes.status, 201);
  const created2 = await createRes.json();

  const done = await pollRun(service, baseUrl, created2.run.id, (detail) => detail.run.status !== "running" && detail.run.status !== "pending");
  assert.equal(done.run.status, "succeeded", JSON.stringify(done.steps));
  assert.equal(done.steps[0].status, "succeeded");

  const scoreJson = JSON.parse(await readFile(join(worktree.path, "score.json"), "utf8"));
  assert.equal(scoreJson.killed, true);
  assert.equal(scoreJson.false_alarms, 0);
  assert.equal(scoreJson.contract_ok, true);
  assert.equal(scoreJson.passed, true);
});

test("dsh-testengineer-trial's score step: quality gate fails when sql-tests/agent/ is empty (no-op agent)", async (t) => {
  const { baseUrl, store, service, worktrees, project } = await withServer(t);
  const scoreStep = await materializedScoreStep(project.id);

  const created = await worktrees.create({ project, title: "m01-empty", agent: "dsh" });
  const worktree = await store.createWorktree({ ...created, agent: "dsh" } as any);
  // No sql-tests/agent/, no findings.json - simulates a no-op/blocked agent.

  const createRes = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      goal: "dsh-testengineer-trial score step (empty agent suite)",
      steps: [{ ...scoreStep, dependsOn: [], input: { ...scoreStep.input, worktreeId: worktree.id } }]
    })
  });
  assert.equal(createRes.status, 201);
  const created2 = await createRes.json();

  const done = await pollRun(service, baseUrl, created2.run.id, (detail) => detail.run.status !== "running" && detail.run.status !== "pending");
  assert.equal(done.run.status, "failed", JSON.stringify(done.steps));
  assert.equal(done.steps[0].status, "failed");

  const scoreJson = JSON.parse(await readFile(join(worktree.path, "score.json"), "utf8"));
  assert.equal(scoreJson.contract_ok, false);
  assert.equal(scoreJson.passed, false);
});
