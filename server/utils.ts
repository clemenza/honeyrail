import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createReadStream, existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
};

export type SafeCommandOutput = CommandOutput & {
  ok: boolean;
  code?: number | string;
};

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix: string) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function slugify(value: unknown) {
  return String(value || "task")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "task";
}

export function expandHome(path: string | undefined) {
  if (!path) return path;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function quoteShellArg(value: unknown) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(cmd: string, args: string[] = [], options: CommandOptions = {}): Promise<CommandOutput> {
  const result = await execFileAsync(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 30000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export async function runCommandSafe(cmd: string, args: string[] = [], options: CommandOptions = {}): Promise<SafeCommandOutput> {
  try {
    return { ok: true, ...(await runCommand(cmd, args, options)) };
  } catch (error: unknown) {
    const err = error as Record<string, unknown>;
    return {
      ok: false,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? (error as Error).message ?? ""),
      code: (err.code as number | string) ?? 1
    };
  }
}

export function spawnCommand(cmd: string, args: string[] = [], options: Pick<CommandOptions, "cwd" | "env"> = {}) {
  return spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export type FileTail = {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(): void;
};

/**
 * Follows appends to a file and emits new bytes on `stdout`, similar in shape
 * to a spawned child process (stdout/stderr EventEmitters plus a kill()).
 *
 * Unlike `tmux pipe-pane`, this never touches the pane's own pipe, so it is
 * safe to attach/detach any number of times without disturbing another
 * pipe-pane consumer (e.g. a long-lived session log) that is already active
 * on the same pane.
 */
export function tailFile(path: string): FileTail {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let position = 0;
  let closed = false;
  let watcher: FSWatcher | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  try {
    position = existsSync(path) ? statSync(path).size : 0;
  } catch {
    position = 0;
  }

  function readNewData() {
    if (closed) return;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < position) {
      // File was truncated or replaced (e.g. log rotation); start over.
      position = 0;
    }
    if (size <= position) return;
    const start = position;
    position = size;
    const readStream = createReadStream(path, { start, end: size - 1 });
    readStream.on("data", (chunk) => stdout.emit("data", chunk));
    readStream.on("error", (error) => stderr.emit("data", Buffer.from(String(error))));
  }

  function startWatching() {
    if (closed) return;
    try {
      watcher = watch(path, { persistent: false }, () => readNewData());
      // Pick up anything written between the initial stat and the watch registration.
      readNewData();
    } catch {
      if (!closed) retryTimer = setTimeout(startWatching, 500);
    }
  }

  startWatching();

  return {
    stdout,
    stderr,
    kill() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      watcher?.close();
      watcher = null;
    }
  };
}

export function branchTimestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}
