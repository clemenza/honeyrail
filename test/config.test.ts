import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_PORT, assertProductionAuth, collectNamingDeprecations, loadGatewayConfig, migrateLegacyHome } from "../server/config.js";

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
      /requires HONEYRAIL_SESSION_SECRET/
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

test("default port avoids the Agent Gateway runtime port", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-default-port-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  await withEnv({ HONEYRAIL_CONFIG: join(tempDir, "missing-config.json"), AGENT_GATEWAY_CONFIG: undefined, PORT: undefined }, async () => {
    const config = await loadGatewayConfig();
    assert.equal(config.port, DEFAULT_PORT);
    assert.notEqual(config.port, 4177);
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

  await withEnv({ HONEYRAIL_CONFIG: configPath, AGENT_GATEWAY_CONFIG: undefined, HONEYRAIL_DATA: undefined, AGENT_GATEWAY_DATA: undefined, HONEYRAIL_LEGACY_JSON_DATA: undefined, AGENT_GATEWAY_LEGACY_JSON_DATA: undefined }, async () => {
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

  await withEnv({ HONEYRAIL_CONFIG: configPath, AGENT_GATEWAY_CONFIG: undefined, HONEYRAIL_DATA: undefined, AGENT_GATEWAY_DATA: undefined, HONEYRAIL_LEGACY_JSON_DATA: undefined, AGENT_GATEWAY_LEGACY_JSON_DATA: undefined }, async () => {
    const config = await loadGatewayConfig();
    assert.equal(config.dataFile, join(tempDir, "state.sqlite"));
    assert.equal(config.legacyJsonDataFile, join(tempDir, "state.json"));
  });
});

test("HONEYRAIL_* env vars take precedence over AGENT_GATEWAY_* equivalents", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "hr-precedence-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const newConfig = join(tempDir, "new-config.json");
  const oldConfig = join(tempDir, "old-config.json");
  await writeFile(newConfig, JSON.stringify({}));
  await writeFile(oldConfig, JSON.stringify({}));

  await withEnv({
    HONEYRAIL_CONFIG: newConfig,
    AGENT_GATEWAY_CONFIG: oldConfig,
    HONEYRAIL_TOKEN: "new-token",
    AGENT_GATEWAY_TOKEN: "old-token",
    HONEYRAIL_DATA: undefined,
    AGENT_GATEWAY_DATA: undefined,
    HONEYRAIL_LEGACY_JSON_DATA: undefined,
    AGENT_GATEWAY_LEGACY_JSON_DATA: undefined,
  }, async () => {
    const config = await loadGatewayConfig();
    assert.equal(config.token, "new-token");
  });
});

test("old AGENT_GATEWAY_* env vars still work when HONEYRAIL_* are not set", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "hr-legacy-env-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const configPath = join(tempDir, "config.json");
  await writeFile(configPath, JSON.stringify({}));

  await withEnv({
    HONEYRAIL_CONFIG: undefined,
    AGENT_GATEWAY_CONFIG: configPath,
    HONEYRAIL_TOKEN: undefined,
    AGENT_GATEWAY_TOKEN: "legacy-token",
    HONEYRAIL_DATA: undefined,
    AGENT_GATEWAY_DATA: undefined,
    HONEYRAIL_LEGACY_JSON_DATA: undefined,
    AGENT_GATEWAY_LEGACY_JSON_DATA: undefined,
  }, async () => {
    const config = await loadGatewayConfig();
    assert.equal(config.token, "legacy-token");
  });
});

test("migrateLegacyHome copies ~/.agent-gateway to ~/.honeyrail when defaults are used", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "hr-migrate-home-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const oldHome = join(tempDir, ".agent-gateway");
  const newHome = join(tempDir, ".honeyrail");
  await mkdir(oldHome, { recursive: true });
  await writeFile(join(oldHome, "config.json"), JSON.stringify({ port: 4178 }));
  await writeFile(join(oldHome, "dummy.txt"), "test data");

  await withEnv({
    HOME: tempDir,
    HONEYRAIL_CONFIG: undefined, AGENT_GATEWAY_CONFIG: undefined,
    HONEYRAIL_DATA: undefined, AGENT_GATEWAY_DATA: undefined,
    HONEYRAIL_LEGACY_JSON_DATA: undefined, AGENT_GATEWAY_LEGACY_JSON_DATA: undefined,
    HONEYRAIL_ATTACHMENT_ROOT: undefined, AGENT_ATTACHMENT_ROOT: undefined,
    HONEYRAIL_SESSION_LOG_ROOT: undefined, AGENT_SESSION_LOG_ROOT: undefined,
  }, async () => {
    const migrated = await migrateLegacyHome();
    assert.equal(migrated, true);
    assert.ok(existsSync(newHome), "~/.honeyrail should exist after migration");
    assert.ok(existsSync(join(newHome, "config.json")), "config.json should be copied");
    assert.ok(existsSync(join(newHome, "dummy.txt")), "all files should be copied");
    assert.ok(existsSync(`${oldHome}.bak`), "~/.agent-gateway.bak should exist");
    assert.ok(!existsSync(oldHome), "~/.agent-gateway should be gone (renamed to .bak)");
  });
});

test("migrateLegacyHome rewrites absolute paths baked into config.json by npm run setup", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "hr-migrate-setup-config-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const oldHome = join(tempDir, ".agent-gateway");
  const newHome = join(tempDir, ".honeyrail");
  await mkdir(oldHome, { recursive: true });
  await mkdir(join(oldHome, "attachments"), { recursive: true });
  await mkdir(join(oldHome, "sessions"), { recursive: true });
  await writeFile(join(oldHome, "gateway.sqlite"), "real data");
  // npm run setup always writes fully-expanded absolute paths, even for accepted defaults.
  await writeFile(join(oldHome, "config.json"), JSON.stringify({
    port: 4178,
    dataFile: join(oldHome, "gateway.json"),
    attachmentRoot: join(oldHome, "attachments"),
    sessionLogRoot: join(oldHome, "sessions"),
    worktreeRoot: join(tempDir, "agent-worktrees")
  }));

  await withEnv({
    HOME: tempDir,
    HONEYRAIL_CONFIG: undefined, AGENT_GATEWAY_CONFIG: undefined,
    HONEYRAIL_DATA: undefined, AGENT_GATEWAY_DATA: undefined,
    HONEYRAIL_LEGACY_JSON_DATA: undefined, AGENT_GATEWAY_LEGACY_JSON_DATA: undefined,
    HONEYRAIL_ATTACHMENT_ROOT: undefined, AGENT_ATTACHMENT_ROOT: undefined,
    HONEYRAIL_SESSION_LOG_ROOT: undefined, AGENT_SESSION_LOG_ROOT: undefined,
  }, async () => {
    const migrated = await migrateLegacyHome();
    assert.equal(migrated, true);

    const rewritten = JSON.parse(await readFile(join(newHome, "config.json"), "utf8"));
    assert.equal(rewritten.dataFile, join(newHome, "gateway.json"));
    assert.equal(rewritten.attachmentRoot, join(newHome, "attachments"));
    assert.equal(rewritten.sessionLogRoot, join(newHome, "sessions"));
    // worktreeRoot was never under ~/.agent-gateway, so it must be left untouched.
    assert.equal(rewritten.worktreeRoot, join(tempDir, "agent-worktrees"));

    const config = await loadGatewayConfig();
    assert.equal(config.dataFile, join(newHome, "gateway.sqlite"));
    assert.equal(config.attachmentRoot, join(newHome, "attachments"));
    assert.equal(config.sessionLogRoot, join(newHome, "sessions"));
  });
});

test("migrateLegacyHome does not act when explicit env vars are set", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "hr-migrate-skip-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const oldHome = join(tempDir, ".agent-gateway");
  await mkdir(oldHome, { recursive: true });
  await writeFile(join(oldHome, "config.json"), "{}");

  await withEnv({
    HOME: tempDir,
    HONEYRAIL_CONFIG: join(tempDir, "custom-config.json"),
    AGENT_GATEWAY_CONFIG: undefined,
    HONEYRAIL_DATA: undefined, AGENT_GATEWAY_DATA: undefined,
    HONEYRAIL_LEGACY_JSON_DATA: undefined, AGENT_GATEWAY_LEGACY_JSON_DATA: undefined,
    HONEYRAIL_ATTACHMENT_ROOT: undefined, AGENT_ATTACHMENT_ROOT: undefined,
    HONEYRAIL_SESSION_LOG_ROOT: undefined, AGENT_SESSION_LOG_ROOT: undefined,
  }, async () => {
    const migrated = await migrateLegacyHome();
    assert.equal(migrated, false);
    assert.ok(existsSync(oldHome), "~/.agent-gateway should still exist");
  });
});

test("collectNamingDeprecations reports deprecated env vars", () => {
  const env = {
    AGENT_GATEWAY_TOKEN: "old-token",
    AGENT_GATEWAY_ACCOUNTS: '[]',
  } as unknown as NodeJS.ProcessEnv;
  const deps = collectNamingDeprecations(env);
  assert.ok(deps.length >= 2);
  assert.ok(deps.some((d) => d.old === "AGENT_GATEWAY_TOKEN" && d.new === "HONEYRAIL_TOKEN"));
  assert.ok(deps.some((d) => d.old === "AGENT_GATEWAY_ACCOUNTS" && d.new === "HONEYRAIL_ACCOUNTS"));
});

test("collectNamingDeprecations returns empty when only new vars are set", () => {
  const env = {
    HONEYRAIL_TOKEN: "new-token",
  } as unknown as NodeJS.ProcessEnv;
  const deps = collectNamingDeprecations(env);
  assert.equal(deps.length, 0);
});
