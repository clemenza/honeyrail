import { useCallback, useEffect, useSyncExternalStore, useState } from "react";
import { api } from "./api.js";
import type { AuthUser, GatewayState, HealthData, SessionData, WorktreeData, TaskData, EventData } from "./types.js";

function getInitialTheme(): "light" | "dark" {
  const stored = localStorage.getItem("theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let currentTheme: "light" | "dark" = typeof window !== "undefined" ? getInitialTheme() : "light";
const listeners = new Set<() => void>();

function applyTheme(theme: "light" | "dark") {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  listeners.forEach((fn) => fn());
}

if (typeof window !== "undefined") {
  applyTheme(currentTheme);
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => currentTheme
  );
  const toggle = useCallback(() => applyTheme(currentTheme === "light" ? "dark" : "light"), []);
  return { theme, toggle };
}

export function useAuth() {
  const [state, setState] = useState<{ loading: boolean; enabled: boolean; loginEnabled: boolean; user: AuthUser | null; error: string }>({ loading: true, enabled: false, loginEnabled: false, user: null, error: "" });

  const refresh = async () => {
    try {
      const configResponse = await fetch("/api/auth/config", { credentials: "same-origin" });
      const config = await configResponse.json();
      if (!config.enabled) {
        setState({ loading: false, enabled: false, loginEnabled: false, user: { username: "local", permissions: ["console", "admin"] } as AuthUser, error: "" });
        return;
      }
      const meResponse = await fetch("/api/auth/me", { credentials: "same-origin" });
      const me = await meResponse.json().catch(() => null);
      setState({
        loading: false,
        enabled: true,
        loginEnabled: Boolean(config.loginEnabled),
        user: meResponse.ok ? me?.user : null,
        error: ""
      });
    } catch (err: unknown) {
      setState((current) => ({ ...current, loading: false, user: null, error: (err as Error).message || "Authentication unavailable" }));
    }
  };

  const login = async (username: string, password: string) => {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    await refresh();
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    await refresh();
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  return { ...state, login, logout, refresh };
}

type SSEPayload = {
  id?: string;
  type?: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
};

function patchList<T extends { id: string }>(list: T[], id: string, updates: Partial<T>): T[] {
  const index = list.findIndex((item) => item.id === id);
  if (index === -1) return list;
  const copy = [...list];
  copy[index] = { ...copy[index], ...updates };
  return copy;
}

function appendEvent(events: EventData[], event: SSEPayload): EventData[] {
  const entry: EventData = {
    id: event.id || "",
    type: event.type || "",
    sessionId: event.sessionId,
    createdAt: event.createdAt || new Date().toISOString(),
    payload: event.payload as EventData["payload"]
  };
  const next = [...events, entry];
  return next.length > 200 ? next.slice(-200) : next;
}

function applySSEDelta(state: GatewayState, eventType: string, data: SSEPayload): GatewayState | null {
  const payload = data.payload || {};

  switch (eventType) {
    case "session.status_changed": {
      if (!data.sessionId) return null;
      const status = payload.status as string | undefined;
      if (!status) return null;
      return {
        ...state,
        sessions: patchList<SessionData>(state.sessions, data.sessionId, {
          status,
          error: (payload.error || payload.reason) as string | undefined
        }),
        events: appendEvent(state.events, data)
      };
    }

    case "session.updated": {
      if (!data.sessionId) return null;
      return { ...state, sessions: patchList<SessionData>(state.sessions, data.sessionId, payload as Partial<SessionData>), events: appendEvent(state.events, data) };
    }

    case "session.deleted": {
      if (!data.sessionId) return null;
      return { ...state, sessions: state.sessions.filter((s) => s.id !== data.sessionId), events: appendEvent(state.events, data) };
    }

    case "session.input_sent":
    case "session.key_sent":
      return { ...state, events: appendEvent(state.events, data) };

    case "worktree.committed":
    case "worktree.checks_passed":
    case "worktree.checks_failed": {
      const worktreeId = payload.worktreeId as string | undefined;
      if (!worktreeId) return null;
      const statusMap: Record<string, string> = { "worktree.committed": "committed", "worktree.checks_passed": "checks_passed", "worktree.checks_failed": "checks_failed" };
      return { ...state, worktrees: patchList<WorktreeData>(state.worktrees, worktreeId, { status: statusMap[eventType] }), events: appendEvent(state.events, data) };
    }

    case "worktree.merged": {
      const worktreeId = payload.worktreeId as string | undefined;
      if (!worktreeId) return null;
      return { ...state, worktrees: patchList<WorktreeData>(state.worktrees, worktreeId, { status: "merged" }), events: appendEvent(state.events, data) };
    }

    case "worktree.discarded": {
      const worktreeId = payload.worktreeId as string | undefined;
      if (!worktreeId) return null;
      return { ...state, worktrees: patchList<WorktreeData>(state.worktrees, worktreeId, { status: "discarded" }), events: appendEvent(state.events, data) };
    }

    case "task.started": {
      if (!data.taskId) return null;
      return { ...state, tasks: patchList<TaskData>(state.tasks, data.taskId, { status: payload.status as string || "agent_running" }), events: appendEvent(state.events, data) };
    }

    case "task.failed": {
      if (!data.taskId) return null;
      const error = (payload.error || payload.reason) as string | undefined;
      const worktreeId = payload.worktreeId as string | undefined;
      return {
        ...state,
        tasks: patchList<TaskData>(state.tasks, data.taskId, {
          status: "failed",
          error
        }),
        worktrees: worktreeId
          ? patchList<WorktreeData>(state.worktrees, worktreeId, { status: "failed", error })
          : state.worktrees,
        events: appendEvent(state.events, data)
      };
    }

    case "task.completed": {
      if (!data.taskId) return null;
      return {
        ...state,
        tasks: patchList<TaskData>(state.tasks, data.taskId, { status: "done", error: undefined }),
        events: appendEvent(state.events, data)
      };
    }

    case "run.created":
    case "run.started":
    case "run.running":
    case "run.waiting_input":
    case "run.waiting_approval":
    case "run.succeeded":
    case "run.failed":
    case "run.cancelled":
    case "step.ready":
    case "step.started":
    case "step.waiting_input":
    case "step.waiting_approval":
    case "step.succeeded":
    case "step.failed":
    case "step.retrying":
    case "step.skipped":
    case "step.cancelled":
    case "artifact.created":
    case "evidence.recorded":
    case "evaluation.completed":
    case "quality_gate.passed":
    case "quality_gate.failed":
    case "quality_gate.waiting_approval":
      return { ...state, events: appendEvent(state.events, data) };

    default:
      return null;
  }
}

export function useGatewayData(enabled = true) {
  const [state, setState] = useState<GatewayState>({ projects: [], sessions: [], tasks: [], worktrees: [], runs: [], events: [], tmuxSessions: [] });
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [dashboard, nextHealth] = await Promise.all([api("/api/dashboard"), api("/api/health")]);
      setState(dashboard);
      setHealth(nextHealth);
      setError("");
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    setConnectionStatus("connecting");
    const stream = new EventSource("/api/events/stream");

    stream.onopen = () => setConnectionStatus("connected");
    stream.onerror = () => {
      setConnectionStatus((current) => current === "connected" ? "reconnecting" : "disconnected");
    };

    const incrementalHandler = (event: MessageEvent) => {
      let data: SSEPayload;
      try {
        data = JSON.parse(event.data);
      } catch {
        refresh();
        return;
      }
      const eventType = data.type || event.type;
      setState((prev) => {
        const delta = applySSEDelta(prev, eventType, data);
        return delta || prev;
      });
      if (eventType === "session.created" || eventType === "project.created" || eventType === "project.unregistered" || eventType === "worktree.created") {
        refresh();
      }
    };

    stream.addEventListener("gateway.connected", () => refresh());
    stream.addEventListener("project.created", () => refresh());
    stream.addEventListener("project.unregistered", () => refresh());
    stream.addEventListener("worktree.created", () => refresh());
    stream.addEventListener("session.created", () => refresh());

    stream.addEventListener("session.status_changed", incrementalHandler);
    stream.addEventListener("session.updated", incrementalHandler);
    stream.addEventListener("session.deleted", incrementalHandler);
    stream.addEventListener("session.input_sent", incrementalHandler);
    stream.addEventListener("session.key_sent", incrementalHandler);
    stream.addEventListener("worktree.committed", incrementalHandler);
    stream.addEventListener("worktree.checks_passed", incrementalHandler);
    stream.addEventListener("worktree.checks_failed", incrementalHandler);
    stream.addEventListener("worktree.merged", incrementalHandler);
    stream.addEventListener("worktree.discarded", incrementalHandler);
    stream.addEventListener("task.started", (event) => {
      incrementalHandler(event);
      refresh();
    });
    stream.addEventListener("task.failed", incrementalHandler);
    stream.addEventListener("task.completed", incrementalHandler);
    for (const type of ["run.created", "run.started", "run.running", "run.waiting_input", "run.waiting_approval", "run.succeeded", "run.failed", "run.cancelled", "step.ready", "step.started", "step.waiting_input", "step.waiting_approval", "step.succeeded", "step.failed", "step.retrying", "step.skipped", "step.cancelled", "artifact.created", "evidence.recorded", "evaluation.completed", "quality_gate.passed", "quality_gate.failed", "quality_gate.waiting_approval"]) {
      stream.addEventListener(type, () => refresh());
    }

    stream.onmessage = (event) => {
      let data: SSEPayload;
      try {
        data = JSON.parse(event.data);
      } catch {
        refresh();
        return;
      }
      const eventType = data.type || "";
      setState((prev) => {
        const delta = applySSEDelta(prev, eventType, data);
        return delta || prev;
      });
    };

    return () => stream.close();
  }, [enabled]);

  return { state, health, error, connectionStatus, loaded, refresh };
}
