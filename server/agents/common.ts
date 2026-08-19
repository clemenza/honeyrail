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

/**
 * Detects a fixed completion marker among the last `tailLines` *non-blank*
 * lines of captured tmux output - for an adapter that prints one clean
 * marker line and then goes permanently silent (null/minimal, #71), rather
 * than codex/claude's continuously-redrawn TUI status line.
 *
 * `output.split("\n").slice(-N)` (the pattern codex/claude/hermes use) only
 * works when real content keeps arriving near the end of the capture. tmux
 * pads a short-lived pane's capture with blank lines out to the full pane
 * height, so a marker printed once and never followed by anything else can
 * end up on line 1 of a 24-line capture - nowhere near the raw last N
 * lines, even though it's unambiguously the *last thing the pane printed*.
 * Filtering blanks first and then taking the tail fixes that: since nothing
 * more is ever printed after the marker, it's always the last non-blank
 * line, regardless of pane height or how much blank padding follows it.
 */
export function hasCompletedByTailMarker(output: string, marker: string, tailLines = 5): boolean {
  const nonBlankLines = output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
  return nonBlankLines.slice(-tailLines).some((line) => line.includes(marker));
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

/**
 * Bumped whenever the text below changes materially. Recorded on every
 * agent-task step's completion evidence (see recordCompletionArtifacts in
 * executors/agent-task.ts) so harness prompt iterations can be A/B compared
 * across runs without contaminating historical eval data with a silent
 * prompt change.
 */
export const HARNESS_PROMPT_VERSION = "1";

/**
 * The manifest/artifacts channel described here is convention, not trust:
 * the runtime never depends on an agent following it - diff/changed-files/
 * transcript (#48) are harvested unconditionally regardless of whether the
 * agent writes anything here. This only supplements what the runtime can't
 * derive on its own (e.g. "which file is the new test").
 */
export function buildHarnessPrompt({ stepDir, produces }: { stepDir: string; produces?: string[] }): string {
  const lines = [
    `Harness runtime conventions (prompt v${HARNESS_PROMPT_VERSION}):`,
    "- Your code diff and the list of changed files are captured automatically after you finish - don't restate them.",
    `- For anything else worth recording that the runtime can't derive on its own (e.g. "this is the new test file that verifies the change"), write files under ${stepDir}/artifacts/ and optionally describe them in ${stepDir}/manifest.json as {"artifacts": [{"name": "<file>", "path": "artifacts/<file>", "type": "<optional contract type>", "claim": "<what this demonstrates>"}]}.`
  ];
  if (produces?.length) {
    lines.push(`- This step's contract declares it must produce: ${produces.join(", ")}. Anything in that list the runtime can't derive automatically needs to show up via the manifest above.`);
  }
  lines.push("This is a convention, not a requirement - skip the manifest entirely if there's nothing extra to report.");
  return lines.join("\n");
}

export function withHarnessConventions(prompt: unknown, opts: { stepDir: string; produces?: string[] }): string {
  const trimmed = normalizedPrompt(prompt);
  const conventions = buildHarnessPrompt(opts);
  return trimmed ? `${conventions}\n\n${trimmed}` : conventions;
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
