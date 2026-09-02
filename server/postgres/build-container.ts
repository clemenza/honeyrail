import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { runCommandSafe } from "../utils.js";
import { BUILDER_CONTAINER_PATHS } from "./container-paths.js";
import type { RunCommand } from "./runtime.js";

/**
 * The Linux build container the scored PostgreSQL build runs in (#182).
 *
 * This module is only the plumbing: what a `docker run` for a build step
 * looks like, and how the builder image's identity is read back so it can
 * participate in the build cache key. The build recipe itself (configure,
 * make, make install, the neutral prefix, DESTDIR staging, cache publication)
 * stays in research-environment.ts, which calls in here for the "how do I run
 * one step" part and is otherwise identical between the container and host
 * build modes.
 *
 * Two properties are load-bearing and are why this is not just `docker run`
 * inline at the call site:
 *
 * - **Nothing of the host environment is inherited.** A build container gets
 *   an explicitly constructed environment (PATH, HOME, LC_ALL, plus the
 *   declared build variables that are already in the cache key) - the same
 *   discipline the agent container uses. A build that silently picked up the
 *   operator's CFLAGS through the ambient environment would produce binaries
 *   the cache key does not describe.
 * - **The image identity is observed, not declared.** `:latest` is mutable;
 *   two different images can wear the same tag on two different days. The
 *   cache key therefore includes the image's content-addressed ID, so a
 *   rebuilt builder image invalidates every entry it produced instead of
 *   silently mixing toolchains inside one cache.
 */

export const DEFAULT_BUILDER_IMAGE = "honeyrail-postgres-builder:latest";

/** No host PATH is inherited; a container gets exactly what is passed with `-e`. */
export const BUILDER_CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export const DEFAULT_BUILDER_MEMORY = "6g";
export const DEFAULT_BUILDER_TMP_SIZE = "2g";

/**
 * Content identity of the builder image, as the daemon actually resolved it.
 *
 * `id` is the image's content-addressed config digest and is always
 * available, including for an image that was only ever built locally and
 * never pushed. `digest` is the registry manifest digest (`RepoDigests[0]`)
 * and is only present for an image that was pulled from, or pushed to, a
 * registry - a freshly `docker build`-ed local image has none.
 *
 * The cache key uses `reference` + `id`. `id` is what makes a rebuilt
 * `:latest` invalidate its own cache entries; `digest` is recorded for
 * reviewers and for reproducing a build elsewhere, but keying on it as well
 * would mean an entry silently invalidates the first time the same image gets
 * pushed somewhere, which is not a toolchain change.
 */
export type BuilderImageIdentity = {
  reference: string;
  id: string;
  digest: string | null;
  /** From the image config, e.g. "linux/arm64" - the platform the build actually targets. */
  platform: string;
  os: string;
  architecture: string;
};

export class PostgresBuildContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresBuildContainerError";
  }
}

async function inspect(image: string, format: string, runCommand: RunCommand): Promise<string> {
  const result = await runCommand("docker", ["image", "inspect", "--format", format, image], { timeout: 30_000 });
  if (!result.ok) {
    throw new PostgresBuildContainerError(
      `Build image "${image}" is not available to the docker daemon. ` +
        `Build it first: docker build -t ${image} docker/postgres-research-builder ` +
        `(or pass build.builderImage / set build.mode: "host" for an explicitly unscored local build). ` +
        `${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout.trim();
}

/**
 * Resolves the builder image's identity, failing loudly if the image is not
 * present. There is deliberately no implicit `docker pull`: a scored build
 * must not depend on remote availability, and a pull is also how a mutable
 * tag quietly changes toolchains underneath a cache.
 */
export async function resolveBuilderImageIdentity(
  image: string = DEFAULT_BUILDER_IMAGE,
  runCommand: RunCommand = runCommandSafe
): Promise<BuilderImageIdentity> {
  const id = await inspect(image, "{{.Id}}", runCommand);
  const digest = await inspect(image, "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}", runCommand);
  const os = await inspect(image, "{{.Os}}", runCommand);
  const architecture = await inspect(image, "{{.Architecture}}", runCommand);
  if (!id) throw new PostgresBuildContainerError(`Build image "${image}" reported no image id`);
  return { reference: image, id, digest: digest || null, platform: `${os}/${architecture}`, os, architecture };
}

/** Delimits the probe's fields so `--version` banners spanning several lines parse unambiguously. */
const PROBE_FIELD = "@@HONEYRAIL-FIELD@@";

/**
 * The toolchain identity as observed *inside* the build container: the
 * compiler's `--version` first line and `-dumpmachine` target, plus the
 * `make` that will drive the build.
 *
 * Once compilation has moved into a container, the host's `cc` is not the
 * compiler that produced the binaries, so keying the cache on it would be
 * both wrong and misleading: two different hosts driving the same builder
 * image produce interchangeable binaries and must share a cache entry, and
 * one host whose builder image changed underneath it must not.
 *
 * One container start, not three, because it runs on every build - including
 * every cache *hit*, where it is the only thing standing between a lookup and
 * an answer.
 */
export async function probeBuildContainerToolchain(
  options: { image?: string; runCommand?: RunCommand; buildEnv?: Record<string, string>; timeout?: number } = {}
): Promise<{ compiler: { command: string; version: string; target: string }; make: string }> {
  const runCommand = options.runCommand ?? runCommandSafe;
  const image = options.image ?? DEFAULT_BUILDER_IMAGE;
  const command = options.buildEnv?.CC || "cc";
  const probe = await runCommand(
    "docker",
    [
      ...containerRunPrelude(`honeyrail-pg-probe-${randomUUID()}`),
      "-e",
      `PATH=${BUILDER_CONTAINER_PATH}`,
      "-e",
      "LC_ALL=C",
      image,
      "/bin/sh",
      "-c",
      `set -e; ${command} --version | head -1; echo '${PROBE_FIELD}'; ${command} -dumpmachine; echo '${PROBE_FIELD}'; make --version | head -1`
    ],
    { timeout: options.timeout ?? 120_000 }
  );
  if (!probe.ok) {
    throw new PostgresBuildContainerError(
      `Build image "${image}" has no usable toolchain: the ${command}/make probe failed ` +
        `(${(probe.stderr || probe.stdout).trim()})`
    );
  }
  const [version = "", target = "", make = ""] = probe.stdout.split(PROBE_FIELD).map((field) => field.trim());
  return { compiler: { command, version, target: target || "unknown" }, make };
}

/**
 * The shared leading portion of every build `docker run`. Same posture as
 * server/containers/hardening.ts applies to the agent container, minus the
 * `--read-only` root: a compiler legitimately writes outside its bind mounts
 * (gcc spills into $TMPDIR), and the tmpfs covers that.
 *
 * `--network none` is not a hardening nicety here - it is what makes the
 * build offline by construction, so a `configure` that tried to reach the
 * network would fail rather than make a scored build depend on it.
 */
function containerRunPrelude(containerName: string): string[] {
  const { uid, gid } = userInfo();
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    `${uid}:${gid}`,
    "--tmpfs",
    `/tmp:size=${DEFAULT_BUILDER_TMP_SIZE},exec`,
    "-e",
    "HOME=/tmp"
  ];
}

export type BuildContainerStepSpec = {
  /** Host path of the `.git`-free snapshot; mounted rw, because PostgreSQL builds in-tree. */
  sourceDir: string;
  /** Host DESTDIR staging root; mounted rw. */
  stagingDir: string;
  image: string;
  /** argv executed inside the container, cwd `/build/source`. */
  command: string[];
  /** Declared build variables. Already in the cache key; nothing else is passed through. */
  buildEnv?: Record<string, string>;
  memory?: string;
  containerName?: string;
};

/**
 * The `docker run` argv for one build step. Exposed separately from the
 * execution so tests can assert exactly what is mounted and what is passed
 * without needing a docker daemon.
 */
export function buildContainerStepArgs(spec: BuildContainerStepSpec): string[] {
  const paths = BUILDER_CONTAINER_PATHS;
  const args = [
    ...containerRunPrelude(spec.containerName ?? `honeyrail-pg-build-${randomUUID()}`),
    "--memory",
    spec.memory ?? DEFAULT_BUILDER_MEMORY,
    "-v",
    `${resolve(spec.sourceDir)}:${paths.source}:rw`,
    "-v",
    `${resolve(spec.stagingDir)}:${paths.staging}:rw`,
    "-w",
    paths.source,
    "-e",
    `PATH=${BUILDER_CONTAINER_PATH}`,
    // A build that depends on the operator's locale is a build the cache key
    // does not describe, and configure's output parsing is locale-sensitive.
    "-e",
    "LC_ALL=C",
    "-e",
    "LANG=C"
  ];
  for (const [key, value] of Object.entries(spec.buildEnv ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(spec.image, ...spec.command);
  return args;
}

/**
 * Runs one build step inside the builder image and returns docker's own
 * result.
 *
 * The container is always named, and a step that did not succeed is followed
 * by a best-effort `docker kill`. That is not tidiness: a step timeout kills
 * the local `docker` *client*, and the container it started keeps compiling -
 * holding CPU, memory and a write handle on the staging directory the caller
 * is about to delete. `--rm` only fires once the container exits, so
 * something has to make it exit.
 */
export async function runBuildContainerStep(
  spec: BuildContainerStepSpec,
  options: { runCommand?: RunCommand; timeout: number }
) {
  const runCommand = options.runCommand ?? runCommandSafe;
  const containerName = spec.containerName ?? `honeyrail-pg-build-${randomUUID()}`;
  const result = await runCommand("docker", buildContainerStepArgs({ ...spec, containerName }), {
    timeout: options.timeout,
    maxBuffer: 1024 * 1024 * 64
  });
  if (!result.ok) {
    // Already-exited containers make this a no-op; a runaway one it stops.
    await runCommand("docker", ["kill", containerName], { timeout: 30_000 }).catch(() => undefined);
  }
  return result;
}
