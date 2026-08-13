import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

import { listAgentAdapters } from "./agents/registry.js";
import { attachmentMissingSvg } from "./attachments.js";
import { createAuthenticator, type Account } from "./auth.js";
import type { EventBus } from "./events.js";
import { createDeepSeekSummaryClient, type SessionSummaryClient } from "./session-helpers.js";
import type { TmuxManager } from "./tmux.js";
import type { GatewayEvent, Store } from "./types.js";
import { pathExists, runCommandSafe } from "./utils.js";
import type { WorktreeManager } from "./worktrees.js";

import { asyncRoute, type HttpError, type RouteContext } from "./route-context.js";
import { projectRoutes } from "./project-routes.js";
import { worktreeRoutes } from "./worktree-routes.js";
import { sessionRoutes } from "./session-routes.js";
import { taskRoutes } from "./task-routes.js";
import { mcpHttpRoutes } from "./mcp-http-transport.js";
import type { McpContext } from "./mcp-server.js";
import { createOAuthSupport } from "./oauth.js";
import { OrchestrationService } from "./orchestration/service.js";
import { runRoutes } from "./orchestration/routes.js";

type CreateAppOptions = {
  store: Store;
  bus: EventBus;
  tmux: TmuxManager;
  worktrees: WorktreeManager;
  run?: typeof runCommandSafe;
  summaryClient?: SessionSummaryClient;
  summaryModel?: string;
  summaryApiKey?: string | null;
  summaryApiBaseUrl?: string;
  token?: string | null;
  accounts?: Account[] | string | null;
  sessionSecret?: string | null;
  auth?: ReturnType<typeof createAuthenticator>;
  publicBaseUrl?: string | null;
  attachmentRoot?: string;
  sessionLogRoot?: string;
  defaultWorkspace?: string;
  orchestration?: OrchestrationService;
};

export function createApp({
  store,
  bus,
  tmux,
  worktrees,
  run = runCommandSafe,
  summaryClient,
  summaryModel = process.env.AGENT_SESSION_SUMMARY_MODEL || "deepseek-v4-flash",
  summaryApiKey = process.env.DEEPSEEK_API_KEY || process.env.AGENT_SESSION_SUMMARY_API_KEY,
  summaryApiBaseUrl = process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com",
  token = process.env.AGENT_GATEWAY_TOKEN,
  accounts = process.env.AGENT_GATEWAY_ACCOUNTS,
  sessionSecret = process.env.AGENT_GATEWAY_SESSION_SECRET,
  auth: providedAuth,
  publicBaseUrl = process.env.AGENT_GATEWAY_PUBLIC_BASE_URL,
  attachmentRoot = resolve(homedir(), ".agent-gateway", "attachments"),
  sessionLogRoot = resolve(homedir(), ".agent-gateway", "sessions"),
  defaultWorkspace = resolve(homedir(), "Workspace"),
  orchestration: providedOrchestration
}: CreateAppOptions) {
  const app = express();
  const auth = providedAuth || createAuthenticator({ token, accounts, sessionSecret });
  const sessionSummaryClient = summaryClient || createDeepSeekSummaryClient({ apiKey: summaryApiKey, baseUrl: summaryApiBaseUrl });

  const ctx: RouteContext = {
    store,
    bus,
    tmux,
    worktrees,
    run,
    sessionSummaryClient,
    summaryModel,
    attachmentRoot,
    sessionLogRoot,
    defaultWorkspace
  };
  const orchestration = providedOrchestration || new OrchestrationService({
    store,
    bus,
    tmux,
    worktrees,
    runCommand: run,
    sessionLogRoot,
    attachmentRoot
  });

  app.use(cors({ exposedHeaders: ["mcp-session-id", "www-authenticate"] }));
  app.use(express.json({ limit: "60mb" }));
  auth.routes(app);
  const oauth = createOAuthSupport({ auth, publicBaseUrl });
  app.use(oauth.routes);
  app.use("/api/mcp", oauth.requireMcpAccess);
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    if (req.path === "/api/health") return next();
    if (req.path === "/api/mcp") return next();
    return auth.requireConsole(req, res, next);
  });

  // Health
  app.get("/api/health", asyncRoute(async (_req, res) => {
    const tmuxVersion = await run("tmux", ["-V"]);
    const agentBackends = await Promise.all(
      listAgentAdapters().map((adapter) => adapter.detectInstallation?.(run) || Promise.resolve({
        id: adapter.id,
        displayName: adapter.displayName,
        stability: adapter.stability,
        available: false,
        detail: "no detector"
      }))
    );
    const agentAvailability = Object.fromEntries(agentBackends.map((agent) => [agent.id, agent.available]));
    res.json({
      ok: true,
      tmux: tmuxVersion.ok ? tmuxVersion.stdout.trim() : "unavailable",
      agents: {
        codex: Boolean(agentAvailability.codex),
        claude: Boolean(agentAvailability.claude),
        hermes: Boolean(agentAvailability.hermes)
      },
      agentBackends
    });
  }));

  // Attachments
  app.get("/api/attachments/:fileName", asyncRoute(async (req, res) => {
    const fileNameParam = String(req.params.fileName);
    const fileName = basename(fileNameParam);
    if (fileName !== fileNameParam) throw httpError(400, "Invalid attachment name");
    const attachmentPath = join(attachmentRoot, fileName);
    if (!(await pathExists(attachmentPath))) {
      res.status(404).type("image/svg+xml").send(attachmentMissingSvg(fileName));
      return;
    }
    res.sendFile(attachmentPath);
  }));

  // Dashboard
  app.get("/api/dashboard", asyncRoute(async (_req, res) => {
    const [projects, sessions, tasks, worktreesList, runs, tmuxSessions, events] = await Promise.all([
      store.listProjects(),
      store.listSessions(),
      store.listTasks(),
      store.listWorktrees(),
      orchestration.listRuns(),
      tmux.listSessions(),
      store.listEvents(40)
    ]);
    res.json({ projects, sessions, tasks, worktrees: worktreesList, runs, tmuxSessions, events });
  }));

  // Domain routers
  app.use(projectRoutes(ctx));
  app.use(worktreeRoutes(ctx));
  app.use(sessionRoutes(ctx));
  app.use(taskRoutes(ctx));
  app.use(runRoutes(orchestration));

  // MCP HTTP transport (Streamable HTTP for remote AI agent access)
  const mcpCtx: McpContext = { store, bus, tmux, worktrees, run, sessionLogRoot, attachmentRoot, orchestration };
  app.use(mcpHttpRoutes(mcpCtx));

  // SSE stream
  app.get("/api/events/stream", asyncRoute(async (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const send = (event: GatewayEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: "gateway.connected", payload: {}, createdAt: new Date().toISOString(), id: "" });
    const unsubscribe = bus.subscribe(send);
    req.on("close", unsubscribe);
  }));

  // Error handler
  app.use((error: HttpError, _req: Request, res: Response, _next: NextFunction) => {
    if (!error.status || error.status >= 500) {
      console.error(error);
    }
    res.status(error.status || 500).json({ error: error.message || "Internal server error" });
  });

  return app;
}

function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}
