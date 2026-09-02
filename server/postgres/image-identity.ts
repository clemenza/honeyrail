import { runCommandSafe } from "../utils.js";
import type { RunCommand } from "./runtime.js";

/**
 * "Which image is this, actually?" - asked of the docker daemon, for the two
 * pinned images a scored PostgreSQL research trial depends on: the builder
 * (server/postgres/build-container.ts) and the runtime sidecar
 * (server/postgres/runtime-container.ts).
 *
 * This is a leaf module rather than a helper inside build-container.ts for the
 * same reason container-paths.ts is one: runtime-container.ts needs the exact
 * same fact, and importing it out of the *build* module would both read wrong
 * and couple two independent containers through a third.
 *
 * Two properties are load-bearing:
 *
 * - **Observed, never declared.** A tag is mutable; two different images can
 *   wear `:latest` on two different days. The build cache key includes the
 *   builder's content-addressed id so a rebuilt builder invalidates what it
 *   produced, and the runtime manifest records the runtime's id so a reviewer
 *   can tell which server binary-compatible base actually ran.
 * - **No implicit pull.** A missing image is a loud failure naming the
 *   `docker build` that creates it. A scored trial must not depend on remote
 *   availability, and a pull is exactly how a mutable tag quietly changes
 *   underneath a cache.
 */

export type ContainerImageIdentity = {
  reference: string;
  /**
   * The image's content-addressed config digest (`{{.Id}}`). Always present,
   * including for an image that was only ever built locally.
   */
  id: string;
  /**
   * The registry manifest digest (`RepoDigests[0]`), when there is one. A
   * freshly `docker build`-ed local image has none, which is why `id` and not
   * this is what participates in the build cache key.
   */
  digest: string | null;
  /** From the image config, e.g. "linux/arm64". */
  platform: string;
  os: string;
  architecture: string;
};

export class PostgresImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresImageError";
  }
}

async function inspect(image: string, format: string, runCommand: RunCommand, buildHint: string): Promise<string> {
  const result = await runCommand("docker", ["image", "inspect", "--format", format, image], { timeout: 30_000 });
  if (!result.ok) {
    throw new PostgresImageError(
      `Image "${image}" is not available to the docker daemon. ${buildHint} ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout.trim();
}

/**
 * Resolves an image's identity, failing loudly (with the command that would
 * create it) if the daemon does not already have it.
 */
export async function resolveImageIdentity(
  image: string,
  options: { runCommand?: RunCommand; buildHint: string }
): Promise<ContainerImageIdentity> {
  const runCommand = options.runCommand ?? runCommandSafe;
  const id = await inspect(image, "{{.Id}}", runCommand, options.buildHint);
  const digest = await inspect(image, "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}", runCommand, options.buildHint);
  const os = await inspect(image, "{{.Os}}", runCommand, options.buildHint);
  const architecture = await inspect(image, "{{.Architecture}}", runCommand, options.buildHint);
  if (!id) throw new PostgresImageError(`Image "${image}" reported no image id`);
  return { reference: image, id, digest: digest || null, platform: `${os}/${architecture}`, os, architecture };
}
