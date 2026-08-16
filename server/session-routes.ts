import { Router } from "express";
import { getAgentAdapter } from "./agents/registry.js";
import { asyncRoute, httpError, type RouteContext } from "./route-context.js";
import { saveImageAttachments } from "./attachments.js";
import {
  buildSessionSummaryPrompt,
  errorMessage,
  markSessionFailed,
  publishInitialAgentPrompt,
  readSessionLog,
  replayTerminalLog,
  restartSessionWithModel,
  sessionLogPath,
  tmuxName
} from "./session-helpers.js";
import { sessionAcceptsInput } from "./session-monitor.js";
import {
  publishSessionCreated,
  publishSessionDeleted,
  publishSessionInputSent,
  publishSessionKeySent,
  publishSessionStatusChanged,
  publishSessionUpdated
} from "./domain-events.js";
import {
  validate,
  createSessionBody,
  updateSessionBody,
  sessionInputBody,
  sessionKeyBody,
  sessionSummarizeBody
} from "./validation.js";
import { makeId } from "./utils.js";
import type { Session } from "./types.js";

export function sessionRoutes(ctx: RouteContext) {
  const { store, tmux, sessionSummaryClient, summaryModel, attachmentRoot, sessionLogRoot } = ctx;
  const router = Router();

  router.get("/api/sessions", asyncRoute(async (_req, res) => {
    res.json({ sessions: await store.listSessions(), tmuxSessions: await tmux.listSessions() });
  }));

  router.post("/api/sessions", validate(createSessionBody), asyncRoute(async (req, res) => {
    const project = req.body.projectId ? await store.getProject(req.body.projectId) : null;
    if (req.body.projectId && !project) return res.status(404).json({ error: "Project not found" });
    const cwd = req.body.cwd || project?.repoPath || process.cwd();
    const agent = req.body.agent || project?.defaultAgent || "shell";
    const adapter = getAgentAdapter(agent);
    const name = req.body.name || `${agent} session`;
    const tmuxSessionName = req.body.tmuxSessionName || tmuxName("sess", name);
    const model = String(req.body.model || "").trim();
    const prompt = String(req.body.prompt || "").trim();
    const sessionId = makeId("sess");
    const logPath = sessionLogPath(sessionLogRoot, sessionId);
    await tmux.startSession({ name: tmuxSessionName, cwd, command: adapter.buildLaunchCommand({ prompt, model }), logPath });
    const session = await store.createSession({
      id: sessionId,
      projectId: project?.id ?? null,
      worktreeId: req.body.worktreeId ?? null,
      name,
      agent,
      model: model || null,
      prompt,
      tmuxSessionName,
      cwd,
      logPath,
      status: "running"
    });
    await publishSessionCreated(ctx, project?.id, session.id, agent, tmuxSessionName);
    await publishInitialAgentPrompt({ store, bus: ctx.bus, session, text: prompt });
    res.status(201).json({ session });
  }));

  router.get("/api/sessions/:sessionId/output", asyncRoute(async (req, res) => {
    const session = await store.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });
    let output: string;
    try {
      output = await tmux.capture(session.tmuxSessionName, Number(req.query.lines || 200));
      await store.updateSession(session.id, { lastOutputAt: new Date().toISOString() });
    } catch (error) {
      const reason = errorMessage(error);
      const logOutput = await replayTerminalLog(await readSessionLog(session.logPath));
      output = logOutput || `capture unavailable: ${reason}`;
      const isTerminal = ["failed", "killed", "completed", "merged", "cancelled"].includes(String(session.status));
      if (!isTerminal) {
        if (logOutput) {
          await store.updateSession(session.id, { status: "completed", lastOutputAt: new Date().toISOString() });
        } else {
          await markSessionFailed({ store, bus: ctx.bus, session, reason });
        }
      }
    }
    res.json({ output, logPath: session.logPath || null });
  }));

  router.post("/api/sessions/:sessionId/summarize", validate(sessionSummarizeBody), asyncRoute(async (req, res) => {
    const session = await store.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });
    const requestedLines = Number(req.body?.lines || 600);
    const lines = Number.isFinite(requestedLines) ? Math.min(Math.max(requestedLines, 100), 2000) : 600;
    const prompt = await buildSessionSummaryPrompt({ store, tmux, run: ctx.run, session, lines });
    const text = await sessionSummaryClient.summarize({ model: summaryModel, prompt });
    const generatedAt = new Date().toISOString();
    const summary = { text, model: summaryModel, generatedAt };
    const updated = await store.updateSession(session.id, { summary, summaryUpdatedAt: generatedAt });
    await publishSessionUpdated(ctx, session, { summaryUpdatedAt: generatedAt });
    res.json({ summary, session: updated });
  }));

  router.patch("/api/sessions/:sessionId", validate(updateSessionBody), asyncRoute(async (req, res) => {
    const session = await store.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });
    const updates: Partial<Session> = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "model")) {
      updates.model = String(req.body.model || "").trim() || null;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No session updates provided" });
    }
    const adapter = getAgentAdapter(session.agent);
    const shouldRestart = session.status === "running" && adapter.id !== "shell" && Object.prototype.hasOwnProperty.call(updates, "model");
    const updated = shouldRestart
      ? await restartSessionWithModel({ store, bus: ctx.bus, tmux, session: { ...session, ...updates }, model: updates.model ?? null, sessionLogRoot })
      : await store.updateSession(session.id, updates);
    await publishSessionUpdated(ctx, session, updates as Record<string, unknown>);
    res.json({ session: updated });
  }));

  router.post("/api/sessions/:sessionId/input", validate(sessionInputBody), asyncRoute(async (req, res) => {
    const session = await store.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!sessionAcceptsInput(session.status)) {
      return res.status(409).json({ error: `Session is not accepting input: ${session.status}` });
    }
    const attachments = await saveImageAttachments(req.body.attachments, attachmentRoot);
    const adapter = getAgentAdapter(session.agent);
    const input = adapter.formatInput({ text: req.body.text, attachments });
    if (!input) return res.status(400).json({ error: "text or image attachment is required" });
    await tmux.sendInput(session.tmuxSessionName, input);
    await publishSessionInputSent(ctx, session, String(req.body.text || "").trim(), attachments);
    res.json({ ok: true });
  }));

  router.post("/api/sessions/:sessionId/key", validate(sessionKeyBody), asyncRoute(async (req, res) => {
    const session = await store.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!sessionAcceptsInput(session.status)) {
      return res.status(409).json({ error: `Session is not accepting input: ${session.status}` });
    }
    await tmux.sendKey(session.tmuxSessionName, req.body.key || "Enter");
    await publishSessionKeySent(ctx, session, req.body.key || "Enter");
    res.json({ ok: true });
  }));

  router.post("/api/sessions/:sessionId/stop", asyncRoute(async (req, res) => {
    const session = await store.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });
    try {
      await tmux.killSession(session.tmuxSessionName);
    } catch {
      // tmux may already be gone
    }
    const updated = await store.updateSession(session.id, { status: "killed" });
    await publishSessionStatusChanged(ctx, session, "killed");
    res.json({ session: updated });
  }));

  router.delete("/api/sessions/:sessionId", asyncRoute(async (req, res) => {
    const session = await store.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.status === "running") {
      try {
        await tmux.killSession(session.tmuxSessionName);
      } catch {
        // tmux may already be gone
      }
    }
    const deleted = await store.deleteSession(session.id);
    await publishSessionDeleted(ctx, session);
    res.json({ ok: true, sessionId: deleted?.id });
  }));

  return router;
}
