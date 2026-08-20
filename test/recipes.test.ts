import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { AgentTaskExecutor } from "../server/executors/agent-task.js";
import { CheckExecutor } from "../server/executors/check.js";
import { PostgresExecutor } from "../server/executors/postgres.js";
import { ExecutorRegistry } from "../server/executors/registry.js";
import type { ExecutionHandle, ExecutionState, Executor, StepExecutionContext } from "../server/executors/types.js";
import { EventBus } from "../server/events.js";
import { validateContractLevel, validateStepContracts } from "../server/orchestration/dag.js";
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
  assert.deepEqual(ids, [
    "dsh-testengineer-trial",
    "eval-instruction-ab-trial",
    "implement-check-gate-approve",
    "postgres-transaction-restart"
  ]);
});

test("shipped eval-instruction-ab-trial recipe materializes the instruction file into the agent-task step", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("eval-instruction-ab-trial")!;

  const materialized = materializeRecipe(recipe, {
    projectId: "proj_1",
    parameters: {
      prompt: "implement fizzbuzz",
      instructionContent: "# Agent instructions\nRun checks.\n",
      instructionLabel: "improved",
      checkCommand: "python -m pytest -q test_fizzbuzz.py"
    }
  });
  assert.equal(materialized.contractLevel, "L2");

  const implementStep = materialized.steps.find((step) => step.id === "implement")!;
  // Template substitution must reach inside the nested instructionFile object.
  assert.deepEqual(implementStep.input?.instructionFile, {
    path: "AGENTS.md",
    content: "# Agent instructions\nRun checks.\n",
    label: "improved"
  });
  // Eval trials must terminate unattended: a blocked agent doesn't hang the trial.
  assert.equal(implementStep.onBlocked?.action, "auto_retry");
  assert.deepEqual(implementStep.produces, ["diff", "changed_files"]);

  const checkStep = materialized.steps.find((step) => step.id === "check")!;
  assert.deepEqual(checkStep.input?.commands, ["python -m pytest -q test_fizzbuzz.py"]);
  assert.deepEqual(checkStep.consumes, ["diff"]);
  assert.equal(checkStep.qualityGate?.onFail, "fail");
});

// #71: the recipe's `agent` enum lists the bare word `null` as an option -
// a YAML footgun, since an unquoted `null` list entry parses as the JS
// value null, not the string "null". This proves the YAML source actually
// quotes it and the calibration-probe agent id survives materialization as
// a real string, end to end through the real loader (not just an assertion
// about the parsed Recipe object).
test("shipped eval-instruction-ab-trial recipe accepts the 'null' calibration-agent option as a real string, not YAML's null value", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("eval-instruction-ab-trial")!;
  const agentParam = recipe.parameters.find((param) => param.key === "agent")!;
  assert.deepEqual(agentParam.options, ["codex", "claude", "hermes", "shell", "null", "minimal"]);
  assert.equal(typeof agentParam.options![4], "string");

  const materialized = materializeRecipe(recipe, {
    projectId: "proj_1",
    parameters: {
      agent: "null",
      prompt: "implement fizzbuzz",
      instructionContent: "# Agent instructions\nRun checks.\n",
      instructionLabel: "baseline",
      checkCommand: "python -m pytest -q test_fizzbuzz.py"
    }
  });
  const implementStep = materialized.steps.find((step) => step.id === "implement")!;
  assert.equal(implementStep.input?.agent, "null");
  assert.equal(typeof implementStep.input?.agent, "string");
});

test("shipped eval-instruction-ab-trial recipe is self-contained with zero parameters, using the baseline sample variant", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("eval-instruction-ab-trial")!;

  const materialized = materializeRecipe(recipe, { projectId: "proj_1", parameters: {} });
  const implementStep = materialized.steps.find((step) => step.id === "implement")!;
  const instructionFile = implementStep.input?.instructionFile as { path: string; content: string; label: string };
  assert.equal(instructionFile.path, "AGENTS.md");
  assert.equal(instructionFile.label, "baseline");
  assert.match(instructionFile.content, /Agent instructions/);
  assert.match(String(implementStep.input?.prompt), /fizzbuzz\.py/);

  const checkStep = materialized.steps.find((step) => step.id === "check")!;
  assert.deepEqual(checkStep.input?.commands, ["python -m pytest -q"]);
});

// #92: dsh-testengineer-trial wires the DSH adapter (#88) and score.py
// (#91) into a single trial, modeled on eval-instruction-ab-trial above -
// same instructionFile/onBlocked/produces shape, but the injected file is
// `cordis.patch.yml` (the DSH adapter's Route A patch overlay - see
// docs/dsh-adapter-notes.md) and the check step's command is score.py
// rather than a fixed pytest invocation.
test("shipped dsh-testengineer-trial recipe defaults agent to dsh and materializes cordis.patch.yml as the instruction file", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("dsh-testengineer-trial")!;
  assert.equal(recipe.contractLevel, "L2");

  const materialized = materializeRecipe(recipe, {
    projectId: "proj_1",
    parameters: { scoreCommand: "python3 score.py --worktree . --clean /fixtures/clean --out score.json" }
  });

  const testEngineerStep = materialized.steps.find((step) => step.id === "test-engineer")!;
  assert.equal(testEngineerStep.input?.agent, "dsh");
  assert.equal(typeof testEngineerStep.input?.agent, "string");
  assert.equal(testEngineerStep.input?.interaction, "autonomous");
  assert.deepEqual(testEngineerStep.input?.instructionFile, {
    path: "cordis.patch.yml",
    content: "[]\n",
    label: "baseline"
  });
  assert.equal(testEngineerStep.onBlocked?.action, "auto_retry");
  assert.deepEqual(testEngineerStep.produces, ["changed_files"]);
  assert.match(String(testEngineerStep.input?.prompt), /senior test engineer/);
  assert.match(String(testEngineerStep.input?.prompt), /sql-tests\/agent\//);

  const scoreStep = materialized.steps.find((step) => step.id === "score")!;
  assert.deepEqual(scoreStep.dependsOn, ["test-engineer"]);
  assert.deepEqual(scoreStep.input?.commands, ["python3 score.py --worktree . --clean /fixtures/clean --out score.json"]);
  assert.deepEqual(scoreStep.qualityGate?.evaluators, [{ type: "check" }]);
  assert.equal(scoreStep.qualityGate?.onFail, "fail");
});

// scoreCommand has no built-in default (see the recipe's own description):
// it's fixture-specific, so a driver must always supply it.
test("shipped dsh-testengineer-trial recipe requires scoreCommand - it has no default", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("dsh-testengineer-trial")!;
  assert.throws(
    () => materializeRecipe(recipe, { projectId: "proj_1", parameters: {} }),
    (error: unknown) => error instanceof RecipeValidationError && /scoreCommand/.test(error.message)
  );
});

test("shipped dsh-testengineer-trial recipe accepts a candidate profile override and a baseline-comparison agent", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("dsh-testengineer-trial")!;

  const materialized = materializeRecipe(recipe, {
    projectId: "proj_1",
    parameters: {
      agent: "codex",
      scoreCommand: "python3 score.py --worktree . --clean /fixtures/clean --out score.json",
      profilePath: "AGENTS.md",
      profileContent: "# candidate persona override\n",
      profileLabel: "candidate"
    }
  });
  const testEngineerStep = materialized.steps.find((step) => step.id === "test-engineer")!;
  assert.equal(testEngineerStep.input?.agent, "codex");
  assert.deepEqual(testEngineerStep.input?.instructionFile, {
    path: "AGENTS.md",
    content: "# candidate persona override\n",
    label: "candidate"
  });
});

test("shipped dsh-testengineer-trial recipe declares StepContract produces and passes L2 contract validation", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("dsh-testengineer-trial")!;
  const executors = new ExecutorRegistry([new AgentTaskExecutor(), new CheckExecutor()]);

  const materialized = materializeRecipe(recipe, {
    projectId: "proj_1",
    parameters: { scoreCommand: "python3 score.py --worktree . --clean /fixtures/clean --out score.json" }
  });
  assert.doesNotThrow(() => validateContractLevel(materialized.contractLevel!, materialized.steps, executors));
});

test("shipped implement-check-gate-approve recipe wires interaction/onBlocked defaults and overrides", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("implement-check-gate-approve")!;

  const defaulted = materializeRecipe(recipe, { projectId: "proj_1", parameters: { title: "t", prompt: "p" } });
  const implementStep = defaulted.steps.find((step) => step.id === "implement")!;
  assert.equal(implementStep.input?.interaction, "autonomous");
  assert.equal(implementStep.input?.model, "");
  assert.equal(implementStep.onBlocked?.action, "wait_approval");
  assert.equal(implementStep.onBlocked?.timeoutMs, 1_800_000);

  const overridden = materializeRecipe(recipe, {
    projectId: "proj_1",
    parameters: { title: "t", prompt: "p", interaction: "interactive", onBlocked: "auto_retry", blockedTimeoutMinutes: 5, model: "gpt-5-codex" }
  });
  const overriddenStep = overridden.steps.find((step) => step.id === "implement")!;
  assert.equal(overriddenStep.input?.interaction, "interactive");
  assert.equal(overriddenStep.input?.model, "gpt-5-codex");
  assert.equal(overriddenStep.onBlocked?.action, "auto_retry");
  assert.equal(overriddenStep.onBlocked?.timeoutMs, 300_000);
});

// #72: the verify-gate self-test overrides this recipe's agent to "null"
// and forces gateOnFail to "fail" so a null-agent run reaches a clean
// terminal "failed" state (its default, "wait_approval", would otherwise
// park the run waiting for a human instead of giving a definite verdict).
test("shipped implement-check-gate-approve recipe accepts the 'null' calibration-agent override with gateOnFail forced to fail", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("implement-check-gate-approve")!;
  const agentParam = recipe.parameters.find((param) => param.key === "agent")!;
  assert.ok(agentParam.options?.includes("null"));
  assert.equal(typeof agentParam.options![agentParam.options!.indexOf("null")], "string");

  const materialized = materializeRecipe(recipe, { projectId: "proj_1", parameters: { agent: "null", gateOnFail: "fail" } });
  const implementStep = materialized.steps.find((step) => step.id === "implement")!;
  assert.equal(implementStep.input?.agent, "null");
  const checkStep = materialized.steps.find((step) => step.id === "check")!;
  assert.equal(checkStep.qualityGate?.onFail, "fail");
});

test("shipped implement-check-gate-approve recipe is deterministic and self-contained with zero parameters", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("implement-check-gate-approve")!;

  const materialized = materializeRecipe(recipe, { projectId: "proj_1", parameters: {} });
  const implementStep = materialized.steps.find((step) => step.id === "implement")!;
  assert.match(String(implementStep.input?.title), /fizzbuzz/i);
  assert.match(String(implementStep.input?.prompt), /fizzbuzz\.py/);
  assert.match(String(implementStep.input?.prompt), /test_fizzbuzz\.py/);
  assert.match(String(implementStep.input?.prompt), /python -m pytest -q/);

  const checkStep = materialized.steps.find((step) => step.id === "check")!;
  assert.deepEqual(checkStep.input?.commands, ["python -m pytest -q"]);
});

test("shipped implement-check-gate-approve recipe declares StepContract produces/consumes and passes dataflow lint", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const recipe = registry.get("implement-check-gate-approve")!;

  const implementStep = recipe.steps.find((step) => step.id === "implement")!;
  const checkStep = recipe.steps.find((step) => step.id === "check")!;
  assert.deepEqual(implementStep.produces, ["diff", "changed_files"]);
  assert.deepEqual(checkStep.consumes, ["diff"]);

  const materialized = materializeRecipe(recipe, { projectId: "proj_1", parameters: {} });
  const executors = new ExecutorRegistry([new AgentTaskExecutor(), new CheckExecutor()]);
  assert.doesNotThrow(() => validateStepContracts(materialized.steps, executors));
});

test("both shipped recipes declare contract level L2+ and pass validateContractLevel at that level", async () => {
  const registry = await loadRecipesFromDirectory(shippedRecipesDir);
  const executors = new ExecutorRegistry([new AgentTaskExecutor(), new CheckExecutor(), new PostgresExecutor()]);

  for (const id of ["implement-check-gate-approve", "postgres-transaction-restart"]) {
    const recipe = registry.get(id)!;
    assert.equal(recipe.contractLevel, "L2", `${id} must declare contract level L2+`);
    const materialized = materializeRecipe(recipe, { projectId: "proj_1", parameters: {} });
    assert.doesNotThrow(() => validateContractLevel(materialized.contractLevel!, materialized.steps, executors));
  }
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

// #78: a recipe can declare a static maxParallel ceiling, forwarded as-is
// into the materialized run params (mirrors contractLevel).
test("materializeRecipe forwards a recipe's maxParallel into the materialized run", () => {
  const capped: Recipe = { ...demoRecipe, maxParallel: 2 };
  const materialized = materializeRecipe(capped, { projectId: "proj_1", parameters: { message: "hello" } });
  assert.equal(materialized.maxParallel, 2);

  const uncapped = materializeRecipe(demoRecipe, { projectId: "proj_1", parameters: { message: "hello" } });
  assert.equal(uncapped.maxParallel, undefined);
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

test("materializeRecipe rejects empty string and boolean values for a number parameter instead of silently coercing to 0/1", () => {
  // Note: an explicit `null` falls back to the parameter's default via `??`
  // before it ever reaches coerceParameterValue, so it isn't exercised here
  // — only values that actually reach the number branch are.
  for (const bad of ["", true, false]) {
    assert.throws(
      () => materializeRecipe(demoRecipe, { projectId: "proj_1", parameters: { message: "hi", count: bad } }),
      (error: unknown) => error instanceof RecipeValidationError && /count/.test(error.message)
    );
  }
});

test("a number parameter's multiplier converts a user-friendly unit into what the step field expects", () => {
  const minutesRecipe: Recipe = {
    id: "minutes-demo",
    name: "Minutes demo",
    parameters: [
      { key: "timeoutMinutes", label: "Timeout (minutes)", type: "number", default: 30, multiplier: 60_000 }
    ],
    steps: [{ id: "a", executor: "ok", input: { timeoutMs: "{{ timeoutMinutes }}" } }]
  };
  const materialized = materializeRecipe(minutesRecipe, { projectId: "proj_1", parameters: {} });
  assert.equal((materialized.steps[0].input as Record<string, unknown>).timeoutMs, 1_800_000);

  const overridden = materializeRecipe(minutesRecipe, { projectId: "proj_1", parameters: { timeoutMinutes: 5 } });
  assert.equal((overridden.steps[0].input as Record<string, unknown>).timeoutMs, 300_000);
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

const checkRecipe: Recipe = {
  id: "check-only",
  name: "Check only",
  description: "A recipe used to exercise preflight validation on a bare check step",
  category: "test",
  parameters: [],
  steps: [{ id: "check", executor: "check", input: { worktreeId: "wt_placeholder" } }]
};

async function withCheckHttpServer(t: TestContext, testCommands: string[]) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-recipes-preflight-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const executors = new ExecutorRegistry([new CheckExecutor()]);
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
  const recipeRegistry = new RecipeRegistry([checkRecipe]);
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
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands, runCommands: [] });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, project, orchestration };
}

test("POST /api/recipes/:id/preview rejects with 400 when a check step resolves to no commands, so the wizard can't reach submit", async (t) => {
  const { baseUrl, project } = await withCheckHttpServer(t, []);
  const res = await fetch(`${baseUrl}/api/recipes/check-only/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id })
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no check commands/);
});

test("POST /api/recipes/:id/preview succeeds once the project has check commands configured", async (t) => {
  const { baseUrl, project } = await withCheckHttpServer(t, ["npm test"]);
  const res = await fetch(`${baseUrl}/api/recipes/check-only/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id })
  });
  assert.equal(res.status, 200);
});
