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

test("inferSessionStatus marks stale sessions without recent output", () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  assert.equal(inferSessionStatus("working...", old, 1_000), "stale");
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
