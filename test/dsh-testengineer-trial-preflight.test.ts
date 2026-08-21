import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { buildSeedRoot } from "../scripts/tinytable-seed-root-builder.js";

// #106: dsh-testengineer-trial's "test-engineer" step accepts an optional
// expectedManifest parameter (a #104 buildSeedRoot() manifest's `files`
// list). When set, AgentTaskExecutor.preflight() checks it against the
// *registered project's repo* - before any Run/Step record exists, let
// alone a worktree or an agent session - and rejects the run outright on a
// mismatch. This is the #103 AC1 fix: a run launched against the wrong (or
// an incomplete) project used to silently hand the agent a worktree missing
// the fixture; now it fails immediately with an error naming what's
// missing, and no agent turn is ever spent.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const shippedRecipesDir = join(repoRoot, "server", "recipes");

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function gitInit(repoPath: string) {
  await runCommandSafe("git", ["init"], { cwd: repoPath });
  await runCommandSafe("git", ["checkout", "-B", "main"], { cwd: repoPath });
  await runCommandSafe("git", ["config", "user.email", "e2e@example.com"], { cwd: repoPath });
  await runCommandSafe("git", ["config", "user.name", "E2E"], { cwd: repoPath });
  await runCommandSafe("git", ["add", "-A"], { cwd: repoPath });
  await runCommandSafe("git", ["commit", "-m", "seed"], { cwd: repoPath });
}

/** A tmux stub that counts startSession calls, so a test can assert how many agent turns were actually spent. */
function countingTmux() {
  let startSessionCalls = 0;
  const tmux = {
    listSessions: async () => [],
    startSession: async () => {
      startSessionCalls += 1;
    },
    killSession: async () => {},
    capture: async () => "",
    sendInput: async () => {}
  };
  return { tmux, callCount: () => startSessionCalls };
}

async function withServer(t: TestContext, repoPath: string) {
  const tempRoot = await tempDir(t, "honeyrail-dsh-preflight-");
  const worktreeRoot = join(tempRoot, "worktrees");
  const store = new JsonStore(join(tempRoot, "store.json"));
  const bus = new EventBus();
  const worktrees = new WorktreeManager({ root: worktreeRoot, run: runCommandSafe });
  const executors = createDefaultExecutorRegistry();
  const { tmux, callCount } = countingTmux();
  const service = new OrchestrationService({
    store,
    bus,
    tmux: tmux as any,
    worktrees,
    runCommand: runCommandSafe,
    sessionLogRoot: join(tempRoot, "sessions"),
    attachmentRoot: join(tempRoot, "attachments"),
    executors
  });
  const recipeRegistry = await loadRecipesFromDirectory(shippedRecipesDir);
  const app = createApp({
    store,
    bus,
    tmux: { listSessions: async () => [] } as any,
    worktrees,
    run: runCommandSafe,
    token: null,
    attachmentRoot: join(tempRoot, "attachments"),
    sessionLogRoot: join(tempRoot, "sessions"),
    orchestration: service,
    recipeRegistry
  });
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const project = await store.createProject({
    name: "preflight-fixture",
    repoPath,
    defaultBranch: "main",
    defaultAgent: "dsh",
    testCommands: [],
    runCommands: []
  });

  t.after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });
  return { baseUrl, project, agentTurns: callCount };
}

// #109: POST /api/recipes/dsh-testengineer-trial/runs is blocked outright
// (that route hands the agent shared filesystem access to the registered
// project's real repo - see recipe-launch-guard.test.ts). This test isn't
// exercising that HTTP wiring, though - it's exercising the #106 manifest
// preflight mechanism itself (AgentTaskExecutor.preflight(), invoked from
// OrchestrationService.createRun()), so it materializes the recipe in
// process (same as materializeRecipe's other callers) and posts the result
// to the generic POST /api/runs, exactly like dsh-testengineer-trial.test.ts
// already does for the same reason.
async function createDshTrialRun(
  baseUrl: string,
  projectId: string,
  expectedManifest: string,
  agentOverride?: string
) {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("dsh-testengineer-trial")!;
  const materialized = materializeRecipe(recipe, {
    projectId,
    parameters: {
      scoreCommand: "true",
      expectedManifest,
      ...(agentOverride ? { agent: agentOverride } : {})
    }
  });
  return fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      goal: materialized.goal,
      contractLevel: materialized.contractLevel,
      steps: materialized.steps
    })
  });
}

test("dsh-testengineer-trial preflight: rejects a run against a project missing the fixture, before any agent turn is spent (#103 AC1)", async (t) => {
  const repoPath = await tempDir(t, "honeyrail-preflight-broken-repo-");
  // Deliberately unrelated content - the exact #103 scenario (wrong/empty project).
  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), "unrelated repo\n");
  await gitInit(repoPath);

  const seedRootDir = await tempDir(t, "honeyrail-preflight-seed-");
  const manifest = await buildSeedRoot({ mutantId: "m01", outDir: seedRootDir });

  const { baseUrl, project, agentTurns } = await withServer(t, repoPath);

  const res = await createDshTrialRun(baseUrl, project.id, JSON.stringify({ files: manifest.files }));

  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error || "", /does not match the expected fixture manifest/);
  assert.match(body.error || "", /missing "SPEC\.md"/);
  assert.match(body.error || "", /missing "tinytable\/__init__\.py"/);
  assert.equal(agentTurns(), 0, "no agent session should ever have been started");

  const runsRes = await fetch(`${baseUrl}/api/runs?projectId=${project.id}`);
  const runs = (await runsRes.json()) as { runs: unknown[] };
  assert.equal(runs.runs.length, 0, "no Run record should have been created for a run that fails preflight");
});

test("dsh-testengineer-trial preflight: a project whose repo matches the manifest behaves identically to no manifest at all (#106 AC2)", async (t) => {
  const seedRootDir = await tempDir(t, "honeyrail-preflight-seed2-");
  const manifest = await buildSeedRoot({ mutantId: "m01", outDir: seedRootDir });
  const repoPath = await tempDir(t, "honeyrail-preflight-good-repo-");
  await cp(seedRootDir, repoPath, { recursive: true });
  await gitInit(repoPath);

  const { baseUrl, project, agentTurns } = await withServer(t, repoPath);

  // "null" (#71's calibration probe - see docs/agent-adapters.md) rather
  // than the recipe's default "dsh": this test isolates the #106 manifest
  // check from AgentTaskExecutor's separate, pre-existing doctor-style
  // adapter-detection preflight, which would otherwise fail here since a
  // real dsh install isn't available in this environment (same reasoning
  // as dsh-testengineer-trial.test.ts's own header comment).
  const res = await createDshTrialRun(baseUrl, project.id, JSON.stringify({ files: manifest.files }), "null");

  const responseBody = await res.json();
  assert.equal(res.status, 201, JSON.stringify(responseBody));
  const created = responseBody as { run: { id: string; status: string }; steps: Array<{ id: string; status: string }> };
  assert.ok(created.run.id);
  // createRun() schedules the run once synchronously before returning, so
  // the dependency-free "test-engineer" step should already have been
  // started - proving the manifest check didn't just pass statically, the
  // step actually proceeded to create a worktree and launch an agent
  // session, exactly as it would with no expectedManifest set at all.
  assert.equal(agentTurns(), 1, "the agent session should have been started exactly once");

  const runDetail = (await (await fetch(`${baseUrl}/api/runs/${created.run.id}`)).json()) as {
    steps: Array<{ id: string; status: string }>;
  };
  const testEngineerStep = runDetail.steps.find((s) => s.id === "test-engineer");
  assert.ok(testEngineerStep);
  assert.notEqual(testEngineerStep!.status, "failed");
});
