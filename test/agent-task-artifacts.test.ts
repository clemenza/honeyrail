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
      diff: async () => ({ diff: "diff --git a/foo.py b/foo.py\n+print('hi')\n", diffStat: " foo.py | 1 +\n 1 file changed, 1 insertion(+)", status: " M foo.py", commits: "" })
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
  assert.equal(artifacts.length, 3);
  assert.equal(evidence.length, 4);

  const diffArtifact = artifacts.find((item) => item.name === "changes.diff")!;
  assert.ok(diffArtifact, "diff artifact must exist");
  assert.ok(diffArtifact.path, "diff artifact must have a file path GET /api/artifacts/:id/content can stream");
  assert.match(await readFile(diffArtifact.path!, "utf8"), /print\('hi'\)/);
  const diffEvidence = evidence.find((item) => item.kind === "agent.diff")!;
  assert.ok(diffEvidence, "diff evidence must exist");
  assert.match(diffEvidence.claim || "", /1 file changed, 1 insertion/);
  assert.deepEqual(diffEvidence.artifactIds, [diffArtifact.id]);

  const changedFilesArtifact = artifacts.find((item) => item.name === "changed_files.json")!;
  assert.ok(changedFilesArtifact, "changed_files.json artifact must exist");
  assert.equal(changedFilesArtifact.kind, "json");
  const changedFiles = JSON.parse(await readFile(changedFilesArtifact.path!, "utf8"));
  assert.deepEqual(changedFiles, [{ path: "foo.py", changeType: "modified" }]);
  const changedFilesEvidence = evidence.find((item) => item.kind === "agent.changed_files")!;
  assert.ok(changedFilesEvidence, "changed_files evidence must exist");
  assert.deepEqual(changedFilesEvidence.artifactIds, [changedFilesArtifact.id]);

  const transcriptArtifact = artifacts.find((item) => item.name === "session-transcript.log")!;
  assert.ok(transcriptArtifact, "transcript artifact must exist");
  const transcriptContent = await readFile(transcriptArtifact.path!, "utf8");
  // ANSI codes stripped, and no literal escape byte left behind.
  assert.match(transcriptContent, /\$ implement the feature\nDone\./);
  assert.ok(!transcriptContent.includes("\x1b"), "transcript must not contain raw ANSI escapes");
  const transcriptEvidence = evidence.find((item) => item.kind === "agent.transcript")!;
  assert.ok(transcriptEvidence, "transcript evidence must exist");
  assert.deepEqual(transcriptEvidence.artifactIds, [transcriptArtifact.id]);

  const completionEvidence = evidence.find((item) => item.kind === "agent.completion")!;
  assert.ok(completionEvidence, "completion metadata evidence must exist");
  assert.match(completionEvidence.claim || "", /done/);
  assert.equal((completionEvidence.value as Record<string, unknown>).taskStatus, "done");
});

test("completion artifact capture is best-effort: a task with no worktree/session still succeeds with no diff/transcript artifacts, but records completion evidence", async (t) => {
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
  // No worktree/session to harvest from, but the task's own completion
  // metadata (status, agent, ids) can always be derived - "Artifacts 0" then
  // means "the agent genuinely changed nothing", not "nothing was captured".
  const evidence = await store.listEvidence("run_bare", "implement");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "agent.completion");
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
  // The diff harvest failed, but completion metadata is independent of it
  // and should still be recorded.
  const evidence = await store.listEvidence("run_diff_fail", "implement");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "agent.completion");
});

test("changed_files.json captures added/deleted/renamed/untracked files with the right change type", async (t) => {
  const { store, tempDir } = await makeStore(t, "honeyrail-agent-task-artifacts-changed-files-");
  const project = await store.createProject({ name: "demo", repoPath: tempDir, defaultBranch: "main", defaultAgent: "codex", testCommands: [], runCommands: [] });
  const worktree = await store.createWorktree({ projectId: project.id, path: join(tempDir, "wt"), branch: "codex/task", baseBranch: "main", baseRevision: "base", title: "task", agent: "codex" });
  const task = await store.createTask({ projectId: project.id, title: "task", agent: "codex", status: "done", worktreeId: worktree.id });
  const step = await store.createStep({ id: "implement", runId: "run_changed_files", name: "Implement change", executor: "agent-task", input: {}, status: "running" });

  const executor = new AgentTaskExecutor();
  const ctx = {
    store,
    bus: new EventBus(),
    tmux: {} as any,
    worktrees: {
      diff: async () => ({
        diff: "diff --git a/new.py b/new.py\n+print('new')\n",
        diffStat: " new.py | 1 +\n 1 file changed, 1 insertion(+)",
        status: "A  new.py\nD  old.py\nR  from.py -> to.py\n?? untracked.py",
        commits: ""
      })
    } as any,
    runCommand: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    project,
    runId: "run_changed_files",
    step,
    sessionLogRoot: "",
    attachmentRoot: join(tempDir, "attachments")
  };

  const state = await executor.inspect(ctx, { taskId: task.id });
  assert.equal(state.status, "succeeded");

  const artifacts = await store.listArtifacts("run_changed_files", "implement");
  const changedFilesArtifact = artifacts.find((item) => item.name === "changed_files.json")!;
  const changedFiles = JSON.parse(await readFile(changedFilesArtifact.path!, "utf8"));
  assert.deepEqual(changedFiles, [
    { path: "new.py", changeType: "added" },
    { path: "old.py", changeType: "deleted" },
    { path: "to.py", changeType: "renamed", fromPath: "from.py" },
    { path: "untracked.py", changeType: "untracked" }
  ]);
});
