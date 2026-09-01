import { userInfo } from "node:os";

/**
 * The `docker run` hardening flags HoneyRail uses whenever it launches an
 * agent process that must not be able to read the host filesystem.
 *
 * Factored out of `scripts/tinytable-exam-room.ts`'s `buildDockerArgs()`
 * (#105) so the PostgreSQL research environment's isolated agent launcher
 * (`server/postgres/agent-container.ts`, #182) enforces the *same* boundary
 * rather than a second, subtly weaker copy of it. It is deliberately just a
 * flag builder shared by two call sites - not a container abstraction, not a
 * provider interface. Each call site appends its own mounts, working
 * directory, environment, image and command afterwards, because those are
 * exactly the parts that differ.
 *
 * What the flags buy, and why each one is here:
 *
 * - `--cap-drop=ALL` + `--security-opt no-new-privileges`: no capability can
 *   be used or regained to widen the process's view.
 * - `--read-only`: the container's own root filesystem is immutable. Defense
 *   in depth, not the load-bearing part - writes go to the tmpfs `$HOME` and
 *   to whatever the caller bind-mounts read-write.
 * - `--pids-limit` / `--memory`: a runaway agent bounds itself.
 * - `--user <host uid:gid>`: the agent writes into caller-supplied bind
 *   mounts as the host user that owns them, so nothing needs pre-chowning.
 * - `--tmpfs /tmp` + `HOME=/tmp`: a writable, ephemeral home that dies with
 *   the container's `--rm`.
 *
 * The actual isolation guarantee is not in this list at all: it is that the
 * caller mounts *only* the paths the agent is meant to see. A host path that
 * is never bind-mounted does not exist inside the container's mount
 * namespace, which is what #103 proved an in-process sandbox cannot promise.
 */

export const DEFAULT_MEMORY = "2g";
export const DEFAULT_PIDS_LIMIT = 256;
export const DEFAULT_TMP_SIZE = "256m";

export type ContainerHardeningOptions = {
  /** `--name`, so a timeout can `docker kill` the container rather than only its client. */
  containerName: string;
  /**
   * "bridge" (default) gives the agent its own network namespace with
   * outbound access - enough for its own model API, and with no route to the
   * host's loopback services. "none" disables networking entirely. Any other
   * docker network name is passed through.
   */
  network?: "none" | "bridge" | (string & {});
  memory?: string;
  pidsLimit?: number;
  tmpfsSize?: string;
};

/**
 * The leading, shared portion of a `docker run` argv: everything from `run`
 * up to and including the tmpfs `$HOME`. Callers append `-v`/`-w`/`-e`, then
 * the image and command.
 */
export function containerHardeningArgs(options: ContainerHardeningOptions): string[] {
  const { uid, gid } = userInfo();
  return [
    "run",
    "--rm",
    "--name",
    options.containerName,
    "--network",
    options.network ?? "bridge",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--pids-limit",
    String(options.pidsLimit ?? DEFAULT_PIDS_LIMIT),
    "--memory",
    options.memory ?? DEFAULT_MEMORY,
    "--user",
    `${uid}:${gid}`,
    "--tmpfs",
    `/tmp:size=${options.tmpfsSize ?? DEFAULT_TMP_SIZE}`,
    "-e",
    "HOME=/tmp"
  ];
}
