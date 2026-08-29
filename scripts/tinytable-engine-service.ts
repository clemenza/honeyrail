/**
 * evals: engine-service orchestration (#168) - server-side half of the
 * oracle-container black-box eval mode, the concrete implementation of
 * #166's conclusion that a real black box needs a process boundary, not a
 * file-format one (#158's `.pyc`-hiding MVP; #164 showed the scored agent
 * just `dis.dis()`'d the live bytecode straight to the correct defect
 * instead).
 *
 * Launches docker/tinytable-engine-service/Dockerfile's image on a fresh,
 * per-trial private Docker network, bind-mounting *only* the real
 * `tinytable/` package (privateRoot's, per #168's issue body - never
 * agentRoot's, which has none) read-only, and polls its `/health`
 * endpoint until the service is actually ready to serve `/run` requests.
 *
 * The private network is a plain (non-`--internal`) user-defined bridge:
 * isolates this trial's engine-service from every other concurrently-
 * running trial (unique name per call, like tinytable-exam-room.ts's own
 * `randomUUID()`-suffixed container names), while still giving both
 * containers on it normal outbound internet - #168's non-goals list
 * "protecting the engine-service against the host/driver" as explicitly
 * out of scope, so there is no need for `--internal` here; the boundary
 * this defends is "no import/filesystem path from the agent's own
 * process", not "no network route from the host".
 *
 * Pairs with scripts/tinytable-exam-room.ts: pass this call's returned
 * `networkName` as that file's own `network` option (it accepts any
 * docker network name, not just "bridge"/"none") so the exam-room
 * container joins the *same* private network as its one and only network
 * - giving it both outbound internet (same as today's default "bridge"
 * behavior, since this network isn't `--internal`) and container-name DNS
 * resolution to `hostname` below, with nothing else on that network to
 * reach. A driver wires the two together roughly like:
 *
 *   const engineService = await startEngineService({ mutantRootDir: join(privateRoot, "tinytable") });
 *   try {
 *     await runInExamRoom({
 *       seedRootDir: agentRoot,
 *       network: engineService.networkName,
 *       env: { ENGINE_SERVICE_URL: `http://${engineService.hostname}:${engineService.port}` },
 *       command: [...]
 *     });
 *   } finally {
 *     await engineService.stop();
 *   }
 *
 * That full driver wiring (seed-root-builder's privateRoot/agentRoot
 * split, dsh-evals-demo.ts integration, kill-attribution classifier
 * awareness) is out of scope for this file - see #168's issue body for
 * the rest of the MVP checklist this is one piece of.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ENGINE_SERVICE_IMAGE = "tinytable-engine-service:latest";
const DEFAULT_PORT = 8765;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const DEFAULT_MEMORY = "512m";
const DEFAULT_PIDS_LIMIT = 64;
const DEFAULT_TMP_SIZE = "64m";
/** DNS name the exam-room container resolves this service at, once joined to the same private network - see tinytable-exam-room.ts's `network` option. */
export const ENGINE_SERVICE_NETWORK_ALIAS = "engine-service";

export type EngineServiceOptions = {
  /**
   * Host directory that IS the real tinytable/ package (e.g. `join(privateRoot, "tinytable")`)
   * - bind-mounted read-only at /mutant/tinytable inside the container, the ONLY host path this
   * container ever sees. Never agentRoot - agentRoot has no tinytable/ to mount in the first place.
   */
  mutantRootDir: string;
  image?: string;
  /** Container-internal port engine_service.py binds to (default 8765) - never published to the host; reachable only over the private network this call creates. */
  port?: number;
  memory?: string;
  pidsLimit?: number;
  healthTimeoutMs?: number;
};

export type EngineServiceHandle = {
  containerName: string;
  networkName: string;
  hostname: string;
  port: number;
  /** Stops the container and removes the private network. Safe to call more than once - a second call is a no-op. */
  stop(): Promise<void>;
};

type RunResult = { code: number | null; stdout: string; stderr: string };

async function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** The `docker run` argv this module uses, exposed for tests/inspection without requiring a docker daemon. */
export function buildEngineServiceDockerArgs(options: EngineServiceOptions, containerName: string, networkName: string): string[] {
  const mutantRootDir = resolve(options.mutantRootDir);
  const port = options.port ?? DEFAULT_PORT;
  return [
    "run",
    "-d",
    "--rm",
    "--name", containerName,
    "--network", networkName,
    "--network-alias", ENGINE_SERVICE_NETWORK_ALIAS,
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--pids-limit", String(options.pidsLimit ?? DEFAULT_PIDS_LIMIT),
    "--memory", options.memory ?? DEFAULT_MEMORY,
    "--tmpfs", `/tmp:size=${DEFAULT_TMP_SIZE}`,
    // read-only: this is the real, possibly mutated tinytable/ package -
    // the engine-service never needs to (and must never be able to) write
    // to it.
    "-v", `${mutantRootDir}:/mutant/tinytable:ro`,
    options.image ?? DEFAULT_ENGINE_SERVICE_IMAGE,
    "--root", "/mutant",
    "--host", "0.0.0.0",
    "--port", String(port)
  ];
}

async function getContainerAddress(containerName: string, networkName: string): Promise<string> {
  const result = await run("docker", ["inspect", "-f", `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`, containerName]);
  const address = result.stdout.trim();
  if (result.code !== 0 || !address) {
    throw new Error(`could not determine ${containerName}'s address on network ${networkName}: ${result.stderr || "(no address)"}`);
  }
  return address;
}

async function waitForHealth(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_000);
      try {
        const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
        if (response.ok) return true;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // not up yet - keep polling until timeoutMs elapses
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Creates a fresh private network, starts the engine-service container on
 * it, and waits for `/health` to succeed before returning. Throws (and
 * cleans up anything it already created) if the container fails to start
 * or never becomes healthy within `healthTimeoutMs` - callers should never
 * be left holding a half-started container or a leaked network on failure.
 */
export async function startEngineService(options: EngineServiceOptions): Promise<EngineServiceHandle> {
  const suffix = randomUUID();
  const containerName = `tinytable-engine-service-${suffix}`;
  const networkName = `tinytable-engine-net-${suffix}`;
  const port = options.port ?? DEFAULT_PORT;

  const networkResult = await run("docker", ["network", "create", networkName]);
  if (networkResult.code !== 0) {
    throw new Error(`failed to create private network ${networkName}: ${networkResult.stderr}`);
  }

  let containerStarted = false;
  try {
    const args = buildEngineServiceDockerArgs(options, containerName, networkName);
    const runResult = await run("docker", args);
    if (runResult.code !== 0) {
      throw new Error(`failed to start engine-service container ${containerName}: ${runResult.stderr}`);
    }
    containerStarted = true;

    const address = await getContainerAddress(containerName, networkName);
    const healthy = await waitForHealth(address, port, options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    if (!healthy) {
      const logs = await run("docker", ["logs", containerName]);
      throw new Error(
        `engine-service ${containerName} never became healthy within ${options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS}ms - ` +
          `logs:\n${logs.stdout}\n${logs.stderr}`
      );
    }

    let stopped = false;
    return {
      containerName,
      networkName,
      hostname: ENGINE_SERVICE_NETWORK_ALIAS,
      port,
      async stop() {
        if (stopped) return;
        stopped = true;
        await run("docker", ["stop", "-t", "5", containerName]).catch(() => {});
        await run("docker", ["network", "rm", networkName]).catch(() => {});
      }
    };
  } catch (error) {
    if (containerStarted) {
      await run("docker", ["stop", "-t", "5", containerName]).catch(() => {});
    }
    await run("docker", ["network", "rm", networkName]).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CLI - starts the service, prints its connection info as JSON, and stops
// it cleanly on SIGINT/SIGTERM. Useful for manual testing against a real
// docker daemon; scripts/tinytable-exam-room.ts's own driver usage is the
// programmatic startEngineService()/stop() pair documented above.
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { mutantRootDir: string; image?: string; port?: number } {
  let mutantRootDir: string | undefined;
  let image: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--mutant-root": mutantRootDir = next(); break;
      case "--image": image = next(); break;
      case "--port": port = Number(next()); break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/tinytable-engine-service.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!mutantRootDir) throw new Error("--mutant-root <dir> is required (a directory that IS a tinytable/ package)");
  return { mutantRootDir, image, port };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const handle = await startEngineService(options);
  console.log(JSON.stringify({ containerName: handle.containerName, networkName: handle.networkName, hostname: handle.hostname, port: handle.port }, null, 2));
  console.error(`engine-service ready. Reachable as http://${handle.hostname}:${handle.port} from a container on network ${handle.networkName}. Ctrl-C to stop.`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // keep the process alive until a signal arrives
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
