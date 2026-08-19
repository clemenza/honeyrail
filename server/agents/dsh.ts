import { formatGenericInput, hasCompletedByTailMarker, normalizedPrompt, detectCli } from "./common.js";
import type { AgentAdapter, AgentFatalError, AgentLaunchInput } from "./types.js";
import { quoteShellArg } from "../utils.js";

const DONE_MARKER = "HR_DSH_DONE";

/**
 * `dsh --profile headless` is a real one-shot subprocess that exits on its
 * own (see docs/dsh-adapter-notes.md) rather than an idling TUI like
 * codex/claude, so without a keep-alive tail the pane - and the shell
 * running it - would close the instant the marker is printed, racing
 * session-monitor's poller the same way null-agent's own comment describes.
 * Every adapter ends up with the same idle-until-killed shape for that
 * reason; this just gets there by construction instead of by nature.
 */
function buildLaunchCommand(input: AgentLaunchInput = {}): string {
  const prompt = normalizedPrompt(input.prompt);
  const taskArg = prompt ? ` ${quoteShellArg(prompt)}` : "";
  return [
    `dsh --profile headless --patch cordis.patch.yml${taskArg}`,
    `echo ${DONE_MARKER}`,
    `while :; do sleep 3600; done`
  ].join("; ");
}

/**
 * The two failure shapes observed in the #87 spike. Both are hard,
 * immediate exits (no hang, no retry) rather than something an unattended
 * run could work around, so either one should fail the task right away
 * instead of waiting for hasCompletedTask to time out.
 */
function findFatalError(output: string): AgentFatalError | null {
  if (/dsh: MISSING_CREDENTIAL:/.test(output)) {
    return {
      code: "dsh_missing_credential",
      message: "dsh has no DEEPSEEK_API_KEY for provider route \"deepseek-official\" - export DEEPSEEK_API_KEY in the launching environment."
    };
  }
  const bootFailure = output.match(/^Error: dsh: (.+)$/m);
  if (bootFailure) {
    return {
      code: "dsh_boot_failure",
      message: `dsh failed to boot (${bootFailure[1].trim()}) - check the pinned dsh version and that Node >= 24 is active (see docs/dsh-adapter-notes.md).`
    };
  }
  return null;
}

/**
 * DSH (DeepSeek Harness) CLI, developer preview - see #87's spike for the
 * install/permission/version findings this adapter is built on.
 */
export const dshAdapter: AgentAdapter = {
  id: "dsh",
  displayName: "DSH (DeepSeek Harness)",
  stability: "experimental",
  capabilities: {
    // The spike confirmed model selection is possible (patching the
    // `agent-default-model` plugin's config), but only through the same
    // single `cordis.patch.yml` the instructionFile mechanism already owns
    // for the Route A variant content - there's no `--model` flag and no
    // second patch file this adapter can write on its own. Left false
    // rather than claiming a capability nothing here implements or tests.
    modelSelection: false,
    attachments: false,
    images: false,
    // Headless has no built-in approval answerer at all (see
    // docs/dsh-adapter-notes.md) - it structurally cannot prompt, the same
    // guarantee minimal-agent has for having no CLI to prompt through.
    interactivePrompts: false
  },

  buildLaunchCommand,

  formatInput: formatGenericInput,

  findFatalError,

  hasCompletedTask(output) {
    return hasCompletedByTailMarker(output, DONE_MARKER);
  },

  async detectInstallation(run) {
    return detectCli(this, run, "dsh");
  }
};
