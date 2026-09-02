import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCommandSafe } from "../utils.js";
import { containerHardeningArgs } from "../containers/hardening.js";
import { RESEARCH_CONTAINER_PATHS } from "./container-paths.js";
import { BUILD_COMPLETE_MARKER } from "./research-environment.js";
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
 * PostgreSQL itself keeps running as a host process. The agent reaches that
 * cluster through the bind-mounted socket directory: AF_UNIX filesystem-path
 * sockets are resolved through the mount namespace, not the network
 * namespace, which is the same mechanism that makes mounting
 * `/var/run/docker.sock` into a container work - and it is why the scored
 * default `--network none` costs the agent nothing it actually needs.
 *
 * The *build* is containerized as of the third review (#182): it runs in
 * docker/postgres-research-builder with the neutral prefix
 * RESEARCH_CONTAINER_PATHS.postgres, so the binaries mounted here are Linux
 * binaries this container can execute on any Docker host, and nothing in them
 * names the grader's cache. Containerizing the *server* as well is still a
 * larger change and is not attempted here; the consequence is that the
 * cluster-side of a scored trial wants a Linux host. See
 * research-environment.ts's abiHint().
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
 * Where per-trial build views live: a sibling of the build cache rather than
 * a directory inside it, so that the cache root's own path never appears in
 * the container's mount table either. A sibling is also guaranteed to be on
 * the same filesystem, which is what makes the hard-link view below possible.
 */
export function defaultBuildViewsRoot(cacheRoot?: string): string {
  if (process.env.HONEYRAIL_PG_BUILD_VIEWS) return process.env.HONEYRAIL_PG_BUILD_VIEWS;
  if (cacheRoot) return join(dirname(cacheRoot), "pg-research-build-views");
  return join(homedir(), ".honeyrail", "pg-research-build-views");
}

async function linkTree(src: string, dest: string, skip: ReadonlySet<string>) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await linkTree(from, to, new Set());
    } else if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else {
      // Hard links share the cached build's data - this is a second *view* of
      // one build, not a second copy of it. A cross-device or link-hostile
      // filesystem falls back to a real copy rather than failing the trial.
      await link(from, to).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === "EXDEV" || error.code === "EPERM" || error.code === "EMLINK" || error.code === "ENOTSUP") {
          await copyFile(from, to);
          return;
        }
        throw error;
      });
    }
  }
}

export type BuildView = {
  /** Host path of this trial's view. Grader-side only; the agent sees it as /opt/honeyrail/postgres. */
  dir: string;
  /** Random, per-trial, uncorrelatable across trials. */
  id: string;
};

/**
 * Builds this trial's private, randomly-named hard-link view of a cached
 * build, and mounts *that* rather than the cache entry itself.
 *
 * This is what actually closes the deterministic-identity hole, and the
 * reason it is needed even though the container already exposes the build at
 * a fixed neutral path: a bind mount's source path is visible inside the
 * container in `/proc/self/mountinfo`. Verified directly - mounting
 * `<cacheRoot>/<entryId>` at `/opt/honeyrail/postgres` puts the literal
 * `entryId` in the container's own mount table, where an agent that can
 * enumerate a bounded set of candidate refs could recompute and match it.
 * Mounting a per-trial random directory puts a random string there instead.
 *
 * The build itself is not duplicated (hard links), and the cache stays
 * deterministic and shared grader-side, so cache reuse is unaffected.
 *
 * The completion marker is deliberately left out of the view: it carries the
 * deterministic `entryId`, which is exactly what must not reach the agent.
 */
export async function createBuildView(installDir: string, viewsRoot: string): Promise<BuildView> {
  await mkdir(viewsRoot, { recursive: true });
  const parent = await mkdtemp(join(viewsRoot, "view-"));
  const id = randomBytes(16).toString("hex");
  const dir = join(parent, id);
  await linkTree(installDir, dir, new Set([BUILD_COMPLETE_MARKER]));
  return { dir, id };
}

/** Removes a build view. Never throws: it runs from cleanup paths. */
export async function removeBuildView(view: BuildView | undefined): Promise<void> {
  if (!view) return;
  await rm(dirname(view.dir), { recursive: true, force: true }).catch(() => {});
}

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
