import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { AgentTaskExecutor, parseAgentEnvironment } from "../server/executors/agent-task.js";
import { ConfigError } from "../server/executors/types.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";

// The #179 research-environment hook: a step can declare input.environment to
// have connection coordinates exported into the agent process and mirrored to
// $HR_STEP_DIR/environment.json. agent-task stays ignorant of PostgreSQL -
// this is just "hand the agent these variables".

async function makeFixture(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-agent-env-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  const project = await store.createProject({
    name: "demo",
    repoPath: tempDir,
    defaultBranch: "main",
    defaultAgent: "codex",
    testCommands: [],
    runCommands: []
  });
  const worktreePath = join(tempDir, "wt");
  await mkdir(worktreePath, { recursive: true });
  return { tempDir, store, project, worktreePath };
}

test("declared environment variables are exported into the agent launch command and mirrored to the step dir", async (t) => {
  const fixture = await makeFixture(t);
  const step = await fixture.store.createStep({
    id: "research",
    runId: "run_env",
    name: "Research the cluster",
    executor: "agent-task",
    input: {
      agent: "codex",
      title: "research trial",
      prompt: "investigate",
      environment: { HR_PG_HOST: "127.0.0.1", HR_PG_PORT: 54321, HR_PG_SOURCE_DIR: "/tmp/snap shot" }
    },
    status: "running",
    attempt: 1
  });

  let launchCommand = "";
  const executor = new AgentTaskExecutor();
  await executor.start({
    store: fixture.store,
    bus: new EventBus(),
    tmux: {
      startSession: async (options: { command: string }) => {
        launchCommand = options.command;
      }
    } as any,
    worktrees: {
      create: async () => ({
        path: fixture.worktreePath,
        branch: "codex/research",
        projectId: fixture.project.id,
        baseBranch: "main",
        baseRevision: "base",
        title: "research trial",
        agent: "codex"
      })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project: fixture.project,
    runId: "run_env",
    step,
    sessionLogRoot: fixture.tempDir,
    attachmentRoot: join(fixture.tempDir, "attachments")
  } as any);

  assert.match(launchCommand, /HR_STEP_DIR='[^']+' HR_PG_HOST='127\.0\.0\.1' HR_PG_PORT='54321' HR_PG_SOURCE_DIR='\/tmp\/snap shot' /);

  const stepDir = join(fixture.tempDir, "attachments", "runs", "run_env", "research", "attempt-1", "step");
  assert.deepEqual(JSON.parse(await readFile(join(stepDir, "environment.json"), "utf8")), {
    HR_PG_HOST: "127.0.0.1",
    HR_PG_PORT: "54321",
    HR_PG_SOURCE_DIR: "/tmp/snap shot"
  });

  const evidence = (await fixture.store.listEvidence("run_env", "research")).find((item) => item.kind === "harness.environment")!;
  assert.ok(evidence, "environment injection must be recorded as evidence");
  const value = evidence.value as Record<string, unknown>;
  assert.deepEqual(value.keys, ["HR_PG_HOST", "HR_PG_PORT", "HR_PG_SOURCE_DIR"]);
  assert.match(String(value.sha256), /^[0-9a-f]{64}$/);
  // Values stay out of the store; only key names and a content hash are kept.
  assert.equal(JSON.stringify(value).includes("54321"), false);
});

test("a step with no environment declaration keeps the original launch command and writes no environment.json", async (t) => {
  const fixture = await makeFixture(t);
  const step = await fixture.store.createStep({
    id: "plain",
    runId: "run_plain",
    name: "Plain task",
    executor: "agent-task",
    input: { agent: "codex", title: "plain", prompt: "do it" },
    status: "running",
    attempt: 1
  });

  let launchCommand = "";
  await new AgentTaskExecutor().start({
    store: fixture.store,
    bus: new EventBus(),
    tmux: {
      startSession: async (options: { command: string }) => {
        launchCommand = options.command;
      }
    } as any,
    worktrees: {
      create: async () => ({
        path: fixture.worktreePath,
        branch: "codex/plain",
        projectId: fixture.project.id,
        baseBranch: "main",
        baseRevision: "base",
        title: "plain",
        agent: "codex"
      })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project: fixture.project,
    runId: "run_plain",
    step,
    sessionLogRoot: fixture.tempDir,
    attachmentRoot: join(fixture.tempDir, "attachments")
  } as any);

  assert.match(launchCommand, /^HR_STEP_DIR='[^']+' codex/);
  const stepDir = join(fixture.tempDir, "attachments", "runs", "run_plain", "plain", "attempt-1", "step");
  assert.equal(await readFile(join(stepDir, "environment.json"), "utf8").catch(() => null), null);
  assert.equal((await fixture.store.listEvidence("run_plain", "plain")).some((item) => item.kind === "harness.environment"), false);
});

test("parseAgentEnvironment validates shape, key names, and value safety", () => {
  assert.equal(parseAgentEnvironment(undefined), null);
  assert.equal(parseAgentEnvironment(null), null);
  assert.equal(parseAgentEnvironment({}), null);

  assert.deepEqual(parseAgentEnvironment({ HR_PG_PORT: 5432, HR_PG_TLS: false, HR_PG_HOST: "127.0.0.1" }), {
    HR_PG_PORT: "5432",
    HR_PG_TLS: "false",
    HR_PG_HOST: "127.0.0.1"
  });

  assert.throws(() => parseAgentEnvironment("HR_PG_PORT=5432"), ConfigError);
  assert.throws(() => parseAgentEnvironment([["HR_PG_PORT", "5432"]]), ConfigError);
  assert.throws(() => parseAgentEnvironment({ "HR-PG-PORT": "5432" }), ConfigError);
  assert.throws(() => parseAgentEnvironment({ "2PORT": "5432" }), ConfigError);
  assert.throws(() => parseAgentEnvironment({ HR_PG_PORT: null }), ConfigError);
  assert.throws(() => parseAgentEnvironment({ HR_PG_PORT: { value: 5432 } }), ConfigError);
  assert.throws(() => parseAgentEnvironment({ HR_PG_NOTE: "line one\nline two" }), ConfigError);
});
