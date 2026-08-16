import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CheckRun, Project, Store, Worktree } from "./types.js";
import { pathExists, slugify, type SafeCommandOutput } from "./utils.js";

type HttpError = Error & { status: number };

function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

export async function gitSummary(project: Project, run: typeof import("./utils.js").runCommandSafe) {
  const branch = await run("git", ["branch", "--show-current"], { cwd: project.repoPath });
  const status = await run("git", ["status", "--short"], { cwd: project.repoPath });
  const remote = await run("git", ["remote", "get-url", "origin"], { cwd: project.repoPath });
  return {
    branch: branch.ok ? branch.stdout.trim() : project.defaultBranch,
    dirtyFiles: status.ok ? status.stdout.split("\n").filter(Boolean).length : null,
    status: status.ok ? status.stdout : "",
    remoteUrl: remote.ok ? remote.stdout.trim() : ""
  };
}

export async function recoverLegacyTaskWorktrees(store: Store, run: typeof import("./utils.js").runCommandSafe) {
  const [tasks, sessions, projects, existingWorktrees] = await Promise.all([
    store.listTasks(),
    store.listSessions(),
    store.listProjects(),
    store.listWorktrees()
  ]);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const worktreesByTaskId = new Map(existingWorktrees.filter((worktree) => worktree.taskId).map((worktree) => [worktree.taskId, worktree]));

  for (const task of tasks) {
    if (task.worktreeId) continue;
    const session = task.sessionId ? sessionsById.get(task.sessionId) : null;
    const project = projectsById.get(task.projectId);
    if (!session?.cwd || !project || session.cwd === project.repoPath) continue;

    const existing = worktreesByTaskId.get(task.id);
    if (existing) {
      await store.updateTask(task.id, { worktreeId: existing.id });
      if (session.worktreeId !== existing.id) await store.updateSession(session.id, { worktreeId: existing.id });
      continue;
    }

    const branch = await run("git", ["branch", "--show-current"], { cwd: session.cwd });
    const worktree = await store.createWorktree({
      projectId: project.id,
      taskId: task.id,
      path: session.cwd,
      branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : basename(session.cwd),
      title: task.title || session.name || "agent task",
      agent: task.agent || session.agent,
      status: task.status as Worktree["status"] || "created"
    });
    await store.updateTask(task.id, { worktreeId: worktree.id });
    await store.updateSession(session.id, { worktreeId: worktree.id });
  }
}

export async function browseDirectory(inputPath: unknown) {
  const currentPath = resolve(String(inputPath || "") || homedir());
  const currentStat = await stat(currentPath);
  if (!currentStat.isDirectory()) {
    const error = new Error("Path is not a directory") as HttpError;
    error.status = 400;
    throw error;
  }

  const entries = await readdir(currentPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== ".git")
    .filter((entry) => !entry.name.startsWith("."))
    .slice(0, 300)
    .map((entry) => ({
      name: entry.name,
      path: join(currentPath, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    path: currentPath,
    name: basename(currentPath) || currentPath,
    parentPath: dirname(currentPath) === currentPath ? null : dirname(currentPath),
    isGitRepo: await pathExists(join(currentPath, ".git")),
    roots: [
      { label: "Home", path: homedir() },
      { label: "Workspace", path: join(homedir(), "Workspace") },
      { label: "Documents", path: join(homedir(), "Documents") },
      { label: "Temp", path: tmpdir() }
    ],
    directories
  };
}

export function normalizeProjectPath(inputPath: unknown) {
  const raw = String(inputPath || "").trim();
  return raw ? resolve(raw.replace(/^~(?=$|\/)/, homedir())) : "";
}

export async function readProjectWorkspace(store: Store, fallback: string) {
  const settings = typeof store.getSettings === "function" ? await store.getSettings() : {};
  const path = normalizeProjectPath(settings.defaultWorkspace || fallback);
  return { path };
}

export async function writeProjectWorkspace(store: Store, inputPath: unknown, fallback: string) {
  const path = normalizeProjectPath(inputPath);
  if (!path) throw httpError(400, "workspace path is required");
  await mkdir(path, { recursive: true });
  if (typeof store.updateSettings === "function") {
    await store.updateSettings({ defaultWorkspace: path });
  }
  return readProjectWorkspace(store, fallback);
}

export async function ensureNewProjectRepo(repoPath: string, defaultBranch: string, run: typeof import("./utils.js").runCommandSafe) {
  await mkdir(repoPath, { recursive: true });
  const init = await run("git", ["init"], { cwd: repoPath });
  if (!init.ok) throw httpError(500, init.stderr || init.stdout || "git init failed");
  const branch = await run("git", ["checkout", "-B", defaultBranch], { cwd: repoPath });
  if (!branch.ok) throw httpError(500, branch.stderr || branch.stdout || "git branch initialization failed");
  // A freshly `git init`'d branch is "unborn" - it has no commit, so
  // `git rev-parse <branch>` (used by WorktreeManager.create() for every
  // task's worktree) fails with "ambiguous argument ... unknown revision".
  // Every task on a newly-created project hit this on its very first run.
  // An empty commit gives the branch a real ref to resolve without writing
  // any files into what's meant to be a blank scaffold.
  const commit = await run("git", ["commit", "--allow-empty", "-m", "Initial commit"], { cwd: repoPath });
  if (!commit.ok) throw httpError(500, commit.stderr || commit.stdout || "git initial commit failed");
}

export async function cloneRepo(repoUrl: string, targetPath: string, run: typeof import("./utils.js").runCommandSafe) {
  await mkdir(dirname(targetPath), { recursive: true });
  const clone = await run("git", ["clone", repoUrl, targetPath]);
  if (!clone.ok) throw httpError(500, clone.stderr || clone.stdout || "git clone failed");
}

export async function requireWorktreeAndProject(store: Store, worktreeId: string) {
  const worktree = await store.getWorktree(worktreeId);
  if (!worktree) throw httpError(404, "Worktree not found");
  const project = await store.getProject(worktree.projectId);
  if (!project) throw httpError(404, "Project not found");
  return { worktree, project };
}

export function mergeCheckRuns(existing: unknown, nextRuns: CheckRun[]) {
  const current = Array.isArray(existing) ? existing as CheckRun[] : [];
  return [...current, ...nextRuns];
}

export function defaultCheckCommands(project: Project, requested: unknown) {
  if (Array.isArray(requested)) return requested as string[];
  return Array.isArray(project.testCommands) ? project.testCommands : [];
}
