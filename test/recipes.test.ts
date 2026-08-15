import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { ExecutorRegistry } from "../server/executors/registry.js";
import type { ExecutionHandle, ExecutionState, Executor, StepExecutionContext } from "../server/executors/types.js";
import { EventBus } from "../server/events.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import {
  loadRecipesFromDirectory,
  materializeRecipe,
  RecipeRegistry,
  RecipeValidationError
} from "../server/recipes/registry.js";
import type { Recipe } from "../server/recipes/types.js";
import { JsonStore } from "../server/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shippedRecipesDir = resolve(__dirname, "..", "server", "recipes");

class MemoryExecutor implements Executor {
  type: string;

  constructor(type: string) {
    this.type = type;
  }

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    return { executor: this.type, stepId: ctx.step.id };
  }

  async inspect(): Promise<ExecutionState> {
    return { status: "succeeded", output: { ok: true } };
  }
}

const demoRecipe: Recipe = {
  id: "demo",
  name: "Demo recipe",
  description: "A recipe used only in tests",
  category: "test",
  parameters: [
    { key: "message", label: "Message", type: "string", required: true },
    { key: "count", label: "Count", type: "number", default: 3 },
    { key: "enabled", label: "Enabled", type: "boolean", default: false },
    { key: "mode", label: "Mode", type: "enum", options: ["fast", "slow"], default: "fast" }
  ],
  steps: [
    {
      id: "a",
      executor: "ok",
      input: {
        message: "{{ message }}",
        count: "{{ count }}",
        enabled: "{{ enabled }}",
        mode: "{{ mode }}",
        literal: "prefix-{{ count }}-suffix"
      }
    }
  ]
};

test("loadRecipesFromDirectory loads the shipped recipes without throwing", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const ids = registry.list().map((recipe) => recipe.id).sort();
  assert.deepEqual(ids, ["implement-check-gate-approve", "postgres-transaction-restart"]);
});

test("RecipeRegistry.list() omits steps", () => {
  const registry = new RecipeRegistry([demoRecipe]);
  const [summary] = registry.list();
  assert.equal(summary.id, "demo");
  assert.equal((summary as unknown as Record<string, unknown>).steps, undefined);
});

test("materializeRecipe coerces typed parameters and substitutes whole-string templates only", () => {
  const materialized = materializeRecipe(demoRecipe, {
    projectId: "proj_1",
    parameters: { message: "hello" }
  });
  const input = materialized.steps[0].input as Record<string, unknown>;
  assert.equal(input.message, "hello");
  assert.equal(input.count, 3);
  assert.equal(typeof input.count, "number");
  assert.equal(input.enabled, false);
  assert.equal(input.mode, "fast");
  assert.equal(input.literal, "prefix-{{ count }}-suffix");
  assert.equal(materialized.goal, demoRecipe.name);
});

test("materializeRecipe rejects unknown parameter keys", () => {
  assert.throws(
    () => materializeRecipe(demoRecipe, { projectId: "proj_1", parameters: { message: "hi", bogus: 1 } }),
    (error: unknown) => error instanceof RecipeValidationError && /bogus/.test(error.message)
  );
});

test("materializeRecipe rejects a missing required parameter", () => {
  assert.throws(
    () => materializeRecipe(demoRecipe, { projectId: "proj_1", parameters: {} }),
    (error: unknown) => error instanceof RecipeValidationError && /message/.test(error.message)
  );
});

test("materializeRecipe rejects an enum value outside options", () => {
  assert.throws(
    () => materializeRecipe(demoRecipe, { projectId: "proj_1", parameters: { message: "hi", mode: "turbo" } }),
    (error: unknown) => error instanceof RecipeValidationError && /mode/.test(error.message)
  );
});

test("materializeRecipe does not double-process a parameter value that looks like a template", () => {
  const materialized = materializeRecipe(demoRecipe, {
    projectId: "proj_1",
    parameters: { message: "{{ evil }}" }
  });
  const input = materialized.steps[0].input as Record<string, unknown>;
  assert.equal(input.message, "{{ evil }}");
});

async function withHttpServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-recipes-api-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const executors = new ExecutorRegistry([new MemoryExecutor("ok")]);
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
  const recipeRegistry = new RecipeRegistry([demoRecipe]);
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project, orchestration };
}

test("GET /api/recipes lists summaries and GET /api/recipes/:id 404s for unknown ids", async (t) => {
  const { baseUrl } = await withHttpServer(t);

  const listRes = await fetch(`${baseUrl}/api/recipes`);
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.deepEqual(listBody.recipes.map((r: { id: string }) => r.id), ["demo"]);

  const getRes = await fetch(`${baseUrl}/api/recipes/demo`);
  assert.equal(getRes.status, 200);
  assert.equal((await getRes.json()).recipe.id, "demo");

  const missingRes = await fetch(`${baseUrl}/api/recipes/missing`);
  assert.equal(missingRes.status, 404);
});

test("POST /api/recipes/:id/preview materializes a createRunBody-shaped payload without persisting a run", async (t) => {
  const { baseUrl, project, orchestration } = await withHttpServer(t);
  const before = await orchestration.listRuns();

  const res = await fetch(`${baseUrl}/api/recipes/demo/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, parameters: { message: "hi", mode: "slow" } })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.run.projectId, project.id);
  assert.equal(body.run.steps[0].input.mode, "slow");
  assert.equal(body.run.steps[0].input.count, 3);
  assert.equal(typeof body.run.steps[0].input.count, "number");

  const after = await orchestration.listRuns();
  assert.equal(after.length, before.length);
});

test("POST /api/recipes/:id/preview rejects invalid parameters with 400", async (t) => {
  const { baseUrl, project } = await withHttpServer(t);
  const res = await fetch(`${baseUrl}/api/recipes/demo/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, parameters: {} })
  });
  assert.equal(res.status, 400);
});

test("POST /api/recipes/:id/runs creates a real run and forbids parameter injection via templating", async (t) => {
  const { baseUrl, project, orchestration } = await withHttpServer(t);

  const res = await fetch(`${baseUrl}/api/recipes/demo/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, parameters: { message: "{{ evil }}" } })
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.run.projectId, project.id);
  assert.equal(body.steps[0].input.message, "{{ evil }}");

  const runs = await orchestration.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, body.run.id);
});

test("POST /api/recipes/:id/runs 404s for an unknown project id", async (t) => {
  const { baseUrl } = await withHttpServer(t);
  const res = await fetch(`${baseUrl}/api/recipes/demo/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "missing_project", parameters: { message: "hi" } })
  });
  assert.equal(res.status, 404);
});
