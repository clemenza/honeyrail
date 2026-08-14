import React, { useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  GitBranch,
  GitMerge,
  Play,
  RefreshCw,
  Shield,
  XCircle,
  Trash2
} from "lucide-react";
import { api } from "../api.js";
import type { DiffData, EventData, GatewayState, ProjectData, RunData, SessionData, TaskData, WorktreeData, WorktreeItem } from "../types.js";
import { StatusPill } from "./layout.js";
import { ProjectForm, ProjectList } from "./ProjectPanel.js";
import { SessionLauncher, TaskComposer, TaskTable } from "./TaskPanel.js";
import { VerificationDrawer } from "./VerificationDrawer.js";

function EventFeed({ events, className }: { events: EventData[]; className?: string }) {
  return (
    <section className={`panel event-feed ${className || ""}`}>
      <div className="panel-heading">
        <div>
          <h2>Event stream</h2>
          <p>Recent gateway events</p>
        </div>
      </div>
      <div className="event-list">
        {events.slice().reverse().slice(0, 10).map((event) => (
          <div className="event-row" key={event.id || `${event.type}-${event.createdAt}`}>
            <span>{event.type}</span>
            <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function SessionsTable({ sessions, loading, onOpenSession }: { sessions: SessionData[]; loading: boolean; onOpenSession: (sessionId: string) => void }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Managed sessions</h2>
          <p>{sessions.length} tmux-backed sessions. Open a session to interact on its dedicated page.</p>
        </div>
      </div>
      <div className="table sessions-table">
        <div className="table-header">
          <span>Name</span>
          <span>Agent</span>
          <span>Status</span>
          <span>CWD</span>
          <span>Action</span>
        </div>
        {sessions.slice().reverse().map((session) => (
          <div className="table-row" key={session.id}>
            <strong>{session.name}</strong>
            <span>{session.agent}</span>
            <StatusPill tone={session.status === "running" ? "good" : "warn"}>{session.status}</StatusPill>
            <span className="truncate">{session.cwd}</span>
            <button type="button" className="secondary-button table-action" onClick={() => onOpenSession(session.id)}>
              Open <ArrowRight size={15} />
            </button>
          </div>
        ))}
        {loading ? (
          <div className="table-empty">
            <div className="skeleton skeleton-card" style={{ marginBottom: 8 }} />
            <div className="skeleton skeleton-text" style={{ width: "40%" }} />
          </div>
        ) : !sessions.length ? (
          <div className="table-empty">No sessions yet.</div>
        ) : null}
      </div>
    </section>
  );
}

function WorktreeList({ tasks, worktrees = [], onMerged }: { tasks: TaskData[]; worktrees?: WorktreeData[]; onMerged?: () => Promise<void> }) {
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [diffs, setDiffs] = useState<Record<string, DiffData>>({});
  const [expandedActions, setExpandedActions] = useState<string | null>(null);
  const worktreeItems: WorktreeItem[] = worktrees.length
    ? worktrees
    : tasks.filter((task) => task.worktreeId).map((task) => ({
      id: task.worktreeId!,
      taskId: task.id,
      title: task.title,
      agent: task.agent,
      status: task.status,
      error: task.error
    }));

  const runWorktreeAction = async (worktree: WorktreeItem, action: string, label: string, body: Record<string, unknown> = {}) => {
    setBusyId(`${worktree.id}:${action}`);
    setError("");
    setMessage("");
    try {
      const result = await api(`/api/worktrees/${worktree.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (action === "checks") {
        setMessage(`${label} ${result.ok ? "passed" : "failed"} for ${worktree.branch || worktree.id}.`);
      } else {
        setMessage(`${label} completed for ${worktree.branch || worktree.id}.`);
      }
      await onMerged?.();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusyId("");
      setExpandedActions(null);
    }
  };

  const showDiff = async (worktree: WorktreeItem) => {
    setBusyId(`${worktree.id}:diff`);
    setError("");
    try {
      const result = await api(`/api/worktrees/${worktree.id}/diff`);
      setDiffs((current) => ({ ...current, [worktree.id]: result }));
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusyId("");
    }
  };

  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Worktree inventory</h2>
          <p>{worktreeItems.length} task worktrees</p>
        </div>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {message ? <div className="inline-success">{message}</div> : null}
      <div className="table worktree-table">
        <div className="table-header">
          <span>Task</span>
          <span>Branch</span>
          <span>Agent</span>
          <span>Status</span>
          <span>Action</span>
        </div>
        {worktreeItems.slice().reverse().map((worktree) => {
          const task = tasks.find((item) => item.id === worktree.taskId);
          const status = worktree.status || task?.status || "created";
          const failureReason = worktree.error || task?.error;
          const terminal = ["merged", "discarded", "cancelled"].includes(status);
          const diff = diffs[worktree.id];
          const isExpanded = expandedActions === worktree.id;
          return (
            <div className="table-row worktree-row" key={worktree.id}>
              <strong className="truncate">{task?.title || worktree.title || worktree.id}</strong>
              <span className="truncate">{worktree.branch || worktree.id}</span>
              <span>{worktree.agent || task?.agent}</span>
              <StatusPill tone={status === "merged" || status === "checks_passed" || status === "committed" ? "good" : status === "failed" || status === "checks_failed" ? "bad" : status === "agent_running" ? "good" : "warn"}>{status}</StatusPill>
              <div className="worktree-actions">
                <button type="button" className="secondary-button table-action" onClick={() => showDiff(worktree)} disabled={!worktree.id || busyId === `${worktree.id}:diff`}>
                  <RefreshCw size={15} /> Diff
                </button>
                <button type="button" className="secondary-button table-action" onClick={() => runWorktreeAction(worktree, "commit", "Commit")} disabled={!worktree.id || terminal || busyId === `${worktree.id}:commit`}>
                  <GitBranch size={15} /> Commit
                </button>
                <button type="button" className="secondary-button table-action" onClick={() => runWorktreeAction(worktree, "checks", "Checks")} disabled={!worktree.id || terminal || busyId === `${worktree.id}:checks`}>
                  <Play size={15} /> Checks
                </button>
                <button type="button" className="secondary-button table-action" onClick={() => runWorktreeAction(worktree, "merge", "Merge")} disabled={!worktree.id || status === "merged" || terminal || busyId === `${worktree.id}:merge`}>
                  <GitMerge size={15} /> Merge
                </button>
                <button type="button" className="secondary-button table-action danger" onClick={() => runWorktreeAction(worktree, "discard", "Discard", { force: false })} disabled={!worktree.id || terminal || busyId === `${worktree.id}:discard`}>
                  <Trash2 size={15} /> Discard
                </button>
              </div>
              {diff ? (
                <pre className="worktree-diff-preview">{diff.diffStat || diff.status || diff.commits || "No diff."}</pre>
              ) : null}
              {failureReason ? <small className="record-error" role="alert">{failureReason}</small> : null}
            </div>
          );
        })}
        {!worktreeItems.length ? <div className="table-empty">No task worktrees yet.</div> : null}
      </div>
    </section>
  );
}

function ApprovalQueue({ tasks }: { tasks: TaskData[] }) {
  const waitingTasks = tasks.filter((task) => String(task.status).includes("approval") || String(task.status).includes("waiting"));
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Approval queue</h2>
          <p>{waitingTasks.length} tasks waiting for operator action</p>
        </div>
        <Shield size={18} />
      </div>
      <div className="table">
        <div className="table-header">
          <span>Task</span>
          <span>Agent</span>
          <span>Status</span>
          <span>Action</span>
        </div>
        {waitingTasks.map((task) => (
          <div className="table-row" key={task.id}>
            <strong>{task.title}</strong>
            <span>{task.agent}</span>
            <StatusPill tone="warn">{task.status}</StatusPill>
            <span>Use the session inspector quick actions.</span>
          </div>
        ))}
        {!waitingTasks.length ? <div className="table-empty">No approvals waiting.</div> : null}
      </div>
    </section>
  );
}

function evaluationTone(step: RunData["steps"][number]) {
  const evaluations = step.verification?.evaluations;
  if (!evaluations || evaluations.passed + evaluations.failed + evaluations.error === 0) return "neutral";
  if (evaluations.error || evaluations.failed) return "bad";
  return "good";
}

function evaluationLabel(step: RunData["steps"][number]) {
  const evaluations = step.verification?.evaluations;
  if (!evaluations || evaluations.passed + evaluations.failed + evaluations.error === 0) return "not evaluated";
  if (evaluations.error) return "ERROR";
  if (evaluations.failed) return "FAIL";
  return "PASS";
}

function latestGateDecision(step: RunData["steps"][number]) {
  return step.verification?.gateDecisionItems?.at(-1);
}

function gateDecisionTone(step: RunData["steps"][number]) {
  const decision = latestGateDecision(step);
  if (!decision) return "neutral";
  if (decision.status === "passed") return "good";
  if (decision.status === "overridden") return "warn";
  return "bad";
}

function gateDecisionLabel(step: RunData["steps"][number]) {
  const decision = latestGateDecision(step);
  if (!decision) return "no gate decision";
  if (decision.status === "overridden") return "OVERRIDDEN";
  return decision.status.toUpperCase();
}

function compactJson(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function RunsPanel({ runs, projects, refresh }: { runs: RunData[]; projects: ProjectData[]; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<{ runId: string; stepId: string; kind: "artifact" | "evidence" } | null>(null);

  const act = async (path: string, label: string) => {
    setBusy(label);
    setError("");
    try {
      await api(path, { method: "POST", body: JSON.stringify({}) });
      await refresh();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const drawerStep = drawer ? runs.find((run) => run.id === drawer.runId)?.steps.find((step) => step.id === drawer.stepId) : undefined;

  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Orchestration runs</h2>
          <p>{runs.length} persisted multi-step workflows</p>
        </div>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="run-list">
        {runs.slice().reverse().map((run) => {
          const project = projects.find((item) => item.id === run.projectId);
          const terminal = ["succeeded", "failed", "cancelled"].includes(run.status);
          return (
            <article className="run-card" key={run.id}>
              <div className="run-card-header">
                <div>
                  <h3>{run.goal}</h3>
                  <p>{project?.name || run.projectId} · {run.id}</p>
                </div>
                <StatusPill tone={run.status === "succeeded" ? "good" : run.status === "failed" ? "bad" : "warn"}>{run.status}</StatusPill>
              </div>
              <div className="run-steps">
                {run.steps.map((step) => (
                  <div className="run-step" key={step.id}>
                    <div>
                      <strong>{step.name}</strong>
                      <span>{step.executor} · attempt {step.attempt}/{step.maxAttempts}</span>
                      <small>depends on {step.dependsOn.length ? step.dependsOn.join(", ") : "none"}</small>
                      {step.error ? <small className="run-step-error">{step.error}</small> : null}
                      <div className="run-verification">
                        <button
                          type="button"
                          className="verification-count-button"
                          disabled={!step.verification?.artifacts}
                          onClick={() => setDrawer({ runId: run.id, stepId: step.id, kind: "artifact" })}
                        >
                          Artifacts {step.verification?.artifacts || 0}
                        </button>
                        <button
                          type="button"
                          className="verification-count-button"
                          disabled={!step.verification?.evidence}
                          onClick={() => setDrawer({ runId: run.id, stepId: step.id, kind: "evidence" })}
                        >
                          Evidence {step.verification?.evidence || 0}
                        </button>
                        {step.verification?.latestAttempt ? <span>Latest attempt {step.verification.latestAttempt}</span> : null}
                        <StatusPill tone={evaluationTone(step)}>{evaluationLabel(step)}</StatusPill>
                        <StatusPill tone={gateDecisionTone(step)}>{gateDecisionLabel(step)}</StatusPill>
                      </div>
                      {step.verification && (step.verification.artifactItems?.length || step.verification.evidenceItems?.length || step.verification.evaluationItems?.length || step.verification.gateDecisionItems?.length) ? (
                        <details className="run-verification-detail">
                          <summary>Verification detail</summary>
                          {step.verification.artifactItems?.map((artifact) => (
                            <div className="run-verification-item" key={artifact.id}>
                              <strong>{artifact.kind}: {artifact.name}</strong>
                              <small>{artifact.uri || artifact.path || artifact.id}</small>
                              {artifact.metadata ? <code>{compactJson(artifact.metadata)}</code> : null}
                            </div>
                          ))}
                          {step.verification.evidenceItems?.map((evidence) => (
                            <div className="run-verification-item" key={evidence.id}>
                              <strong>{evidence.kind}</strong>
                              {evidence.claim ? <small>{evidence.claim}</small> : null}
                              {evidence.value !== undefined ? <code>{compactJson(evidence.value)}</code> : null}
                            </div>
                          ))}
                          {step.verification.evaluationItems?.map((evaluation) => (
                            <div className="run-verification-item" key={evaluation.id}>
                              <strong>{evaluation.evaluator}: {evaluation.status}{evaluation.attempt ? ` · attempt ${evaluation.attempt}` : ""}</strong>
                              {evaluation.reason ? <small>{evaluation.reason}</small> : null}
                              <code>{compactJson({ score: evaluation.score, threshold: evaluation.threshold, metadata: evaluation.metadata })}</code>
                            </div>
                          ))}
                          {step.verification.gateDecisionItems?.map((decision) => (
                            <div className="run-verification-item" key={decision.id}>
                              <strong>gate: {decision.status}{decision.attempt ? ` · attempt ${decision.attempt}` : ""}</strong>
                              <small>{decision.decidedBy}{decision.reason ? ` · ${decision.reason}` : ""}</small>
                              <code>{compactJson({ evaluationIds: decision.evaluationIds })}</code>
                            </div>
                          ))}
                        </details>
                      ) : null}
                    </div>
                    <div className="run-step-actions">
                      <StatusPill tone={step.status === "succeeded" ? "good" : step.status === "failed" ? "bad" : step.status === "waiting_approval" ? "warn" : "neutral"}>{step.status}</StatusPill>
                      {step.executionRef?.sessionId ? (
                        <a className="secondary-button table-action" href={`#/session/${step.executionRef.sessionId}`}>Session <ArrowRight size={14} /></a>
                      ) : null}
                      {step.status === "waiting_approval" ? (
                        <>
                          <button type="button" className="secondary-button table-action" disabled={Boolean(busy)} onClick={() => act(`/api/runs/${run.id}/steps/${step.id}/approve`, `approve:${step.id}`)}>
                            <Shield size={14} /> Approve
                          </button>
                          <button type="button" className="secondary-button table-action danger" disabled={Boolean(busy)} onClick={() => act(`/api/runs/${run.id}/steps/${step.id}/reject`, `reject:${step.id}`)}>
                            <XCircle size={14} /> Reject
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              <div className="run-card-footer">
                <button type="button" className="secondary-button table-action danger" disabled={terminal || Boolean(busy)} onClick={() => act(`/api/runs/${run.id}/cancel`, `cancel:${run.id}`)}>
                  <Trash2 size={14} /> Cancel run
                </button>
              </div>
            </article>
          );
        })}
        {!runs.length ? <div className="table-empty">No orchestration runs yet.</div> : null}
      </div>
      {drawer && drawerStep ? (
        <VerificationDrawer step={drawerStep} initialKind={drawer.kind} onClose={() => setDrawer(null)} />
      ) : null}
    </section>
  );
}

function ManagementSummary({ state, onOpenSession, onNavigate }: { state: GatewayState; onOpenSession: (sessionId: string) => void; onNavigate?: (view: string) => void }) {
  const runningSessions = state.sessions.filter((session) => session.status === "running").length;
  const activeTasks = state.tasks.filter((task) => !["done", "failed", "cancelled"].includes(task.status)).length;
  const latestSession = state.sessions.at(-1);

  return (
    <section className="management-summary">
      <div className="summary-card" onClick={() => onNavigate?.("projects")} role="button" tabIndex={0}>
        <span>Projects</span>
        <strong>{state.projects.length}</strong>
      </div>
      <div className="summary-card" onClick={() => onNavigate?.("sessions")} role="button" tabIndex={0}>
        <span>Running sessions</span>
        <strong>{runningSessions}</strong>
      </div>
      <div className="summary-card" onClick={() => onNavigate?.("worktrees")} role="button" tabIndex={0}>
        <span>Active tasks</span>
        <strong>{activeTasks}</strong>
      </div>
      <div className="summary-card" onClick={() => onNavigate?.("runs")} role="button" tabIndex={0}>
        <span>Runs</span>
        <strong>{state.runs.length}</strong>
      </div>
      <div className="summary-card summary-card-action">
        <span>Latest session</span>
        <strong>{latestSession?.name || "None"}</strong>
        <button type="button" className="secondary-button" onClick={() => latestSession && onOpenSession(latestSession.id)} disabled={!latestSession}>
          Open session <ArrowRight size={15} />
        </button>
      </div>
    </section>
  );
}

export function MainContent({ activeView, state, loaded, selectedProject, setSelectedProjectId, refresh, onOpenSession, showFabForm, setShowFabForm }: {
  activeView: string;
  state: GatewayState;
  loaded: boolean;
  selectedProject: ProjectData | undefined;
  setSelectedProjectId: (id: string) => void;
  refresh: () => Promise<void>;
  onOpenSession: (sessionId: string) => void;
  showFabForm?: boolean;
  setShowFabForm?: (show: boolean) => void;
}) {
  if (activeView === "projects") {
    return (
      <div className="content-grid">
        <div className="primary-column">
          <ProjectList
            projects={state.projects}
            selectedProjectId={selectedProject?.id}
            setSelectedProjectId={setSelectedProjectId}
            title="Project registry"
            subtitle={`${state.projects.length} local repos`}
            onChanged={refresh}
          />
        </div>
        <div className="secondary-column">
          <ProjectForm onCreated={refresh} />
          <EventFeed events={state.events} className="event-feed-hide-mobile" />
        </div>
      </div>
    );
  }

  if (activeView === "sessions") {
    return (
      <div className="content-grid">
        <div className="primary-column">
          {showFabForm ? (
            <SessionLauncher
              projects={state.projects}
              selectedProjectId={selectedProject?.id}
              onCreated={async () => { setShowFabForm?.(false); await refresh(); }}
              title="New session"
              subtitle="Start a tmux-backed shell, codex, claude, or hermes process."
            />
          ) : null}
          <SessionsTable sessions={state.sessions} loading={!loaded} onOpenSession={onOpenSession} />
        </div>
        <div className="secondary-column">
          <SessionLauncher
            projects={state.projects}
            selectedProjectId={selectedProject?.id}
            onCreated={refresh}
            title="Session launcher"
            subtitle="Start a tmux-backed shell, codex, claude, or hermes process."
          />
          <EventFeed events={state.events} className="event-feed-hide-mobile" />
        </div>
      </div>
    );
  }

  if (activeView === "worktrees") {
    return (
      <div className="content-grid">
        <div className="primary-column">
          {showFabForm ? (
            <TaskComposer
              projects={state.projects}
              selectedProjectId={selectedProject?.id}
              onCreated={async () => { setShowFabForm?.(false); await refresh(); }}
              panelTitle="New task"
              subtitle="Creates a worktree, branch, tmux session, and task record."
            />
          ) : null}
          <TaskComposer
            projects={state.projects}
            selectedProjectId={selectedProject?.id}
            onCreated={refresh}
            panelTitle="Worktree-backed tasks"
            subtitle="Create an isolated branch, worktree, tmux session, and task record."
          />
          <TaskTable tasks={state.tasks} projects={state.projects} />
        </div>
        <div className="secondary-column">
          <WorktreeList tasks={state.tasks} worktrees={state.worktrees} onMerged={refresh} />
          <EventFeed events={state.events} className="event-feed-hide-mobile" />
        </div>
      </div>
    );
  }

  if (activeView === "approvals") {
    return (
      <div className="content-grid">
        <div className="primary-column">
          <ApprovalQueue tasks={state.tasks} />
          <TaskTable tasks={state.tasks} projects={state.projects} />
        </div>
        <div className="secondary-column">
          <EventFeed events={state.events} className="event-feed-hide-mobile" />
        </div>
      </div>
    );
  }

  if (activeView === "runs") {
    return (
      <div className="content-grid">
        <div className="primary-column">
          <RunsPanel runs={state.runs} projects={state.projects} refresh={refresh} />
        </div>
        <div className="secondary-column">
          <EventFeed events={state.events} className="event-feed-hide-mobile" />
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-layout">
      <ManagementSummary state={state} onOpenSession={onOpenSession} />
      <div className="dashboard-management-grid">
        <SessionsTable sessions={state.sessions} loading={!loaded} onOpenSession={onOpenSession} />
        <TaskTable tasks={state.tasks} projects={state.projects} />
      </div>
      <EventFeed events={state.events} />
      {!state.sessions.length ? (
        <div className="dashboard-empty-action">
          <SessionLauncher projects={state.projects} selectedProjectId={selectedProject?.id} onCreated={refresh} />
        </div>
      ) : null}
    </div>
  );
}
