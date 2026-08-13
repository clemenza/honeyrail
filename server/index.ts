import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

import { createApp } from "./api.js";
import { createAuthenticator } from "./auth.js";
import { assertProductionAuth, ensureRuntimeDirectories, loadGatewayConfig } from "./config.js";
import { EventBus } from "./events.js";
import { recoverLegacyTaskWorktrees } from "./project-helpers.js";
import { SQLiteStore } from "./sqlite-store.js";
import { TmuxManager } from "./tmux.js";
import { runCommandSafe } from "./utils.js";
import { sessionAcceptsInput, startSessionMonitor } from "./session-monitor.js";
import { readSessionLog, stripAnsi } from "./session-helpers.js";
import { WorktreeManager } from "./worktrees.js";
import { OrchestrationService } from "./orchestration/service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
async function main() {
    const config = await loadGatewayConfig();
    assertProductionAuth(config);
    await ensureRuntimeDirectories(config);

    const store = new SQLiteStore(config.dataFile, { legacyJsonPath: config.legacyJsonDataFile });
    const bus = new EventBus();
    const tmux = new TmuxManager();
    const worktrees = new WorktreeManager({ root: config.worktreeRoot });
    const auth = createAuthenticator({
        token: config.token,
        accounts: config.accounts,
        sessionSecret: config.sessionSecret
    });
    
    await recoverLegacyTaskWorktrees(store, runCommandSafe);
    const orchestration = new OrchestrationService({
        store,
        bus,
        tmux,
        worktrees,
        runCommand: runCommandSafe,
        sessionLogRoot: config.sessionLogRoot,
        attachmentRoot: config.attachmentRoot
    });
    await orchestration.recover();

    const app = createApp({
        store,
        bus,
        tmux,
        worktrees,
        run: runCommandSafe,
        auth,
        publicBaseUrl: config.publicBaseUrl,
        attachmentRoot: config.attachmentRoot,
        sessionLogRoot: config.sessionLogRoot,
        orchestration
    });

    startSessionMonitor({
        store,
        bus,
        tmux,
        intervalMs: config.healthCheckIntervalMs,
        staleMs: config.sessionStaleMs
    });

    const dist = join(root, "dist");
    app.use(express.static(dist));
    app.use((req, res, next) => {
        if (req.path.startsWith("/api")) {
            return next();
        }
        res.sendFile(join(dist, "index.html"));
    });

    const server = createServer(app);
    const wss = new WebSocketServer({ server, path: "/api/terminal" });

    wss.on("connection", async (socket, req) => {
        try {
            if (!auth.canAccessConsole(req as import("express").Request)) {
                socket.send("Unauthorized\n");
                socket.close();
                return;
            }
            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
            const sessionId = url.searchParams.get("sessionId");
            const session = sessionId ? await store.getSession(sessionId) : null;
            if (!session) {
                socket.send("Session not found\n");
                socket.close();
                return;
            }

            // Capture initial screen state before streaming
            let tmuxAlive = true;
            try {
                socket.send(await tmux.capture(session.tmuxSessionName, 80));
            } catch {
                tmuxAlive = false;
                const logContent = stripAnsi(await readSessionLog(session.logPath));
                if (logContent) {
                    const lines = logContent.split("\n");
                    socket.send(lines.slice(-200).join("\n"));
                } else {
                    socket.send(`[Session ended — no log available]\n`);
                }
            }

            if (!tmuxAlive) {
                socket.close();
                return;
            }

            const stream = tmux.stream(session.logPath || "");

            stream.stdout.on("data", (data) => {
                if (socket.readyState === socket.OPEN) {
                    socket.send(data);
                }
            });

            stream.stderr.on("data", (data) => {
                if (socket.readyState === socket.OPEN) {
                    socket.send(`Error from tmux stream: ${data.toString()}\n`);
                }
            });

            socket.on("message", async (message) => {
                const input = message.toString();
                if (!sessionAcceptsInput(session.status)) return;
                
                if (input === "\r") await tmux.sendKey(session.tmuxSessionName, "Enter");
                else if (input === "\u0003") await tmux.sendKey(session.tmuxSessionName, "C-c");
                else await tmux.sendLiteral(session.tmuxSessionName, input);
            });

            socket.on("close", () => {
                stream.kill();
            });
        } catch (error) {
            console.error("WebSocket connection error:", error);
            socket.send("An internal error occurred on the WebSocket server.\n");
            socket.close();
        }
    });

    server.listen(config.port, "0.0.0.0", () => {
        console.log(`HoneyRail listening on http://127.0.0.1:${config.port}`);
        console.log(`Data file: ${config.dataFile}`);
        console.log(`Worktree root: ${config.worktreeRoot}`);
        console.log(`Attachment root: ${config.attachmentRoot}`);
        console.log(`Session log root: ${config.sessionLogRoot}`);
    });
}

main().catch(console.error);
