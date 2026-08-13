import { Router } from "express";
import { basename, join } from "node:path";
import { asyncRoute, httpError, type RouteContext } from "./route-context.js";
import {
  browseDirectory,
  cloneRepo,
  ensureNewProjectRepo,
  gitSummary,
  normalizeProjectPath,
  readProjectWorkspace,
  writeProjectWorkspace
} from "./project-helpers.js";
import { publishProjectCreated, publishProjectUnregistered } from "./domain-events.js";
import { validate, updateWorkspaceBody, createProjectBody } from "./validation.js";
import { slugify } from "./utils.js";

export function projectRoutes(ctx: RouteContext) {
  const { store, run, defaultWorkspace } = ctx;
  const router = Router();

  router.get("/api/filesystem/browse", asyncRoute(async (req, res) => {
    res.json(await browseDirectory(req.query.path));
  }));

  router.get("/api/projects", asyncRoute(async (_req, res) => {
    const projects = await store.listProjects();
    const enriched = await Promise.all(projects.map(async (project) => ({
      ...project,
      git: await gitSummary(project, run)
    })));
    res.json({ projects: enriched });
  }));

  router.get("/api/projects/workspace", asyncRoute(async (_req, res) => {
    res.json({ workspace: await readProjectWorkspace(store, defaultWorkspace) });
  }));

  router.put("/api/projects/workspace", validate(updateWorkspaceBody), asyncRoute(async (req, res) => {
    res.json({ workspace: await writeProjectWorkspace(store, req.body.path, defaultWorkspace) });
  }));

  router.post("/api/projects", validate(createProjectBody), asyncRoute(async (req, res) => {
    const create = Boolean(req.body.create);
    const githubRepoUrl = String(req.body.githubRepoUrl || "").trim();
    const defaultBranch = req.body.defaultBranch || "main";
    const workspace = await readProjectWorkspace(store, defaultWorkspace);
    const requestedPath = normalizeProjectPath(req.body.repoPath);
    const requestedName = String(req.body.name || "").trim();
    let repoPath: string;
    if (create) {
      if (githubRepoUrl) {
        const repoName = githubRepoUrl.split("/").at(-1)?.replace(/\.git$/, "") || slugify(requestedName) || "repo";
        repoPath = requestedPath || join(workspace.path, repoName);
        await cloneRepo(githubRepoUrl, repoPath, run);
      } else {
        repoPath = requestedPath || (requestedName ? join(workspace.path, slugify(requestedName)) : "");
        if (!repoPath) return res.status(400).json({ error: "name or repoPath is required" });
        await ensureNewProjectRepo(repoPath, defaultBranch, run);
      }
    } else {
      repoPath = requestedPath;
      if (!repoPath) return res.status(400).json({ error: "repoPath is required" });
    }
    const branch = await run("git", ["branch", "--show-current"], { cwd: repoPath });
    const project = await store.createProject({
      name: req.body.name || basename(repoPath),
      repoPath,
      defaultBranch: req.body.defaultBranch || (branch.ok && branch.stdout.trim()) || "main",
      defaultAgent: req.body.defaultAgent || "codex",
      testCommands: req.body.testCommands || [],
      runCommands: req.body.runCommands || []
    });
    await publishProjectCreated(ctx, project.id, project.name);
    res.status(201).json({ project });
  }));

  router.delete("/api/projects/:projectId", asyncRoute(async (req, res) => {
    const project = await store.getProject(String(req.params.projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const deleted = await store.deleteProject(project.id);
    await publishProjectUnregistered(ctx, project.id, project.name, project.repoPath);
    res.json({ ok: true, projectId: deleted?.id });
  }));

  return router;
}
