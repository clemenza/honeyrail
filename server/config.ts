import { cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Account } from "./auth.js";
import { expandHome } from "./utils.js";

export type GatewayConfig = {
  port: number;
  dataFile: string;
  legacyJsonDataFile: string;
  worktreeRoot: string;
  attachmentRoot: string;
  sessionLogRoot: string;
  token?: string | null;
  accounts?: Account[] | string | null;
  sessionSecret?: string | null;
  publicBaseUrl?: string | null;
  healthCheckIntervalMs: number;
  sessionStaleMs: number;
  orchestrationPollIntervalMs: number;
};

export const DEFAULT_PORT = 4178;

type RawGatewayConfig = Partial<GatewayConfig> & Record<string, unknown>;

function parseNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmpty(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function hasConfiguredAccounts(accounts: GatewayConfig["accounts"]) {
  if (Array.isArray(accounts)) return accounts.length > 0;
  return Boolean(nonEmpty(accounts));
}

function looksLikeLegacyJsonDataFile(path: string) {
  return path.trim().toLowerCase().endsWith(".json");
}

function sqlitePathForLegacyJson(path: string) {
  return path.replace(/\.json$/i, ".sqlite");
}

async function readConfigFile(path: string): Promise<RawGatewayConfig> {
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function resolveEnv(env: NodeJS.ProcessEnv, newKey: string, oldKey: string) {
  if (nonEmpty(env[newKey])) return { value: env[newKey]!, deprecatedKey: null };
  if (nonEmpty(env[oldKey])) return { value: env[oldKey]!, deprecatedKey: oldKey };
  return { value: undefined, deprecatedKey: null };
}

const ENV_RENAME_MAP: [string, string][] = [
  ["HONEYRAIL_CONFIG", "AGENT_GATEWAY_CONFIG"],
  ["HONEYRAIL_DATA", "AGENT_GATEWAY_DATA"],
  ["HONEYRAIL_LEGACY_JSON_DATA", "AGENT_GATEWAY_LEGACY_JSON_DATA"],
  ["HONEYRAIL_ATTACHMENT_ROOT", "AGENT_ATTACHMENT_ROOT"],
  ["HONEYRAIL_SESSION_LOG_ROOT", "AGENT_SESSION_LOG_ROOT"],
  ["HONEYRAIL_WORKTREE_ROOT", "AGENT_WORKTREE_ROOT"],
  ["HONEYRAIL_TOKEN", "AGENT_GATEWAY_TOKEN"],
  ["HONEYRAIL_ACCOUNTS", "AGENT_GATEWAY_ACCOUNTS"],
  ["HONEYRAIL_SESSION_SECRET", "AGENT_GATEWAY_SESSION_SECRET"],
  ["HONEYRAIL_PUBLIC_BASE_URL", "AGENT_GATEWAY_PUBLIC_BASE_URL"],
  ["HONEYRAIL_HEALTH_INTERVAL_MS", "AGENT_HEALTH_INTERVAL_MS"],
  ["HONEYRAIL_SESSION_STALE_MS", "AGENT_SESSION_STALE_MS"],
  ["HONEYRAIL_ORCHESTRATION_POLL_INTERVAL_MS", "AGENT_ORCHESTRATION_POLL_INTERVAL_MS"],
];

export function collectNamingDeprecations(env: NodeJS.ProcessEnv = process.env): { old: string; new: string }[] {
  const deprecations: { old: string; new: string }[] = [];
  for (const [newKey, oldKey] of ENV_RENAME_MAP) {
    if (nonEmpty(env[oldKey]) && !nonEmpty(env[newKey])) {
      deprecations.push({ old: oldKey, new: newKey });
    }
  }
  return deprecations;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const MIGRATED_CONFIG_PATH_KEYS = ["dataFile", "legacyJsonDataFile", "attachmentRoot", "sessionLogRoot"] as const;

// `npm run setup` always writes fully-expanded absolute paths into config.json, even for
// defaults (see setup.ts). A plain directory copy leaves those pointing at the old home, so
// the app silently falls back to freshly-created empty state under the (now-renamed) old path.
// Rewrite any of those fields that were pointing inside the old home to point inside the new one.
async function rewriteMigratedConfigPaths(newHome: string, oldHome: string) {
  const configPath = resolve(newHome, "config.json");
  let raw: RawGatewayConfig;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return;
  }

  let changed = false;
  for (const key of MIGRATED_CONFIG_PATH_KEYS) {
    const value = raw[key];
    if (typeof value !== "string") continue;
    const resolved = resolve(expandHome(value) || "");
    if (resolved !== oldHome && !resolved.startsWith(`${oldHome}/`)) continue;
    (raw as Record<string, unknown>)[key] = newHome + resolved.slice(oldHome.length);
    changed = true;
  }

  if (changed) await writeFile(configPath, JSON.stringify(raw, null, 2));
}

export async function migrateLegacyHome(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const oldHome = resolve(expandHome("~/.agent-gateway") || "");
  const newHome = resolve(expandHome("~/.honeyrail") || "");

  const explicitKeys = [
    "HONEYRAIL_CONFIG", "AGENT_GATEWAY_CONFIG",
    "HONEYRAIL_DATA", "AGENT_GATEWAY_DATA",
    "HONEYRAIL_LEGACY_JSON_DATA", "AGENT_GATEWAY_LEGACY_JSON_DATA",
    "HONEYRAIL_ATTACHMENT_ROOT", "AGENT_ATTACHMENT_ROOT",
    "HONEYRAIL_SESSION_LOG_ROOT", "AGENT_SESSION_LOG_ROOT",
  ];
  for (const key of explicitKeys) {
    if (nonEmpty(env[key])) return false;
  }

  if (!(await pathExists(oldHome)) || await pathExists(newHome)) return false;

  await cp(oldHome, newHome, { recursive: true });
  await rewriteMigratedConfigPaths(newHome, oldHome);
  await rename(oldHome, `${oldHome}.bak`);
  console.warn(`[honeyrail] Migrated ~/.agent-gateway to ~/.honeyrail (backup at ~/.agent-gateway.bak)`);
  return true;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const { value } = resolveEnv(env, "HONEYRAIL_CONFIG", "AGENT_GATEWAY_CONFIG");
  return resolve(expandHome(value || "~/.honeyrail/config.json") || "");
}

export async function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): Promise<GatewayConfig> {
  await migrateLegacyHome(env);

  const fileConfig = await readConfigFile(defaultConfigPath(env));

  const dataEnv = resolveEnv(env, "HONEYRAIL_DATA", "AGENT_GATEWAY_DATA");
  const legacyJsonEnv = resolveEnv(env, "HONEYRAIL_LEGACY_JSON_DATA", "AGENT_GATEWAY_LEGACY_JSON_DATA");
  const attachmentEnv = resolveEnv(env, "HONEYRAIL_ATTACHMENT_ROOT", "AGENT_ATTACHMENT_ROOT");
  const sessionLogEnv = resolveEnv(env, "HONEYRAIL_SESSION_LOG_ROOT", "AGENT_SESSION_LOG_ROOT");
  const worktreeEnv = resolveEnv(env, "HONEYRAIL_WORKTREE_ROOT", "AGENT_WORKTREE_ROOT");
  const tokenEnv = resolveEnv(env, "HONEYRAIL_TOKEN", "AGENT_GATEWAY_TOKEN");
  const accountsEnv = resolveEnv(env, "HONEYRAIL_ACCOUNTS", "AGENT_GATEWAY_ACCOUNTS");
  const secretEnv = resolveEnv(env, "HONEYRAIL_SESSION_SECRET", "AGENT_GATEWAY_SESSION_SECRET");
  const baseUrlEnv = resolveEnv(env, "HONEYRAIL_PUBLIC_BASE_URL", "AGENT_GATEWAY_PUBLIC_BASE_URL");
  const healthEnv = resolveEnv(env, "HONEYRAIL_HEALTH_INTERVAL_MS", "AGENT_HEALTH_INTERVAL_MS");
  const staleEnv = resolveEnv(env, "HONEYRAIL_SESSION_STALE_MS", "AGENT_SESSION_STALE_MS");
  const orchEnv = resolveEnv(env, "HONEYRAIL_ORCHESTRATION_POLL_INTERVAL_MS", "AGENT_ORCHESTRATION_POLL_INTERVAL_MS");

  const configuredDataFile = dataEnv.value || fileConfig.dataFile as string || "~/.honeyrail/gateway.sqlite";
  const configuredLegacyJsonDataFile = legacyJsonEnv.value || fileConfig.legacyJsonDataFile as string || "~/.honeyrail/gateway.json";
  const dataFileIsLegacyJson = looksLikeLegacyJsonDataFile(configuredDataFile);
  const dataFile = resolve(expandHome(dataFileIsLegacyJson ? sqlitePathForLegacyJson(configuredDataFile) : configuredDataFile) || "");
  const legacyJsonDataFile = resolve(expandHome(dataFileIsLegacyJson ? configuredDataFile : configuredLegacyJsonDataFile) || "");
  const attachmentRoot = resolve(expandHome(attachmentEnv.value || fileConfig.attachmentRoot as string || "~/.honeyrail/attachments") || "");
  const sessionLogRoot = resolve(expandHome(sessionLogEnv.value || fileConfig.sessionLogRoot as string || "~/.honeyrail/sessions") || "");
  const worktreeRoot = resolve(expandHome(worktreeEnv.value || fileConfig.worktreeRoot as string || "~/agent-worktrees") || "");

  return {
    port: parseNumber(env.PORT || fileConfig.port, DEFAULT_PORT),
    dataFile,
    legacyJsonDataFile,
    worktreeRoot,
    attachmentRoot,
    sessionLogRoot,
    token: nonEmpty(tokenEnv.value) || fileConfig.token as string || null,
    accounts: accountsEnv.value || fileConfig.accounts as Account[] | string || null,
    sessionSecret: nonEmpty(secretEnv.value) || fileConfig.sessionSecret as string || null,
    publicBaseUrl: nonEmpty(baseUrlEnv.value) || fileConfig.publicBaseUrl as string || null,
    healthCheckIntervalMs: parseNumber(healthEnv.value || fileConfig.healthCheckIntervalMs, 15000),
    sessionStaleMs: parseNumber(staleEnv.value || fileConfig.sessionStaleMs, 1000 * 60 * 30),
    orchestrationPollIntervalMs: parseNumber(orchEnv.value || fileConfig.orchestrationPollIntervalMs, 3000)
  };
}

export function assertProductionAuth(config: Pick<GatewayConfig, "accounts" | "token" | "sessionSecret">) {
  if (process.env.NODE_ENV !== "production") return;
  if (config.token || hasConfiguredAccounts(config.accounts)) {
    if (!config.token && !config.sessionSecret) {
      throw new Error("Production account auth requires HONEYRAIL_SESSION_SECRET (or legacy AGENT_GATEWAY_SESSION_SECRET) or sessionSecret in config.json.");
    }
    return;
  }
  throw new Error(
    "Production mode requires authentication. Configure HONEYRAIL_TOKEN, HONEYRAIL_ACCOUNTS, or run `npm run setup`."
  );
}

export async function ensureRuntimeDirectories(config: Pick<GatewayConfig, "dataFile" | "legacyJsonDataFile" | "worktreeRoot" | "attachmentRoot" | "sessionLogRoot">) {
  await mkdir(dirname(config.dataFile), { recursive: true });
  await mkdir(dirname(config.legacyJsonDataFile), { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });
  await mkdir(config.attachmentRoot, { recursive: true });
  await mkdir(config.sessionLogRoot, { recursive: true });
}
