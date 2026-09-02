import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { runCommandSafe } from "../utils.js";
import { containerHardeningArgs } from "../containers/hardening.js";
import { RUNTIME_CONTAINER_PATHS } from "./container-paths.js";
import { resolveImageIdentity, type ContainerImageIdentity } from "./image-identity.js";
import { psqlArgs, waitForPostgresReady, type PostgresReadiness, type RunCommand } from "./runtime.js";

/**
 * The PostgreSQL runtime sidecar (#182, fourth review).
 *
 * ## What was broken
 *
 * The third review moved the *build* into a Linux container with a neutral
 * prefix. It did not move the *server*: `PostgresResearchEnvironment` still
 * ran `initdb`, `pg_ctl`, `postgres` and the grader's `psql` as host
 * processes. A `container`-mode build produces Linux ELF binaries, so on
 * macOS or Windows the first `start()` did not degrade - it died with
 * `exec format error`. Every green "live cluster" test on a developer machine
 * was running the synthetic `#!/bin/sh` fixture, whose "binaries" are text and
 * therefore execute anywhere. The real Linux artifact had never started a
 * server, accepted a connection or answered a query.
 *
 * ## What this is
 *
 * A long-lived container that holds a real PostgreSQL cluster, driven entirely
 * by `docker exec` from the grader side:
 *
 *   docker run -d --network none ... <runtime image> <inert process>
 *   docker exec <rt> /opt/honeyrail/postgres/bin/initdb -D /runtime/pgdata ...
 *   docker exec <rt> /opt/honeyrail/postgres/bin/pg_ctl ... start -w
 *   docker exec <rt> /opt/honeyrail/postgres/bin/psql ... -c 'SELECT 1;'
 *   docker exec <rt> /opt/honeyrail/postgres/bin/pg_ctl ... stop -m fast -w
 *   docker rm -f <rt>
 *
 * The inert PID 1 is the load-bearing part of that shape. `pg_ctl start`
 * daemonizes: the postmaster is reparented to PID 1 and outlives the `exec`
 * that launched it, but only for as long as the *container* lives. A
 * `docker run --rm` whose controlling process exits would take the cluster
 * with it (or orphan it), which is why the container is created once and
 * every lifecycle step is an `exec` into it.
 *
 * ## How the agent reaches it
 *
 * Through the trial's Unix socket directory, bind-mounted into both
 * containers from the same host directory. AF_UNIX filesystem sockets are
 * resolved through the mount namespace, not the network namespace, so both
 * sides keep `--network none` and the server never publishes a host TCP port
 * (it is started with `-h ''`, so it does not listen on TCP at all). Verified
 * on this repository's own Docker Desktop/VirtioFS host: a container can
 * `bind()` a socket in a macOS bind mount and a second container can
 * `connect()` to it.
 *
 * ## Ownership, and the identity shim
 *
 * The container runs as the host uid/gid, so PGDATA, the socket directory and
 * the server log are written by the host user that owns those bind mounts and
 * host-side cleanup can remove them afterwards without privilege.
 *
 * PostgreSQL calls `getpwuid()` on its effective uid before it does anything
 * else (`initdb`'s `get_id()`), and an arbitrary host uid - this repository's
 * developer machine reports 71393735 - has no entry in any stock image:
 *
 *   initdb: could not look up effective user ID 71393735: user does not exist
 *
 * So the runner generates a single-entry `passwd`/`group` pair per trial and
 * bind-mounts them read-only over `/etc/passwd` and `/etc/group`. That is a
 * two-line generated file naming only the trial's own uid/gid - not host
 * research data, and never mounted into the agent container. Baking a fixed
 * user into the image instead would only work for hosts that happen to share
 * its uid, which is exactly the assumption the review forbids.
 *
 * A host that *is* root is the mirror-image problem: PostgreSQL refuses to run
 * as uid 0, so the runner picks a fixed non-root uid and chowns the trial's
 * ephemeral directories to it. Root can still remove them afterwards.
 *
 * This module is deliberately PostgreSQL-specific and store/executor-agnostic:
 * it knows about initdb, pg_ctl, psql and PGDATA, and nothing about
 * HoneyRail's DAG, evidence model or agent execution. It is not a generic
 * container/lease/environment framework, and must not become one.
 */

export const DEFAULT_RUNTIME_IMAGE = "honeyrail-postgres-runtime:latest";

export const DEFAULT_RUNTIME_MEMORY = "2g";
export const DEFAULT_RUNTIME_PIDS_LIMIT = 512;
/** shared_buffers defaults to 128MB and PostgreSQL puts its dsm segments under /dev/shm, not /tmp. */
export const DEFAULT_RUNTIME_TMP_SIZE = "512m";

/**
 * The inert PID 1. It must (a) never exit on its own, (b) reap nothing that
 * matters, and (c) exist in a bare debian:bookworm-slim. `sleep infinity` in a
 * shell loop satisfies all three and, unlike `tail -f /dev/null`, does not
 * hold a file descriptor on anything.
 */
export const RUNTIME_INERT_PROCESS = ["/bin/sh", "-c", "while true; do sleep 3600; done"] as const;

/**
 * The uid the runtime runs as when the host user is root. Arbitrary, and
 * deliberately not "postgres": there is no postgres user in the image either,
 * so the identity shim covers this case with the same mechanism.
 */
export const ROOT_HOST_FALLBACK_UID = 10001;
export const ROOT_HOST_FALLBACK_GID = 10001;

export class PostgresRuntimeContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresRuntimeContainerError";
  }
}

/** The uid/gid the runtime container runs PostgreSQL as, given the host user. */
export function runtimeUserIds(host: { uid: number; gid: number } = userInfo()): { uid: number; gid: number } {
  if (host.uid === 0) return { uid: ROOT_HOST_FALLBACK_UID, gid: ROOT_HOST_FALLBACK_GID };
  return { uid: host.uid, gid: host.gid };
}

/** The generated `/etc/passwd` and `/etc/group` contents. Two lines each; no host facts. */
export function runtimeIdentityFiles(ids: { uid: number; gid: number }): { passwd: string; group: string } {
  return {
    passwd: [
      "root:x:0:0:root:/root:/bin/sh",
      `hrpg:x:${ids.uid}:${ids.gid}:HoneyRail PostgreSQL runtime:/tmp:/bin/sh`,
      ""
    ].join("\n"),
    group: ["root:x:0:", `hrpg:x:${ids.gid}:`, ""].join("\n")
  };
}

/** Writes the identity shim into `dir` and returns the two file paths. */
export async function writeRuntimeIdentityFiles(
  dir: string,
  ids: { uid: number; gid: number }
): Promise<{ passwd: string; group: string }> {
  await mkdir(dir, { recursive: true });
  const contents = runtimeIdentityFiles(ids);
  const passwd = join(dir, "passwd");
  const group = join(dir, "group");
  await writeFile(passwd, contents.passwd);
  await writeFile(group, contents.group);
  // World-readable: they are mounted over /etc/passwd, which every libc lookup
  // in the container reads, including ones running as a different uid.
  await chmod(passwd, 0o644);
  await chmod(group, 0o644);
  return { passwd, group };
}

/**
 * Resolves the runtime image, failing loudly if it is absent. No implicit
 * pull, for the same reason the builder image is never pulled: a scored trial
 * must not depend on remote availability, and matching tags do not mean
 * matching contents.
 */
export async function resolveRuntimeImageIdentity(
  image: string = DEFAULT_RUNTIME_IMAGE,
  runCommand: RunCommand = runCommandSafe
): Promise<ContainerImageIdentity> {
  try {
    return await resolveImageIdentity(image, {
      runCommand,
      buildHint:
        `Build it first: docker build -t ${image} docker/postgres-research-runtime ` +
        `(or pass runtime.image / set build.mode: "host" for an explicitly unscored local host-process cluster).`
    });
  } catch (error) {
    throw new PostgresRuntimeContainerError((error as Error).message);
  }
}

export type RuntimeContainerMounts = {
  /**
   * Host path of this trial's randomized *view* of the build - never the
   * shared cache entry itself, whose directory name is the deterministic
   * entry id. Mounted read-only at the neutral prefix, which is also what the
   * binaries were configured with, so RUNPATH resolves with no override.
   */
  buildViewDir: string;
  /** Host PGDATA. */
  dataDir: string;
  /** Host socket directory; the same directory the agent container mounts. */
  socketDir: string;
  /** Host path of the server log file. Must exist: docker would otherwise create a directory. */
  logPath: string;
  /** Generated `/etc/passwd`; see writeRuntimeIdentityFiles(). */
  passwdPath: string;
  /** Generated `/etc/group`. */
  groupPath: string;
};

export type RuntimeContainerSpec = {
  mounts: RuntimeContainerMounts;
  image?: string;
  memory?: string;
  pidsLimit?: number;
  tmpfsSize?: string;
  /** `uid:gid`; defaults to runtimeUserIds() of the current host user. */
  user?: string;
};

/**
 * The `docker run` argv for the runtime sidecar, exposed separately from the
 * execution so a test can assert exactly what is and is not mounted without
 * needing a docker daemon.
 *
 * The mount list is the whole security argument, so it is short and explicit.
 * Never mounted: the PostgreSQL source mirror or any `.git`, HoneyRail's
 * attachment tree, the grader-private directory, the shared build-cache root,
 * a sibling trial's directories, the HoneyRail checkout, the home directory,
 * or the docker socket.
 */
export function buildRuntimeContainerArgs(spec: RuntimeContainerSpec, containerName: string): string[] {
  const paths = RUNTIME_CONTAINER_PATHS;
  const m = spec.mounts;
  const ids = runtimeUserIds();
  const args = containerHardeningArgs({
    containerName,
    // Not a hardening nicety: it is what makes "the server is unreachable
    // except through the shared socket" true by construction rather than by
    // configuration. The server is additionally started with -h '' so it does
    // not listen on TCP inside its own namespace either.
    network: "none",
    memory: spec.memory ?? DEFAULT_RUNTIME_MEMORY,
    pidsLimit: spec.pidsLimit ?? DEFAULT_RUNTIME_PIDS_LIMIT,
    tmpfsSize: spec.tmpfsSize ?? DEFAULT_RUNTIME_TMP_SIZE,
    user: spec.user ?? `${ids.uid}:${ids.gid}`
  });
  // Detached: the container outlives the `docker run` client, which is the
  // entire point - the postmaster is reparented to this container's PID 1.
  args.splice(1, 0, "-d");
  args.push(
    "-v", `${resolve(m.buildViewDir)}:${paths.postgres}:ro`,
    "-v", `${resolve(m.dataDir)}:${paths.data}:rw`,
    "-v", `${resolve(m.socketDir)}:${paths.socket}:rw`,
    "-v", `${resolve(m.logPath)}:${paths.log}:rw`,
    "-v", `${resolve(m.passwdPath)}:${paths.passwd}:ro`,
    "-v", `${resolve(m.groupPath)}:${paths.group}:ro`,
    "-w", paths.runtime,
    // Nothing of the host environment is inherited; a container gets exactly
    // what is passed here. Note what is absent: every PG* variable, so an
    // operator's ambient PGHOST/PGPORT/PGDATA cannot redirect the cluster.
    "-e", `PATH=${paths.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    // Redundant while the build is mounted at the prefix it was configured
    // with, and kept for the same reason the agent container keeps it: an
    // operator-supplied entry built with a different prefix stays loadable.
    "-e", `LD_LIBRARY_PATH=${paths.lib}`,
    // Explicit locale. initdb --no-locale still consults the environment for
    // messages, and a cluster whose behaviour depends on the operator's LANG
    // is not a reproducible research subject.
    "-e", "LC_ALL=C",
    "-e", "LANG=C"
  );
  args.push(spec.image ?? DEFAULT_RUNTIME_IMAGE, ...RUNTIME_INERT_PROCESS);
  return args;
}

/** What the grader records about how (and whether) the server was contained. */
export type PostgresRuntimeRecord = {
  /** `container` is the only scored value; `host-process` is the legacy development path. */
  mode: "container" | "host-process";
  /**
   * True only for a real runtime container. Folded into the session-level
   * verdict together with the build and agent axes - see
   * PostgresResearchIsolationRecord.
   */
  scoredEligible: boolean;
  /** Present, and loud, whenever `scoredEligible` is false. */
  unscoredReason?: string;
  image?: ContainerImageIdentity;
  containerName?: string;
  /** The daemon's own id for the container that ran, so evidence is traceable. */
  containerId?: string;
  networkMode?: string;
  /** `uid:gid` PostgreSQL ran as inside the container. */
  user?: string;
  /** The exact `-v` specs, so a reviewer can see what was and was not exposed. */
  mounts?: string[];
  /** Host paths, grader-side. The server itself only ever saw /runtime/*. */
  dataDir?: string;
  socketDir?: string;
  logPath?: string;
};

// Whether the container was removed is deliberately *not* a field here: this
// record is captured while the trial is still running, so it could only ever
// say "false" and would read like a leak. PostgresCleanupResult's
// `runtimeContainerRemoved` is the single authoritative answer.

export const HOST_RUNTIME_UNSCORED_REASON =
  'This cluster ran as host processes (build.mode: "host"): initdb, the postmaster and psql were executed by the ' +
  "host kernel rather than inside the pinned Linux runtime container, so the server under research is not the " +
  "artifact a scored trial runs. Development only - not a scored trial.";

export type RuntimeExecOptions = { timeout?: number; maxBuffer?: number };

/**
 * The one place this module does not go through `RunCommand`: running a
 * command with something on its stdin, which `runCommandSafe`'s `execFile`
 * shape has no way to express. Used only by psqlFile(), and it returns the
 * same result shape so callers cannot tell the difference.
 */
async function execWithInput(
  command: string,
  args: string[],
  input: string,
  options: RuntimeExecOptions = {}
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const limit = options.maxBuffer ?? 1024 * 1024 * 32;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { ok: boolean; stdout: string; stderr: string; code: number | string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout, stderr: `${stderr}\ntimed out after ${options.timeout ?? 120_000}ms`, code: "ETIMEDOUT" });
    }, options.timeout ?? 120_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < limit) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < limit) stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, stdout, stderr: `${stderr}${error.message}`, code: 1 }));
    child.on("close", (code) => finish({ ok: code === 0, stdout, stderr, code: code ?? 1 }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * One trial's PostgreSQL server, inside its own container.
 *
 * Lifecycle mirrors the host path it replaces one-for-one - create, initdb,
 * start, waitReady, psql/psqlFile, restart, stop, health, cleanup - so
 * PostgresResearchEnvironment can delegate to it without either side growing
 * a mode switch beyond "is there a runtime container?".
 */
export class PostgresRuntimeContainer {
  readonly containerName: string;
  readonly image: ContainerImageIdentity;
  readonly mounts: RuntimeContainerMounts;
  readonly user: string;
  readonly networkMode = "none";

  private readonly runCommand: RunCommand;
  private readonly memory?: string;
  private readonly pidsLimit?: number;
  private readonly tmpfsSize?: string;
  private mountSpecs: string[] = [];
  private containerId = "";
  private created = false;
  private removed = false;

  constructor(input: {
    image: ContainerImageIdentity;
    mounts: RuntimeContainerMounts;
    runCommand?: RunCommand;
    containerName?: string;
    memory?: string;
    pidsLimit?: number;
    tmpfsSize?: string;
    user?: string;
  }) {
    this.image = input.image;
    this.mounts = input.mounts;
    this.runCommand = input.runCommand ?? runCommandSafe;
    this.containerName = input.containerName ?? `honeyrail-pg-runtime-${randomUUID()}`;
    const ids = runtimeUserIds();
    this.user = input.user ?? `${ids.uid}:${ids.gid}`;
    this.memory = input.memory;
    this.pidsLimit = input.pidsLimit;
    this.tmpfsSize = input.tmpfsSize;
  }

  isCreated() {
    return this.created && !this.removed;
  }

  record(): PostgresRuntimeRecord {
    return {
      mode: "container",
      scoredEligible: true,
      image: this.image,
      containerName: this.containerName,
      containerId: this.containerId || undefined,
      networkMode: this.networkMode,
      user: this.user,
      mounts: [...this.mountSpecs],
      dataDir: this.mounts.dataDir,
      socketDir: this.mounts.socketDir,
      logPath: this.mounts.logPath
    };
  }

  /**
   * Starts the container. Nothing PostgreSQL-related runs yet - this only
   * establishes the namespace the rest of the lifecycle execs into.
   */
  async create(options: { timeout?: number } = {}): Promise<void> {
    if (this.created) return;
    const args = buildRuntimeContainerArgs(
      {
        mounts: this.mounts,
        image: this.image.reference,
        memory: this.memory,
        pidsLimit: this.pidsLimit,
        tmpfsSize: this.tmpfsSize,
        user: this.user
      },
      this.containerName
    );
    this.mountSpecs = args.filter((_value, index) => args[index - 1] === "-v");
    const result = await this.runCommand("docker", args, { timeout: options.timeout ?? 120_000 });
    if (!result.ok) {
      // A half-created container (created, then failed to start) would hold
      // the bind mounts open against the cleanup that is about to run.
      await this.forceRemove();
      throw new PostgresRuntimeContainerError(
        `Could not start the PostgreSQL runtime container from "${this.image.reference}": ` +
          `${(result.stderr || result.stdout).trim()}`
      );
    }
    this.containerId = result.stdout.trim();
    this.created = true;
  }

  private assertCreated() {
    if (!this.created || this.removed) {
      throw new PostgresRuntimeContainerError(
        `The PostgreSQL runtime container ${this.containerName} is not running (create() first)`
      );
    }
  }

  /** `docker exec` into the sidecar. The container's own env is inherited; nothing of the host's is. */
  async exec(argv: string[], options: RuntimeExecOptions = {}) {
    this.assertCreated();
    return this.runCommand("docker", ["exec", this.containerName, ...argv], {
      timeout: options.timeout ?? 120_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 32
    });
  }

  /**
   * A RunCommand that transparently executes inside the container, so helpers
   * written against the host lifecycle (waitForPostgresReady) work unchanged.
   */
  private execRunCommand: RunCommand = async (command, args = [], options = {}) =>
    this.exec([command, ...args], { timeout: options.timeout, maxBuffer: options.maxBuffer });

  private bin(program: string) {
    return `${RUNTIME_CONTAINER_PATHS.bin}/${program}`;
  }

  async initdb(args: readonly string[], options: RuntimeExecOptions = {}) {
    const result = await this.exec([this.bin("initdb"), "-D", RUNTIME_CONTAINER_PATHS.data, ...args], options);
    if (!result.ok) {
      throw new PostgresRuntimeContainerError(
        `initdb failed inside the runtime container: ${(result.stderr || result.stdout).trim()}`
      );
    }
    return result;
  }

  /**
   * `-h ''` is the reason no host TCP port is ever published: the postmaster
   * does not listen on TCP at all, in its own network namespace or anywhere
   * else. The port still names the socket file (`.s.PGSQL.<port>`), which is
   * what keeps two trials sharing a socket root from colliding.
   */
  postmasterOptions(port: number) {
    return `-p ${port} -h '' -k ${RUNTIME_CONTAINER_PATHS.socket}`;
  }

  async start(port: number, options: RuntimeExecOptions = {}) {
    return this.exec(
      [
        this.bin("pg_ctl"),
        "-D", RUNTIME_CONTAINER_PATHS.data,
        "-l", RUNTIME_CONTAINER_PATHS.log,
        "-o", this.postmasterOptions(port),
        "start",
        "-w"
      ],
      options
    );
  }

  async restart(port: number, options: RuntimeExecOptions = {}) {
    return this.exec(
      [
        this.bin("pg_ctl"),
        "-D", RUNTIME_CONTAINER_PATHS.data,
        "restart",
        "-m", "fast",
        "-w",
        "-l", RUNTIME_CONTAINER_PATHS.log,
        "-o", this.postmasterOptions(port)
      ],
      options
    );
  }

  async stop(mode: "fast" | "immediate", options: RuntimeExecOptions = {}) {
    return this.exec([this.bin("pg_ctl"), "-D", RUNTIME_CONTAINER_PATHS.data, "stop", "-m", mode, "-w"], options);
  }

  async waitReady(target: { port: number; user: string; database: string }): Promise<PostgresReadiness> {
    return waitForPostgresReady({
      runCommand: this.execRunCommand,
      cwd: RUNTIME_CONTAINER_PATHS.runtime,
      psql: this.bin("psql"),
      // libpq treats a host beginning with "/" as a Unix socket directory.
      host: RUNTIME_CONTAINER_PATHS.socket,
      port: target.port,
      user: target.user,
      database: target.database
    });
  }

  async psql(target: { port: number; user: string; database: string }, tail: string[], options: RuntimeExecOptions = {}) {
    return this.exec(
      [
        this.bin("psql"),
        ...psqlArgs({ host: RUNTIME_CONTAINER_PATHS.socket, port: target.port, user: target.user, database: target.database }, tail)
      ],
      options
    );
  }

  /**
   * Runs a grader-side SQL script.
   *
   * The file is on the *host*, which the runtime container cannot see - and
   * must not, since it could be anywhere, including under the grader-private
   * tree. So the script is streamed in on `docker exec -i`'s stdin and read by
   * `psql -f -`. No new bind mount, no host path inside the container, and no
   * argv size limit on the script.
   *
   * The two obvious alternatives were both worse. `docker cp` is refused
   * outright by a `--read-only` container ("container rootfs is marked
   * read-only") even when the destination is a tmpfs, and dropping
   * `--read-only` to accommodate it would weaken the sidecar for the sake of a
   * convenience. Passing the script as an argv element hits `MAX_ARG_STRLEN`
   * (128 KiB) on a large reproducer.
   */
  async psqlFile(
    target: { port: number; user: string; database: string },
    hostPath: string,
    options: RuntimeExecOptions = {}
  ) {
    this.assertCreated();
    const script = await readFile(hostPath, "utf8").catch((error: Error) => error);
    if (script instanceof Error) {
      return { ok: false, stdout: "", stderr: `could not read ${hostPath}: ${script.message}`, code: 1 as number | string };
    }
    return execWithInput(
      "docker",
      [
        "exec",
        "-i",
        this.containerName,
        this.bin("psql"),
        ...psqlArgs(
          { host: RUNTIME_CONTAINER_PATHS.socket, port: target.port, user: target.user, database: target.database },
          ["-v", "ON_ERROR_STOP=1", "-f", "-"]
        )
      ],
      script,
      options
    );
  }

  /** Two independent facts: is the container up, and does pg_ctl think the postmaster is up. */
  async health(): Promise<{ containerRunning: boolean; serverRunning: boolean; detail: string }> {
    const inspected = await this.runCommand("docker", ["inspect", "--format", "{{.State.Running}}", this.containerName], {
      timeout: 30_000
    });
    const containerRunning = inspected.ok && inspected.stdout.trim() === "true";
    if (!containerRunning) {
      return { containerRunning: false, serverRunning: false, detail: (inspected.stderr || inspected.stdout).trim() };
    }
    const status = await this.exec([this.bin("pg_ctl"), "-D", RUNTIME_CONTAINER_PATHS.data, "status"], { timeout: 30_000 });
    return { containerRunning, serverRunning: status.ok, detail: (status.stdout || status.stderr).trim() };
  }

  private async forceRemove() {
    await this.runCommand("docker", ["rm", "-f", this.containerName], { timeout: 60_000 }).catch(() => undefined);
  }

  /**
   * Removes the container. Never throws: it runs from cleanup paths where
   * throwing would mask the original failure. `--rm` means an already-exited
   * container is usually gone by now, so "no such container" is success.
   */
  async cleanup(): Promise<boolean> {
    if (this.removed) return true;
    this.removed = true;
    if (!this.created) return true;
    const result = await this.runCommand("docker", ["rm", "-f", this.containerName], { timeout: 60_000 });
    return result.ok || /No such container/i.test(result.stderr || result.stdout);
  }
}

/**
 * Makes the trial's ephemeral runtime directories writable by the uid the
 * runtime container will run PostgreSQL as. A no-op on every host whose user
 * is not root, which is the normal case; on a root host (a Linux CI runner)
 * the container runs as ROOT_HOST_FALLBACK_UID instead, and initdb's own
 * `chmod 0700` of PGDATA would otherwise fail against a root-owned directory.
 */
export async function alignRuntimeOwnership(paths: string[], host: { uid: number; gid: number } = userInfo()): Promise<void> {
  if (host.uid !== 0) return;
  const ids = runtimeUserIds(host);
  for (const path of paths) {
    await chown(path, ids.uid, ids.gid).catch(() => undefined);
  }
}
