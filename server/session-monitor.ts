import { stat } from "node:fs/promises";
import { getAgentAdapter } from "./agents/registry.js";
import type { EventBus } from "./events.js";
import { publishEvent } from "./events.js";
import { readSessionLog } from "./session-helpers.js";
import type { Session, SessionStatus, Store } from "./types.js";
import type { TmuxManager } from "./tmux.js";

type SessionMonitorOptions = {
  store: Store;
  bus: EventBus;
  tmux: TmuxManager;
  intervalMs: number;
  staleMs: number;
};

const TERMINAL_STATUSES = new Set<string>(["failed", "killed", "completed", "merged", "cancelled"]);
const WAITING_APPROVAL_PATTERNS = [
  /do you want to (?:continue|proceed)/i,
  /waiting for (?:operator )?approval/i,
  /requires (?:operator )?approval/i
];
const WAITING_INPUT_PATTERNS = [
  /queued follow-up inputs/i,
  /waiting for input/i,
  /send a message/i,
  /press enter/i,
  // Claude Code's AskUserQuestion menu and similar interactive pickers
  // (e.g. loaded via a user-level skill like superpowers:brainstorming).
  /enter to select\s*[·•]\s*[↑↓]/i,
  /^\s*[❯>]\s*1\.\s+\S[\s\S]*?\n\s*2\.\s/m,
  /chat about this/i,
  /type something\.?\s*$/mi
];

function nowIso() {
  return new Date().toISOString();
}

function elapsedMs(input: unknown) {
  const time = new Date(String(input || 0)).getTime();
  return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

export function sessionAcceptsInput(status: unknown) {
  return ["running", "waiting_approval", "waiting_input", "idle", "stale"].includes(String(status || ""));
}

export function inferSessionStatus(output: string, lastOutputAt: unknown, staleMs: number): SessionStatus {
  // tmux capture includes scrollback from the whole interaction. Only inspect
  // the recent tail so words in prompts, docs, or completed commands do not
  // make an actively working agent look like it is waiting for approval.
  const recentOutput = output.split("\n").slice(-20).join("\n");
  if (WAITING_APPROVAL_PATTERNS.some((pattern) => pattern.test(recentOutput))) return "waiting_approval";
  if (WAITING_INPUT_PATTERNS.some((pattern) => pattern.test(recentOutput))) return "waiting_input";
  if (elapsedMs(lastOutputAt) > staleMs) return "stale";
  return "running";
}

async function markRelatedRecordsFailed(store: Store, session: Session, reason: string, failedAt: string) {
  const tasks = await store.listTasks();
  const task = tasks.find((item) => item.sessionId === session.id || (session.worktreeId && item.worktreeId === session.worktreeId));
  if (task && !TERMINAL_STATUSES.has(String(task.status))) {
    await store.updateTask(task.id, { status: "failed", failedAt, error: reason });
  }
  if (session.worktreeId) {
    const worktree = await store.getWorktree(session.worktreeId);
    if (worktree && !TERMINAL_STATUSES.has(String(worktree.status))) {
      await store.updateWorktree(worktree.id, { status: "failed", failedAt, error: reason });
    }
  }
  return task;
}

const logSizes = new Map<string, number>();

const MAX_AUTO_RESPONSE_ATTEMPTS_PER_PROMPT = 2;
const autoResponseAttempts = new Map<string, Map<string, number>>();

function forgetAutoResponseAttempts(sessionId: string) {
  autoResponseAttempts.delete(sessionId);
}

function pruneAutoResponseAttempts(activeSessionIds: Set<string>) {
  for (const sessionId of autoResponseAttempts.keys()) {
    if (!activeSessionIds.has(sessionId)) autoResponseAttempts.delete(sessionId);
  }
}

async function logFileChanged(logPath: string | undefined): Promise<boolean> {
  if (!logPath) return false;
  try {
    const info = await stat(logPath);
    const size = info.size;
    const previous = logSizes.get(logPath) ?? -1;
    logSizes.set(logPath, size);
    return previous !== -1 && size !== previous;
  } catch {
    return false;
  }
}

function forgetLogSize(logPath: string | undefined) {
  if (logPath) logSizes.delete(logPath);
}

async function pruneLogSizeCache(activeLogPaths: Set<string>) {
  for (const logPath of logSizes.keys()) {
    if (!activeLogPaths.has(logPath)) logSizes.delete(logPath);
  }
}

export async function reconcileSessions({ store, bus, tmux, staleMs }: Omit<SessionMonitorOptions, "intervalMs">) {
  const sessions = await store.listSessions();
  await pruneLogSizeCache(new Set(sessions.map((session) => session.logPath).filter((logPath): logPath is string => Boolean(logPath))));
  pruneAutoResponseAttempts(new Set(sessions.map((session) => session.id)));
  for (const session of sessions) {
    if (TERMINAL_STATUSES.has(String(session.status))) {
      forgetLogSize(session.logPath);
      forgetAutoResponseAttempts(session.id);
      continue;
    }
    try {
      const hasNewOutput = await logFileChanged(session.logPath);
      const output = await tmux.capture(session.tmuxSessionName, 80);
      const capturedAt = nowIso();

      const adapter = getAgentAdapter(session.agent);
      const fatalError = adapter.findFatalError?.(output) || null;
      if (fatalError) {
        try {
          await tmux.killSession(session.tmuxSessionName);
        } catch {
          // The CLI may have already exited after printing the fatal error.
        }
        await store.updateSession(session.id, {
          status: "failed",
          error: fatalError.message,
          lastHealthCheckAt: capturedAt,
          lastOutputAt: capturedAt
        });
        forgetLogSize(session.logPath);
        forgetAutoResponseAttempts(session.id);
        const task = await markRelatedRecordsFailed(store, session, fatalError.message, capturedAt);
        await publishEvent(store, bus, {
          type: "session.status_changed",
          projectId: session.projectId ?? undefined,
          sessionId: session.id,
          taskId: task?.id,
          payload: {
            status: "failed",
            previousStatus: session.status,
            error: fatalError.message,
            reason: fatalError.message,
            code: fatalError.code
          }
        });
        if (task) {
          await publishEvent(store, bus, {
            type: "task.failed",
            projectId: task.projectId,
            sessionId: session.id,
            taskId: task.id,
            payload: {
              reason: fatalError.message,
              error: fatalError.message,
              worktreeId: task.worktreeId,
              code: fatalError.code
            }
          });
        }
        continue;
      }
      if (session.taskId && adapter.hasCompletedTask?.(output)) {
        try {
          await tmux.killSession(session.tmuxSessionName);
        } catch {
          // The CLI may have exited after completing the task.
        }
        await store.updateSession(session.id, {
          status: "completed",
          lastHealthCheckAt: capturedAt,
          lastOutputAt: capturedAt,
          error: undefined
        });
        forgetLogSize(session.logPath);
        forgetAutoResponseAttempts(session.id);
        const task = await store.getTask(session.taskId);
        if (task && task.status === "agent_running") {
          await store.updateTask(task.id, { status: "done", error: undefined });
          await publishEvent(store, bus, {
            type: "task.completed",
            projectId: task.projectId,
            sessionId: session.id,
            taskId: task.id,
            payload: { status: "done", worktreeId: task.worktreeId }
          });
        }
        await publishEvent(store, bus, {
          type: "session.status_changed",
          projectId: session.projectId ?? undefined,
          sessionId: session.id,
          taskId: session.taskId,
          payload: { status: "completed", previousStatus: session.status }
        });
        continue;
      }
      const promptResponse = adapter.findInteractivePromptResponse?.(output) || null;
      if (promptResponse) {
        const attemptsByLabel = autoResponseAttempts.get(session.id) ?? new Map<string, number>();
        const attempts = attemptsByLabel.get(promptResponse.label) ?? 0;
        if (attempts < MAX_AUTO_RESPONSE_ATTEMPTS_PER_PROMPT) {
          attemptsByLabel.set(promptResponse.label, attempts + 1);
          autoResponseAttempts.set(session.id, attemptsByLabel);
          for (const key of promptResponse.keys) {
            await tmux.sendKey(session.tmuxSessionName, key);
          }
          await store.updateSession(session.id, { lastHealthCheckAt: capturedAt, lastOutputAt: capturedAt });
          await publishEvent(store, bus, {
            type: "session.prompt_auto_answered",
            projectId: session.projectId ?? undefined,
            sessionId: session.id,
            payload: { label: promptResponse.label, keys: promptResponse.keys }
          });
          continue;
        }
      }

      const nextStatus = inferSessionStatus(output, session.lastOutputAt || session.createdAt, staleMs);
      const previousStatus = session.status;
      const statusChanged = previousStatus !== nextStatus;
      const updates: Partial<Session> = { lastHealthCheckAt: capturedAt };
      if (output.trim() || hasNewOutput) updates.lastOutputAt = capturedAt;
      if (statusChanged) updates.status = nextStatus;
      if (Object.keys(updates).length) await store.updateSession(session.id, updates);
      if (statusChanged) {
        await publishEvent(store, bus, {
          type: "session.status_changed",
          projectId: session.projectId ?? undefined,
          sessionId: session.id,
          payload: { status: nextStatus, previousStatus }
        });
      }
    } catch (error) {
      const failedAt = nowIso();
      const reason = error instanceof Error ? error.message : String(error || "tmux session unavailable");
      const latest = await store.getSession(session.id);
      if (latest && !TERMINAL_STATUSES.has(String(latest.status))) {
        const logContent = await readSessionLog(session.logPath);
        const hasSubstantialOutput = logContent.trim().length > 0;
        const finalStatus: SessionStatus = hasSubstantialOutput ? "completed" : "failed";

        await store.updateSession(session.id, {
          status: finalStatus,
          error: finalStatus === "failed" ? reason : undefined,
          lastHealthCheckAt: failedAt,
          lastOutputAt: failedAt
        });
        forgetLogSize(session.logPath);

        if (finalStatus === "failed") {
          const task = await markRelatedRecordsFailed(store, session, reason, failedAt);
          await publishEvent(store, bus, {
            type: "session.status_changed",
            projectId: session.projectId ?? undefined,
            sessionId: session.id,
            taskId: task?.id,
            payload: { status: "failed", previousStatus: session.status, reason }
          });
        } else {
          await publishEvent(store, bus, {
            type: "session.status_changed",
            projectId: session.projectId ?? undefined,
            sessionId: session.id,
            payload: { status: "completed", previousStatus: session.status }
          });
        }
      }
    }
  }
}

async function recoverSessionsOnStartup({ store, bus, tmux, staleMs }: Omit<SessionMonitorOptions, "intervalMs">) {
  const sessions = await store.listSessions();
  const tmuxSessions = await tmux.listSessions();
  const activeTmuxNames = new Set(tmuxSessions.map((s) => s.name));

  for (const session of sessions) {
    if (TERMINAL_STATUSES.has(String(session.status))) continue;
    if (activeTmuxNames.has(session.tmuxSessionName)) continue;

    const logContent = await readSessionLog(session.logPath);
    const hasOutput = logContent.trim().length > 0;
    const finalStatus: SessionStatus = hasOutput ? "completed" : "failed";
    const now = nowIso();

    await store.updateSession(session.id, {
      status: finalStatus,
      error: finalStatus === "failed" ? "tmux session lost during server downtime" : undefined,
      lastHealthCheckAt: now,
      lastOutputAt: now
    });
    forgetLogSize(session.logPath);

    if (finalStatus === "failed") {
      await markRelatedRecordsFailed(store, session, "tmux session lost during server downtime", now);
    }

    await publishEvent(store, bus, {
      type: "session.status_changed",
      projectId: session.projectId ?? undefined,
      sessionId: session.id,
      payload: { status: finalStatus, previousStatus: session.status, reason: "server restart recovery" }
    });
  }
}

export function startSessionMonitor(options: SessionMonitorOptions) {
  let stopped = false;
  let running = false;
  let rerunRequested = false;
  const run = () => {
    if (stopped) return;
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    reconcileSessions(options)
      .catch((error) => console.error("Session monitor failed:", error))
      .finally(() => {
        running = false;
        if (rerunRequested && !stopped) {
          rerunRequested = false;
          run();
        }
      });
  };
  const timer = setInterval(run, options.intervalMs);
  recoverSessionsOnStartup(options).then(run).catch((error) => console.error("Session recovery failed:", error));

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
