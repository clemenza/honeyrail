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

async function withServer(t: TestContext, { run }: { run?: any } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-projects-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  const commands: any[] = [];
  bus.subscribe((event) => events.push(event));

  const defaultRun = async (cmd: string, args: string[] = [], options: any = {}) => {
    commands.push({ cmd, args, cwd: options.cwd });
    if (cmd === "git" && args.join(" ") === "branch --show-current") {
      return { ok: true, stdout: "main\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const app = createApp({
    store,
    bus,
    tmux: { listSessions: async () => [] } as any,
    worktrees: {} as any,
    run: run || defaultRun,
    token: null,
    attachmentRoot: join(tempDir, "attachments"),
    defaultWorkspace: join(tempDir, "workspace")
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { store, events, commands, tempDir, baseUrl };
}

async function readJson(response: Response) {
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  return response.json();
}

test("GET and PUT /api/projects/workspace manage the default workspace", async (t) => {
  const { baseUrl, tempDir } = await withServer(t);
  const nextWorkspace = join(tempDir, "custom-workspace");

  const initialResponse = await fetch(`${baseUrl}/api/projects/workspace`);
  const initialBody = await readJson(initialResponse);
  const updateResponse = await fetch(`${baseUrl}/api/projects/workspace`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: nextWorkspace })
  });
  const updateBody = await readJson(updateResponse);

  assert.equal(initialResponse.status, 200);
  assert.equal(initialBody.workspace.path, join(tempDir, "workspace"));
  assert.equal(updateResponse.status, 200);
  assert.equal(updateBody.workspace.path, nextWorkspace);
});

test("POST /api/projects creates a new git project inside the default workspace", async (t) => {
  const { baseUrl, commands, tempDir } = await withServer(t);

  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Demo Project", create: true })
  });
  const body = await readJson(response);
  const repoPath = join(tempDir, "workspace", "demo-project");

  assert.equal(response.status, 201);
  assert.equal(body.project.name, "Demo Project");
  assert.equal(body.project.repoPath, repoPath);
  assert.ok(commands.some((call) => call.cmd === "git" && call.args[0] === "init" && call.cwd === repoPath));
});

test("POST /api/projects creates a new git project at a specified path", async (t) => {
  const { baseUrl, commands, tempDir } = await withServer(t);
  const repoPath = join(tempDir, "custom", "target-repo");

  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoPath, create: true, name: "Target Repo" })
  });
  const body = await readJson(response);

  assert.equal(response.status, 201);
  assert.equal(body.project.repoPath, repoPath);
  assert.ok(commands.some((call) => call.cmd === "git" && call.args[0] === "init" && call.cwd === repoPath));
});

test("DELETE /api/projects/:id unregisters a project without deleting its directory", async (t) => {
  const { store, events, baseUrl, tempDir } = await withServer(t);
  const project = await store.createProject({
    name: "demo",
    repoPath: join(tempDir, "workspace", "demo"),
    defaultBranch: "main",
    defaultAgent: "codex"
  });

  const response = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: "DELETE" });
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(await store.getProject(project.id), undefined);
  assert.equal(events.at(-1).type, "project.unregistered");
  assert.equal(events.at(-1).projectId, project.id);
});
