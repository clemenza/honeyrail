import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withUnattendedPreamble } from "../agents/common.js";
import { getAgentAdapter, isKnownAgent } from "../agents/registry.js";
import { publishSessionCreated, publishTaskFailed, publishTaskStarted } from "../domain-events.js";
import { publishEvent } from "../events.js";
import {
  errorMessage,
  publishInitialAgentPrompt,
  readSessionLog,
  replayTerminalLog,
  sessionLogPath,
  stripAnsi,
  tmuxName
} from "../session-helpers.js";
import type { AgentType, Session, Task, Worktree } from "../types.js";
import { makeId } from "../utils.js";
import { ConfigError, type ExecutionHandle, type ExecutionState, type Executor, type PreflightContext, type StepExecutionContext } from "./types.js";

function stringInput(value: unknown, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

const QUESTION_TAIL_LINES = 20;

async function captureQuestion(ctx: StepExecutionContext, session: Session): Promise<string> {
  try {
    const output = await ctx.tmux.capture(session.tmuxSessionName, 40);
    return stripAnsi(output).trim().split("\n").slice(-QUESTION_TAIL_LINES).join("\n");
  } catch {
    return "";
  }
}

const CHANGE_TYPE_BY_CODE: Record<string, string> = {
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  M: "modified",
  "?": "untracked"
};

function changeTypeForCode(code: string): string {
  for (const symbol of code) {
    const changeType = CHANGE_TYPE_BY_CODE[symbol];
    if (changeType) return changeType;
  }
  return "modified";
}

type ChangedFile = { path: string; changeType: string; fromPath?: string };

/**
 * `git status --short` porcelain lines look like "XY path" (or
 * "R  old -> new" for renames/copies). Turned into structured
 * path+change-type records so a reviewer (or a downstream evaluator) can
 * consume "what changed" without parsing diff hunks.
 */
function parseChangedFiles(status: string): ChangedFile[] {
  return status
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim())
    .map((line) => {
      const code = line.slice(0, 2);
      const rest = line.slice(3);
      const changeType = changeTypeForCode(code);
      if (changeType === "renamed" || changeType === "copied") {
        const [fromPath, path] = rest.split(" -> ");
        if (path) return { path, changeType, fromPath };
      }
      return { path: rest, changeType };
    });
}

/**
 * agent-task steps otherwise finish with zero Artifacts/Evidence - there's
 * nothing for a reviewer to look at beyond "it succeeded". Capture what the
 * runtime can derive deterministically, without any agent cooperation: the
 * code diff and a structured changed-files list (the primary things anyone
 * reviewing a run cares about), the cleaned session transcript (the
 * reasoning/commands behind it), and the task's completion metadata. Runs
 * once, right when a task is first observed done - inspectActiveSteps()
 * stops polling a step once it returns "succeeded", so this can't
 * double-fire for the same attempt. Each harvest is independently
 * best-effort: a missing worktree/session or a git failure here is logged
 * but must not turn a genuinely successful task into a failed step.
 */
async function recordCompletionArtifacts(ctx: StepExecutionContext, task: Task): Promise<void> {
  const attemptDir = join(ctx.attachmentRoot, "runs", ctx.runId, ctx.step.id, `attempt-${ctx.step.attempt}`);

  async function saveEvidence(input: {
    kind: string;
    claim: string;
    value?: Record<string, unknown>;
    artifactIds?: string[];
  }): Promise<void> {
    const evidence = await ctx.store.createEvidence({
      runId: ctx.runId,
      stepId: ctx.step.id,
      attempt: ctx.step.attempt,
      kind: input.kind,
      claim: input.claim,
      source: "agent-task",
      artifactIds: input.artifactIds,
      value: input.value
    });
    await publishEvent(ctx.store, ctx.bus, {
      type: "evidence.recorded",
      projectId: ctx.project.id,
      payload: { runId: ctx.runId, stepId: ctx.step.id, evidenceId: evidence.id, kind: evidence.kind, claim: evidence.claim }
    });
  }

  async function saveArtifact(input: {
    name: string;
    content: string;
    kind?: "text" | "json";
    mediaType: string;
    artifactType?: string;
    metadata?: Record<string, unknown>;
    evidence: { kind: string; claim: string; value?: Record<string, unknown> };
  }): Promise<void> {
    if (!input.content.trim()) return;
    await mkdir(attemptDir, { recursive: true });
    const path = join(attemptDir, input.name);
    await writeFile(path, input.content);
    const artifact = await ctx.store.createArtifact({
      runId: ctx.runId,
      stepId: ctx.step.id,
      attempt: ctx.step.attempt,
      kind: input.kind || "text",
      name: input.name,
      path,
      uri: `honeyrail://runs/${ctx.runId}/steps/${ctx.step.id}/attempts/${ctx.step.attempt}/${input.name}`,
      mediaType: input.mediaType,
      artifactType: input.artifactType,
      metadata: input.metadata
    });
    await publishEvent(ctx.store, ctx.bus, {
      type: "artifact.created",
      projectId: ctx.project.id,
      payload: { runId: ctx.runId, stepId: ctx.step.id, artifactId: artifact.id, kind: artifact.kind, name: artifact.name }
    });
    await saveEvidence({ kind: input.evidence.kind, claim: input.evidence.claim, value: input.evidence.value, artifactIds: [artifact.id] });
  }

  if (task.worktreeId) {
    try {
      const worktree = await ctx.store.getWorktree(task.worktreeId);
      if (worktree) {
        const { diff, diffStat, status } = await ctx.worktrees.diff(worktree);
        const statLine = diffStat.trim().split("\n").filter(Boolean).pop();
        await saveArtifact({
          name: "changes.diff",
          content: diff,
          mediaType: "text/x-diff",
          artifactType: "diff",
          metadata: { diffStat, status },
          evidence: {
            kind: "agent.diff",
            claim: statLine ? `Agent changed: ${statLine}` : "Agent produced a code diff",
            value: { diffStat, status }
          }
        });

        const changedFiles = parseChangedFiles(status);
        if (changedFiles.length) {
          await saveArtifact({
            name: "changed_files.json",
            content: JSON.stringify(changedFiles, null, 2),
            kind: "json",
            mediaType: "application/json",
            artifactType: "changed_files",
            metadata: { count: changedFiles.length },
            evidence: {
              kind: "agent.changed_files",
              claim: `Agent touched ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}`,
              value: { count: changedFiles.length }
            }
          });
        }
      }
    } catch (error) {
      // A diff failure (e.g. worktree already merged/discarded) shouldn't
      // turn a completed task into a failed step.
      console.error(`agent-task ${ctx.step.id}: failed to capture diff/changed-files artifacts:`, error);
    }
  }

  if (task.sessionId) {
    try {
      const session = await ctx.store.getSession(task.sessionId);
      if (session) {
        const transcript = await replayTerminalLog(await readSessionLog(session.logPath));
        await saveArtifact({
          name: "session-transcript.log",
          content: transcript,
          mediaType: "text/plain",
          evidence: { kind: "agent.transcript", claim: "Agent session transcript captured" }
        });
      }
    } catch (error) {
      // Same reasoning as above - transcript capture is supplementary.
      console.error(`agent-task ${ctx.step.id}: failed to capture session transcript artifact:`, error);
    }
  }

  try {
    await saveEvidence({
      kind: "agent.completion",
      claim: `Task finished with status "${task.status}"`,
      value: {
        taskId: task.id,
        taskStatus: task.status,
        agent: task.agent,
        worktreeId: task.worktreeId,
        sessionId: task.sessionId,
        headRevision: task.headRevision,
        completedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    // Completion metadata is supplementary - a store failure here shouldn't
    // turn a genuinely successful task into a failed step either.
    console.error(`agent-task ${ctx.step.id}: failed to record completion metadata evidence:`, error);
  }
}

async function taskStateToExecution(ctx: StepExecutionContext, task: Task | undefined): Promise<ExecutionState> {
  if (!task) return { status: "failed", error: "Linked task disappeared" };
  if (task.status === "failed" || task.status === "cancelled") {
    return { status: task.status === "cancelled" ? "cancelled" : "failed", error: task.error };
  }
  if (task.status === "done" || task.status === "merged" || task.status === "ready_to_merge") {
    await recordCompletionArtifacts(ctx, task);
    return { status: "succeeded", output: { taskStatus: task.status, taskId: task.id, worktreeId: task.worktreeId, sessionId: task.sessionId } };
  }
  const baseOutput = { taskStatus: task.status, taskId: task.id, worktreeId: task.worktreeId, sessionId: task.sessionId };
  if (task.status === "agent_running" && task.sessionId) {
    const session = await ctx.store.getSession(task.sessionId);
    if (session?.status === "waiting_input" || session?.status === "waiting_approval") {
      const question = await captureQuestion(ctx, session);
      return { status: session.status, output: { ...baseOutput, question } };
    }
  }
  return { status: "running", output: baseOutput };
}

export class AgentTaskExecutor implements Executor {
  type = "agent-task";
  // recordCompletionArtifacts() above harvests these unconditionally on
  // success whenever the underlying worktree actually changed - so a
  // downstream step can `consumes: [diff]`/`[changed_files]` without this
  // step's recipe entry having to redundantly declare `produces` for them.
  producesTypes = ["diff", "changed_files"];

  async preflight(ctx: PreflightContext): Promise<void> {
    const agent = stringInput(ctx.step.input?.agent, ctx.project.defaultAgent || "codex");
    if (!isKnownAgent(agent)) {
      throw new ConfigError(`agent-task step "${ctx.step.id}" references unknown agent backend "${agent}"`);
    }
    const adapter = getAgentAdapter(agent);
    if (!adapter.detectInstallation) return;
    const status = await adapter.detectInstallation(ctx.runCommand);
    if (!status.available) {
      throw new ConfigError(
        `agent-task step "${ctx.step.id}" references agent "${agent}", which doctor-style detection could not find on this host${status.detail ? ` (${status.detail})` : ""}`
      );
    }
  }

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const agent = stringInput(ctx.step.input.agent, ctx.project.defaultAgent || "codex") as AgentType;
    const adapter = getAgentAdapter(agent);
    const title = stringInput(ctx.step.input.title, ctx.step.name || "Agent task");
    // A retry after the agent stopped to ask a clarifying question runs with
    // an enriched prompt (see enrichRetryInput in orchestration/service.ts)
    // telling it not to ask again; the original prompt is kept in step.input
    // untouched so the UI can still show it.
    const prompt = stringInput(ctx.step.input.effectivePrompt) || stringInput(ctx.step.input.prompt, title);
    const model = stringInput(ctx.step.input.model);
    // agent-task steps are always run-launched, so "autonomous" (no
    // clarifying questions) is the default; a step can opt into
    // "interactive" explicitly if it truly needs a human at the terminal.
    const interaction = ctx.step.input.interaction === "interactive" ? "interactive" : "autonomous";
    const unattended = interaction === "autonomous";
    const launchPrompt = unattended ? withUnattendedPreamble(prompt) : prompt;
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
        command: adapter.buildLaunchCommand({ prompt: launchPrompt, model, unattended }),
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
    return taskStateToExecution(ctx, task);
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
