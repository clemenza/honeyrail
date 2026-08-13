import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";
import {
  createProjectBody,
  createSessionBody,
  createTaskBody,
  createWorktreeBody,
  commitWorktreeBody,
  runChecksBody,
  discardWorktreeBody,
  mergeWorktreeBody,
  updateSessionBody,
  sessionInputBody,
  sessionKeyBody,
  sessionSummarizeBody,
  updateWorkspaceBody
} from "../server/validation.js";

test("createProjectBody accepts valid project inputs", () => {
  const result = createProjectBody.parse({
    name: "my-project",
    repoPath: "/home/user/project",
    defaultBranch: "main",
    defaultAgent: "codex",
    testCommands: ["npm test"],
    runCommands: ["npm start"]
  });
  assert.equal(result.name, "my-project");
  assert.equal(result.defaultAgent, "codex");
  assert.deepEqual(result.testCommands, ["npm test"]);
});

test("createProjectBody accepts an empty body", () => {
  const result = createProjectBody.parse({});
  assert.equal(result.name, undefined);
  assert.equal(result.repoPath, undefined);
});

test("createProjectBody rejects invalid agent type", () => {
  assert.throws(() => createProjectBody.parse({ defaultAgent: "gpt4" }), /invalid/i);
});

test("createProjectBody rejects non-string name", () => {
  assert.throws(() => createProjectBody.parse({ name: 123 }), /expected string/i);
});

test("createProjectBody rejects non-array testCommands", () => {
  assert.throws(() => createProjectBody.parse({ testCommands: "npm test" }), /expected array/i);
});

test("createSessionBody accepts valid session inputs", () => {
  const result = createSessionBody.parse({
    projectId: "proj_1",
    agent: "claude",
    name: "my session",
    prompt: "do stuff",
    model: "o3"
  });
  assert.equal(result.projectId, "proj_1");
  assert.equal(result.agent, "claude");
  assert.equal(result.model, "o3");
});

test("createSessionBody accepts an empty body", () => {
  const result = createSessionBody.parse({});
  assert.equal(result.agent, undefined);
});

test("createSessionBody accepts null worktreeId", () => {
  const result = createSessionBody.parse({ worktreeId: null });
  assert.equal(result.worktreeId, null);
});

test("createSessionBody rejects invalid agent", () => {
  assert.throws(() => createSessionBody.parse({ agent: "gpt" }), /invalid/i);
});

test("createTaskBody requires projectId", () => {
  assert.throws(() => createTaskBody.parse({}), /projectId/);
});

test("createTaskBody accepts valid task inputs", () => {
  const result = createTaskBody.parse({
    projectId: "proj_1",
    title: "fix bug",
    prompt: "fix the bug",
    agent: "codex"
  });
  assert.equal(result.projectId, "proj_1");
  assert.equal(result.agent, "codex");
});

test("createTaskBody rejects non-string projectId", () => {
  assert.throws(() => createTaskBody.parse({ projectId: 42 }), /expected string/i);
});

test("createWorktreeBody accepts valid inputs", () => {
  const result = createWorktreeBody.parse({ title: "task", agent: "codex", baseBranch: "develop" });
  assert.equal(result.title, "task");
  assert.equal(result.agent, "codex");
});

test("commitWorktreeBody accepts optional message", () => {
  assert.deepEqual(commitWorktreeBody.parse({}), {});
  assert.equal(commitWorktreeBody.parse({ message: "done" }).message, "done");
});

test("runChecksBody accepts optional commands array", () => {
  assert.deepEqual(runChecksBody.parse({}), {});
  assert.deepEqual(runChecksBody.parse({ commands: ["npm test"] }).commands, ["npm test"]);
});

test("discardWorktreeBody accepts boolean force", () => {
  assert.equal(discardWorktreeBody.parse({ force: true }).force, true);
  assert.equal(discardWorktreeBody.parse({}).force, undefined);
});

test("discardWorktreeBody rejects non-boolean force", () => {
  assert.throws(() => discardWorktreeBody.parse({ force: "yes" }), /expected boolean/i);
});

test("mergeWorktreeBody accepts optional targetBranch", () => {
  assert.deepEqual(mergeWorktreeBody.parse({}), {});
  assert.equal(mergeWorktreeBody.parse({ targetBranch: "main" }).targetBranch, "main");
});

test("updateSessionBody accepts nullable model", () => {
  assert.equal(updateSessionBody.parse({ model: null }).model, null);
  assert.equal(updateSessionBody.parse({ model: "o3" }).model, "o3");
  assert.equal(updateSessionBody.parse({}).model, undefined);
});

test("sessionInputBody accepts text and attachments", () => {
  const result = sessionInputBody.parse({
    text: "hello",
    attachments: [{ dataUrl: "data:image/png;base64,abc=", name: "img.png" }]
  });
  assert.equal(result.text, "hello");
  assert.equal(result.attachments!.length, 1);
  assert.equal(result.attachments![0].dataUrl, "data:image/png;base64,abc=");
});

test("sessionInputBody rejects non-string attachment dataUrl", () => {
  assert.throws(
    () => sessionInputBody.parse({ attachments: [{ dataUrl: 123 }] }),
    /expected string/i
  );
});

test("sessionKeyBody accepts optional key", () => {
  assert.deepEqual(sessionKeyBody.parse({}), {});
  assert.equal(sessionKeyBody.parse({ key: "C-c" }).key, "C-c");
});

test("sessionSummarizeBody accepts optional lines number", () => {
  assert.deepEqual(sessionSummarizeBody.parse({}), {});
  assert.equal(sessionSummarizeBody.parse({ lines: 300 }).lines, 300);
});

test("sessionSummarizeBody rejects non-number lines", () => {
  assert.throws(() => sessionSummarizeBody.parse({ lines: "300" }), /expected number/i);
});

test("updateWorkspaceBody requires path string", () => {
  assert.throws(() => updateWorkspaceBody.parse({}), /path/i);
  assert.equal(updateWorkspaceBody.parse({ path: "/tmp" }).path, "/tmp");
});

test("schemas strip unrecognized keys", () => {
  const result = createSessionBody.parse({ agent: "codex", _secret: "x", extra: true });
  assert.equal((result as Record<string, unknown>)._secret, undefined);
  assert.equal((result as Record<string, unknown>).extra, undefined);
  assert.equal(result.agent, "codex");
});

async function withServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-validation-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const app = createApp({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      capture: async () => "",
      startSession: async () => {},
      sendInput: async () => {},
      sendKey: async () => {},
      killSession: async () => {}
    } as any,
    worktrees: {} as any,
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
    token: null
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });
  const { port } = server.address() as AddressInfo;
  return { store, baseUrl: `http://127.0.0.1:${port}` };
}

test("POST /api/sessions rejects invalid agent type with 400", async (t) => {
  const { baseUrl } = await withServer(t);
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: "gpt4" })
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /invalid/i);
});

test("POST /api/tasks rejects missing projectId with 400", async (t) => {
  const { baseUrl } = await withServer(t);
  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "task without project" })
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /projectId/);
});

test("POST /api/sessions/:id/key rejects non-string key with 400", async (t) => {
  const { store, baseUrl } = await withServer(t);
  const session = await store.createSession({
    id: "sess_val",
    projectId: null,
    name: "validation test",
    agent: "shell",
    tmuxSessionName: "agw_val",
    cwd: "/tmp",
    status: "running"
  });
  const response = await fetch(`${baseUrl}/api/sessions/${session.id}/key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: 42 })
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /expected string/i);
});

test("POST /api/projects rejects non-boolean create field with 400", async (t) => {
  const { baseUrl } = await withServer(t);
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ create: "yes", name: "bad" })
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /expected boolean/i);
});

test("validation middleware strips unrecognized fields from the request body", async (t) => {
  const { store, baseUrl } = await withServer(t);
  const session = await store.createSession({
    id: "sess_strip",
    projectId: null,
    name: "strip test",
    agent: "shell",
    tmuxSessionName: "agw_strip",
    cwd: "/tmp",
    status: "running"
  });
  const response = await fetch(`${baseUrl}/api/sessions/${session.id}/key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "Enter", _inject: "malicious" })
  });
  assert.equal(response.status, 200);
});
