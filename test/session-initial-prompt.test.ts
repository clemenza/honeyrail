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

async function withServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-initial-prompt-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  const tmuxCalls: any[] = [];
  bus.subscribe((event) => events.push(event));

  const app = createApp({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      startSession: async (input: any) => {
        tmuxCalls.push({ method: "startSession", input });
      },
      sendInput: async (target: string, text: string) => {
        tmuxCalls.push({ method: "sendInput", target, text });
      },
      sendKey: async (target: string, key: string) => {
        tmuxCalls.push({ method: "sendKey", target, key });
      },
      killSession: async () => {}
    } as any,
    worktrees: {
      create: async ({ project, title, agent }: any) => ({
        projectId: project.id,
        path: join(tempDir, "worktree"),
        branch: `${agent}/${title}`,
        title,
        agent
      })
    } as any,
    run: async () => ({ ok: true, stdout: "main\n", stderr: "" }),
    token: null,
    attachmentRoot: join(tempDir, "attachments")
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  const { port } = server.address() as AddressInfo;
  return { store, events, tmuxCalls, baseUrl: `http://127.0.0.1:${port}` };
}

async function readJson(response: Response) {
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  return response.json();
}

test("POST /api/sessions starts agent sessions with the initial prompt", async (t) => {
  const { store, events, tmuxCalls, baseUrl } = await withServer(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });

  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      agent: "codex",
      prompt: "respond to the first prompt",
      tmuxSessionName: "agw_initial"
    })
  });
  const body = await readJson(response);

  assert.equal(response.status, 201);
  assert.equal(body.session.prompt, "respond to the first prompt");
  assert.equal(tmuxCalls.length, 1);
  assert.equal(tmuxCalls[0].method, "startSession");
  assert.equal(tmuxCalls[0].input.name, "agw_initial");
  assert.equal(tmuxCalls[0].input.cwd, "/repo/demo");
  assert.equal(tmuxCalls[0].input.command, "codex 'respond to the first prompt'");
  assert.match(tmuxCalls[0].input.logPath, /\.agent-gateway\/sessions\/sess_.*\.log$/);
  assert.deepEqual(events.map((event) => event.type), ["session.created", "session.input_sent"]);
});

test("POST /api/sessions rejects unknown persisted project default agents", async (t) => {
  const { store, baseUrl } = await withServer(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "future-agent" as any
  });

  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id })
  });
  const body = await readJson(response);

  assert.equal(response.status, 400);
  assert.match(body.error, /Unknown agent backend: future-agent/);
});

test("POST /api/sessions accepts input and keys while waiting for operator action", async (t) => {
  const { store, tmuxCalls, baseUrl } = await withServer(t);
  const session = await store.createSession({
    projectId: "proj_1",
    name: "waiting approval",
    agent: "codex",
    tmuxSessionName: "agw_waiting",
    cwd: "/repo/demo",
    status: "waiting_approval"
  });

  const inputResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "continue" })
  });
  const keyResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "Escape" })
  });

  assert.equal(inputResponse.status, 200);
  assert.equal(keyResponse.status, 200);
  assert.deepEqual(tmuxCalls.slice(-2), [
    { method: "sendInput", target: "agw_waiting", text: "continue" },
    { method: "sendKey", target: "agw_waiting", key: "Escape" }
  ]);
});

test("PATCH /api/sessions/:id restarts running agent sessions through the adapter", async (t) => {
  const { store, tmuxCalls, baseUrl } = await withServer(t);
  const session = await store.createSession({
    projectId: "proj_1",
    name: "restart model",
    agent: "codex",
    prompt: "continue the task",
    model: null,
    tmuxSessionName: "agw_restart",
    cwd: "/repo/demo",
    status: "running"
  });

  const response = await fetch(`${baseUrl}/api/sessions/${session.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5-codex" })
  });
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.session.model, "gpt-5-codex");
  assert.equal(tmuxCalls.length, 1);
  assert.equal(tmuxCalls[0].method, "startSession");
  assert.equal(tmuxCalls[0].input.command, "codex --model 'gpt-5-codex' 'continue the task'");
});

test("POST /api/tasks starts the agent with the task prompt", async (t) => {
  const { store, events, tmuxCalls, baseUrl } = await withServer(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      title: "fix first prompt",
      prompt: "make the first task prompt respond",
      agent: "codex"
    })
  });
  await readJson(response);
  const startCall = tmuxCalls.find((call) => call.method === "startSession");

  assert.equal(response.status, 201);
  assert.equal(startCall.input.command, "codex 'make the first task prompt respond'");
  assert.equal(tmuxCalls.some((call) => call.method === "sendInput"), false);
  assert.deepEqual(events.map((event) => event.type), ["session.created", "session.input_sent", "task.started"]);
});

test("POST /api/tasks starts the agent with task image attachments", async (t) => {
  const { store, events, tmuxCalls, baseUrl } = await withServer(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "codex"
  });

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      title: "fix screenshot bug",
      prompt: "inspect this screenshot",
      agent: "codex",
      attachments: [
        {
          name: "failure.png",
          type: "image/png",
          dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lN7Z0wAAAABJRU5ErkJggg=="
        }
      ]
    })
  });
  const body = await readJson(response);
  const startCall = tmuxCalls.find((call) => call.method === "startSession");

  assert.equal(response.status, 201);
  assert.equal(body.session.prompt, "inspect this screenshot");
  assert.match(startCall.input.command, /^codex '/);
  assert.match(startCall.input.command, /inspect this screenshot Attached file paths:\s+1\. .*\/attachments\/img_[^/]+\.png/);
  assert.equal(tmuxCalls.some((call) => call.method === "sendInput"), false);
  const inputEvent = events.find((event) => event.type === "session.input_sent")!;
  assert.equal(inputEvent.payload.preview, "inspect this screenshot");
  assert.equal(inputEvent.payload.attachments.length, 1);
  assert.equal(inputEvent.payload.attachments[0].name, "failure.png");
  assert.match(inputEvent.payload.attachments[0].url, /^\/api\/attachments\/img_[^/]+\.png$/);
});

test("POST /api/tasks rejects unknown persisted project default agents before launching shell", async (t) => {
  const { store, tmuxCalls, baseUrl } = await withServer(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: "/repo/demo",
    defaultBranch: "main",
    defaultAgent: "future-agent" as any
  });

  const response = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      title: "unknown agent task",
      prompt: "do not launch shell"
    })
  });
  const body = await readJson(response);

  assert.equal(response.status, 400);
  assert.match(body.error, /Unknown agent backend: future-agent/);
  assert.equal(tmuxCalls.some((call) => call.method === "startSession"), false);
});
