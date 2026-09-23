/**
 * Opt-in filesystem isolation for a #237 Capability Lab agent command.
 *
 * Round 1 of the grader-legible harness ran the agent command with the
 * agent-visible workspace as its `cwd` and called that "the only agent-visible
 * directory". A `cwd` is not a filesystem boundary: a real agent can read
 * `../bin/<fixture>` (the fixture's source, which encodes the discriminating
 * behavior), `../archetype-manifest.json` (the task's identity and hashes) and
 * `../state/` (the grader-owned invocation log that drives failure-stage
 * attribution) with one relative path. So a capability number produced that
 * way is not evidence of constructing a grader-legible observable; it may be
 * evidence of having read the fixture.
 *
 * Rather than grow a provider/environment framework for this, we reuse the one
 * filesystem-isolation primitive this repo already has - the shared
 * `docker run` hardening flags in `server/containers/hardening.ts` - exactly
 * the way `server/postgres/agent-container.ts` does. The guarantee is the same
 * one documented there and is not in the flags: it is that the caller mounts
 * *only* what the agent is meant to see. A host path that is never bind-mounted
 * is absent from the container's mount namespace, not merely unmentioned.
 *
 * The agent-visible surface, and nothing else:
 *
 *   /workspace          the condition's agent-visible workspace   rw
 *   /workspace/bin      the fixture, so it stays on PATH          ro
 *
 * Never mounted: `state/` (grader-owned invocation log),
 * `archetype-manifest.json` (task identity), `runs/` (retained raw
 * observations), the sibling condition's tree, and any other host path.
 *
 * `bin/` is mounted *inside* the workspace rather than beside it because the
 * workspace is the only mount point the agent's cwd can reach; read-only,
 * because the fixture is the system under test and an agent that can rewrite
 * it can manufacture whatever observation it likes. It is still visible as a
 * directory, so this boundary hides the harness's private material, not the
 * fixture's own source - that part is unchanged from the host path and is why
 * every archetype's discriminating behavior is expressed in terms an agent
 * must still *run* the fixture to observe.
 *
 * Isolation is opt-in: a provider without `isolation` keeps today's host-cwd
 * behavior, and the report must not claim isolation for it (see
 * `capabilityEvidenceEligible` in grader-legible-run.ts).
 */

import { resolve } from "node:path";
import { runCommandSafe } from "../utils.js";
import { containerHardeningArgs } from "../containers/hardening.js";

/** Fixed, neutral in-container paths. These, not host paths, are what the agent is told. */
export const GRADER_LEGIBLE_CONTAINER_PATHS = {
  workspace: "/workspace",
  bin: "/workspace/bin"
} as const;

/** No host PATH is inherited: a container gets exactly what is passed with `-e`. */
const CONTAINER_PATH = `${GRADER_LEGIBLE_CONTAINER_PATHS.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

export type GraderLegibleContainerMounts = {
  /** Host path of the condition's agent-visible workspace. Read-write: the agent submits into it. */
  workspaceDir: string;
  /** Host path of the archetype's `bin/`. Read-only: the fixture is the system under test. */
  binDir: string;
};

export type GraderLegibleContainerOptions = {
  mounts: GraderLegibleContainerMounts;
  /** Argv to run inside the container, cwd=/workspace. */
  command: readonly string[];
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
    "-v", `${resolve(options.mounts.binDir)}:${paths.bin}:ro`,
    "-w", paths.workspace,
    "-e", `PATH=${CONTAINER_PATH}`
  ];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(options.image, ...options.command);
  return args;
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
