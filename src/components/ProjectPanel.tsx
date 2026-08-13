import React, { useEffect, useState } from "react";
import {
  ArrowUp,
  FolderGit2,
  FolderOpen,
  Plus,
  Settings,
  Trash2,
  X
} from "lucide-react";
import { api } from "../api.js";
import type { DirectoryListing, ProjectData } from "../types.js";
import { IconButton, StatusPill } from "./layout.js";

function LocalPathPicker({ open, initialPath, onSelect, onClose }: { open: boolean; initialPath: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(initialPath || "");
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const loadPath = async (nextPath: string) => {
    setLoading(true);
    setError("");
    try {
      const query = nextPath ? `?path=${encodeURIComponent(nextPath)}` : "";
      const result = await api(`/api/filesystem/browse${query}`);
      setListing(result);
      setPath(result.path);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadPath(initialPath).catch(() => {});
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="path-picker-title">
        <div className="modal-header">
          <div>
            <h2 id="path-picker-title">Choose local repository</h2>
            <p>Browse folders on this Mac and select the repository directory.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close path picker">
            <X size={16} />
          </button>
        </div>

        <div
          className="path-jump"
        >
          <label>
            Current path
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  loadPath(path).catch(() => {});
                }
              }}
              placeholder="/path/to/workspace/project"
            />
          </label>
          <button className="secondary-button" type="button" onClick={() => loadPath(path)} disabled={loading} aria-label="Open typed path">Go</button>
        </div>

        <div className="path-roots">
          {listing?.roots?.map((root) => (
            <button key={root.path} type="button" onClick={() => loadPath(root.path)}>
              {root.label}
            </button>
          ))}
        </div>

        {error ? <div className="inline-error">{error}</div> : null}

        <div className="browser-panel">
          <button className="directory-row" type="button" disabled={!listing?.parentPath} onClick={() => listing?.parentPath && loadPath(listing.parentPath)}>
            <ArrowUp size={16} />
            <span>Parent folder</span>
          </button>
          {listing?.directories?.map((entry) => (
            <button className="directory-row" type="button" key={entry.path} onClick={() => loadPath(entry.path)}>
              <FolderOpen size={16} />
              <span>{entry.name}</span>
            </button>
          ))}
          {!loading && listing?.directories?.length === 0 ? <div className="directory-empty">No child folders.</div> : null}
          {loading ? <div className="directory-empty">Loading...</div> : null}
        </div>

        <div className="modal-footer">
          <div className="repo-hint">
            {listing?.isGitRepo ? "Git repository detected." : "Select a folder that contains a .git directory."}
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => onSelect(listing?.path || path)}
            disabled={!listing?.path}
          >
            <FolderGit2 size={16} /> Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProjectForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [mode, setMode] = useState("register");
  const [workspace, setWorkspace] = useState<{ path: string } | null>(null);
  const [repoPath, setRepoPath] = useState("");
  const [githubRepoUrl, setGithubRepoUrl] = useState("");
  const [name, setName] = useState("");
  const [defaultAgent, setDefaultAgent] = useState("codex");
  const [busy, setBusy] = useState(false);
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [error, setError] = useState("");

  const loadWorkspace = async () => {
    const result = await api("/api/projects/workspace");
    setWorkspace(result.workspace);
    setWorkspaceDraft(result.workspace?.path || "");
  };

  useEffect(() => {
    loadWorkspace().catch((err: unknown) => setError((err as Error).message));
  }, []);

  const saveWorkspace = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const result = await api("/api/projects/workspace", {
        method: "PUT",
        body: JSON.stringify({ path: workspaceDraft })
      });
      setWorkspace(result.workspace);
      setWorkspaceDraft(result.workspace.path);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          create: mode === "create",
          repoPath: repoPath.trim(),
          githubRepoUrl: githubRepoUrl.trim(),
          name: name.trim(),
          defaultAgent
        })
      });
      setRepoPath("");
      setGithubRepoUrl("");
      setName("");
      await onCreated();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel form-panel" onSubmit={submit}>
      <div className="panel-heading">
        <div>
          <h2>{mode === "create" ? "Create project" : "Add project"}</h2>
          <p>{mode === "create" ? "Create a git repo in the default workspace or at a chosen path." : "Register a local git repository for agent tasks."}</p>
        </div>
        <button
          className="heading-icon-button"
          type="button"
          onClick={() => setPathPickerOpen(true)}
          aria-label="Browse folders"
          title="Browse folders"
        >
          <Plus size={18} />
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="segmented-control" role="group" aria-label="Project mode">
        <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>Register</button>
        <button type="button" className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>Create</button>
      </div>
      <div className="workspace-control">
        <label>
          Default workspace
          <input value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="/path/to/workspace" />
        </label>
        <button className="secondary-button" type="button" onClick={saveWorkspace} disabled={busy || !workspaceDraft.trim()} aria-label="Save default workspace">
          <Settings size={16} /> Save
        </button>
      </div>
      {mode === "create" ? (
        <label>
          GitHub repo URL <span className="field-optional">(optional)</span>
          <input
            value={githubRepoUrl}
            onChange={(event) => setGithubRepoUrl(event.target.value)}
            placeholder="https://github.com/owner/repo"
            type="url"
          />
        </label>
      ) : null}
      <label>
        {mode === "create" && githubRepoUrl.trim() ? "Clone into path" : mode === "create" ? "Project path" : "Repo path"}
        <input
          value={repoPath}
          onChange={(event) => setRepoPath(event.target.value)}
          placeholder={mode === "create" ? `${workspace?.path || workspaceDraft || "/path/to/workspace"}/new-project` : "/path/to/workspace/project"}
          required={mode === "register"}
        />
      </label>
      {mode === "create" && !githubRepoUrl.trim() && !repoPath.trim() ? (
        <div className="subtle compact-hint">Leave path empty to create inside the default workspace.</div>
      ) : null}
      {mode === "create" && githubRepoUrl.trim() && !repoPath.trim() ? (
        <div className="subtle compact-hint">Repo will be cloned into the default workspace.</div>
      ) : null}
      <div className="form-grid">
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={mode === "create" ? "new project name" : "auto from path"} required={mode === "create" && !repoPath.trim()} />
        </label>
        <label>
          Agent
          <select value={defaultAgent} onChange={(event) => setDefaultAgent(event.target.value)}>
            <option value="codex">codex</option>
            <option value="claude">claude</option>
            <option value="hermes">hermes</option>
            <option value="shell">shell</option>
          </select>
        </label>
      </div>
      <button className="primary-button" disabled={busy}>
        <FolderGit2 size={16} /> {mode === "create" ? "Create project" : "Register"}
      </button>
      <LocalPathPicker
        open={pathPickerOpen}
        initialPath={repoPath}
        onClose={() => setPathPickerOpen(false)}
        onSelect={(selectedPath) => {
          setRepoPath(selectedPath);
          if (!name) setName(selectedPath.split("/").filter(Boolean).at(-1) || "");
          setPathPickerOpen(false);
        }}
      />
    </form>
  );
}

export function ProjectList({ projects, selectedProjectId, setSelectedProjectId, title = "Projects", subtitle, onChanged }: { projects: ProjectData[]; selectedProjectId?: string; setSelectedProjectId: (id: string) => void; title?: string; subtitle?: string; onChanged?: () => Promise<void> }) {
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  const unregisterProject = async (project: ProjectData) => {
    if (!window.confirm(`Unregister ${project.name}? The repository directory will stay on disk.`)) return;
    setBusyId(project.id);
    setError("");
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" });
      if (selectedProjectId === project.id) setSelectedProjectId("");
      await onChanged?.();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusyId("");
    }
  };

  if (!projects.length) {
    return (
      <section className="panel empty-state">
        <FolderGit2 size={22} />
        <h2>No projects registered</h2>
        <p>Add a local repository path to start a codex, claude, hermes, or shell session.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle || `${projects.length} local repos`}</p>
        </div>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="project-list">
        {projects.map((project) => (
          <div
            key={project.id}
            className={`project-row ${selectedProjectId === project.id ? "selected" : ""}`}
          >
            <button type="button" className="project-select" onClick={() => setSelectedProjectId(project.id)}>
              <div className="row-icon"><FolderGit2 size={17} /></div>
            </button>
            <button type="button" className="row-main project-main-button" onClick={() => setSelectedProjectId(project.id)}>
              <strong>{project.name}</strong>
              <span>{project.repoPath}</span>
            </button>
            <div className="row-meta">
              <StatusPill tone="neutral">{project.defaultAgent}</StatusPill>
              <IconButton
                icon={Trash2}
                label={`Unregister ${project.name}`}
                tone="danger"
                disabled={busyId === project.id}
                onClick={() => unregisterProject(project)}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
