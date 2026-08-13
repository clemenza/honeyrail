import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertProductionAuth, loadGatewayConfig } from "../server/config.js";

async function withEnv(updates: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withNodeEnv(value: string | undefined, run: () => void | Promise<void>) {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

test("production mode requires token or accounts", async () => {
  await withNodeEnv("production", () => {
    assert.throws(
      () => assertProductionAuth({ token: null, accounts: null, sessionSecret: null }),
      /Production mode requires authentication/
    );
  });
});

test("production account auth requires a stable session secret", async () => {
  await withNodeEnv("production", () => {
    assert.throws(
      () => assertProductionAuth({ token: null, accounts: [{ username: "admin", password: "secret" }], sessionSecret: null }),
      /requires AGENT_GATEWAY_SESSION_SECRET/
    );
  });
});

test("production mode accepts bearer token auth", async () => {
  await withNodeEnv("production", () => {
    assert.doesNotThrow(() => assertProductionAuth({ token: "operator-token", accounts: null, sessionSecret: null }));
  });
});

test("development mode allows local unauthenticated startup", async () => {
  await withNodeEnv("development", () => {
    assert.doesNotThrow(() => assertProductionAuth({ token: null, accounts: null, sessionSecret: null }));
  });
});

test("legacy JSON dataFile config is treated as migration source", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-legacy-config-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "config.json");
  const legacyPath = join(tempDir, "gateway.json");
  await writeFile(configPath, JSON.stringify({
    dataFile: legacyPath,
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions"),
    worktreeRoot: join(tempDir, "worktrees")
  }));

  await withEnv({ AGENT_GATEWAY_CONFIG: configPath, AGENT_GATEWAY_DATA: undefined, AGENT_GATEWAY_LEGACY_JSON_DATA: undefined }, async () => {
    const config = await loadGatewayConfig();
    assert.equal(config.dataFile, join(tempDir, "gateway.sqlite"));
    assert.equal(config.legacyJsonDataFile, legacyPath);
  });
});

test("explicit SQLite dataFile keeps separate legacy JSON migration path", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-sqlite-config-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify({
    dataFile: join(tempDir, "state.sqlite"),
    legacyJsonDataFile: join(tempDir, "state.json"),
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions"),
    worktreeRoot: join(tempDir, "worktrees")
  }));

  await withEnv({ AGENT_GATEWAY_CONFIG: configPath, AGENT_GATEWAY_DATA: undefined, AGENT_GATEWAY_LEGACY_JSON_DATA: undefined }, async () => {
    const config = await loadGatewayConfig();
    assert.equal(config.dataFile, join(tempDir, "state.sqlite"));
    assert.equal(config.legacyJsonDataFile, join(tempDir, "state.json"));
  });
});
