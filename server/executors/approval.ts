import type { ExecutionHandle, ExecutionState, Executor } from "./types.js";

export class HumanApprovalExecutor implements Executor {
  type = "approval";

  async start(): Promise<ExecutionHandle> {
    return { waitingApproval: true, requestedAt: new Date().toISOString() };
  }

  async inspect(): Promise<ExecutionState> {
    return { status: "waiting_approval" };
  }
}
