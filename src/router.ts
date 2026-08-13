import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AppRoute, ViewId } from "./types.js";

function parseRoute(): AppRoute {
  const sessionMatch = window.location.pathname.match(/^\/session\/([^/]+)$/);
  if (sessionMatch) {
    return { kind: "session", sessionId: decodeURIComponent(sessionMatch[1]) };
  }
  const view = new URLSearchParams(window.location.search).get("view") || "dashboard";
  return { kind: "management", view };
}

let currentRoute: AppRoute = parseRoute();
const listeners = new Set<() => void>();

function notify() {
  currentRoute = parseRoute();
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", notify);
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

function getSnapshot() {
  return currentRoute;
}

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  notify();
}

export function sessionPath(sessionId: string) {
  return `/session/${encodeURIComponent(sessionId)}`;
}

export function managementPath(view: ViewId | string = "dashboard") {
  return view === "dashboard" ? "/" : `/?view=${encodeURIComponent(view)}`;
}

export function useRoute() {
  const route = useSyncExternalStore(subscribe, getSnapshot);

  const openSession = useCallback((sessionId: string) => {
    navigate(sessionPath(sessionId));
  }, []);

  const openManagement = useCallback((view: ViewId | string = "sessions") => {
    navigate(managementPath(view));
  }, []);

  return { route, openSession, openManagement };
}

export { parseRoute as readRoute };
export { navigate as pushRoute };
