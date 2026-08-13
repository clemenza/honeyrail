import { AgentTaskExecutor } from "./agent-task.js";
import { CheckExecutor } from "./check.js";
import { HumanApprovalExecutor } from "./approval.js";
import { ExecutorRegistry } from "./registry.js";
import { ShellExecutor } from "./shell.js";

export function createDefaultExecutorRegistry() {
  return new ExecutorRegistry([
    new AgentTaskExecutor(),
    new ShellExecutor(),
    new CheckExecutor(),
    new HumanApprovalExecutor()
  ]);
}
