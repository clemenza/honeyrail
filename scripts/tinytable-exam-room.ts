/**
 * evals: container-level isolation for scored trials (#105). Zone 2 ("exam
 * room") of the #104/#105/#106/#109 three-zone eval isolation design - the
 * P0 remediation for #103 (an agent escaped its sandbox and read
 * examples/tinytable-eval's answer key straight off the shared filesystem).
 *
 * runInExamRoom() launches a command inside a container built from
 * docker/tinytable-exam-room/Dockerfile, bind-mounting *only* the given
 * seed-root directory (normally #104's buildSeedRoot() output) at
 * /workspace. No other host path is ever mounted in - not ~/.honeyrail, not
 * the honeyrail checkout, not the operator's home directory - so there is
 * no path from inside the container back to any answer material, and this
 * holds regardless of what an agent's own sandbox (e.g. dsh
 * `workspace-write`) does or doesn't restrict; see #103, which proved that
 * one doesn't restrict reads at all.
 *
 * This deliberately does not go through HoneyRail's own worktree/tmux/
 * session-monitor machinery (see #93's amendment and docs/security-model.md
 * - "do not treat the gateway as a sandbox"): it's a standalone execution
 * path for scored eval trials, meant to be called by #93's driver.
 *
 * Usage:
 *   node --import tsx scripts/tinytable-exam-room.ts \
 *     --seed-root ./seed-root -- dsh --profile headless "<prompt>"
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_IMAGE = "tinytable-exam-room:latest";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MEMORY = "2g";
const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_TMP_SIZE = "256m";

export type ExamRoomOptions = {
  /** Host directory to bind-mount at /workspace, read-write. The only host path ever exposed to the container. */
  seedRootDir: string;
  /** Argv to run inside the container, cwd=/workspace. */
  command: string[];
  image?: string;
  /** Extra env vars passed into the container (e.g. DEEPSEEK_API_KEY, DSH_PERMISSION_MODE). Never baked into the image. */
  env?: Record<string, string>;
  timeoutMs?: number;
  memory?: string;
  pidsLimit?: number;
  /** "bridge" (default) gives the agent outbound network for its model API calls, in its own network namespace - it cannot reach the host's loopback services. "none" disables networking entirely. */
  network?: "none" | "bridge";
};

export type ExamRoomResult = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

/** The `docker run` argv this module uses, exposed for tests/inspection without requiring a docker daemon. */
export function buildDockerArgs(options: ExamRoomOptions, containerName: string): string[] {
  const seedRootDir = resolve(options.seedRootDir);
  const { uid, gid } = userInfo();

  const args = [
    "run",
    "--rm",
    "--name", containerName,
    "--network", options.network ?? "bridge",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    // The container's own root filesystem is read-only (defense in depth,
    // not load-bearing for the host-isolation guarantee itself): dsh's only
    // writes are to $HOME=/tmp (a tmpfs) and /workspace (the bind mount),
    // both exempted below.
    "--read-only",
    "--pids-limit", String(options.pidsLimit ?? DEFAULT_PIDS_LIMIT),
    "--memory", options.memory ?? DEFAULT_MEMORY,
    // Match the host uid/gid that owns the bind-mounted seed-root, rather
    // than the image's baked-in `examroom` user, so the agent can write
    // sql-tests/agent/ and findings.json into it regardless of which local
    // user is running the harness. The seed-root is answer-free by
    // construction (#104), so this permissive-by-identity approach costs
    // nothing security-wise.
    "--user", `${uid}:${gid}`,
    "--tmpfs", `/tmp:size=${DEFAULT_TMP_SIZE}`,
    "-e", "HOME=/tmp",
    "-v", `${seedRootDir}:/workspace:rw`,
    "-w", "/workspace"
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(options.image ?? DEFAULT_IMAGE, ...options.command);
  return args;
}

export async function runInExamRoom(options: ExamRoomOptions): Promise<ExamRoomResult> {
  const containerName = `tinytable-exam-room-${randomUUID()}`;
  const args = buildDockerArgs(options, containerName);

  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["kill", containerName], { stdio: "ignore" });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ exitCode: code, timedOut, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { seedRootDir: string; image?: string; command: string[] } {
  let seedRootDir: string | undefined;
  let image: string | undefined;
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { i += 1; break; }
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--seed-root": seedRootDir = next(); break;
      case "--image": image = next(); break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/tinytable-exam-room.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg} (command must follow --)`);
    }
  }
  const command = argv.slice(i);
  if (!seedRootDir) throw new Error("--seed-root <dir> is required");
  if (command.length === 0) throw new Error("no command given - pass it after --");
  return { seedRootDir, image, command };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runInExamRoom({
    seedRootDir: options.seedRootDir,
    image: options.image,
    command: options.command,
    env: {
      ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
      // #115: dsh's own tool-bash sandbox needs to mount a fresh /proc,
      // which Docker's default seccomp profile blocks regardless of
      // --cap-drop/--security-opt - this container's own isolation is
      // already the real security boundary, so tell dsh to skip its own
      // (here, non-functional) nested one. Override by exporting
      // DSH_PERMISSION_MODE before invoking this CLI if a caller genuinely
      // needs dsh's own sandbox instead.
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "danger-full-access"
    }
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.timedOut) {
    console.error("tinytable-exam-room: run timed out and was killed");
    process.exit(1);
  }
  process.exit(result.exitCode ?? 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
