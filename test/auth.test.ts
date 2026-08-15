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

async function withServer(t: TestContext, options: any = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-auth-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const app = createApp({
    store,
    bus,
    tmux: { listSessions: async () => [] },
    worktrees: {},
    run: async () => ({ ok: true, stdout: "", stderr: "" }),
    attachmentRoot: join(tempDir, "attachments"),
    sessionSecret: "test-secret",
    ...options
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function readJson(response: Response) {
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  return response.json();
}

function sessionCookie(response: Response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

test("console APIs require login when accounts are configured", async (t) => {
  const { baseUrl } = await withServer(t, {
    token: null,
    accounts: [{ username: "admin", password: "secret", permissions: ["console"] }]
  });

  const response = await fetch(`${baseUrl}/api/dashboard`);
  const body = await readJson(response);

  assert.equal(response.status, 401);
  assert.equal(body.error, "Unauthorized");
});

test("users without console permission cannot sign in to console", async (t) => {
  const { baseUrl } = await withServer(t, {
    token: null,
    accounts: [{ username: "viewer", password: "secret", permissions: ["read"] }]
  });

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "viewer", password: "secret" })
  });
  const body = await readJson(response);

  assert.equal(response.status, 403);
  assert.equal(body.error, "User does not have console access");
});

test("users with console permission can access console APIs after login", async (t) => {
  const { baseUrl } = await withServer(t, {
    token: null,
    accounts: [{ username: "admin", password: "secret", permissions: ["console"] }]
  });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret" })
  });
  const cookie = sessionCookie(login);
  const response = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { cookie }
  });
  const body = await readJson(response);

  assert.equal(login.status, 200);
  assert.ok(cookie.startsWith("honeyrail_session="));
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["events", "projects", "runs", "sessions", "tasks", "tmuxSessions", "worktrees"].sort());
});

test("login cookies are not marked secure for direct HTTP access", async (t) => {
  const { baseUrl } = await withServer(t, {
    token: null,
    accounts: [{ username: "admin", password: "secret", permissions: ["console"] }]
  });

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "secret" })
  });
  const cookie = response.headers.get("set-cookie") || "";

  assert.equal(response.status, 200);
  assert.match(cookie, /honeyrail_session=/);
  assert.doesNotMatch(cookie, /;\s*Secure/i);
});

test("login cookies are marked secure behind an HTTPS proxy", async (t) => {
  const { baseUrl } = await withServer(t, {
    token: null,
    accounts: [{ username: "admin", password: "secret", permissions: ["console"] }]
  });

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-proto": "https"
    },
    body: JSON.stringify({ username: "admin", password: "secret" })
  });
  const cookie = response.headers.get("set-cookie") || "";

  assert.equal(response.status, 200);
  assert.match(cookie, /;\s*Secure/i);
});

test("bearer token access remains available for API clients", async (t) => {
  const { baseUrl } = await withServer(t, {
    token: "operator-token",
    accounts: [{ username: "admin", password: "secret", permissions: ["console"] }]
  });

  const response = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { authorization: "Bearer operator-token" }
  });

  assert.equal(response.status, 200);
});
