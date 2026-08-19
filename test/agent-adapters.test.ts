import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeSubscriptionEnvOverrides } from "../server/agents/claude.js";
import { findBlockedReason, UNATTENDED_PREAMBLE, withUnattendedPreamble } from "../server/agents/common.js";
import { getAgentAdapter, knownAgentIds, listAgentAdapters } from "../server/agents/registry.js";
import { hermesArchPrefix } from "../server/agents/hermes.js";
import type { ImageAttachment } from "../server/attachments.js";

const claudeCleanEnvPrefix = `env ${claudeSubscriptionEnvOverrides.map((name) => `-u ${name}`).join(" ")}`;

function attachment(path: string): ImageAttachment {
  return {
    id: "img_test",
    name: "test.png",
    type: "image/png",
    size: 12,
    fileName: "test.png",
    path,
    url: "/api/attachments/test.png",
    thumbnailDataUrl: "data:image/png;base64,abc"
  };
}

test("registry resolves every registered adapter and exposes metadata", () => {
  assert.deepEqual(knownAgentIds(), ["shell", "codex", "claude", "hermes", "null", "minimal"]);
  const adapters = listAgentAdapters();
  assert.equal(adapters.length, 6);
  assert.equal(getAgentAdapter("codex").stability, "stable");
  assert.equal(getAgentAdapter("claude").stability, "stable");
  assert.equal(getAgentAdapter("shell").capabilities.modelSelection, false);
  assert.equal(getAgentAdapter("hermes").stability, "experimental");
  // #71: both calibration probes are explicitly experimental, and neither
  // has any code path that can surface an interactive prompt.
  assert.equal(getAgentAdapter("null").stability, "experimental");
  assert.equal(getAgentAdapter("null").capabilities.interactivePrompts, false);
  assert.equal(getAgentAdapter("minimal").stability, "experimental");
  assert.equal(getAgentAdapter("minimal").capabilities.interactivePrompts, false);
});

test("registry rejects unknown agent ids clearly", () => {
  assert.throws(() => getAgentAdapter("unknown-agent"), /Unknown agent backend: unknown-agent/);
});

test("shell launch command preserves shell execution behavior", () => {
  assert.equal(getAgentAdapter("shell").buildLaunchCommand(), "$SHELL");
});

test("codex launch command preserves prompt, model, and shell escaping behavior", () => {
  const codex = getAgentAdapter("codex");
  assert.equal(codex.buildLaunchCommand(), "codex");
  assert.equal(codex.buildLaunchCommand({ prompt: "fix billing mode" }), "codex 'fix billing mode'");
  assert.equal(codex.buildLaunchCommand({ model: "gpt-5-codex" }), "codex --model 'gpt-5-codex'");
  assert.equal(
    codex.buildLaunchCommand({ prompt: "fix Bob's bug", model: "gpt-5-codex" }),
    "codex --model 'gpt-5-codex' 'fix Bob'\\''s bug'"
  );
});

test("claude launch command preserves env cleanup and model behavior", () => {
  const claude = getAgentAdapter("claude");
  assert.equal(
    claude.buildLaunchCommand(),
    `${claudeCleanEnvPrefix} claude --dangerously-skip-permissions --setting-sources user`
  );
  assert.equal(
    claude.buildLaunchCommand({ prompt: "fix billing mode", model: "sonnet" }),
    `${claudeCleanEnvPrefix} claude --dangerously-skip-permissions --setting-sources user --model 'sonnet' 'fix billing mode'`
  );
});

test("codex launch command adds the full-auto equivalent flags only in unattended mode", () => {
  // Current Codex CLI (0.147+) rejects the old `--full-auto` shorthand
  // outright ("unexpected argument '--full-auto' found"); this spells out
  // the equivalent flags directly instead.
  const codex = getAgentAdapter("codex");
  assert.equal(codex.buildLaunchCommand({ prompt: "fix billing mode", unattended: true }), "codex --ask-for-approval never --sandbox workspace-write 'fix billing mode'");
  assert.equal(codex.buildLaunchCommand({ unattended: true }), "codex --ask-for-approval never --sandbox workspace-write");
  assert.equal(codex.buildLaunchCommand({ prompt: "fix billing mode", unattended: false }), "codex 'fix billing mode'");
});

test("claude launch command uses project-only settings in unattended mode", () => {
  const claude = getAgentAdapter("claude");
  assert.equal(
    claude.buildLaunchCommand({ prompt: "fix billing mode", unattended: true }),
    `${claudeCleanEnvPrefix} claude --dangerously-skip-permissions --setting-sources project 'fix billing mode'`
  );
  assert.equal(
    claude.buildLaunchCommand({ prompt: "fix billing mode", unattended: false }),
    `${claudeCleanEnvPrefix} claude --dangerously-skip-permissions --setting-sources user 'fix billing mode'`
  );
});

test("hermes launch command preserves oneshot and interactive behavior", () => {
  const arch = process.platform === "darwin" ? "arch -arm64 " : "";
  const hermes = getAgentAdapter("hermes");
  assert.equal(hermesArchPrefix("darwin"), "arch -arm64 ");
  assert.equal(hermesArchPrefix("linux"), "");
  assert.equal(
    hermes.buildLaunchCommand({ prompt: "fix the launch issue", model: "anthropic/claude-sonnet-4.6" }),
    `${arch}hermes -z 'fix the launch issue' -m 'anthropic/claude-sonnet-4.6' && exec ${arch}hermes chat -m 'anthropic/claude-sonnet-4.6' --continue --accept-hooks --yolo`
  );
  assert.equal(hermes.buildLaunchCommand(), `${arch}hermes chat --accept-hooks --yolo`);
});

test("adapter input formatting preserves generic and claude attachment behavior", () => {
  const codex = getAgentAdapter("codex");
  const claude = getAgentAdapter("claude");
  const paths = [
    attachment("/tmp/one image.png"),
    attachment("/tmp/two'quote.md")
  ];

  assert.equal(codex.formatInput({ text: "", attachments: [] }), "");
  assert.equal(codex.formatInput({ text: "inspect", attachments: [] }), "inspect");
  assert.equal(
    codex.formatInput({ text: "inspect", attachments: paths }),
    "inspect Attached file paths:\n1. /tmp/one image.png; 2. /tmp/two'quote.md"
  );
  assert.equal(
    codex.formatInput({ text: "", attachments: paths }),
    "Please inspect the attached file input. Attached file paths:\n1. /tmp/one image.png; 2. /tmp/two'quote.md"
  );
  assert.equal(
    claude.formatInput({ text: "inspect", attachments: paths }),
    "inspect /tmp/one image.png /tmp/two'quote.md"
  );
});

test("withUnattendedPreamble prepends the unattended instructions to a prompt", () => {
  const result = withUnattendedPreamble("fix the billing bug");
  assert.ok(result.startsWith(UNATTENDED_PREAMBLE));
  assert.ok(result.endsWith("fix the billing bug"));
  assert.match(UNATTENDED_PREAMBLE, /BLOCKED:/);
  assert.equal(withUnattendedPreamble(""), UNATTENDED_PREAMBLE);
});

test("findBlockedReason detects a structured BLOCKED: stop in the recent tail", () => {
  assert.deepEqual(findBlockedReason("some output\nBLOCKED: missing API credentials\nmore output"), { message: "missing API credentials" });
  assert.equal(findBlockedReason("no blocked marker here"), null);
  assert.equal(findBlockedReason("BLOCKED:   "), null);
});

test("findBlockedReason only inspects the recent tail, not stale scrollback", () => {
  const output = [
    "BLOCKED: an old reason from a previous, already-resolved attempt",
    ...Array.from({ length: 45 }, (_, index) => `line ${index}`)
  ].join("\n");
  assert.equal(findBlockedReason(output), null);
});

// #71: null-agent - does no real work, only declares the empty artifacts a
// StepContract might require, then idles.
test("null-agent launch command declares empty diff/changed_files artifacts, signals done, and stays alive", () => {
  const nullAgent = getAgentAdapter("null");
  const command = nullAgent.buildLaunchCommand();
  assert.match(command, /mkdir -p "\$HR_STEP_DIR\/artifacts"/);
  assert.match(command, /\$HR_STEP_DIR\/artifacts\/changes\.diff/);
  assert.match(command, /\$HR_STEP_DIR\/artifacts\/changed_files\.json/);
  assert.match(command, /"type":"diff"/);
  assert.match(command, /"type":"changed_files"/);
  assert.match(command, /echo "NULL_AGENT_DONE"/);
  // Never exits on its own - a foreground process exiting closes its tmux
  // pane before the poller can observe the final output.
  assert.match(command, /while :; do sleep 3600; done/);
});

test("null-agent hasCompletedTask detects its own done marker in the recent tail only", () => {
  const nullAgent = getAgentAdapter("null");
  assert.equal(nullAgent.hasCompletedTask?.("some setup output\nNULL_AGENT_DONE\n"), true);
  assert.equal(nullAgent.hasCompletedTask?.("no marker here"), false);
  const stale = ["NULL_AGENT_DONE", ...Array.from({ length: 25 }, (_, i) => `line ${i}`)].join("\n");
  assert.equal(nullAgent.hasCompletedTask?.(stale), false);
});

test("null-agent has no external dependency, so detectInstallation always reports available", async () => {
  const status = await getAgentAdapter("null").detectInstallation?.(async () => ({ ok: true, stdout: "", stderr: "" }));
  assert.equal(status?.available, true);
});

// #71: minimal-agent - a ReAct loop that calls a model API directly.
test("minimal-agent launch command runs the standalone script with prompt/model/temperature, defaulting both", () => {
  const minimal = getAgentAdapter("minimal");
  const defaulted = minimal.buildLaunchCommand({ prompt: "implement fizzbuzz" });
  assert.match(defaulted, /^node '.*minimal-agent\.mjs' --prompt 'implement fizzbuzz' --model 'deepseek-chat' --temperature '0'$/);

  const overridden = minimal.buildLaunchCommand({ prompt: "fix Bob's bug", model: "deepseek-reasoner", temperature: 0.7 });
  assert.match(overridden, /--prompt 'fix Bob'\\''s bug'/);
  assert.match(overridden, /--model 'deepseek-reasoner'/);
  assert.match(overridden, /--temperature '0\.7'/);
});

test("minimal-agent hasCompletedTask detects its own done marker in the recent tail only", () => {
  const minimal = getAgentAdapter("minimal");
  assert.equal(minimal.hasCompletedTask?.("$ ls\nfile.txt\nMINIMAL_AGENT_DONE status=done (3 iterations)\n"), true);
  assert.equal(minimal.hasCompletedTask?.("still working"), false);
});

test("minimal-agent detectInstallation reflects whether an API key is configured", async () => {
  const minimal = getAgentAdapter("minimal");
  const originalDeepseek = process.env.DEEPSEEK_API_KEY;
  const originalSummary = process.env.AGENT_SESSION_SUMMARY_API_KEY;
  const originalMinimal = process.env.MINIMAL_AGENT_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.AGENT_SESSION_SUMMARY_API_KEY;
  delete process.env.MINIMAL_AGENT_API_KEY;
  try {
    const unavailable = await minimal.detectInstallation?.(async () => ({ ok: true, stdout: "", stderr: "" }));
    assert.equal(unavailable?.available, false);
    assert.match(unavailable?.detail || "", /No API key configured/);

    process.env.MINIMAL_AGENT_API_KEY = "test-key";
    const available = await minimal.detectInstallation?.(async () => ({ ok: true, stdout: "", stderr: "" }));
    assert.equal(available?.available, true);
  } finally {
    if (originalDeepseek === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = originalDeepseek;
    if (originalSummary === undefined) delete process.env.AGENT_SESSION_SUMMARY_API_KEY; else process.env.AGENT_SESSION_SUMMARY_API_KEY = originalSummary;
    if (originalMinimal === undefined) delete process.env.MINIMAL_AGENT_API_KEY; else process.env.MINIMAL_AGENT_API_KEY = originalMinimal;
  }
});
