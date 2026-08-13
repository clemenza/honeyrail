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

async function withServer(t: TestContext, { tmux }: { tmux?: any } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-delete-session-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const events: any[] = [];
  bus.subscribe((event) => events.push(event));

  const app = createApp({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      killSession: async () => {},
      ...(tmux || {})
    } as any,
    worktrees: {} as any,
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
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
  const baseUrl = `http://127.0.0.1:${port}`;
  return { store, events, baseUrl };
}

async function readJson(response: Response) {
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  return response.json();
}

test("DELETE /api/sessions/:id kills and removes a running session", async (t) => {
  const killed: string[] = [];
  const { store, events, baseUrl } = await withServer(t, {
    tmux: {
      killSession: async (target: string) => killed.push(target)
    }
  });
  const session = await store.createSession({
    projectId: "proj_1",
    name: "active agent",
    agent: "codex",
    tmuxSessionName: "agw_active",
    cwd: "/tmp",
    status: "running"
  });

  const response = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(killed, ["agw_active"]);
  assert.equal(await store.getSession(session.id), undefined);
  assert.equal(events.at(-1).type, "session.deleted");
  assert.equal(events.at(-1).sessionId, session.id);
});

test("DELETE /api/sessions/:id removes stale running sessions when tmux kill fails", async (t) => {
  const { store, baseUrl } = await withServer(t, {
    tmux: {
      killSession: async () => {
        throw new Error("can't find session");
      }
    }
  });
  const session = await store.createSession({
    projectId: "proj_1",
    name: "stale agent",
    agent: "codex",
    tmuxSessionName: "agw_stale",
    cwd: "/tmp",
    status: "running"
  });

  const response = await fetch(`${baseUrl}/api/sessions/${session.id}`, { method: "DELETE" });
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(await store.getSession(session.id), undefined);
});

test("DELETE /api/sessions/:id returns 404 for an unknown session", async (t) => {
  const { store, baseUrl } = await withServer(t);

  const response = await fetch(`${baseUrl}/api/sessions/missing`, { method: "DELETE" });
  const body = await readJson(response);

  assert.equal(response.status, 404);
  assert.equal(body.error, "Session not found");
  assert.deepEqual(await store.listSessions(), []);
});
