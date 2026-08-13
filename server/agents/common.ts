import type { AgentAdapter, AgentCommandRunner, AgentInstallationStatus, AgentInputContext } from "./types.js";
import { quoteShellArg } from "../utils.js";

export function normalizedModel(model: unknown) {
  return String(model || "").trim();
}

export function normalizedPrompt(prompt: unknown) {
  return String(prompt || "").trim();
}

export function formatGenericInput({ text, attachments }: AgentInputContext) {
  const prompt = String(text || "").replace(/\s+/g, " ").trim();
  if (!attachments.length) return prompt;

  const fileList = attachments
    .map((attachment, index) => `${index + 1}. ${attachment.path}`)
    .join("; ");
  const intro = prompt || "Please inspect the attached file input.";
  return `${intro} Attached file paths:\n${fileList}`;
}

export function modelFlag(flag: string, model: unknown) {
  const modelValue = normalizedModel(model);
  return modelValue ? ` ${flag} ${quoteShellArg(modelValue)}` : "";
}

export async function detectCli(adapter: AgentAdapter, run: AgentCommandRunner, command: string, versionArgs: string[] = ["--version"]): Promise<AgentInstallationStatus> {
  const pathResult = await run("sh", ["-lc", `command -v ${quoteShellArg(command)}`], { timeout: 3000 });
  if (!pathResult.ok) {
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      stability: adapter.stability,
      available: false,
      detail: "not found"
    };
  }

  const versionResult = await run(command, versionArgs, { timeout: 5000 });
  const versionText = versionResult.ok
    ? (versionResult.stdout || versionResult.stderr).trim().split("\n")[0]
    : "";
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    stability: adapter.stability,
    available: true,
    path: pathResult.stdout.trim(),
    version: versionText || undefined,
    detail: versionResult.ok ? undefined : "version unavailable"
  };
}
