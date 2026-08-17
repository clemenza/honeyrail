import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { AgentTaskExecutor, parseInstructionFile } from "../server/executors/agent-task.js";
import { ConfigError } from "../server/executors/types.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";

// Instruction-file injection (#25): a step can declare input.instructionFile
// to have one file (e.g. AGENTS.md) written into the task worktree before
// agent launch and removed again before the completion diff harvest, so two
// harness configurations can be A/B-compared without the injected file ever
// contaminating the measured code change. These tests lock in the full
// lifecycle plus the validation preflight relies on.

async function makeFixture(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-instruction-file-"));
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

function makeCtx(fixture: Awaited<ReturnType<typeof makeFixture>>, step: unknown, overrides: Record<string, unknown> = {}) {
  return {
    store: fixture.store,
    bus: new EventBus(),
    tmux: { startSession: async () => {} } as any,
    worktrees: {
      create: async () => ({
        path: fixture.worktreePath,
        branch: "codex/eval-trial",
        projectId: fixture.project.id,
        baseBranch: "main",
        baseRevision: "base",
        title: "eval trial",
        agent: "codex"
      })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project: fixture.project,
    runId: "run_instruction",
    step,
    sessionLogRoot: fixture.tempDir,
    attachmentRoot: join(fixture.tempDir, "attachments"),
    ...overrides
  } as any;
}

test("instruction file is injected before launch, recorded as evidence, and removed before the diff harvest", async (t) => {
  const fixture = await makeFixture(t);
  const content = "# Agent instructions\nRun the checks yourself.\n";
  const step = await fixture.store.createStep({
    id: "implement",
    runId: "run_instruction",
    name: "Implement change",
    executor: "agent-task",
    input: {
      agent: "codex",
      title: "eval trial",
      prompt: "do the task",
      instructionFile: { path: "AGENTS.md", content, label: "improved" }
    },
    status: "running"
  });

  let fileExistedAtDiffTime: boolean | null = null;
  const ctx = makeCtx(fixture, step, {
    worktrees: {
      create: async () => ({
        path: fixture.worktreePath,
        branch: "codex/eval-trial",
        projectId: fixture.project.id,
        baseBranch: "main",
        baseRevision: "base",
        title: "eval trial",
        agent: "codex"
      }),
      diff: async () => {
        fileExistedAtDiffTime = Boolean(await stat(join(fixture.worktreePath, "AGENTS.md")).catch(() => null));
        return { diff: "", diffStat: "", status: "", commits: "" };
      }
    }
  });

  const executor = new AgentTaskExecutor();
  const handle = await executor.start(ctx);

  assert.equal(await readFile(join(fixture.worktreePath, "AGENTS.md"), "utf8"), content);
  const injectionEvidence = (await fixture.store.listEvidence("run_instruction", "implement")).find(
    (item) => item.kind === "harness.instruction_file"
  )!;
  assert.ok(injectionEvidence, "injection evidence must be recorded at launch");
  assert.match(injectionEvidence.claim || "", /improved/);
  const injectionValue = injectionEvidence.value as Record<string, unknown>;
  assert.equal(injectionValue.path, "AGENTS.md");
  assert.equal(injectionValue.label, "improved");
  assert.match(String(injectionValue.sha256), /^[0-9a-f]{64}$/);

  await fixture.store.updateTask(String(handle.taskId), { status: "done" });
  const state = await executor.inspect(ctx, handle);
  assert.equal(state.status, "succeeded");

  assert.equal(fileExistedAtDiffTime, false, "injected file must be removed before the diff harvest runs");
  assert.equal(await stat(join(fixture.worktreePath, "AGENTS.md")).catch(() => null), null);

  const completion = (await fixture.store.listEvidence("run_instruction", "implement")).find(
    (item) => item.kind === "agent.completion"
  )!;
  const completionValue = completion.value as Record<string, unknown>;
  const injected = completionValue.instructionFile as Record<string, unknown>;
  assert.equal(injected.label, "improved");
  assert.equal(injected.path, "AGENTS.md");
  assert.equal(injected.sha256, injectionValue.sha256);
});

test("injection refuses to overwrite a path that already exists in the worktree", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(join(fixture.worktreePath, "AGENTS.md"), "already tracked\n");
  const step = await fixture.store.createStep({
    id: "implement",
    runId: "run_instruction",
    name: "Implement change",
    executor: "agent-task",
    input: {
      agent: "codex",
      title: "eval trial",
      prompt: "do the task",
      instructionFile: { path: "AGENTS.md", content: "injected\n", label: "improved" }
    },
    status: "running"
  });

  const executor = new AgentTaskExecutor();
  await assert.rejects(executor.start(makeCtx(fixture, step)), ConfigError);
  assert.equal(await readFile(join(fixture.worktreePath, "AGENTS.md"), "utf8"), "already tracked\n");
});

test("parseInstructionFile validates shape and path safety", () => {
  assert.equal(parseInstructionFile(undefined), null);
  assert.equal(parseInstructionFile(null), null);
  // Empty content means "no injection" so recipes can expose it optionally.
  assert.equal(parseInstructionFile({ path: "AGENTS.md", content: "" }), null);
  assert.equal(parseInstructionFile({ path: "AGENTS.md", content: "   " }), null);

  assert.deepEqual(parseInstructionFile({ path: "docs/AGENTS.md", content: "x", label: "b" }), {
    path: "docs/AGENTS.md",
    content: "x",
    label: "b"
  });
  assert.equal(parseInstructionFile({ path: "AGENTS.md", content: "x" })?.label, undefined);

  assert.throws(() => parseInstructionFile("AGENTS.md"), ConfigError);
  assert.throws(() => parseInstructionFile(["AGENTS.md"]), ConfigError);
  assert.throws(() => parseInstructionFile({ content: "x" }), ConfigError);
  assert.throws(() => parseInstructionFile({ path: "/etc/passwd", content: "x" }), ConfigError);
  assert.throws(() => parseInstructionFile({ path: "../outside.md", content: "x" }), ConfigError);
  assert.throws(() => parseInstructionFile({ path: "nested/../../outside.md", content: "x" }), ConfigError);
});
