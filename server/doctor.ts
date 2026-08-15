import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { listAgentAdapters } from "./agents/registry.js";
import type { AgentCommandRunner, AgentInstallationStatus } from "./agents/types.js";
import { collectNamingDeprecations, defaultConfigPath, loadGatewayConfig, type GatewayConfig } from "./config.js";
import { runCommandSafe, type SafeCommandOutput } from "./utils.js";

export type DoctorCoreCheck = {
  name: string;
  ok: boolean;
  value: string;
  required: boolean;
};

export type DoctorRuntimeCheck = {
  label: string;
  path: string;
  ok: boolean;
  detail: string;
};

export type DoctorSecurityCheck = {
  label: string;
  ok: boolean;
  detail: string;
};

export type DoctorNamingCheck = {
  scheme: "current" | "legacy" | "mixed";
  deprecations: { old: string; new: string }[];
};

export type DoctorReport = {
  ready: boolean;
  stableAgentsAvailable: number;
  core: DoctorCoreCheck[];
  agents: AgentInstallationStatus[];
  runtime: DoctorRuntimeCheck[];
  security: DoctorSecurityCheck[];
  naming: DoctorNamingCheck;
};

type DoctorOptions = {
  run?: AgentCommandRunner;
  config?: GatewayConfig;
  env?: NodeJS.ProcessEnv;
};

function firstLine(output: SafeCommandOutput) {
  return (output.stdout || output.stderr || "").trim().split("\n")[0] || "";
}

async function commandCheck(name: string, command: string, args: string[], run: AgentCommandRunner): Promise<DoctorCoreCheck> {
  const result = await run(command, args, { timeout: 5000 });
  return {
    name,
    ok: result.ok,
    value: result.ok ? firstLine(result) : "not found",
    required: true
  };
}

function nodeMajor() {
  const match = /^v?(\d+)/.exec(process.version);
  return match ? Number(match[1]) : 0;
}

async function nearestExistingParent(path: string): Promise<string | null> {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

async function checkWritable(label: string, path: string, filePath = false): Promise<DoctorRuntimeCheck> {
  const target = resolve(path);
  const existingTarget = existsSync(target);
  const accessTarget = existingTarget ? target : await nearestExistingParent(filePath ? dirname(target) : target);
  if (!accessTarget) {
    return { label, path: target, ok: false, detail: "no existing parent found" };
  }
  try {
    await access(accessTarget, constants.W_OK);
    return {
      label,
      path: target,
      ok: true,
      detail: existingTarget ? "writable" : `creatable under ${accessTarget}`
    };
  } catch {
    return { label, path: target, ok: false, detail: `${accessTarget} is not writable` };
  }
}

function hasConfiguredAccounts(accounts: GatewayConfig["accounts"]) {
  if (Array.isArray(accounts)) return accounts.length > 0;
  return Boolean(String(accounts || "").trim());
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const run = options.run || runCommandSafe;
  const config = options.config || await loadGatewayConfig();
  const env = options.env || process.env;

  const nodeOk = nodeMajor() >= 22;
  const core = [
    {
      name: "node",
      ok: nodeOk,
      value: `${process.version}${nodeOk ? "" : " (Node 22+ recommended)"}`,
      required: true
    },
    await commandCheck("git", "git", ["--version"], run),
    await commandCheck("tmux", "tmux", ["-V"], run)
  ];

  const agents = await Promise.all(
    listAgentAdapters().map((adapter) =>
      adapter.detectInstallation
        ? adapter.detectInstallation(run)
        : Promise.resolve({
            id: adapter.id,
            displayName: adapter.displayName,
            stability: adapter.stability,
            available: false,
            detail: "no detector"
          })
    )
  );

  const runtime = await Promise.all([
    checkWritable("config", defaultConfigPath(), true),
    checkWritable("data", config.dataFile, true),
    checkWritable("legacy JSON data", config.legacyJsonDataFile, true),
    checkWritable("attachments", config.attachmentRoot),
    checkWritable("session logs", config.sessionLogRoot),
    checkWritable("worktrees", config.worktreeRoot)
  ]);

  const accountAuth = hasConfiguredAccounts(config.accounts);
  const tokenAuth = Boolean(config.token);
  const security: DoctorSecurityCheck[] = [
    {
      label: "production auth",
      ok: accountAuth || tokenAuth,
      detail: accountAuth || tokenAuth
        ? "configured"
        : "not configured; required for NODE_ENV=production"
    },
    {
      label: "session secret",
      ok: Boolean(config.sessionSecret) || !accountAuth,
      detail: config.sessionSecret
        ? "configured"
        : accountAuth
          ? "missing; account auth in production requires a stable session secret"
          : "not required unless account auth is configured"
    },
    {
      label: "NODE_ENV",
      ok: true,
      detail: env.NODE_ENV || "development"
    }
  ];

  const deprecations = collectNamingDeprecations(env);
  const naming: DoctorNamingCheck = {
    scheme: deprecations.length === 0 ? "current" : "legacy",
    deprecations
  };

  const stableAgentsAvailable = agents.filter((agent) => agent.available && agent.stability === "stable").length;
  const ready = core.every((check) => check.ok) && runtime.every((check) => check.ok);

  return { ready, stableAgentsAvailable, core, agents, runtime, security, naming };
}

function mark(ok: boolean) {
  return ok ? "✓" : "!";
}

function agentLine(agent: AgentInstallationStatus) {
  const version = agent.version ? ` ${agent.version}` : "";
  const detail = agent.available ? version || (agent.path ? ` ${agent.path}` : "") : ` ${agent.detail || "not found"}`;
  return `  ${mark(agent.available)} ${agent.id.padEnd(8)} ${agent.stability.padEnd(12)}${detail}`;
}

export function formatDoctorReport(report: DoctorReport) {
  return [
    "HoneyRail doctor",
    "",
    "Core",
    ...report.core.map((check) => `  ${mark(check.ok)} ${check.name.padEnd(6)} ${check.value}`),
    "",
    "Agents",
    ...report.agents.map(agentLine),
    "",
    "Runtime",
    ...report.runtime.map((check) => `  ${mark(check.ok)} ${check.label.padEnd(16)} ${check.detail} (${check.path.replace(homedir(), "~")})`),
    "",
    "Security",
    ...report.security.map((check) => `  ${mark(check.ok)} ${check.label.padEnd(16)} ${check.detail}`),
    "",
    "Naming",
    `  ${mark(report.naming.deprecations.length === 0)} scheme           ${report.naming.scheme}`,
    ...report.naming.deprecations.map((d) => `  ! ${d.old} -> ${d.new}`),
    "",
    `Result: ${report.ready ? "READY" : "NOT READY"} (${report.stableAgentsAvailable} stable agent backends available)`
  ].join("\n");
}

async function main() {
  const report = await runDoctor();
  console.log(formatDoctorReport(report));
  process.exit(report.ready ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
