import { defaultCheckCommands, mergeCheckRuns } from "../project-helpers.js";
import type { ExecutionHandle, ExecutionState, Executor, StepExecutionContext } from "./types.js";

export class CheckExecutor implements Executor {
  type = "check";

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const worktreeId = String(ctx.step.input.worktreeId || ctx.step.executionRef?.worktreeId || "").trim();
    if (!worktreeId) throw new Error("Check step requires input.worktreeId");
    const worktree = await ctx.store.getWorktree(worktreeId);
    if (!worktree) throw new Error(`Worktree not found: ${worktreeId}`);
    const commands = defaultCheckCommands(ctx.project, Array.isArray(ctx.step.input.commands) ? ctx.step.input.commands : undefined);
    if (!commands.length) throw new Error("No check commands configured");
    const result = await ctx.worktrees.runChecks({ worktree, commands });
    const checkedAt = new Date().toISOString();
    const checkRuns = mergeCheckRuns(worktree.checkRuns, result.runs);
    await ctx.store.updateWorktree(worktree.id, {
      status: result.ok ? "checks_passed" : "checks_failed",
      checkedAt,
      checkRuns
    });
    if (worktree.taskId) {
      const existingTask = await ctx.store.getTask(worktree.taskId);
      await ctx.store.updateTask(worktree.taskId, {
        status: result.ok ? "ready_to_merge" : "checks_failed",
        checkedAt,
        checkRuns: mergeCheckRuns(existingTask?.checkRuns, result.runs)
      });
    }
    return { worktreeId, ok: result.ok, checkRuns: result.runs };
  }

  async inspect(_ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState> {
    const ok = Boolean(handle.ok);
    const output = { worktreeId: handle.worktreeId, checkRuns: handle.checkRuns };
    return ok ? { status: "succeeded", output } : { status: "failed", output, error: "Checks failed" };
  }
}
