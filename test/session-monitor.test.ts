import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";
import { inferSessionStatus, reconcileSessions, sessionAcceptsInput, startSessionMonitor } from "../server/session-monitor.js";

async function makeStore(t: TestContext, prefix: string) {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  return new JsonStore(join(tempDir, "store.json"));
}

test("inferSessionStatus detects waiting approval and waiting input", () => {
  assert.equal(inferSessionStatus("Do you want to continue? Please approve.", new Date().toISOString(), 60_000), "waiting_approval");
  assert.equal(inferSessionStatus("Queued follow-up inputs are waiting", new Date().toISOString(), 60_000), "waiting_input");
});

test("inferSessionStatus ignores approval words in older task output while the agent is working", () => {
  const output = [
    "Approve the final barrier after reviewing the worktree.",
    ...Array.from({ length: 20 }, (_, index) => `inspection output ${index + 1}`),
    "Working (18s - esc to interrupt)"
  ].join("\n");
  assert.equal(inferSessionStatus(output, new Date().toISOString(), 60_000), "running");
});

test("inferSessionStatus marks stale sessions without recent output", () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  assert.equal(inferSessionStatus("working...", old, 1_000), "stale");
});

test("inferSessionStatus detects Claude Code's AskUserQuestion menu", () => {
  const output = [
    "What kind of todo list app do you want?",
    "",
    "❯ 1. Simple CLI todo list",
    "  2. Web app with React",
    "  3. Mobile app with React Native",
    "  4. Desktop app with Electron",
    "  5. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel"
  ].join("\n");
  assert.equal(inferSessionStatus(output, new Date().toISOString(), 60_000), "waiting_input");
});

test("sessionAcceptsInput keeps waiting and stale sessions interactive", () => {
  assert.equal(sessionAcceptsInput("running"), true);
  assert.equal(sessionAcceptsInput("waiting_approval"), true);
  assert.equal(sessionAcceptsInput("waiting_input"), true);
  assert.equal(sessionAcceptsInput("stale"), true);
  assert.equal(sessionAcceptsInput("failed"), false);
});

test("reconcileSessions updates status from tmux output and publishes an event", async (t) => {
  const store = await makeStore(t, "agw-monitor-status-");
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const session = await store.createSession({
    projectId: "proj_1",
    name: "approval wait",
    agent: "codex",
    tmuxSessionName: "agw_waiting",
    cwd: "/tmp",
    status: "running",
    createdAt: new Date().toISOString()
  });

  await reconcileSessions({
    store,
    bus,
    staleMs: 60_000,
    tmux: {
      capture: async () => "Do you want to continue? approve command"
    } as any
  });

  const updated = await store.getSession(session.id);
  assert.equal(updated!.status, "waiting_approval");
  assert.equal(events.at(-1).type, "session.status_changed");
  assert.equal(events.at(-1).payload.status, "waiting_approval");
});

test("reconcileSessions marks related records failed when tmux session disappears", async (t) => {
  const store = await makeStore(t, "agw-monitor-failed-");
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const task = await store.createTask({ projectId: "proj_1", title: "agent task", status: "agent_running" });
  const worktree = await store.createWorktree({ projectId: "proj_1", taskId: task.id, path: "/tmp/wt", branch: "codex/task" });
  const session = await store.createSession({
    projectId: "proj_1",
    taskId: task.id,
    worktreeId: worktree.id,
    name: "missing pane",
    agent: "codex",
    tmuxSessionName: "agw_missing",
    cwd: "/tmp/wt",
    status: "running"
  });
  await store.updateTask(task.id, { sessionId: session.id, worktreeId: worktree.id });

  await reconcileSessions({
    store,
    bus,
    staleMs: 60_000,
    tmux: {
      capture: async () => {
        throw new Error("can't find pane");
      }
    } as any
  });

  assert.equal((await store.getSession(session.id))!.status, "failed");
  assert.equal((await store.getWorktree(worktree.id))!.status, "failed");
  assert.equal((await store.listTasks()).find((item) => item.id === task.id)!.status, "failed");
  assert.equal(events.at(-1).payload.status, "failed");
});

test("reconcileSessions fails a task cleanly on a structured BLOCKED: stop from an unattended agent", async (t) => {
  const store = await makeStore(t, "agw-monitor-blocked-");
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const task = await store.createTask({ projectId: "proj_1", title: "unattended task", agent: "codex", status: "agent_running" });
  const worktree = await store.createWorktree({ projectId: "proj_1", taskId: task.id, path: "/tmp/wt", branch: "codex/unattended", status: "created" });
  const session = await store.createSession({
    projectId: "proj_1",
    taskId: task.id,
    worktreeId: worktree.id,
    name: "unattended",
    agent: "codex",
    tmuxSessionName: "agw_blocked",
    cwd: "/tmp/wt",
    status: "running"
  });
  await store.updateTask(task.id, { sessionId: session.id, worktreeId: worktree.id });

  const killed: string[] = [];
  await reconcileSessions({
    store,
    bus,
    staleMs: 60_000,
    tmux: {
      capture: async () => "doing work...\nBLOCKED: the target database is unreachable from this sandbox",
      killSession: async (name: string) => { killed.push(name); }
    } as any
  });

  assert.deepEqual(killed, ["agw_blocked"]);
  assert.equal((await store.getSession(session.id))!.status, "failed");
  assert.equal((await store.getSession(session.id))!.error, "the target database is unreachable from this sandbox");
  assert.equal((await store.listTasks()).find((item) => item.id === task.id)!.status, "failed");
  assert.equal(events.at(-1).type, "task.failed");
  assert.equal(events.at(-1).payload.code, "agent_blocked");
});

test("reconcileSessions fails a Codex task and prompts for an upgrade when the CLI is too old", async (t) => {
  const store = await makeStore(t, "agw-monitor-codex-upgrade-");
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const task = await store.createTask({ projectId: "proj_1", title: "new model task", agent: "codex", status: "agent_running" });
  const worktree = await store.createWorktree({ projectId: "proj_1", taskId: task.id, path: "/tmp/wt", branch: "codex/new-model", status: "created" });
  const session = await store.createSession({
    projectId: "proj_1",
    taskId: task.id,
    worktreeId: worktree.id,
    name: "unsupported model",
    agent: "codex",
    tmuxSessionName: "agw_old_codex",
    cwd: "/tmp/wt",
    status: "running"
  });
  await store.updateTask(task.id, { sessionId: session.id, worktreeId: worktree.id });

  const killed: string[] = [];
  await reconcileSessions({
    store,
    bus,
    staleMs: 60_000,
    tmux: {
      capture: async () => "The 'gpt-5.6-sol' model requires a\nnewer version of Codex. Please upgrade to the latest app or CLI and try\nagain.",
      killSession: async (name: string) => { killed.push(name); }
    } as any
  });

  const expected = "Codex CLI is too old for model gpt-5.6-sol. Upgrade it with `npm install -g @openai/codex@latest`, then start a new task.";
  assert.deepEqual(killed, ["agw_old_codex"]);
  assert.equal((await store.getSession(session.id))!.status, "failed");
  assert.equal((await store.getSession(session.id))!.error, expected);
  assert.equal((await store.getWorktree(worktree.id))!.status, "failed");
  assert.equal((await store.listTasks()).find((item) => item.id === task.id)!.status, "failed");
  assert.equal(events.at(-2).type, "session.status_changed");
  assert.equal(events.at(-2).payload.code, "codex_cli_upgrade_required");
  assert.equal(events.at(-1).type, "task.failed");
  assert.equal(events.at(-1).payload.reason, expected);
});

test("reconcileSessions completes a linked task when Codex returns to its prompt", async (t) => {
  const store = await makeStore(t, "agw-monitor-codex-complete-");
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const task = await store.createTask({ projectId: "proj_1", title: "completed task", agent: "codex", status: "agent_running" });
  const session = await store.createSession({
    projectId: "proj_1",
    taskId: task.id,
    name: "completed codex task",
    agent: "codex",
    tmuxSessionName: "agw_completed_codex",
    cwd: "/tmp/wt",
    status: "running"
  });
  await store.updateTask(task.id, { sessionId: session.id });

  const killed: string[] = [];
  await reconcileSessions({
    store,
    bus,
    staleMs: 60_000,
    tmux: {
      capture: async () => "Added the requested note.\n\n─ Worked for 1m 29s ─────\n\n› Use /skills to list available skills",
      killSession: async (name: string) => { killed.push(name); }
    } as any
  });

  assert.deepEqual(killed, ["agw_completed_codex"]);
  assert.equal((await store.getSession(session.id))!.status, "completed");
  assert.equal((await store.getTask(task.id))!.status, "done");
  assert.deepEqual(events.slice(-2).map((event) => event.type), ["task.completed", "session.status_changed"]);
});

test("reconcileSessions does not refresh lastOutputAt just because the pane is non-blank, so a truly idle session goes stale", async (t) => {
  const store = await makeStore(t, "agw-monitor-lastoutput-");
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const staleLastOutputAt = new Date(Date.now() - 120_000).toISOString();
  const session = await store.createSession({
    projectId: "proj_1",
    name: "quietly idle",
    agent: "claude",
    tmuxSessionName: "agw_idle",
    cwd: "/tmp",
    status: "running",
    createdAt: staleLastOutputAt
  });
  await store.updateSession(session.id, { lastOutputAt: staleLastOutputAt });

  // `output.trim()` alone used to be enough to reset lastOutputAt to "now"
  // on every poll, since a non-blank pane is the normal case - that masked
  // genuinely idle sessions from ever being detected as stale. There's no
  // logPath here, so logFileChanged (hasNewOutput) is false throughout.
  await reconcileSessions({
    store,
    bus,
    staleMs: 1_000,
    tmux: {
      capture: async () => "── previous turn output, unchanged for two minutes ──"
    } as any
  });

  const updated = await store.getSession(session.id);
  assert.equal(updated!.status, "stale");
  assert.equal(updated!.lastOutputAt, staleLastOutputAt, "lastOutputAt must not be bumped when the log hasn't actually grown");
});

test("reconcileSessions auto-answers a known interactive prompt instead of flagging waiting_approval", async (t) => {
  const store = await makeStore(t, "agw-monitor-autoanswer-");
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));
  const session = await store.createSession({
    projectId: "proj_1",
    name: "fresh worktree session",
    agent: "claude",
    tmuxSessionName: "agw_trust_dialog",
    cwd: "/tmp/wt",
    status: "running",
    createdAt: new Date().toISOString()
  });

  const sentKeys: string[] = [];
  await reconcileSessions({
    store,
    bus,
    staleMs: 60_000,
    tmux: {
      capture: async () =>
        "Quick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit",
      sendKey: async (_target: string, key: string) => { sentKeys.push(key); }
    } as any
  });

  assert.deepEqual(sentKeys, ["1", "Enter"]);
  const updated = await store.getSession(session.id);
  assert.equal(updated!.status, "running", "auto-answered prompt must not be left in waiting_approval");
  assert.equal(events.at(-1).type, "session.prompt_auto_answered");
  assert.equal(events.at(-1).payload.label, "claude_trust_folder");
});

test("reconcileSessions stops re-sending an auto-response after the retry cap", async (t) => {
  const store = await makeStore(t, "agw-monitor-autoanswer-cap-");
  const bus = new EventBus();
  await store.createSession({
    projectId: "proj_1",
    name: "stuck dialog",
    agent: "codex",
    tmuxSessionName: "agw_stuck_dialog",
    cwd: "/tmp/wt",
    status: "running",
    createdAt: new Date().toISOString()
  });

  const sentKeys: string[] = [];
  const options = {
    store,
    bus,
    staleMs: 60_000,
    tmux: {
      capture: async () =>
        "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit",
      sendKey: async (_target: string, key: string) => { sentKeys.push(key); }
    } as any
  };

  await reconcileSessions(options);
  await reconcileSessions(options);
  await reconcileSessions(options);

  // Capped at 2 attempts (MAX_AUTO_RESPONSE_ATTEMPTS_PER_PROMPT) so a dialog
  // that never clears can't be hammered with keystrokes forever.
  assert.deepEqual(sentKeys, ["1", "1"]);
});

test("startSessionMonitor does not run overlapping reconciliations for slow tmux captures", async (t) => {
  const store = await makeStore(t, "agw-monitor-overlap-");
  const bus = new EventBus();
  await store.createSession({
    projectId: "proj_1",
    name: "slow capture",
    agent: "codex",
    tmuxSessionName: "agw_slow",
    cwd: "/tmp",
    status: "running"
  });

  let activeCaptures = 0;
  let maxActiveCaptures = 0;
  const stop = startSessionMonitor({
    store,
    bus,
    intervalMs: 5,
    staleMs: 60_000,
    tmux: {
      listSessions: async () => [{ name: "agw_slow" }],
      capture: async () => {
        activeCaptures += 1;
        maxActiveCaptures = Math.max(maxActiveCaptures, activeCaptures);
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeCaptures -= 1;
        return "working";
      }
    } as any
  });
  t.after(stop);

  await new Promise((resolve) => setTimeout(resolve, 90));
  stop();

  assert.equal(maxActiveCaptures, 1);
});
