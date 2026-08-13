import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeSubscriptionEnvOverrides } from "../server/agents/claude.js";
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
  assert.deepEqual(knownAgentIds(), ["shell", "codex", "claude", "hermes"]);
  const adapters = listAgentAdapters();
  assert.equal(adapters.length, 4);
  assert.equal(getAgentAdapter("codex").stability, "stable");
  assert.equal(getAgentAdapter("claude").stability, "stable");
  assert.equal(getAgentAdapter("shell").capabilities.modelSelection, false);
  assert.equal(getAgentAdapter("hermes").stability, "experimental");
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
