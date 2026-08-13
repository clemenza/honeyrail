import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";

const AUTH_TOKEN = "test-mcp-token";

async function withServer(t: TestContext, options: Record<string, unknown> = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-mcp-http-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const app = createApp({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      startSession: async () => {},
      sendInput: async () => {},
      sendLiteral: async () => {},
      sendKey: async () => {},
      killSession: async () => {},
      capture: async () => "output",
      stream: () => {
        throw new Error("not implemented in test");
      },
    } as any,
    worktrees: {
      create: async ({ project, title, agent }: any) => ({
        projectId: project.id, path: "/tmp/wt", branch: `${agent}/${title}`,
        baseBranch: "main", baseRevision: "abc000", title, agent,
      }),
      diff: async () => ({ diff: "+line", diffStat: "1 file", status: "M file", commits: "abc" }),
      commit: async () => ({ message: "done", headRevision: "abc123", stdout: "", stderr: "" }),
      runChecks: async () => ({ ok: true, runs: [] }),
      merge: async () => ({ branch: "x", targetBranch: "main", stdout: "", stderr: "" }),
      discard: async () => ({ path: "/tmp/wt", branch: "x", removed: "", branchDeleted: true, branchDeleteOutput: "" }),
    } as any,
    run: async () => ({ ok: true, stdout: "main\n", stderr: "" }),
    token: AUTH_TOKEN,
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions"),
    ...options,
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

function authHeaders(extra: Record<string, string> = {}) {
  return { "content-type": "application/json", authorization: `Bearer ${AUTH_TOKEN}`, ...extra };
}

function initializeBody(id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
}

function toolsListBody(id = 2) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  });
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function initializeSession(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders({ accept: "application/json, text/event-stream" }),
    body: initializeBody(),
  });
  assert.ok(res.ok, `Initialize failed: ${res.status}`);
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "Expected mcp-session-id header in response");

  // Consume SSE body to avoid hanging connections
  await res.text();

  // Send initialized notification
  await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders({ "mcp-session-id": sessionId }),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  return sessionId;
}

test("POST /api/mcp initialize returns mcp-session-id header", async (t) => {
  const { baseUrl } = await withServer(t);
  const sessionId = await initializeSession(baseUrl);
  assert.ok(sessionId);
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
});

test("POST /api/mcp tools/list returns all registered tools", async (t) => {
  const { baseUrl } = await withServer(t);
  const sessionId = await initializeSession(baseUrl);

  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders({ "mcp-session-id": sessionId, accept: "application/json, text/event-stream" }),
    body: toolsListBody(),
  });
  assert.ok(res.ok, `tools/list failed: ${res.status}`);

  const body = await res.text();
  // Response is SSE — extract the JSON-RPC result from the data line
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine, "Expected SSE data line in response");
  const rpcResult = JSON.parse(dataLine.slice(6));
  assert.ok(rpcResult.result.tools.length >= 17, `Expected at least 17 tools, got ${rpcResult.result.tools.length}`);
  const names = rpcResult.result.tools.map((tool: any) => tool.name);
  assert.ok(names.includes("list_projects"));
  assert.ok(names.includes("create_agent_task"));
  assert.ok(names.includes("propose_merge"));
  assert.ok(names.includes("approve_merge"));
});

test("POST /api/mcp without session ID and non-initialize body returns 400", async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders(),
    body: toolsListBody(),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test("POST /api/mcp requires authentication", async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: initializeBody(),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") || "", /oauth-protected-resource/);
});

test("OAuth metadata advertises protected MCP resource and authorization server", async (t) => {
  const { baseUrl } = await withServer(t);
  const resourceRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(resourceRes.status, 200);
  const resource = await resourceRes.json();
  assert.equal(resource.resource, `${baseUrl}/api/mcp`);
  assert.deepEqual(resource.authorization_servers, [baseUrl]);
  assert.deepEqual(resource.scopes_supported, ["mcp:read", "mcp:write"]);

  const authRes = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(authRes.status, 200);
  const metadata = await authRes.json();
  assert.equal(metadata.issuer, baseUrl);
  assert.equal(metadata.authorization_endpoint, `${baseUrl}/oauth/authorize`);
  assert.equal(metadata.token_endpoint, `${baseUrl}/oauth/token`);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
});

test("OAuth authorization-code token can access MCP", async (t) => {
  const { baseUrl } = await withServer(t, {
    token: null,
    accounts: [{ username: "admin", password: "secret", permissions: ["console", "admin"] }],
    sessionSecret: "test-session-secret",
  });
  const { verifier, challenge } = pkcePair();
  const redirectUri = `${baseUrl}/callback`;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "https://chatgpt.com/oauth/test-client/client.json",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${baseUrl}/api/mcp`,
    scope: "mcp:read mcp:write",
    state: "state-1",
    username: "admin",
    password: "secret",
  });

  const authorizeRes = await fetch(`${baseUrl}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "manual",
  });
  assert.equal(authorizeRes.status, 302);
  const location = authorizeRes.headers.get("location");
  assert.ok(location, "Expected OAuth redirect");
  const redirect = new URL(location);
  assert.equal(`${redirect.origin}${redirect.pathname}`, redirectUri);
  assert.equal(redirect.searchParams.get("state"), "state-1");
  const code = redirect.searchParams.get("code");
  assert.ok(code, "Expected authorization code");

  const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: "https://chatgpt.com/oauth/test-client/client.json",
      resource: `${baseUrl}/api/mcp`,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const tokenBody = await tokenRes.json();
  assert.equal(tokenBody.token_type, "Bearer");
  assert.equal(tokenBody.scope, "mcp:read mcp:write");
  assert.ok(tokenBody.access_token);

  const initRes = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${tokenBody.access_token}`,
    },
    body: initializeBody(),
  });
  assert.ok(initRes.ok, `Initialize with OAuth token failed: ${initRes.status}`);
  assert.ok(initRes.headers.get("mcp-session-id"));
  await initRes.text();
});

test("DELETE /api/mcp terminates session", async (t) => {
  const { baseUrl } = await withServer(t);
  const sessionId = await initializeSession(baseUrl);

  const deleteRes = await fetch(`${baseUrl}/api/mcp`, {
    method: "DELETE",
    headers: authHeaders({ "mcp-session-id": sessionId }),
  });
  assert.ok(deleteRes.ok || deleteRes.status === 200 || deleteRes.status === 204,
    `DELETE failed: ${deleteRes.status}`);
  await deleteRes.text();

  // Subsequent request with that session ID should fail
  const postRes = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders({ "mcp-session-id": sessionId }),
    body: toolsListBody(),
  });
  // Transport is gone — either 400 (our code) or 404 (SDK session validation)
  assert.ok(postRes.status >= 400, `Expected error after DELETE, got ${postRes.status}`);
});

test("GET /api/mcp without session ID returns 400", async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/mcp`, {
    headers: authHeaders(),
  });
  assert.equal(res.status, 400);
});

test("POST /api/mcp tool call executes against shared backend", async (t) => {
  const { baseUrl, store } = await withServer(t);
  const sessionId = await initializeSession(baseUrl);

  // Create a project via MCP tool call
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders({ "mcp-session-id": sessionId, accept: "application/json, text/event-stream" }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_project",
        arguments: { name: "mcp-test", repoPath: "/tmp/mcp-test" },
      },
    }),
  });
  assert.ok(res.ok, `tool call failed: ${res.status}`);

  const body = await res.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine, "Expected SSE data line");
  const rpcResult = JSON.parse(dataLine.slice(6));
  const toolResult = JSON.parse(rpcResult.result.content[0].text);
  assert.ok(toolResult.project.id);
  assert.equal(toolResult.project.name, "mcp-test");

  // Verify the project exists in the shared store
  const projects = await store.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "mcp-test");
});

test("CORS exposes mcp-session-id header", async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: authHeaders({ accept: "application/json, text/event-stream" }),
    body: initializeBody(),
  });
  const exposed = res.headers.get("access-control-expose-headers") || "";
  assert.ok(exposed.toLowerCase().includes("mcp-session-id"),
    `Expected mcp-session-id in exposed headers, got: ${exposed}`);
});
