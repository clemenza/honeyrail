import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCommandSafe } from "../utils.js";
import { containerHardeningArgs } from "../containers/hardening.js";
import { RESEARCH_CONTAINER_PATHS } from "./container-paths.js";
import type { PostgresConnectionInfo } from "./research-environment.js";

/**
 * The isolated launch path for a PostgreSQL research agent (#182).
 *
 * The round-1 boundary was path separation on a shared filesystem: the agent
 * was *told* about `source/`, `pgdata/` and the build's `bin/`, and told
 * nothing about `privateDir`, the source mirror or the build cache. A process
 * running as the same OS user could simply look anyway. This module replaces
 * that with the boundary `scripts/tinytable-exam-room.ts` already proved out
 * for tinytable (#103/#105): the agent runs inside a container that
 * bind-mounts *only* its research surface, so every other host path is not
 * "unmentioned" but absent from its mount namespace.
 *
 * The agent reaches the cluster through the bind-mounted socket directory:
 * AF_UNIX filesystem-path sockets are resolved through the mount namespace,
 * not the network namespace, which is the same mechanism that makes mounting
 * `/var/run/docker.sock` into a container work - and it is why the scored
 * default `--network none` costs the agent nothing it actually needs.
 *
 * As of the third review (#182) the *build* is containerized
 * (docker/postgres-research-builder, neutral prefix
 * RESEARCH_CONTAINER_PATHS.postgres), and as of the fourth the *server* is too
 * (docker/postgres-research-runtime, server/postgres/runtime-container.ts).
 * So the socket directory this module mounts is now shared between two
 * containers rather than between a container and a host process, and a scored
 * trial executes no Linux PostgreSQL binary on the host at all - which is what
 * makes macOS and Windows real scored hosts rather than build-only ones.
 *
 * The agent-visible surface, and nothing else:
 *
 *   /workspace/source              the .git-free snapshot          rw
 *   /workspace/runtime/pgdata      PGDATA                          rw
 *   /workspace/runtime/socket      the cluster's socket directory  rw
 *   /workspace/runtime/postgres.log the server log                 ro
 *   /workspace/agent               scratch for repros/results      rw
 *   /opt/honeyrail/postgres        the selected build              ro
 *
 * Never mounted: the attachment tree, the grader-private directory, the
 * PostgreSQL source mirror or any `.git`, the shared build-cache root, and
 * any sibling trial's directories.
 */

/**
 * Fixed, neutral in-container paths. These, not host paths, are what the
 * agent is told - and `RESEARCH_CONTAINER_PATHS.postgres` is additionally the
 * literal `configure --prefix=` every build is compiled with, which is why it
 * is defined in the leaf module both sides import rather than here. See
 * ./container-paths.ts.
 */
export { RESEARCH_CONTAINER_PATHS } from "./container-paths.js";

export const DEFAULT_RESEARCH_IMAGE = "honeyrail-postgres-research:latest";

/**
 * The scored default. `none` gives the agent no network stack beyond its own
 * loopback, so there is no bridge, no default gateway and no
 * `host.docker.internal` to reach a grader/host service through - the gap the
 * #182 third review identified in `bridge`, where mount isolation says
 * nothing about what an HTTP request can retrieve.
 *
 * `bridge` remains available for an agent that genuinely needs outbound model
 * API access, but it has to be asked for by name, and a session that asks for
 * it is recorded `scoredEligible: false`. See
 * PostgresResearchIsolationRecord.
 */
export const DEFAULT_RESEARCH_NETWORK = "none";

/** True only for a network mode that carries no route to host or private services. */
export function isScoredNetworkMode(network: string | undefined): boolean {
  return (network ?? DEFAULT_RESEARCH_NETWORK) === "none";
}

/** No host PATH is inherited: a container gets exactly what is passed with `-e`. */
const CONTAINER_PATH = `${RESEARCH_CONTAINER_PATHS.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export type ResearchContainerMounts = {
  /** Host path of the `.git`-free snapshot. */
  sourceDir: string;
  /** Host PGDATA. */
  dataDir: string;
  /** Host socket directory holding `.s.PGSQL.<port>`. */
  socketDir: string;
  /** Host path of the server log file. */
  logPath: string;
  /** Host scratch directory the agent writes repros/results into. */
  scratchDir: string;
  /**
   * Host path of this trial's *view* of the build (see createBuildView()) -
   * never the shared cache entry itself.
   */
  buildViewDir: string;
};

export type ResearchContainerOptions = {
  mounts: ResearchContainerMounts;
  /** Argv to run inside the container, cwd=/workspace/agent. */
  command: string[];
  image?: string;
  /**
   * Defaults to DEFAULT_RESEARCH_NETWORK ("none"): no network stack beyond
   * the container's own loopback, so no host or private service is reachable
   * at all. The research cluster is still reachable, through the bind-mounted
   * Unix socket - AF_UNIX filesystem sockets resolve through the mount
   * namespace, not the network namespace.
   *
   * "bridge" is available for an agent that needs outbound model-API access,
   * but it is not scored: a bridge-networked container has a default gateway
   * to the host and, on Docker Desktop, `host.docker.internal`.
   */
  network?: "none" | "bridge" | (string & {});
  memory?: string;
  pidsLimit?: number;
  /** Extra variables. Nothing from the host environment is inherited implicitly. */
  env?: Record<string, string>;
  /** Keep stdin open (`-i`) so the caller can write to the agent. */
  interactive?: boolean;
};

/**
 * The in-container coordinates handed to an isolated agent.
 *
 * Every value is an in-container path. Leaking a host path here would defeat
 * the point twice over: it would tell the agent where HoneyRail keeps things
 * even though it cannot read them, and any code that used the exported value
 * for a real filesystem operation would be operating outside the boundary.
 *
 * `HOST`/`SOCKET_DIR` are the mounted socket directory rather than
 * `127.0.0.1`: libpq treats a host beginning with `/` as a Unix-domain socket
 * directory, and the container has no TCP route to the host's loopback.
 */
export function containerAgentEnvironment(connection: PostgresConnectionInfo, prefix = "HR_PG"): Record<string, string> {
  const paths = RESEARCH_CONTAINER_PATHS;
  return {
    [`${prefix}_HOST`]: paths.socket,
    [`${prefix}_PORT`]: String(connection.port),
    [`${prefix}_SOCKET_DIR`]: paths.socket,
    [`${prefix}_USER`]: connection.user,
    [`${prefix}_DATABASE`]: connection.database,
    [`${prefix}_URL`]: `postgresql://${connection.user}@/${connection.database}?host=${paths.socket}&port=${connection.port}`,
    [`${prefix}_BIN_DIR`]: paths.bin,
    [`${prefix}_SOURCE_DIR`]: paths.source,
    [`${prefix}_DATA_DIR`]: paths.data,
    [`${prefix}_LOG`]: paths.log,
    [`${prefix}_WORK_DIR`]: paths.scratch
  };
}

/** The `docker run` argv, exposed for tests/inspection without requiring a docker daemon. */
export function buildResearchContainerArgs(options: ResearchContainerOptions, containerName: string): string[] {
  const paths = RESEARCH_CONTAINER_PATHS;
  const m = options.mounts;
  const args = [
    ...containerHardeningArgs({
      containerName,
      // Explicit rather than relying on the shared helper's default: the exam
      // room's default is its own decision, and this path's scored default
      // must not move if that one does.
      network: options.network ?? DEFAULT_RESEARCH_NETWORK,
      memory: options.memory,
      pidsLimit: options.pidsLimit
    })
  ];
  if (options.interactive) args.push("-i");
  args.push(
    // PGDATA is read-write because inspecting and perturbing a cluster's own
    // storage is legitimate research; it holds nothing grader-private. The
    // log is read-only - it is evidence, and an agent that can rewrite it can
    // rewrite the record of what it did.
    "-v", `${resolve(m.sourceDir)}:${paths.source}:rw`,
    "-v", `${resolve(m.dataDir)}:${paths.data}:rw`,
    "-v", `${resolve(m.socketDir)}:${paths.socket}:rw`,
    "-v", `${resolve(m.logPath)}:${paths.log}:ro`,
    "-v", `${resolve(m.scratchDir)}:${paths.scratch}:rw`,
    "-v", `${resolve(m.buildViewDir)}:${paths.postgres}:ro`,
    "-w", paths.scratch,
    "-e", `PATH=${CONTAINER_PATH}`,
    // Redundant now that configure --prefix *is* paths.postgres and the build
    // is mounted exactly there - RUNPATH already resolves. Kept because it
    // costs nothing and keeps a build made with a different prefix (an
    // operator-supplied cache entry, a future profile) loadable rather than
    // failing at dyld/ld.so time.
    "-e", `LD_LIBRARY_PATH=${paths.lib}`
  );
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(options.image ?? DEFAULT_RESEARCH_IMAGE, ...options.command);
  return args;
}

/** True when a docker daemon is actually reachable, not merely when the client is installed. */
export async function dockerAvailable(runCommand = runCommandSafe): Promise<boolean> {
  const result = await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
  return result.ok && Boolean(result.stdout.trim());
}

/** Best-effort stop of a named container; used when an agent exceeds its timeout. */
export function killResearchContainer(containerName: string): void {
  try {
    spawn("docker", ["kill", containerName], { stdio: "ignore" }).on("error", () => {});
  } catch {
    // The daemon is gone or the container already exited; the client process
    // is killed separately, so there is nothing further to do here.
  }
}

/**
 * The per-trial build view moved to ./build-view.ts when the runtime sidecar
 * started needing the same view for its own read-only mount: agent-container
 * imports research-environment, so research-environment cannot import these
 * back from here without closing an ESM cycle. Re-exported so every existing
 * import path still resolves.
 */
export {
  createBuildView,
  removeBuildView,
  defaultBuildViewsRoot,
  type BuildView
} from "./build-view.js";

/**
 * Creates the per-trial scratch directory the agent writes into, and drops a
 * short README so a real agent can tell where it is meant to leave results.
 */
export async function createAgentScratchDir(root: string): Promise<string> {
  const dir = join(root, "agent-work");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "README.txt"),
    [
      "This directory is your working area ($HR_PG_WORK_DIR).",
      "Write reproducers, notes and results here; it is kept after the run.",
      ""
    ].join("\n")
  );
  return dir;
}
