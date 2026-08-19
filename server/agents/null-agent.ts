import type { AgentAdapter, AgentInstallationStatus } from "./types.js";
import { formatGenericInput } from "./common.js";
import { quoteShellArg } from "../utils.js";

const DONE_MARKER = "NULL_AGENT_DONE";

/**
 * Declares the two artifact types AgentTaskExecutor auto-harvests
 * (producesTypes = ["diff", "changed_files"]) via the manifest/artifacts
 * channel, with empty content, since a genuinely no-op agent produces no
 * git diff for the automatic harvest to find - and an empty diff is
 * silently dropped by that harvest's own content guard. Without this, a
 * step whose recipe declares `produces: [diff, changed_files]` would fail
 * with failureKind contract_violation instead of reaching its real
 * verification step, corrupting what "null-agent failed" is supposed to
 * mean for calibration (#71).
 */
const MANIFEST = JSON.stringify({
  artifacts: [
    { path: "changes.diff", type: "diff", claim: "null-agent made no changes" },
    { path: "changed_files.json", type: "changed_files", claim: "null-agent touched no files" }
  ]
});

function buildLaunchCommand(): string {
  return [
    `mkdir -p "$HR_STEP_DIR/artifacts"`,
    `: > "$HR_STEP_DIR/artifacts/changes.diff"`,
    `printf '[]' > "$HR_STEP_DIR/artifacts/changed_files.json"`,
    `printf '%s' ${quoteShellArg(MANIFEST)} > "$HR_STEP_DIR/manifest.json"`,
    `echo "${DONE_MARKER}"`,
    // Stay alive after signaling completion instead of exiting: tmux closes
    // a pane (and can tear down the whole session) the moment its
    // foreground process exits, which would race the poller trying to
    // capture this output. Every other adapter has the same shape (an
    // idle/prompting CLI that stays running until explicitly killed) - the
    // harness kills this session once hasCompletedTask below fires,
    // identically to codex/claude/hermes.
    `while :; do sleep 3600; done`
  ].join(" && ");
}

/**
 * Does no real work: launches, declares the contractually-required empty
 * artifacts above, and idles. A calibration floor - "did the harness's own
 * gate correctly reject an agent that changed nothing," not a real coding
 * agent. See docs/agent-adapters.md for intended use.
 */
export const nullAgentAdapter: AgentAdapter = {
  id: "null",
  displayName: "Null Agent",
  stability: "experimental",
  capabilities: {
    modelSelection: false,
    attachments: false,
    images: false,
    interactivePrompts: false
  },

  buildLaunchCommand,

  formatInput: formatGenericInput,

  hasCompletedTask(output) {
    return output.split("\n").slice(-20).some((line) => line.includes(DONE_MARKER));
  },

  async detectInstallation(): Promise<AgentInstallationStatus> {
    return {
      id: "null",
      displayName: "Null Agent",
      stability: "experimental",
      available: true,
      detail: "no external dependency"
    };
  }
};
