import { defaultCheckCommands, mergeCheckRuns } from "../project-helpers.js";
import { publishEvent } from "../events.js";
import { ConfigError, type ExecutionHandle, type ExecutionState, type Executor, type PreflightContext, type StepExecutionContext } from "./types.js";

function durationMs(startedAt: string, finishedAt: string) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : undefined;
}

function preview(value: string, max = 4000) {
  return value.length > max ? value.slice(value.length - max) : value;
}

/** Where a check step's effective commands came from: an explicit step-level override, or the project's configured test commands. */
function commandsSource(input: Record<string, unknown> | undefined): "step" | "project" {
  return Array.isArray(input?.commands) ? "step" : "project";
}

export class CheckExecutor implements Executor {
  type = "check";

  preflight(ctx: PreflightContext): void {
    const commands = defaultCheckCommands(ctx.project, Array.isArray(ctx.step.input?.commands) ? ctx.step.input?.commands : undefined);
    if (!commands.length) {
      throw new ConfigError(
        `check step "${ctx.step.id}" resolves to no check commands: project "${ctx.project.name}" has no configured test commands and the step did not override them via input.commands`
      );
    }
  }

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const worktreeId = String(ctx.step.input.worktreeId || ctx.step.executionRef?.worktreeId || "").trim();
    if (!worktreeId) throw new ConfigError("Check step requires input.worktreeId");
    const worktree = await ctx.store.getWorktree(worktreeId);
    if (!worktree) throw new ConfigError(`Worktree not found: ${worktreeId}`);
    const commands = defaultCheckCommands(ctx.project, Array.isArray(ctx.step.input.commands) ? ctx.step.input.commands : undefined);
    if (!commands.length) throw new ConfigError("No check commands configured");
    const source = commandsSource(ctx.step.input);
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
    const artifactIds: string[] = [];
    const evidenceIds: string[] = [];
    for (const [index, run] of result.runs.entries()) {
      const artifact = await ctx.store.createArtifact({
        runId: ctx.runId,
        stepId: ctx.step.id,
        kind: "log",
        name: `check-${index + 1}.log`,
        uri: `honeyrail://runs/${ctx.runId}/steps/${ctx.step.id}/checks/${index + 1}`,
        mediaType: "text/plain",
        metadata: {
          command: run.command,
          status: run.status,
          exitCode: run.exitCode ?? (run.status === "passed" ? 0 : 1),
          stdoutPreview: preview(run.stdout || ""),
          stderrPreview: preview(run.stderr || "")
        }
      });
      artifactIds.push(artifact.id);
      await publishEvent(ctx.store, ctx.bus, {
        type: "artifact.created",
        projectId: ctx.project.id,
        payload: { runId: ctx.runId, stepId: ctx.step.id, artifactId: artifact.id, kind: artifact.kind, name: artifact.name }
      });
      const exitCode = run.exitCode ?? (run.status === "passed" ? 0 : 1);
      const evidence = await ctx.store.createEvidence({
        runId: ctx.runId,
        stepId: ctx.step.id,
        kind: "check.command",
        claim: `Command \`${run.command}\` ${run.status}`,
        source: "check",
        artifactIds: [artifact.id],
        value: {
          command: run.command,
          status: run.status,
          exitCode,
          durationMs: durationMs(run.startedAt, run.finishedAt)
        },
        metadata: {
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          commandsSource: source
        }
      });
      evidenceIds.push(evidence.id);
      await publishEvent(ctx.store, ctx.bus, {
        type: "evidence.recorded",
        projectId: ctx.project.id,
        payload: { runId: ctx.runId, stepId: ctx.step.id, evidenceId: evidence.id, kind: evidence.kind, claim: evidence.claim }
      });
    }
    return { worktreeId, ok: result.ok, checkRuns: result.runs, artifactIds, evidenceIds, commandsSource: source };
  }

  async inspect(_ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState> {
    // Execution succeeding only means the checks ran without an
    // infrastructure error (see CheckExecutor.start, which throws for
    // missing worktrees/commands). Whether the *commands* passed is a fact
    // for the quality gate to judge, not the executor - otherwise a failing
    // check command fails the step before its qualityGate (including
    // onFail: "wait_approval") ever runs. OrchestrationService applies a
    // default check-type gate for "check" steps that don't declare one, so
    // this does not change the observed default behavior.
    const output = { worktreeId: handle.worktreeId, checkRuns: handle.checkRuns, ok: Boolean(handle.ok), commandsSource: handle.commandsSource };
    return { status: "succeeded", output };
  }
}
