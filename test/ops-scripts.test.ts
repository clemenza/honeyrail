import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

test("ops start builds assets before launching the tmux server", async () => {
  const script = await readFile(join(root, "scripts", "start.sh"), "utf8");
  const alreadyRunningIndex = script.indexOf("HoneyRail already running");
  const buildIndex = script.indexOf("npm run build");
  const launchIndex = script.indexOf("new-session -d -s");

  assert.ok(alreadyRunningIndex > -1, "start.sh should keep the existing-service fast path");
  assert.ok(buildIndex > -1, "start.sh should build before starting the server");
  assert.ok(launchIndex > -1, "start.sh should launch the tmux server");
  assert.ok(alreadyRunningIndex < buildIndex, "existing running services should not be rebuilt by start.sh");
  assert.ok(buildIndex < launchIndex, "fresh starts should build before launching tmux");
});
