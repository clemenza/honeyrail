import { mkdir, readFile } from "node:fs/promises";
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

export function defaultConfigPath() {
  return resolve(expandHome(process.env.AGENT_GATEWAY_CONFIG || "~/.agent-gateway/config.json") || "");
}

export async function loadGatewayConfig(): Promise<GatewayConfig> {
  const fileConfig = await readConfigFile(defaultConfigPath());
  const configuredDataFile = process.env.AGENT_GATEWAY_DATA || fileConfig.dataFile as string || "~/.agent-gateway/gateway.sqlite";
  const configuredLegacyJsonDataFile = process.env.AGENT_GATEWAY_LEGACY_JSON_DATA || fileConfig.legacyJsonDataFile as string || "~/.agent-gateway/gateway.json";
  const dataFileIsLegacyJson = looksLikeLegacyJsonDataFile(configuredDataFile);
  const dataFile = resolve(expandHome(dataFileIsLegacyJson ? sqlitePathForLegacyJson(configuredDataFile) : configuredDataFile) || "");
  const legacyJsonDataFile = resolve(expandHome(dataFileIsLegacyJson ? configuredDataFile : configuredLegacyJsonDataFile) || "");
  const attachmentRoot = resolve(expandHome(process.env.AGENT_ATTACHMENT_ROOT || fileConfig.attachmentRoot as string || "~/.agent-gateway/attachments") || "");
  const sessionLogRoot = resolve(expandHome(process.env.AGENT_SESSION_LOG_ROOT || fileConfig.sessionLogRoot as string || "~/.agent-gateway/sessions") || "");
  const worktreeRoot = resolve(expandHome(process.env.AGENT_WORKTREE_ROOT || fileConfig.worktreeRoot as string || "~/agent-worktrees") || "");

  return {
    port: parseNumber(process.env.PORT || fileConfig.port, DEFAULT_PORT),
    dataFile,
    legacyJsonDataFile,
    worktreeRoot,
    attachmentRoot,
    sessionLogRoot,
    token: nonEmpty(process.env.AGENT_GATEWAY_TOKEN) || fileConfig.token as string || null,
    accounts: process.env.AGENT_GATEWAY_ACCOUNTS || fileConfig.accounts as Account[] | string || null,
    sessionSecret: nonEmpty(process.env.AGENT_GATEWAY_SESSION_SECRET) || fileConfig.sessionSecret as string || null,
    publicBaseUrl: nonEmpty(process.env.AGENT_GATEWAY_PUBLIC_BASE_URL) || fileConfig.publicBaseUrl as string || null,
    healthCheckIntervalMs: parseNumber(process.env.AGENT_HEALTH_INTERVAL_MS || fileConfig.healthCheckIntervalMs, 15000),
    sessionStaleMs: parseNumber(process.env.AGENT_SESSION_STALE_MS || fileConfig.sessionStaleMs, 1000 * 60 * 30)
  };
}

export function assertProductionAuth(config: Pick<GatewayConfig, "accounts" | "token" | "sessionSecret">) {
  if (process.env.NODE_ENV !== "production") return;
  if (config.token || hasConfiguredAccounts(config.accounts)) {
    if (!config.token && !config.sessionSecret) {
      throw new Error("Production account auth requires AGENT_GATEWAY_SESSION_SECRET or sessionSecret in config.json.");
    }
    return;
  }
  throw new Error(
    "Production mode requires authentication. Configure AGENT_GATEWAY_TOKEN, AGENT_GATEWAY_ACCOUNTS, or run `npm run setup`."
  );
}

export async function ensureRuntimeDirectories(config: Pick<GatewayConfig, "dataFile" | "legacyJsonDataFile" | "worktreeRoot" | "attachmentRoot" | "sessionLogRoot">) {
  await mkdir(dirname(config.dataFile), { recursive: true });
  await mkdir(dirname(config.legacyJsonDataFile), { recursive: true });
  await mkdir(config.worktreeRoot, { recursive: true });
  await mkdir(config.attachmentRoot, { recursive: true });
  await mkdir(config.sessionLogRoot, { recursive: true });
}
