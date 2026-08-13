import { Router } from "express";
import { getAgentAdapter } from "./agents/registry.js";
import { asyncRoute, httpError, type HttpError, type RouteContext } from "./route-context.js";
import { saveImageAttachments } from "./attachments.js";
import {
  errorMessage,
  publishInitialAgentPrompt,
  sessionLogPath,
  tmuxName
} from "./session-helpers.js";
import { publishSessionCreated, publishTaskFailed, publishTaskStarted } from "./domain-events.js";
import { validate, createTaskBody } from "./validation.js";
import { makeId } from "./utils.js";
import type { Session, Worktree } from "./types.js";

export function taskRoutes(ctx: RouteContext) {
  const { store, tmux, worktrees, attachmentRoot, sessionLogRoot } = ctx;
  const router = Router();

  router.get("/api/tasks", asyncRoute(async (_req, res) => {
    res.json({ tasks: await store.listTasks() });
  }));

  router.post("/api/tasks", validate(createTaskBody), asyncRoute(async (req, res) => {
    const project = await store.getProject(req.body.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const agent = req.body.agent || project.defaultAgent || "codex";
    const adapter = getAgentAdapter(agent);
    const title = req.body.title || "Agent task";
    const attachments = await saveImageAttachments(req.body.attachments, attachmentRoot);
    const task = await store.createTask({
      projectId: project.id,
      title,
      prompt: req.body.prompt || title,
      agent,
      status: "worktree_preparing"
    });
    let worktree: Worktree | null = null;
    let session: Session | null = null;
    try {
      const createdWorktree = await worktrees.create({ project, title, agent });
      worktree = await store.createWorktree({ ...createdWorktree, taskId: task.id } as Partial<Worktree>);
      const tmuxSessionName = tmuxName("task", title);
      const model = String(req.body.model || "").trim();
      const sessionId = makeId("sess");
      const logPath = sessionLogPath(sessionLogRoot, sessionId);
      const initialAgentInput = adapter.formatInput({ text: task.prompt || title, attachments });
      await tmux.startSession({
        name: tmuxSessionName,
        cwd: worktree.path,
        command: adapter.buildLaunchCommand({ prompt: initialAgentInput, model }),
        logPath
      });
      session = await store.createSession({
        id: sessionId,
        projectId: project.id,
        worktreeId: worktree.id,
        taskId: task.id,
        name: title,
        agent,
        model: model || null,
        prompt: task.prompt,
        tmuxSessionName,
        cwd: worktree.path,
        logPath,
        status: "running"
      });
      await publishSessionCreated(ctx, project.id, session.id, agent, tmuxSessionName);
      await publishInitialAgentPrompt({ store, bus: ctx.bus, session, text: task.prompt || title, attachments });
      const updatedTask = await store.updateTask(task.id, {
        worktreeId: worktree.id,
        sessionId: session.id,
        status: "agent_running"
      });
      await publishTaskStarted(ctx, project.id, session.id, task.id, title, agent, worktree.path);
      res.status(201).json({ task: updatedTask, worktree, session });
    } catch (error) {
      const reason = errorMessage(error);
      const failedAt = new Date().toISOString();
      const failedTask = await store.updateTask(task.id, {
        worktreeId: worktree?.id,
        sessionId: session?.id,
        status: "failed",
        failedAt,
        error: reason
      });
      if (worktree?.id) await store.updateWorktree(worktree.id, { status: "failed", failedAt, error: reason });
      if (session?.id) await store.updateSession(session.id, { status: "failed", lastOutputAt: failedAt, error: reason });
      await publishTaskFailed(ctx, project.id, session?.id, task.id, title, agent, worktree?.id, reason);
      const failure = httpError((error as HttpError).status || 500, reason);
      (failure as HttpError & { task: unknown }).task = failedTask;
      throw failure;
    }
  }));

  return router;
}
