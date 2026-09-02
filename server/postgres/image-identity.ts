import { runCommandSafe } from "../utils.js";
import type { RunCommand } from "./runtime.js";

/**
 * "Which image is this, actually?" - asked of the docker daemon, for the
 * pinned images a scored PostgreSQL research trial depends on: the builder
 * (server/postgres/build-container.ts), the runtime sidecar
 * (server/postgres/runtime-container.ts) and the agent runner
 * (server/postgres/agent-container.ts).
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
  /** Normalized from the image config, e.g. "linux/arm64" or "linux/arm/v7". */
  platform: string;
  os: string;
  architecture: string;
  variant: string | null;
};

export type ContainerPlatformInput = {
  platform?: string;
  os?: string;
  architecture?: string;
  variant?: string | null;
};

export type NormalizedContainerPlatform = {
  platform: string;
  os: string;
  architecture: string;
  variant: string | null;
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

export function normalizeContainerOs(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeContainerArchitecture(value: string): string {
  const architecture = value.trim().toLowerCase().split("/")[0] ?? "";
  if (architecture === "x64" || architecture === "x86_64") return "amd64";
  if (architecture === "aarch64") return "arm64";
  return architecture;
}

export function normalizeContainerVariant(value?: string | null): string | null {
  const variant = (value ?? "").trim().toLowerCase();
  if (!variant || variant === "<no value>") return null;
  return variant.startsWith("v") ? variant : `v${variant}`;
}

export function normalizedContainerPlatform(input: ContainerPlatformInput): NormalizedContainerPlatform {
  const parts = (input.platform ?? "").split("/").map((part) => part.trim()).filter(Boolean);
  const architectureSource = input.architecture ?? parts[1] ?? "";
  const architectureParts = architectureSource.split("/").map((part) => part.trim()).filter(Boolean);
  const os = normalizeContainerOs(input.os ?? parts[0] ?? "");
  const architecture = normalizeContainerArchitecture(architectureSource);
  const variant = normalizeContainerVariant(
    input.variant ??
      (architectureParts.length > 1
        ? architectureParts.slice(1).join("/")
        : parts.length > 2
          ? parts.slice(2).join("/")
          : null)
  );
  return {
    os,
    architecture,
    variant,
    platform: `${os}/${architecture}${variant ? `/${variant}` : ""}`
  };
}

export function containerPlatformsCompatible(left: ContainerPlatformInput, right: ContainerPlatformInput): boolean {
  const a = normalizedContainerPlatform(left);
  const b = normalizedContainerPlatform(right);
  if (!a.os || !a.architecture || !b.os || !b.architecture) return false;
  if (a.os !== b.os || a.architecture !== b.architecture) return false;
  return !a.variant || !b.variant || a.variant === b.variant;
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
  const variant = await inspect(image, "{{if .Variant}}{{.Variant}}{{end}}", runCommand, options.buildHint);
  if (!id) throw new PostgresImageError(`Image "${image}" reported no image id`);
  const platform = normalizedContainerPlatform({ os, architecture, variant });
  return {
    reference: image,
    id,
    digest: digest || null,
    platform: platform.platform,
    os: platform.os,
    architecture: platform.architecture,
    variant: platform.variant
  };
}
