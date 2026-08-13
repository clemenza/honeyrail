import React, { useEffect, useState } from "react";
import {
  Activity,
  Braces,
  FolderGit2,
  GitBranch,
  ListTree,
  LogOut,
  Moon,
  RefreshCw,
  Shield,
  SquareTerminal,
  Sun
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AuthUser, HealthData, ViewId } from "../types.js";

export function StatusPill({ tone = "neutral", children = null }: { tone?: string; children?: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function IconButton({ icon: Icon, label, onClick, tone = "plain", disabled = false }: { icon: LucideIcon; label: string; onClick: () => void; tone?: string; disabled?: boolean }) {
  return (
    <button className={`icon-button icon-button-${tone}`} onClick={onClick} disabled={disabled} title={label} aria-label={label}>
      <Icon size={16} />
    </button>
  );
}

export function ThemeToggle({ theme, toggle }: { theme: string; toggle: () => void }) {
  return (
    <button className="theme-toggle" onClick={toggle} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`} aria-label="Toggle theme">
      {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}

const NAV_ITEMS: Array<[ViewId, LucideIcon, string]> = [
  ["dashboard", Activity, "Dashboard"],
  ["projects", FolderGit2, "Projects"],
  ["sessions", SquareTerminal, "Sessions"],
  ["worktrees", GitBranch, "Worktrees"],
  ["runs", ListTree, "Runs"],
  ["approvals", Shield, "Approvals"]
];

export const VIEW_META: Record<string, { title: string; subtitle: string }> = {
  dashboard: {
    title: "HoneyRail",
    subtitle: "engineering goals, evidence, and approvals"
  },
  projects: {
    title: "Projects",
    subtitle: "registered repositories and default agent settings"
  },
  sessions: {
    title: "Sessions",
    subtitle: "manage tmux-backed shells and open dedicated interaction pages"
  },
  worktrees: {
    title: "Worktrees",
    subtitle: "isolated task branches for agent runs"
  },
  runs: {
    title: "Runs",
    subtitle: "orchestrated multi-step engineering workflows"
  },
  approvals: {
    title: "Approvals",
    subtitle: "agent waits, review actions, and recent control events"
  }
};

export function Sidebar({ activeView, setActiveView }: { activeView: string; setActiveView: (view: string) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Braces size={18} /></div>
        <div>
          <strong>HoneyRail</strong>
          <span>engineering runtime</span>
        </div>
      </div>
      <nav className="nav">
        {NAV_ITEMS.map(([id, Icon, label]) => (
          <button key={id} className={activeView === id ? "active" : ""} onClick={() => setActiveView(id)}>
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

export function BottomNav({ activeView, setActiveView }: { activeView: string; setActiveView: (view: string) => void }) {
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      {NAV_ITEMS.map(([id, Icon, label]) => (
        <button key={id} className={activeView === id ? "active" : ""} onClick={() => setActiveView(id)} aria-label={label}>
          <Icon size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

export function Topbar({ health, error, connectionStatus, refresh, view, user, onLogout, theme, toggleTheme }: { health: HealthData | null; error: string; connectionStatus: string; refresh: () => void; view: string; user: AuthUser | null; onLogout: (() => void) | null; theme: string; toggleTheme: () => void }) {
  const meta = VIEW_META[view] || VIEW_META.dashboard;
  const online = health && !error && connectionStatus === "connected";
  const connectionLabel = online ? "Online" : connectionStatus === "reconnecting" ? "Reconnecting" : connectionStatus === "connecting" ? "Connecting" : "Offline";
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{meta.title}</h1>
        <span>{meta.subtitle}</span>
      </div>
      <div className="topbar-actions">
        {user ? <span className="account-badge"><Shield size={14} /> {user.username}</span> : null}
        <span className={`connection-dot ${online ? "online" : "offline"}`}>{connectionLabel}</span>
        <ThemeToggle theme={theme} toggle={toggleTheme} />
        <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} />
        {onLogout ? <IconButton icon={LogOut} label="Sign out" onClick={onLogout} /> : null}
      </div>
    </header>
  );
}

export function LoginScreen({ login, error: authError, loginEnabled }: { login: (username: string, password: string) => Promise<void>; error: string; loginEnabled: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(authError || "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setError(authError || "");
  }, [authError]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await login(username, password);
    } catch (err: unknown) {
      setError((err as Error).message || "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand login-brand">
          <div className="brand-mark"><Braces size={18} /></div>
          <div>
            <strong>HoneyRail</strong>
            <span>console access</span>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <div>
            <h1 id="login-title">Sign in</h1>
            <p>Use an account with console permission.</p>
          </div>
          {!loginEnabled ? <div className="inline-error">Account login is not configured on this server.</div> : null}
          {error ? <div className="inline-error">{error}</div> : null}
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" />
          </label>
          <button className="primary-button" type="submit" disabled={submitting || !loginEnabled}>
            <Shield size={16} /> {submitting ? "Signing in" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
