import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DEFAULT_PORT, defaultConfigPath } from "./config.js";

function hashPassword(password: string) {
  // Salt is a fixed crypto value, not a brand name — changing it would invalidate all stored password hashes.
  return scryptSync(password, "agent-gateway", 64).toString("hex");
}

function expandHome(path: string) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function defaultValue(value: string, fallback: string) {
  return value.trim() || fallback;
}

async function main() {
  const rl = createInterface({ input, output });
  try {
    const configPath = defaultConfigPath();
    const username = defaultValue(await rl.question("Console username [admin]: "), "admin");
    const password = await rl.question("Console password: ");
    if (!password.trim()) throw new Error("Console password is required.");
    const port = Number(defaultValue(await rl.question(`Port [${DEFAULT_PORT}]: `), String(DEFAULT_PORT)));
    const worktreeRoot = expandHome(defaultValue(await rl.question("Worktree root [~/agent-worktrees]: "), "~/agent-worktrees"));
    const dataFile = expandHome(defaultValue(await rl.question("SQLite state file [~/.honeyrail/gateway.sqlite]: "), "~/.honeyrail/gateway.sqlite"));
    const legacyJsonDataFile = expandHome(defaultValue(await rl.question("Legacy JSON state file for migration [~/.honeyrail/gateway.json]: "), "~/.honeyrail/gateway.json"));
    const attachmentRoot = expandHome(defaultValue(await rl.question("Attachment root [~/.honeyrail/attachments]: "), "~/.honeyrail/attachments"));
    const sessionLogRoot = expandHome(defaultValue(await rl.question("Session log root [~/.honeyrail/sessions]: "), "~/.honeyrail/sessions"));
    const publicBaseUrl = (await rl.question("Public base URL, optional: ")).trim() || null;

    const config = {
      port,
      dataFile,
      legacyJsonDataFile,
      worktreeRoot,
      attachmentRoot,
      sessionLogRoot,
      publicBaseUrl,
      accounts: [
        {
          username,
          passwordHash: hashPassword(password),
          permissions: ["console", "admin"]
        }
      ],
      sessionSecret: randomBytes(32).toString("hex")
    };

    await mkdir(dirname(configPath), { recursive: true });
    await mkdir(dirname(dataFile), { recursive: true });
    await mkdir(dirname(legacyJsonDataFile), { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    await mkdir(attachmentRoot, { recursive: true });
    await mkdir(sessionLogRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    console.log(`\nHoneyRail config written to ${configPath}`);
    console.log("Start with: npm run ops:start");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
