import type { SafeCommandOutput } from "../utils.js";
import type { ExecutionHandle, ExecutionState, Executor, StepExecutionContext } from "./types.js";

type ShellState = {
  done: boolean;
  cancelled: boolean;
  result?: SafeCommandOutput;
};

const running = new Map<string, ShellState>();

function truncate(value: string, max = 64 * 1024) {
  return value.length > max ? value.slice(value.length - max) : value;
}

export class ShellExecutor implements Executor {
  type = "shell";

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const command = String(ctx.step.input.command || "").trim();
    if (!command) throw new Error("Shell step requires input.command");
    const cwd = String(ctx.step.input.cwd || ctx.project.repoPath);
    const timeoutMs = Number(ctx.step.input.timeoutMs || 1000 * 60 * 10);
    const processId = `${ctx.runId}:${ctx.step.id}:${ctx.step.attempt + 1}`;
    const state: ShellState = { done: false, cancelled: false };
    running.set(processId, state);
    ctx.runCommand("sh", ["-lc", command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    }).then((result) => {
      state.done = true;
      state.result = {
        ...result,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr)
      };
    }).catch((error) => {
      state.done = true;
      state.result = {
        ok: false,
        stdout: "",
        stderr: String((error as Error).message || error),
        code: 1
      };
    });
    return { processId, command, cwd, timeoutMs, startedAt: new Date().toISOString() };
  }

  async inspect(_ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState> {
    const processId = String(handle.processId || "");
    const state = running.get(processId);
    if (!state) {
      return { status: "failed", error: "Shell process is not attached after restart", output: { restartSemantics: "shell steps fail if their process disappears before completion" } };
    }
    if (state.cancelled) {
      running.delete(processId);
      return { status: "cancelled", error: "Shell step cancelled" };
    }
    if (!state.done || !state.result) return { status: "running" };
    running.delete(processId);
    const output = {
      stdout: state.result.stdout,
      stderr: state.result.stderr,
      exitCode: state.result.code ?? 0
    };
    if (state.result.ok) return { status: "succeeded", output };
    return { status: "failed", output, error: state.result.stderr || `Shell command failed with exit code ${state.result.code ?? "unknown"}` };
  }

  async cancel(_ctx: StepExecutionContext, handle: ExecutionHandle): Promise<void> {
    const processId = String(handle.processId || "");
    const state = running.get(processId);
    if (state) state.cancelled = true;
  }
}
