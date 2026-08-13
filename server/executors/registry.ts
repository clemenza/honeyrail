import type { Executor } from "./types.js";

export class UnknownExecutorError extends Error {
  constructor(type: unknown) {
    super(`Unknown executor type: ${String(type || "(empty)")}`);
    this.name = "UnknownExecutorError";
  }
}

export class ExecutorRegistry {
  private executors = new Map<string, Executor>();

  constructor(executors: Executor[] = []) {
    for (const executor of executors) this.register(executor);
  }

  register(executor: Executor) {
    this.executors.set(executor.type, executor);
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  get(type: string): Executor {
    const executor = this.executors.get(type);
    if (!executor) throw new UnknownExecutorError(type);
    return executor;
  }

  list(): Executor[] {
    return [...this.executors.values()];
  }
}
