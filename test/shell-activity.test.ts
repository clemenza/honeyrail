import assert from "node:assert/strict";
import { test } from "node:test";

import { agentActivityText } from "../src/activity.js";

test("running shell sessions render cleaned terminal output in the main transcript", () => {
  const output = [
    "humezhang@MacBook-Pro-M3:~/repo|main$",
    "→ ls",
    "action.yml                 LICENSE",
    "AGENTS.md                  Makefile",
    "README.md",
    "humezhang@MacBook-Pro-M3:~/repo|main$"
  ].join("\n");

  const activity = agentActivityText({
    selected: { agent: "shell", status: "running" },
    selectedIsRunning: true,
    output,
    userPrompts: [{ payload: { preview: "ls" } }]
  });

  assert.match(activity!, /action\.yml/);
  assert.match(activity!, /AGENTS\.md/);
  assert.doesNotMatch(activity!, /Waiting for activity/);
  assert.doesNotMatch(activity!, /humezhang@MacBook-Pro-M3/);
});

test("running shell sessions stay quiet until terminal output exists", () => {
  const activity = agentActivityText({
    selected: { agent: "shell", status: "running" },
    selectedIsRunning: true,
    output: "humezhang@MacBook-Pro-M3:~/repo|main$",
    userPrompts: [{ payload: { preview: "pwd" } }]
  });

  assert.equal(activity, null);
});
