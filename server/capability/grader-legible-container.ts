/**
 * Opt-in filesystem isolation for a #237 Capability Lab agent command.
 *
 * Round 1 ran the agent with the workspace as its `cwd` and called that "the
 * only agent-visible directory". A `cwd` is not a boundary: `../bin/<fixture>`,
 * `../archetype-manifest.json` and `../state/` were all one relative path away.
 *
 * Round 2 containerized that and mounted the real `bin/` read-only. That fixed
 * the manifest and the grader state and left the largest leak open, because
 * read-only prevents writing, not reading, and the fixture's *source* is the
 * discriminating truth the task exists to make the agent discover by
 * experiment. `cat "$(command -v meter)"` ended the task.
 *
 * So the real `bin/` is no longer mounted anywhere. The agent's PATH entry is
 * the generic facade client from `grader-legible-facade.ts`, and the fixture
 * runs on the host, reached over a request/response file channel. See that
 * module for the protocol and for why the channel polls rather than watches.
 *
 * We still reuse the one filesystem-isolation primitive this repo has - the
 * shared `docker run` hardening flags in `server/containers/hardening.ts` -
 * exactly the way `server/postgres/agent-container.ts` does. The guarantee is
 * not in the flags: it is that the caller mounts *only* what the agent may
 * see, and a host path that is never bind-mounted is absent from the
 * container's mount namespace rather than merely unmentioned.
 *
 * The agent-visible surface, and nothing else:
 *
 *   /workspace          the condition's agent-visible workspace       rw
 *   /workspace/bin      facade-bin/: the generic client, on PATH      ro
 *   /workspace/.facade  the request/response channel                  rw
 *
 * Never mounted, and therefore not in the namespace at all: the real `bin/`
 * (fixture source), `state/` (grader-owned invocation log),
 * `archetype-manifest.json` (task identity), `runs/` (retained raw
 * observations), the sibling condition's tree, and any other host path.
 *
 * The facade client is mounted read-only for the same reason the fixture used
 * to be: an agent that can rewrite its own PATH entry can manufacture whatever
 * observation it likes. Reading it is now harmless - it is byte-identical for
 * every archetype and contains no archetype behavior.
 *
 * Isolation is opt-in: a provider without `isolation` keeps today's host-cwd
 * behavior and makes no isolation claim (see `capabilityEvidenceEligible` in
 * grader-legible-run.ts). When isolation *is* requested,
 * `runGraderLegiblePairedExperiment()` resolves the image identity before the
 * first attempt - and that resolution proves only that the image exists.
 * Whether a container then actually started, and whether the configured agent
 * executable then actually launched inside it, are established separately and
 * per attempt, by two markers the wrapper writes into the facade channel;
 * `capabilityEvidenceEligible` requires all three.
 */

import { resolve } from "node:path";
import { runCommandSafe } from "../utils.js";
import { containerHardeningArgs } from "../containers/hardening.js";
import { GRADER_LEGIBLE_FACADE_CONTAINER_DIR, GRADER_LEGIBLE_FACADE_DIR_ENV } from "./grader-legible-facade.js";

/** Fixed, neutral in-container paths. These, not host paths, are what the agent is told. */
export const GRADER_LEGIBLE_CONTAINER_PATHS = {
  workspace: "/workspace",
  bin: "/workspace/bin",
  facade: GRADER_LEGIBLE_FACADE_CONTAINER_DIR
} as const;

/**
 * Network policy when the provider does not name one. Exported so the report's
 * `realAgentIdentity.network` records the policy actually applied rather than
 * re-deriving a default that could drift from this one.
 */
export const GRADER_LEGIBLE_DEFAULT_NETWORK = "bridge";

/** No host PATH is inherited: a container gets exactly what is passed with `-e`. */
const CONTAINER_PATH = `${GRADER_LEGIBLE_CONTAINER_PATHS.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export type GraderLegibleContainerMounts = {
  /** Host path of the condition's agent-visible workspace. Read-write: the agent submits into it. */
  workspaceDir: string;
  /**
   * Host path of the archetype's `facade-bin/` - the generic facade client,
   * **not** the real fixture. Mounted at `/workspace/bin` so the agent's PATH
   * entry keeps its name. Read-only: an agent that can rewrite its own PATH
   * entry can manufacture any observation.
   */
  facadeBinDir: string;
  /** Host path of this attempt's request/response channel. Read-write: the client writes requests here. */
  facadeDir: string;
};

export type GraderLegibleContainerOptions = {
  mounts: GraderLegibleContainerMounts;
  /** Argv to run inside the container, cwd=/workspace. */
  command: readonly string[];
  /**
   * `--entrypoint`. Omitted, `command` is the image's CMD and the image's own
   * entrypoint still wraps it, which is the behavior every archetype relies on.
   * Set, `command` is passed to this program instead - used by the isolated
   * runner to prefix the argv with a marker step, which it can only do by
   * taking the entrypoint slot and re-execing the image's entrypoint itself.
   */
  entrypoint?: string;
  /** Operator-supplied; there is no default and no implicit pull. */
  image: string;
  /**
   * Defaults to "bridge", unlike the PostgreSQL research path's scored
   * "none". A grader-legible attempt is a real agent solving a task with its
   * own model API, and nothing grader-private is reachable over the network
   * here: the private material is filesystem-resident and simply not mounted.
   * "none" stays available for an operator whose agent needs no egress.
   */
  network?: "none" | "bridge" | (string & {});
  /** Extra variables. Nothing from the host environment is inherited implicitly. */
  env?: Record<string, string>;
  memory?: string;
  pidsLimit?: number;
};

/** The `docker run` argv, exposed for tests/inspection without requiring a docker daemon. */
export function buildGraderLegibleContainerArgs(options: GraderLegibleContainerOptions, containerName: string): string[] {
  const paths = GRADER_LEGIBLE_CONTAINER_PATHS;
  const args = [
    ...containerHardeningArgs({
      containerName,
      network: options.network ?? "bridge",
      memory: options.memory,
      pidsLimit: options.pidsLimit
    }),
    // Same no-implicit-pull discipline as the research agent: a pull is how a
    // mutable tag quietly changes the agent that produced the evidence.
    "--pull=never",
    "-v", `${resolve(options.mounts.workspaceDir)}:${paths.workspace}:rw`,
    "-v", `${resolve(options.mounts.facadeBinDir)}:${paths.bin}:ro`,
    "-v", `${resolve(options.mounts.facadeDir)}:${paths.facade}:rw`,
    "-w", paths.workspace,
    "-e", `PATH=${CONTAINER_PATH}`,
    "-e", `${GRADER_LEGIBLE_FACADE_DIR_ENV}=${paths.facade}`
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  if (options.entrypoint !== undefined) args.push("--entrypoint", options.entrypoint);
  args.push(options.image, ...options.command);
  return args;
}

/** Raised when an isolation precondition cannot be *established*, as distinct from being absent. */
export class GraderLegibleIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderLegibleIsolationError";
  }
}

/**
 * The image's configured exec-form entrypoint, or `[]` when it declares none.
 *
 * Needed only by the isolated runner: overriding `--entrypoint` to interpose a
 * marker step discards whatever the image declared, so the wrapper has to put
 * it back. Reading it here keeps that faithful to the image instead of
 * assuming, as an earlier draft did, that `command` is the whole argv - the
 * #237 stub image's entrypoint *is* the agent, and `command` is only the
 * fixture name it is invoked with.
 *
 * A shell-form entrypoint arrives from docker already normalized to
 * `["/bin/sh", "-c", ...]`, so it needs no special handling.
 *
 * Fails closed, and that is the whole point of the shape checks below. An
 * earlier version returned `[]` both when the image genuinely declared no
 * entrypoint and when the inspect or the parse failed, which conflated "there
 * is no entrypoint" with "we could not find out". The second case silently
 * drops the image's declared entrypoint from the argv, so the agent command
 * runs as its own program - a different agent than the one the operator
 * configured, reported as if it were the configured one. Only a genuinely
 * absent (`null`/missing) entrypoint yields `[]`; anything we cannot read
 * throws and the caller treats that attempt as an infrastructure failure.
 *
 * Plain `docker image inspect` plus `JSON.parse`, not a Go `--format`
 * template, for the reason documented in `server/postgres/image-identity.ts`:
 * templates fail unpredictably on real daemons when a key is absent from a
 * config map, and a fail-closed reader that spuriously throws is its own
 * problem.
 */
export async function graderLegibleImageEntrypoint(image: string, runCommand = runCommandSafe): Promise<string[]> {
  const result = await runCommand("docker", ["image", "inspect", image], { timeout: 20_000 });
  if (!result.ok) {
    throw new GraderLegibleIsolationError(
      `could not inspect image ${image} to read its entrypoint: ${result.stderr.trim() || "docker reported a failure with no diagnostic"}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new GraderLegibleIsolationError(
      `could not parse docker image inspect output for ${image}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new GraderLegibleIsolationError(`docker image inspect returned no record for image ${image}`);
  }
  const config = (parsed[0] as { Config?: unknown }).Config;
  if (config !== undefined && config !== null && typeof config !== "object") {
    throw new GraderLegibleIsolationError(`docker image inspect returned an unreadable Config for image ${image}`);
  }
  const entrypoint = (config as { Entrypoint?: unknown } | undefined | null)?.Entrypoint;
  if (entrypoint === undefined || entrypoint === null) return [];
  if (!Array.isArray(entrypoint) || entrypoint.some((entry) => typeof entry !== "string")) {
    throw new GraderLegibleIsolationError(
      `image ${image} declares an entrypoint we cannot read: expected an array of strings, got ${JSON.stringify(entrypoint)}`
    );
  }
  return entrypoint as string[];
}

/**
 * True when the operator-supplied image is already present locally.
 *
 * Deliberately `docker image inspect` and not a pull, matching
 * `resolveResearchAgentImageIdentity()`: a run must not depend on remote
 * availability, and the caller reports a missing image rather than silently
 * fetching whatever the tag points at today.
 */
export async function graderLegibleImageAvailable(image: string, runCommand = runCommandSafe): Promise<boolean> {
  const result = await runCommand("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { timeout: 20_000 });
  return result.ok && Boolean(result.stdout.trim());
}
