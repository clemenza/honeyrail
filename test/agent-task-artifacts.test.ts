import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { AgentTaskExecutor } from "../server/executors/agent-task.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";

// agent-task steps used to finish with zero Artifacts/Evidence - a reviewer
// looking at a completed run had nothing beyond "it succeeded" to look at.
// These tests lock in that a finished task now surfaces the diff (what
// changed) and the cleaned session transcript (how), and that capturing
// them is best-effort - a missing worktree/session or a git failure must
// never turn an actually-successful task into a failed step.

async function makeStore(t: TestContext, prefix: string) {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  return { store: new JsonStore(join(tempDir, "store.json")), tempDir };
}

test("a completed agent-task step gets a diff artifact/evidence and a transcript artifact/evidence", async (t) => {
  const { store, tempDir } = await makeStore(t, "honeyrail-agent-task-artifacts-");
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  const worktree = await store.createWorktree({ projectId: project.id, path: join(tempDir, "wt"), branch: "codex/task", baseBranch: "main", baseRevision: "base", title: "task", agent: "codex" });

  const logPath = join(tempDir, "session.log");
  await writeFile(logPath, "\x1b[32m$ implement the feature\x1b[0m\nDone.\n");
  const session = await store.createSession({
    projectId: project.id,
    worktreeId: worktree.id,
    name: "task",
    agent: "codex",
    tmuxSessionName: "agw_task",
    cwd: worktree.path,
    logPath,
    status: "completed"
  });

  const task = await store.createTask({ projectId: project.id, title: "task", agent: "codex", status: "done", worktreeId: worktree.id, sessionId: session.id });
  const step = await store.createStep({ id: "implement", runId: "run_artifacts", name: "Implement change", executor: "agent-task", input: {}, status: "running" });

  const executor = new AgentTaskExecutor();
  const ctx = {
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {
      diff: async () => ({ diff: "diff --git a/foo.py b/foo.py\n+print('hi')\n", diffStat: " foo.py | 1 +\n 1 file changed, 1 insertion(+)", status: "M foo.py", commits: "" })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project,
    runId: "run_artifacts",
    step,
    sessionLogRoot: "",
    attachmentRoot: join(tempDir, "attachments")
  };

  const state = await executor.inspect(ctx, { taskId: task.id });
  assert.equal(state.status, "succeeded");

  const artifacts = await store.listArtifacts("run_artifacts", "implement");
  const evidence = await store.listEvidence("run_artifacts", "implement");
  assert.equal(artifacts.length, 2);
  assert.equal(evidence.length, 2);

  const diffArtifact = artifacts.find((item) => item.name === "changes.diff")!;
  assert.ok(diffArtifact, "diff artifact must exist");
  assert.ok(diffArtifact.path, "diff artifact must have a file path GET /api/artifacts/:id/content can stream");
  assert.match(await readFile(diffArtifact.path!, "utf8"), /print\('hi'\)/);
  const diffEvidence = evidence.find((item) => item.kind === "agent.diff")!;
  assert.ok(diffEvidence, "diff evidence must exist");
  assert.match(diffEvidence.claim || "", /1 file changed, 1 insertion/);
  assert.deepEqual(diffEvidence.artifactIds, [diffArtifact.id]);

  const transcriptArtifact = artifacts.find((item) => item.name === "session-transcript.log")!;
  assert.ok(transcriptArtifact, "transcript artifact must exist");
  const transcriptContent = await readFile(transcriptArtifact.path!, "utf8");
  // ANSI codes stripped, and no literal escape byte left behind.
  assert.match(transcriptContent, /\$ implement the feature\nDone\./);
  assert.ok(!transcriptContent.includes("\x1b"), "transcript must not contain raw ANSI escapes");
  const transcriptEvidence = evidence.find((item) => item.kind === "agent.transcript")!;
  assert.ok(transcriptEvidence, "transcript evidence must exist");
  assert.deepEqual(transcriptEvidence.artifactIds, [transcriptArtifact.id]);
});

test("completion artifact capture is best-effort: a task with no worktree/session still succeeds with no artifacts", async (t) => {
  const { store, tempDir } = await makeStore(t, "honeyrail-agent-task-artifacts-bare-");
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  const task = await store.createTask({ projectId: project.id, title: "task", agent: "codex", status: "done" });
  const step = await store.createStep({ id: "implement", runId: "run_bare", name: "Implement change", executor: "agent-task", input: {}, status: "running" });

  const executor = new AgentTaskExecutor();
  const ctx = {
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {} as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project,
    runId: "run_bare",
    step,
    sessionLogRoot: "",
    attachmentRoot: join(tempDir, "attachments")
  };

  const state = await executor.inspect(ctx, { taskId: task.id });
  assert.equal(state.status, "succeeded");
  assert.deepEqual(await store.listArtifacts("run_bare", "implement"), []);
  assert.deepEqual(await store.listEvidence("run_bare", "implement"), []);
});

test("a git diff failure does not turn a genuinely completed task into a failed step", async (t) => {
  const { store, tempDir } = await makeStore(t, "honeyrail-agent-task-artifacts-diff-fail-");
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  const worktree = await store.createWorktree({ projectId: project.id, path: join(tempDir, "wt"), branch: "codex/task", baseBranch: "main", baseRevision: "base", title: "task", agent: "codex" });
  const task = await store.createTask({ projectId: project.id, title: "task", agent: "codex", status: "done", worktreeId: worktree.id });
  const step = await store.createStep({ id: "implement", runId: "run_diff_fail", name: "Implement change", executor: "agent-task", input: {}, status: "running" });

  const executor = new AgentTaskExecutor();
  const ctx = {
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {
      diff: async () => {
        throw new Error("worktree already discarded");
      }
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project,
    runId: "run_diff_fail",
    step,
    sessionLogRoot: "",
    attachmentRoot: join(tempDir, "attachments")
  };

  const state = await executor.inspect(ctx, { taskId: task.id });
  assert.equal(state.status, "succeeded");
  assert.deepEqual(await store.listArtifacts("run_diff_fail", "implement"), []);
});
