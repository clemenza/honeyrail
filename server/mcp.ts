import { dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ensureRuntimeDirectories, loadGatewayConfig } from "./config.js";
import { EventBus } from "./events.js";
import { createMcpServer } from "./mcp-server.js";
import { recoverLegacyTaskWorktrees } from "./project-helpers.js";
import { SQLiteStore } from "./sqlite-store.js";
import { TmuxManager } from "./tmux.js";
import { runCommandSafe } from "./utils.js";
import { WorktreeManager } from "./worktrees.js";

async function main() {
  const config = await loadGatewayConfig();
  await ensureRuntimeDirectories(config);

  const store = new SQLiteStore(config.dataFile, { legacyJsonPath: config.legacyJsonDataFile });
  const bus = new EventBus();
  const tmux = new TmuxManager();
  const worktreeMgr = new WorktreeManager({ root: config.worktreeRoot });

  await recoverLegacyTaskWorktrees(store, runCommandSafe);

  const server = createMcpServer({
    store,
    bus,
    tmux,
    worktrees: worktreeMgr,
    run: runCommandSafe,
    sessionLogRoot: config.sessionLogRoot,
    attachmentRoot: config.attachmentRoot
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});
