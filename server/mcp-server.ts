import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAgentAdapter } from "./agents/registry.js";
import type { EventBus } from "./events.js";
import type { TmuxManager } from "./tmux.js";
import type { Store } from "./types.js";
import type { WorktreeManager } from "./worktrees.js";
import type { runCommandSafe as RunCommandSafe } from "./utils.js";
import { makeId } from "./utils.js";
import { gitSummary, defaultCheckCommands, mergeCheckRuns, requireWorktreeAndProject } from "./project-helpers.js";
import {
  errorMessage,
  publishInitialAgentPrompt,
  sessionLogPath,
  tmuxName,
  readSessionLog,
  markSessionFailed
} from "./session-helpers.js";
import { sessionAcceptsInput } from "./session-monitor.js";
import {
  publishProjectCreated,
  publishSessionCreated,
  publishSessionInputSent,
  publishSessionStatusChanged,
  publishSessionDeleted,
  publishTaskStarted,
  publishTaskFailed,
  publishWorktreeCreated,
  publishWorktreeCommitted,
  publishWorktreeCheckResult,
  publishWorktreeMerged
} from "./domain-events.js";

export type McpContext = {
  store: Store;
  bus: EventBus;
  tmux: TmuxManager;
  worktrees: WorktreeManager;
  run: typeof RunCommandSafe;
  sessionLogRoot: string;
  attachmentRoot: string;
};

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

export function createMcpServer(ctx: McpContext): McpServer {
  const { store, bus, tmux, worktrees, run, sessionLogRoot } = ctx;
  const server = new McpServer({
    name: "codex-remote-controller",
    version: "0.1.0"
  });

  // ── list_projects ──────────────────────────────────────────────
  server.tool(
    "list_projects",
    "List all registered projects with git status",
    {},
    async () => {
      const projects = await store.listProjects();
      const enriched = await Promise.all(
        projects.map(async (project) => ({
          ...project,
          git: await gitSummary(project, run)
        }))
      );
      return json({ projects: enriched });
    }
  );

  // ── create_project ─────────────────────────────────────────────
  server.tool(
    "create_project",
    "Register an existing git repository as a project",
    {
      name: z.string().describe("Project display name"),
      repoPath: z.string().describe("Absolute path to the git repository"),
      defaultBranch: z.string().optional().describe("Default branch name (defaults to 'main')"),
      defaultAgent: z.enum(["shell", "codex", "claude", "hermes"]).optional().describe("Default agent type"),
      testCommands: z.array(z.string()).optional().describe("Commands to run for checks (e.g. ['npm test'])")
    },
    async ({ name, repoPath, defaultBranch, defaultAgent, testCommands }) => {
      const branch = await run("git", ["branch", "--show-current"], { cwd: repoPath });
      const project = await store.createProject({
        name,
        repoPath,
        defaultBranch: defaultBranch || (branch.ok && branch.stdout.trim()) || "main",
        defaultAgent: defaultAgent || "codex",
        testCommands: testCommands || [],
        runCommands: []
      });
      await publishProjectCreated({ store, bus }, project.id, project.name);
      return json({ project });
    }
  );

  // ── list_sessions ──────────────────────────────────────────────
  server.tool(
    "list_sessions",
    "List all agent sessions with their current status",
    {
      projectId: z.string().optional().describe("Filter by project ID")
    },
    async ({ projectId }) => {
      let sessions = await store.listSessions();
      if (projectId) {
        sessions = sessions.filter((s) => s.projectId === projectId);
      }
      return json({ sessions });
    }
  );

  // ── create_session ─────────────────────────────────────────────
  server.tool(
    "create_session",
    "Create a standalone agent session (not tied to a task/worktree)",
    {
      projectId: z.string().optional().describe("Project ID to associate with"),
      agent: z.enum(["shell", "codex", "claude", "hermes"]).optional().describe("Agent type (default: shell)"),
      prompt: z.string().optional().describe("Initial prompt for the agent"),
      model: z.string().optional().describe("Model override for the agent"),
      name: z.string().optional().describe("Session display name")
    },
    async ({ projectId, agent: agentInput, prompt, model, name: nameInput }) => {
      const project = projectId ? await store.getProject(projectId) : null;
      if (projectId && !project) return text("Error: Project not found");
      const cwd = project?.repoPath || process.cwd();
      const agent = agentInput || project?.defaultAgent || "shell";
      const adapter = getAgentAdapter(agent);
      const name = nameInput || `${agent} session`;
      const tmuxSessionName = tmuxName("sess", name);
      const sessionId = makeId("sess");
      const logPath = sessionLogPath(sessionLogRoot, sessionId);
      const normalizedModel = String(model || "").trim();
      const normalizedPrompt = String(prompt || "").trim();

      await tmux.startSession({
        name: tmuxSessionName,
        cwd,
        command: adapter.buildLaunchCommand({ prompt: normalizedPrompt, model: normalizedModel }),
        logPath
      });
      const session = await store.createSession({
        id: sessionId,
        projectId: project?.id ?? null,
        name,
        agent,
        model: normalizedModel || null,
        prompt: normalizedPrompt,
        tmuxSessionName,
        cwd,
        logPath,
        status: "running"
      });
      await publishSessionCreated({ store, bus }, project?.id, session.id, agent, tmuxSessionName);
      await publishInitialAgentPrompt({ store, bus, session, text: normalizedPrompt });
      return json({ session });
    }
  );

  // ── get_session_output ─────────────────────────────────────────
  server.tool(
    "get_session_output",
    "Get recent terminal output from a session (tail)",
    {
      sessionId: z.string().describe("Session ID"),
      lines: z.number().optional().describe("Number of lines to capture (default: 200)")
    },
    async ({ sessionId, lines }) => {
      const session = await store.getSession(sessionId);
      if (!session) return text("Error: Session not found");
      let output: string;
      try {
        output = await tmux.capture(session.tmuxSessionName, lines || 200);
        await store.updateSession(session.id, { lastOutputAt: new Date().toISOString() });
      } catch (error) {
        const reason = errorMessage(error);
        const logOutput = await readSessionLog(session.logPath);
        output = logOutput
          ? `${logOutput}\n\ncapture unavailable: ${reason}`
          : `capture unavailable: ${reason}`;
        await markSessionFailed({ store, bus, session, reason });
      }
      return text(output);
    }
  );

  // ── send_session_input ─────────────────────────────────────────
  server.tool(
    "send_session_input",
    "Send text input or follow-up to a running session",
    {
      sessionId: z.string().describe("Session ID"),
      text: z.string().describe("Text to send to the session")
    },
    async ({ sessionId, text: inputText }) => {
      const session = await store.getSession(sessionId);
      if (!session) return text("Error: Session not found");
      if (!sessionAcceptsInput(session.status)) {
        return text(`Error: Session is not accepting input (status: ${session.status})`);
      }
      await tmux.sendInput(session.tmuxSessionName, inputText);
      await publishSessionInputSent({ store, bus }, session, inputText);
      return json({ ok: true, sessionId: session.id });
    }
  );

  // ── stop_session ───────────────────────────────────────────────
  server.tool(
    "stop_session",
    "Stop a running session by killing its tmux process",
    {
      sessionId: z.string().describe("Session ID to stop")
    },
    async ({ sessionId }) => {
      const session = await store.getSession(sessionId);
      if (!session) return text("Error: Session not found");
      try {
        await tmux.killSession(session.tmuxSessionName);
      } catch {
        // tmux may already be gone
      }
      const updated = await store.updateSession(session.id, { status: "killed" });
      await publishSessionStatusChanged({ store, bus }, session, "killed");
      return json({ session: updated });
    }
  );

  // ── delete_session ─────────────────────────────────────────────
  server.tool(
    "delete_session",
    "Delete a session record (stops it first if running)",
    {
      sessionId: z.string().describe("Session ID to delete")
    },
    async ({ sessionId }) => {
      const session = await store.getSession(sessionId);
      if (!session) return text("Error: Session not found");
      if (session.status === "running") {
        try {
          await tmux.killSession(session.tmuxSessionName);
        } catch {
          // tmux may already be gone
        }
      }
      await store.deleteSession(session.id);
      await publishSessionDeleted({ store, bus }, session);
      return json({ ok: true, sessionId: session.id });
    }
  );

  // ── create_agent_task ──────────────────────────────────────────
  server.tool(
    "create_agent_task",
    "Create a full agent task: provisions a git worktree, starts an agent session, and begins execution",
    {
      projectId: z.string().describe("Project ID to create the task in"),
      prompt: z.string().describe("Task prompt / instructions for the agent"),
      title: z.string().optional().describe("Short title for the task"),
      agent: z.enum(["shell", "codex", "claude", "hermes"]).optional().describe("Agent type (default: project default)"),
      model: z.string().optional().describe("Model override for the agent")
    },
    async ({ projectId, prompt: taskPrompt, title: titleInput, agent: agentInput, model }) => {
      const project = await store.getProject(projectId);
      if (!project) return text("Error: Project not found");
      const agent = agentInput || project.defaultAgent || "codex";
      const adapter = getAgentAdapter(agent);
      const title = titleInput || "Agent task";
      const task = await store.createTask({
        projectId: project.id,
        title,
        prompt: taskPrompt || title,
        agent,
        status: "worktree_preparing"
      });
      try {
        const createdWorktree = await worktrees.create({ project, title, agent });
        const worktree = await store.createWorktree({
          ...createdWorktree,
          taskId: task.id
        } as Parameters<typeof store.createWorktree>[0]);
        const tmuxSessionName = tmuxName("task", title);
        const normalizedModel = String(model || "").trim();
        const sessionId = makeId("sess");
        const logPath = sessionLogPath(sessionLogRoot, sessionId);
        await tmux.startSession({
          name: tmuxSessionName,
          cwd: worktree.path,
          command: adapter.buildLaunchCommand({ prompt: taskPrompt || title, model: normalizedModel }),
          logPath
        });
        const session = await store.createSession({
          id: sessionId,
          projectId: project.id,
          worktreeId: worktree.id,
          name: title,
          agent,
          model: normalizedModel || null,
          prompt: task.prompt,
          tmuxSessionName,
          cwd: worktree.path,
          logPath,
          status: "running"
        });
        await publishInitialAgentPrompt({ store, bus, session, text: task.prompt || title });
        const updatedTask = await store.updateTask(task.id, {
          worktreeId: worktree.id,
          sessionId: session.id,
          status: "agent_running"
        });
        await publishTaskStarted({ store, bus }, project.id, session.id, task.id, title, agent, worktree.path);
        return json({ task: updatedTask, worktree, session });
      } catch (error) {
        const reason = errorMessage(error);
        const failedAt = new Date().toISOString();
        await store.updateTask(task.id, { status: "failed", failedAt, error: reason });
        await publishTaskFailed({ store, bus }, project.id, undefined, task.id, title, agent, undefined, reason);
        return text(`Error creating task: ${reason}`);
      }
    }
  );

  // ── get_task_status ────────────────────────────────────────────
  server.tool(
    "get_task_status",
    "Get the current status of a task including its linked session and worktree",
    {
      taskId: z.string().describe("Task ID")
    },
    async ({ taskId }) => {
      const task = await store.getTask(taskId);
      if (!task) return text("Error: Task not found");
      const session = task.sessionId ? await store.getSession(task.sessionId) : null;
      const worktree = task.worktreeId ? await store.getWorktree(task.worktreeId) : null;
      return json({ task, session, worktree });
    }
  );

  // ── list_tasks ─────────────────────────────────────────────────
  server.tool(
    "list_tasks",
    "List all tasks with their current status",
    {
      projectId: z.string().optional().describe("Filter by project ID")
    },
    async ({ projectId }) => {
      let tasks = await store.listTasks();
      if (projectId) {
        tasks = tasks.filter((t) => t.projectId === projectId);
      }
      return json({ tasks });
    }
  );

  // ── get_worktree_diff ──────────────────────────────────────────
  server.tool(
    "get_worktree_diff",
    "Get the git diff, file status, and recent commits of a worktree",
    {
      worktreeId: z.string().describe("Worktree ID")
    },
    async ({ worktreeId }) => {
      const worktree = await store.getWorktree(worktreeId);
      if (!worktree) return text("Error: Worktree not found");
      const diff = await worktrees.diff(worktree);
      return json({ worktreeId, branch: worktree.branch, ...diff });
    }
  );

  // ── run_checks ─────────────────────────────────────────────────
  server.tool(
    "run_checks",
    "Run test/check commands on a worktree (uses project's configured testCommands by default)",
    {
      worktreeId: z.string().describe("Worktree ID to run checks on"),
      commands: z.array(z.string()).optional().describe("Override check commands (defaults to project testCommands)")
    },
    async ({ worktreeId, commands: requestedCommands }) => {
      const { worktree, project } = await requireWorktreeAndProject(store, worktreeId);
      const commands = defaultCheckCommands(project, requestedCommands);
      if (!commands.length) return text("Error: No check commands configured for this project");
      const result = await worktrees.runChecks({ worktree, commands });
      const checkedAt = new Date().toISOString();
      const checkRuns = mergeCheckRuns(worktree.checkRuns, result.runs);
      const updatedWorktree = await store.updateWorktree(worktree.id, {
        status: result.ok ? "checks_passed" : "checks_failed",
        checkedAt,
        checkRuns
      });
      if (worktree.taskId) {
        const existingTask = await store.getTask(worktree.taskId);
        await store.updateTask(worktree.taskId, {
          status: result.ok ? "ready_to_merge" : "checks_failed",
          checkedAt,
          checkRuns: mergeCheckRuns(existingTask?.checkRuns, result.runs)
        });
      }
      await publishWorktreeCheckResult({ store, bus }, result.ok, project.id, worktree.taskId, worktree.id, commands);
      return json({
        ok: result.ok,
        worktree: updatedWorktree,
        checkRuns: result.runs
      });
    }
  );

  // ── commit_worktree ────────────────────────────────────────────
  server.tool(
    "commit_worktree",
    "Stage all changes and commit in a worktree",
    {
      worktreeId: z.string().describe("Worktree ID"),
      message: z.string().optional().describe("Commit message (auto-generated if omitted)")
    },
    async ({ worktreeId, message }) => {
      const { worktree, project } = await requireWorktreeAndProject(store, worktreeId);
      const commit = await worktrees.commit({ worktree, message });
      const committedAt = new Date().toISOString();
      const updatedWorktree = await store.updateWorktree(worktree.id, {
        status: "committed",
        committedAt,
        headRevision: commit.headRevision,
        commit
      });
      if (worktree.taskId) {
        await store.updateTask(worktree.taskId, {
          status: "ready_to_merge",
          committedAt,
          headRevision: commit.headRevision
        });
      }
      await publishWorktreeCommitted({ store, bus }, project.id, worktree.taskId, worktree.id, worktree.branch, commit.headRevision);
      return json({ ok: true, worktree: updatedWorktree, commit });
    }
  );

  // ── propose_merge ──────────────────────────────────────────────
  server.tool(
    "propose_merge",
    "Preview what a worktree merge would do — returns diff summary, check status, and branch info. Does NOT actually merge. Use approve_merge to execute.",
    {
      worktreeId: z.string().describe("Worktree ID to preview merge for")
    },
    async ({ worktreeId }) => {
      const { worktree, project } = await requireWorktreeAndProject(store, worktreeId);
      const diff = await worktrees.diff(worktree);
      const task = worktree.taskId ? await store.getTask(worktree.taskId) : null;
      return json({
        proposal: {
          worktreeId: worktree.id,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          targetBranch: project.defaultBranch,
          status: worktree.status,
          taskStatus: task?.status || null,
          checkRuns: worktree.checkRuns || [],
          diffStat: diff.diffStat,
          fileStatus: diff.status,
          commits: diff.commits,
          headRevision: worktree.headRevision || null,
          warning: worktree.status === "checks_failed"
            ? "Checks have failed on this worktree. Consider running checks again before merging."
            : null
        }
      });
    }
  );

  // ── approve_merge ──────────────────────────────────────────────
  server.tool(
    "approve_merge",
    "Execute a worktree merge into the target branch. Call propose_merge first to review changes.",
    {
      worktreeId: z.string().describe("Worktree ID to merge"),
      targetBranch: z.string().optional().describe("Target branch (defaults to project default branch)")
    },
    async ({ worktreeId, targetBranch }) => {
      const { worktree, project } = await requireWorktreeAndProject(store, worktreeId);
      const merge = await worktrees.merge({ project, worktree, targetBranch });
      const mergedAt = new Date().toISOString();
      const updatedWorktree = await store.updateWorktree(worktree.id, { status: "merged", mergedAt, merge });
      if (worktree.taskId) {
        await store.updateTask(worktree.taskId, { status: "merged", mergedAt });
      }
      await publishWorktreeMerged({ store, bus }, project.id, worktree.taskId, worktree.id, worktree.branch, merge.targetBranch);
      return json({ ok: true, worktree: updatedWorktree, merge });
    }
  );

  // ── get_dashboard ──────────────────────────────────────────────
  server.tool(
    "get_dashboard",
    "Get a full snapshot of the gateway state: projects, sessions, tasks, worktrees, and recent events",
    {},
    async () => {
      const [projects, sessions, tasks, worktreesList, events] = await Promise.all([
        store.listProjects(),
        store.listSessions(),
        store.listTasks(),
        store.listWorktrees(),
        store.listEvents(40)
      ]);
      return json({ projects, sessions, tasks, worktrees: worktreesList, events });
    }
  );

  return server;
}
