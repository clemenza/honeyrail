import React, { useEffect, useRef, useState } from "react";
import {
  FileText,
  Paperclip,
  Play,
  SquareTerminal,
  Trash2,
  Workflow
} from "lucide-react";
import { api } from "../api.js";
import type { ImageAttachmentLocal, ProjectData, TaskData } from "../types.js";
import { fileToAttachment, formatBytes, imageFileToAttachment } from "../utils.js";
import { StatusPill } from "./layout.js";

export function TaskComposer({ projects, selectedProjectId, onCreated, panelTitle = "New agent task", subtitle = "Creates a worktree, branch, tmux session, and task record." }: { projects: ProjectData[]; selectedProjectId?: string; onCreated: () => Promise<void>; panelTitle?: string; subtitle?: string }) {
  const [projectId, setProjectId] = useState(selectedProjectId || "");
  const [agent, setAgent] = useState("codex");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachmentLocal[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (selectedProjectId) {
      const project = projects.find((item) => item.id === selectedProjectId);
      setProjectId(selectedProjectId);
      setAgent(project?.defaultAgent || "codex");
    }
  }, [selectedProjectId, projects]);

  const addImageFiles = async (files: FileList | File[] | null) => {
    const images = Array.from(files || []).filter((file: File) => file.type?.startsWith("image/"));
    if (!images.length) {
      setError("Only image files can be attached.");
      return;
    }
    try {
      const nextAttachments = await Promise.all(images.map(imageFileToAttachment));
      setAttachments((current) => [...current, ...nextAttachments].slice(0, 6));
      setError("");
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to attach image.");
    }
  };

  const addAnyFiles = async (files: FileList | File[] | null) => {
    const fileArray = Array.from(files || []);
    if (!fileArray.length) return;
    try {
      const nextAttachments = await Promise.all(fileArray.map(fileToAttachment));
      setAttachments((current) => [...current, ...nextAttachments].slice(0, 6));
      setError("");
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to attach file.");
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          agent,
          title,
          prompt,
          attachments: attachments.map(({ name, type, dataUrl }) => ({ name, type, dataUrl }))
        })
      });
      setTitle("");
      setPrompt("");
      setAttachments([]);
      setError("");
      await onCreated();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <form className="panel task-composer" onSubmit={submit} onDrop={(event) => {
      event.preventDefault();
      addAnyFiles(event.dataTransfer.files);
    }} onDragOver={(event) => event.preventDefault()}>
      <div className="panel-heading">
        <div>
          <h2>{panelTitle}</h2>
          <p>{subtitle}</p>
        </div>
        <Workflow size={18} />
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="form-grid">
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
            <option value="">Select project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <select value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option value="codex">codex</option>
            <option value="claude">claude</option>
            <option value="hermes">hermes</option>
            <option value="shell">shell</option>
          </select>
        </label>
      </div>
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="fix login selector" required />
      </label>
      <label>
        Prompt
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onPaste={(event) => {
            const files = event.clipboardData?.files;
            if (files?.length) {
              const images = Array.from(files as FileList).filter((file) => file.type?.startsWith("image/"));
              if (images.length) {
                event.preventDefault();
                addImageFiles(images);
              }
            }
          }}
          placeholder="Analyze the failure, implement the fix, run targeted tests, and summarize evidence."
          rows={4}
        />
      </label>
      {attachments.length ? (
        <div className="attachment-strip" aria-label="Task attachments">
          {attachments.map((attachment) => (
            <figure className="attachment-preview" key={attachment.id}>
              {attachment.type.startsWith("image/") ? (
                <img src={attachment.dataUrl} alt={attachment.name} />
              ) : (
                <div className="file-attachment-icon"><FileText size={28} /></div>
              )}
              <figcaption>
                <span>{attachment.name}</span>
                <small>{formatBytes(attachment.size)}</small>
              </figcaption>
              <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                <Trash2 size={14} />
              </button>
            </figure>
          ))}
        </div>
      ) : null}
      <div className="task-composer-actions">
        <label className="attach-button" title="Attach image">
          <Paperclip size={16} />
          <span>Image</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => {
              addImageFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
        <label className="attach-button" title="Attach file">
          <FileText size={16} />
          <span>File</span>
          <input
            type="file"
            multiple
            onChange={(event) => {
              addAnyFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
        <button className="primary-button" disabled={busy || !projectId}>
          <Play size={16} /> {busy ? "Starting task" : "Start task"}
        </button>
      </div>
    </form>
  );
}

export function SessionLauncher({ projects, selectedProjectId, onCreated, title = "Start session", subtitle = "Attach a tmux-backed shell or agent to the selected repo." }: { projects: ProjectData[]; selectedProjectId?: string; onCreated: () => Promise<void>; title?: string; subtitle?: string }) {
  const [projectId, setProjectId] = useState(selectedProjectId || "");
  const [agent, setAgent] = useState("shell");
  const [name, setName] = useState("debug shell");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    if (selectedProjectId) setProjectId(selectedProjectId);
  }, [selectedProjectId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ projectId, agent, name })
      });
      await onCreated();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <form className="panel form-panel" onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <SquareTerminal size={18} />
      </div>
      <label>
        Project
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
          <option value="">Select project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="debug shell" required />
        </label>
        <label>
          Agent
          <select value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option value="shell">shell</option>
            <option value="codex">codex</option>
            <option value="claude">claude</option>
            <option value="hermes">hermes</option>
          </select>
        </label>
      </div>
      <button className="primary-button" disabled={busy || !projectId}>
        <SquareTerminal size={16} /> {busy ? "Starting session" : "Start session"}
      </button>
    </form>
  );
}

export function TaskTable({ tasks, projects }: { tasks: TaskData[]; projects: ProjectData[] }) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Active tasks</h2>
          <p>{tasks.length} tracked runs</p>
        </div>
      </div>
      <div className="table">
        <div className="table-header">
          <span>Task</span>
          <span>Project</span>
          <span>Agent</span>
          <span>Status</span>
        </div>
        {tasks.slice().reverse().map((task) => {
          const project = projects.find((item) => item.id === task.projectId);
          return (
            <div className="table-row" key={task.id}>
              <strong>{task.title}</strong>
              <span>{project?.name || task.projectId}</span>
              <span>{task.agent}</span>
              <StatusPill tone={task.status === "failed" ? "bad" : task.status?.includes("running") ? "good" : "warn"}>{task.status}</StatusPill>
              {task.error ? <small className="record-error" role="alert">{task.error}</small> : null}
            </div>
          );
        })}
        {!tasks.length ? <div className="table-empty">No tasks yet.</div> : null}
      </div>
    </section>
  );
}
