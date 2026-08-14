import React, { useEffect, useMemo, useState } from "react";
import { Braces, Plus } from "lucide-react";
import { useAuth, useGatewayData, useTheme } from "./hooks.js";
import { useRoute } from "./router.js";
import { BottomNav, LoginScreen, Sidebar, Topbar } from "./components/layout.js";
import { MainContent } from "./components/ManagementView.js";
import { SessionPage } from "./components/SessionPage.js";

export default function App() {
  const auth = useAuth();
  const { theme, toggle: toggleTheme } = useTheme();
  const authorized = !auth.loading && (!auth.enabled || auth.user);
  const { state, health, error, connectionStatus, loaded, refresh } = useGatewayData(Boolean(authorized));
  const { route, openSession, openManagement } = useRoute();
  const [activeView, setActiveView] = useState(route.kind === "management" ? route.view : "sessions");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [showFabForm, setShowFabForm] = useState(false);

  const selectedProject = useMemo(
    () => state.projects.find((project) => project.id === selectedProjectId) || state.projects[0],
    [state.projects, selectedProjectId]
  );

  useEffect(() => {
    if (!selectedProjectId && selectedProject?.id) setSelectedProjectId(selectedProject.id);
  }, [selectedProject?.id, selectedProjectId]);

  useEffect(() => {
    if (route.kind === "management") {
      setActiveView(route.view);
    } else {
      setActiveView("sessions");
      setSelectedSessionId(route.sessionId);
    }
  }, [route]);

  const navigateManagement = (view: string = "sessions") => {
    setActiveView(view);
    openManagement(view);
  };

  const navigateSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    openSession(sessionId);
  };

  if (auth.loading) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand login-brand">
            <div className="brand-mark"><Braces size={18} /></div>
            <div>
              <strong>HoneyRail</strong>
              <span>loading access</span>
            </div>
          </div>
          <div className="skeleton skeleton-card" />
          <div className="skeleton skeleton-text" style={{ width: "60%" }} />
        </section>
      </main>
    );
  }

  if (!authorized) {
    return <LoginScreen login={auth.login} error={auth.error} loginEnabled={auth.loginEnabled} />;
  }

  if (route.kind === "session") {
    return (
      <SessionPage
        state={state}
        routeSessionId={route.sessionId}
        selectedSessionId={selectedSessionId}
        setSelectedSessionId={setSelectedSessionId}
        refresh={refresh}
        onOpenSession={navigateSession}
        onBackToManagement={() => navigateManagement("sessions")}
      />
    );
  }

  const showFab = activeView === "sessions" || activeView === "worktrees";

  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} setActiveView={navigateManagement} />
      <main className="main">
        <Topbar
          health={health}
          error={error}
          connectionStatus={connectionStatus}
          refresh={refresh}
          view={activeView}
          user={auth.user}
          onLogout={auth.enabled ? auth.logout : null}
          theme={theme}
          toggleTheme={toggleTheme}
        />
        <MainContent
          activeView={activeView}
          state={state}
          loaded={loaded}
          selectedProject={selectedProject}
          setSelectedProjectId={setSelectedProjectId}
          refresh={refresh}
          onOpenSession={navigateSession}
          showFabForm={showFabForm}
          setShowFabForm={setShowFabForm}
        />
      </main>
      <BottomNav activeView={activeView} setActiveView={navigateManagement} />
      {showFab ? (
        <button
          className="fab"
          onClick={() => setShowFabForm(true)}
          aria-label={activeView === "sessions" ? "New session" : "New task"}
          title={activeView === "sessions" ? "New session" : "New task"}
        >
          <Plus size={24} />
        </button>
      ) : null}
    </div>
  );
}
