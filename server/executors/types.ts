import type { EventBus } from "../events.js";
import type { Project, Step, Store } from "../types.js";
import type { TmuxManager } from "../tmux.js";
import type { runCommandSafe } from "../utils.js";
import type { WorktreeManager } from "../worktrees.js";

export type ExecutionHandle = Record<string, unknown>;

export type ExecutionState = {
  status: "running" | "waiting_input" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
  output?: Record<string, unknown>;
  error?: string;
  executionRef?: ExecutionHandle;
};

export type StepExecutionContext = {
  store: Store;
  bus: EventBus;
  tmux: TmuxManager;
  worktrees: WorktreeManager;
  runCommand: typeof runCommandSafe;
  project: Project;
  runId: string;
  step: Step;
  sessionLogRoot: string;
  attachmentRoot: string;
};

export interface Executor {
  type: string;
  start(ctx: StepExecutionContext): Promise<ExecutionHandle>;
  inspect(ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState>;
  cancel?(ctx: StepExecutionContext, handle: ExecutionHandle): Promise<void>;
}
