import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import { createDefaultExecutorRegistry } from "../server/executors/index.js";
import { loadRecipesFromDirectory } from "../server/recipes/registry.js";
import { JsonStore } from "../server/store.js";

// #109: dsh-testengineer-trial (#103's P0) must never be launchable through
// POST /api/recipes/:id/runs - that route hands the agent shared filesystem
// access to whatever real repo the registered project points at, which is
// exactly how #103's agent read examples/tinytable-eval's answer key. The
// only safe launch path is scripts/dsh-evals-demo.ts (#93), which never
// creates a HoneyRail run at all - so this test exercises the real shipped
// recipe (loaded from server/recipes/, not a test fixture) against the real
// HTTP route, proving the block is enforced server-side regardless of what
// the "New run" UI does or doesn't show.

const __dirname = dirname(fileURLToPath(import.meta.url));
const shippedRecipesDir = resolve(__dirname, "..", "server", "recipes");

async function withServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-recipe-launch-guard-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const executors = createDefaultExecutorRegistry();
  const orchestration = new OrchestrationService({
    store,
    bus,
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    sessionLogRoot: "",
    attachmentRoot: "",
    executors
  });
  const recipeRegistry = await loadRecipesFromDirectory(shippedRecipesDir);
  const app = createApp({
    store,
    bus,
    tmux: { listSessions: async () => [] } as any,
    worktrees: {} as any,
    run: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    token: null,
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions"),
    orchestration,
    recipeRegistry
  });
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const project = await store.createProject({
    name: "honeyrail-self",
    repoPath: tempDir,
    defaultBranch: "main",
    defaultAgent: "dsh",
    testCommands: [],
    runCommands: []
  });
  t.after(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    await rm(tempDir, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project, orchestration };
}

test("GET /api/recipes reports dsh-testengineer-trial as launchDisabled with a reason", async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/recipes`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const recipe = body.recipes.find((r: { id: string }) => r.id === "dsh-testengineer-trial");
  assert.ok(recipe, "dsh-testengineer-trial should still be listed - only its launch path is blocked, not its visibility");
  assert.equal(recipe.launchDisabled, true);
  assert.match(recipe.launchDisabledReason, /scripts\/dsh-evals-demo\.ts/);
});

test("POST /api/recipes/dsh-testengineer-trial/runs is refused with 403, even against a project set up correctly", async (t) => {
  const { baseUrl, project, orchestration } = await withServer(t);
  const before = await orchestration.listRuns();

  const res = await fetch(`${baseUrl}/api/recipes/dsh-testengineer-trial/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      parameters: { scoreCommand: "python3 examples/tinytable-eval/score.py --worktree . --clean examples/tinytable-eval/clean --out score.json" }
    })
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /must not be launched as a HoneyRail run/);
  assert.match(body.error, /scripts\/dsh-evals-demo\.ts/);

  // No run should have been created - the guard fires before materializeRecipe/createRun.
  const after = await orchestration.listRuns();
  assert.equal(after.length, before.length);
});

test("POST /api/recipes/dsh-testengineer-trial/preview still works - it's read-only and creates no run", async (t) => {
  const { baseUrl, project } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/recipes/dsh-testengineer-trial/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      parameters: { scoreCommand: "python3 examples/tinytable-eval/score.py --worktree . --clean examples/tinytable-eval/clean --out score.json" }
    })
  });
  assert.equal(res.status, 200);
});

test("a recipe with no launchDisabled field launches normally through the same route", async (t) => {
  const { baseUrl, project } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/recipes/implement-check-gate-approve/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, parameters: { title: "t", prompt: "p" } })
  });
  assert.equal(res.status, 201);
});
