import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readProjectFile = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("chat workspace has no automatic agent prompt panel renderer", async () => {
  const source = await readProjectFile("src/main.tsx");

  assert.equal(source.includes("function detectAgentPrompt"), false);
  assert.equal(source.includes("agentPrompt"), false);
  assert.equal(source.includes("agent-prompt-card"), false);
  assert.equal(source.includes("MCP selection prompt"), false);
  assert.equal(source.includes("Codex update prompt"), false);
  assert.equal(source.includes("Claude permission prompt"), false);
});

test("removed agent prompt panel styles do not come back", async () => {
  const styles = await readProjectFile("src/styles.css");

  assert.equal(styles.includes(".agent-prompt-card"), false);
  assert.equal(styles.includes(".agent-prompt-actions"), false);
});

test("chat transcript uses terminal view instead of inline details", async () => {
  const source = await readProjectFile("src/components/ChatWorkspace.tsx");

  assert.equal(source.includes('className="runtime-log"'), false);
  assert.equal(source.includes("<summary>Details</summary>"), false);
  assert.equal(source.includes("cleanRuntimeOutput"), true);
  assert.equal(source.includes("Terminal transcript"), true);
  assert.equal(source.includes('className="terminal-view"'), true);
});

test("chat workspace replaces the log button with a session summary action", async () => {
  const source = await readProjectFile("src/components/ChatWorkspace.tsx");

  assert.equal(source.includes("> Log"), false);
  assert.equal(source.includes("Session summary"), true);
  assert.equal(source.includes(`/api/sessions/${"${selected.id}"}/summarize`), true);
  assert.equal(source.includes("summary-view"), true);
});

test("shell sessions do not render stale waiting activity", async () => {
  const source = await readProjectFile("src/activity.ts");

  assert.equal(source.includes("Sent. Waiting for activity."), false);
  assert.equal(source.includes('selected.agent === "shell"'), true);
  assert.equal(source.includes("Shell session is"), true);
});
