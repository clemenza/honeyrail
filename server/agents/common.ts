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

// Prepended to the prompt for unattended (run-launched) agent-task steps so
// the CLI doesn't stop to ask a clarifying question that nobody is watching
// the terminal to answer. `BLOCKED:` is the structured escape hatch for
// genuinely unanswerable prompts — see findBlockedReason below.
export const UNATTENDED_PREAMBLE = [
  "You are running unattended inside an automated pipeline. Nobody is watching this terminal.",
  "- Do NOT ask clarifying questions and do NOT use any \"ask user\"/\"choose an option\" tool or skill.",
  "- When requirements are ambiguous, choose the simplest reasonable interpretation, proceed, and list every assumption under an \"## Assumptions\" heading in your final summary.",
  "- Only if it is genuinely impossible to continue, print a single line starting with `BLOCKED:` followed by the reason, then stop.",
  "Task follows.",
  "---"
].join("\n");

export function withUnattendedPreamble(prompt: unknown): string {
  const trimmed = normalizedPrompt(prompt);
  return trimmed ? `${UNATTENDED_PREAMBLE}\n${trimmed}` : UNATTENDED_PREAMBLE;
}

const BLOCKED_LINE_PATTERN = /^BLOCKED:\s*(.+)$/m;

/**
 * Detects the structured "BLOCKED: <reason>" stop an unattended agent is
 * instructed to print (via UNATTENDED_PREAMBLE) when it's genuinely unable
 * to continue, so the executor can fail the step cleanly instead of the run
 * hanging on a clarifying question nobody will answer.
 */
export function findBlockedReason(output: string): { message: string } | null {
  const recentOutput = output.split("\n").slice(-40).join("\n");
  const match = recentOutput.match(BLOCKED_LINE_PATTERN);
  if (!match) return null;
  const message = match[1].trim();
  return message ? { message } : null;
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
