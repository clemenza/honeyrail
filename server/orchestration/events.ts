import type { EventBus } from "../events.js";
import type { Run, Step, Store } from "../types.js";

export type OrchestrationEventContext = {
  store: Store;
  bus: EventBus;
};

export async function publishRunEvent(ctx: OrchestrationEventContext, type: string, run: Run, extra: Record<string, unknown> = {}) {
  const event = await ctx.store.appendEvent({
    type,
    projectId: run.projectId,
    payload: {
      runId: run.id,
      status: run.status,
      goal: run.goal,
      ...extra
    }
  });
  ctx.bus.publish(event);
}

export async function publishStepEvent(ctx: OrchestrationEventContext, type: string, run: Run, step: Step, extra: Record<string, unknown> = {}) {
  const event = await ctx.store.appendEvent({
    type,
    projectId: run.projectId,
    payload: {
      runId: run.id,
      stepId: step.id,
      stepName: step.name,
      executor: step.executor,
      status: step.status,
      attempt: step.attempt,
      ...extra
    }
  });
  ctx.bus.publish(event);
}
