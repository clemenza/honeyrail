import { getAgentAdapter } from "../agents/registry.js";
import { publishSessionCreated, publishTaskFailed, publishTaskStarted } from "../domain-events.js";
import {
  errorMessage,
  publishInitialAgentPrompt,
  sessionLogPath,
  tmuxName
} from "../session-helpers.js";
import type { AgentType, Session, Task, Worktree } from "../types.js";
import { makeId } from "../utils.js";
import type { ExecutionHandle, ExecutionState, Executor, StepExecutionContext } from "./types.js";

function stringInput(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function taskStateToExecution(task: Task | undefined): ExecutionState {
  if (!task) return { status: "failed", error: "Linked task disappeared" };
  if (task.status === "failed" || task.status === "cancelled") {
    return { status: task.status === "cancelled" ? "cancelled" : "failed", error: task.error };
  }
  if (task.status === "done" || task.status === "merged" || task.status === "ready_to_merge") {
    return { status: "succeeded", output: { taskStatus: task.status, taskId: task.id, worktreeId: task.worktreeId, sessionId: task.sessionId } };
  }
  return { status: "running", output: { taskStatus: task.status, taskId: task.id, worktreeId: task.worktreeId, sessionId: task.sessionId } };
}

export class AgentTaskExecutor implements Executor {
  type = "agent-task";

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const agent = stringInput(ctx.step.input.agent, ctx.project.defaultAgent || "codex") as AgentType;
    const adapter = getAgentAdapter(agent);
    const title = stringInput(ctx.step.input.title, ctx.step.name || "Agent task");
    const prompt = stringInput(ctx.step.input.prompt, title);
    const model = stringInput(ctx.step.input.model);
    const task = await ctx.store.createTask({
      projectId: ctx.project.id,
      title,
      prompt,
      agent,
      status: "worktree_preparing"
    });
    let worktree: Worktree | null = null;
    let session: Session | null = null;
    try {
      const createdWorktree = await ctx.worktrees.create({ project: ctx.project, title, agent });
      worktree = await ctx.store.createWorktree({ ...createdWorktree, taskId: task.id } as Partial<Worktree>);
      const tmuxSessionName = tmuxName("task", title);
      const sessionId = makeId("sess");
      const logPath = sessionLogPath(ctx.sessionLogRoot, sessionId);
      await ctx.tmux.startSession({
        name: tmuxSessionName,
        cwd: worktree.path,
        command: adapter.buildLaunchCommand({ prompt, model }),
        logPath
      });
      session = await ctx.store.createSession({
        id: sessionId,
        projectId: ctx.project.id,
        worktreeId: worktree.id,
        taskId: task.id,
        name: title,
        agent,
        model: model || null,
        prompt,
        tmuxSessionName,
        cwd: worktree.path,
        logPath,
        status: "running"
      });
      await publishSessionCreated(ctx, ctx.project.id, session.id, agent, tmuxSessionName);
      await publishInitialAgentPrompt({ store: ctx.store, bus: ctx.bus, session, text: prompt });
      const updatedTask = await ctx.store.updateTask(task.id, {
        worktreeId: worktree.id,
        sessionId: session.id,
        status: "agent_running"
      });
      await publishTaskStarted(ctx, ctx.project.id, session.id, task.id, title, agent, worktree.path);
      return {
        taskId: task.id,
        sessionId: session.id,
        worktreeId: worktree.id,
        taskStatus: updatedTask?.status || "agent_running"
      };
    } catch (error) {
      const reason = errorMessage(error);
      const failedAt = new Date().toISOString();
      await ctx.store.updateTask(task.id, {
        worktreeId: worktree?.id,
        sessionId: session?.id,
        status: "failed",
        failedAt,
        error: reason
      });
      if (worktree?.id) await ctx.store.updateWorktree(worktree.id, { status: "failed", failedAt, error: reason });
      if (session?.id) await ctx.store.updateSession(session.id, { status: "failed", lastOutputAt: failedAt, error: reason });
      await publishTaskFailed(ctx, ctx.project.id, session?.id, task.id, title, agent, worktree?.id, reason);
      throw error;
    }
  }

  async inspect(ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState> {
    const taskId = String(handle.taskId || "");
    const task = taskId ? await ctx.store.getTask(taskId) : undefined;
    return taskStateToExecution(task);
  }

  async cancel(ctx: StepExecutionContext, handle: ExecutionHandle): Promise<void> {
    const sessionId = String(handle.sessionId || "");
    const taskId = String(handle.taskId || "");
    const worktreeId = String(handle.worktreeId || "");
    const cancelledAt = new Date().toISOString();
    if (sessionId) {
      const session = await ctx.store.getSession(sessionId);
      if (session?.tmuxSessionName) {
        try {
          await ctx.tmux.killSession(session.tmuxSessionName);
        } catch {
          // Existing session lifecycle treats missing tmux as already stopped.
        }
        await ctx.store.updateSession(session.id, { status: "killed", error: "Run cancelled" });
      }
    }
    if (taskId) await ctx.store.updateTask(taskId, { status: "cancelled", cancelledAt, error: "Run cancelled" });
    if (worktreeId) await ctx.store.updateWorktree(worktreeId, { status: "failed", failedAt: cancelledAt, error: "Run cancelled" });
  }
}
