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

/**
 * Thrown by an executor's start() (or preflight()) to mark a failure as
 * caused by the step's static configuration rather than by something that
 * happened while it ran - e.g. no check commands resolved, or an agent CLI
 * that doctor-style detection can't find. OrchestrationService uses this to
 * tag the resulting Step with failureKind "config_error" instead of the
 * default "execution_failed".
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Minimal, pre-run view of a step passed to Executor.preflight() - unlike
 * StepExecutionContext, no Run/Step records exist yet at run-creation time,
 * so this only carries what a static configuration check can use.
 */
export type PreflightContext = {
  project: Project;
  step: { id: string; input?: Record<string, unknown> };
  runCommand: typeof runCommandSafe;
};

export interface Executor {
  type: string;
  /**
   * Artifact types (see KNOWN_ARTIFACT_TYPES in types.ts) this executor
   * unconditionally harvests on step success, independent of anything a
   * recipe declares in a step's `produces`. StepContract dataflow lint treats
   * these as always available from a step of this executor type, so a
   * downstream step can `consumes` them without the upstream step having to
   * redundantly redeclare what its executor already guarantees.
   */
  producesTypes?: string[];
  /**
   * Optional static check run at run-creation time (before any Run/Step
   * records exist) to reject steps that cannot possibly succeed given their
   * resolved configuration. Throw (a ConfigError, ideally) to reject the run.
   * Executors without a meaningful static check simply omit this.
   */
  preflight?(ctx: PreflightContext): Promise<void> | void;
  start(ctx: StepExecutionContext): Promise<ExecutionHandle>;
  inspect(ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState>;
  cancel?(ctx: StepExecutionContext, handle: ExecutionHandle): Promise<void>;
}
