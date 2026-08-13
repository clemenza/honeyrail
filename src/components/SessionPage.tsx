import React, { useEffect } from "react";
import type { GatewayState } from "../types.js";
import { ChatWorkspace } from "./ChatWorkspace.js";

export function SessionPage({ state, routeSessionId, selectedSessionId, setSelectedSessionId, refresh, onOpenSession, onBackToManagement }: {
  state: GatewayState;
  routeSessionId: string;
  selectedSessionId: string;
  setSelectedSessionId: (id: string) => void;
  refresh: () => Promise<void>;
  onOpenSession: (sessionId: string) => void;
  onBackToManagement: () => void;
}) {
  useEffect(() => {
    if (routeSessionId) setSelectedSessionId(routeSessionId);
  }, [routeSessionId, setSelectedSessionId]);

  return (
    <div className="session-route-shell">
      <ChatWorkspace
        sessions={state.sessions}
        events={state.events}
        selectedSessionId={routeSessionId || selectedSessionId}
        setSelectedSessionId={setSelectedSessionId}
        refresh={refresh}
        onBackToManagement={onBackToManagement}
        onSessionChange={onOpenSession}
      />
    </div>
  );
}
