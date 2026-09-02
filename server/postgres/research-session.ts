import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { nowIso } from "../utils.js";
import {
  PostgresResearchError,
  withPostgresResearchEnvironment,
  type PostgresBuildManifest,
  type PostgresConnectionInfo,
  type PostgresResearchEnvironment,
  type PostgresResearchSpec,
  type PostgresSourceManifest,
  type WithPostgresResearchEnvironmentOptions
} from "./research-environment.js";
import {
  buildResearchContainerArgs,
  containerAgentEnvironment,
  createAgentScratchDir,
  dockerAvailable,
  killResearchContainer,
  DEFAULT_RESEARCH_IMAGE,
  DEFAULT_RESEARCH_NETWORK,
  resolveResearchAgentImageIdentity,
  type ResearchAgentImageIdentity,
  RESEARCH_CONTAINER_PATHS
} from "./agent-container.js";
import { containerPlatformsCompatible, normalizedContainerPlatform } from "./image-identity.js";
import type { PostgresRuntimeRecord } from "./runtime-container.js";

/**
 * The one supported way to have an agent drive a *live* PostgreSQL research
 * environment (#179, for the Historical PostgreSQL pilot in #180).
 *
 * It exists because the DAG cannot express this. A `postgres-research` step
 * materializes, builds, starts, experiments and tears down inside a single
 * `start()`, so there is no window in which a later step could attach; and
 * `agent-task`'s `input.environment` is static step input captured at run
 * creation, which cannot carry a port or socket directory that only exists
 * once the environment has been created. Rather than grow a lease/handoff
 * protocol through the orchestration kernel, the composition lives here, in
 * one PostgreSQL-specific function:
 *
 *   materialize -> build -> start -> run the agent against the live cluster
 *   -> wait for the agent -> tear down
 *
 * Cleanup is ordered, not merely eventual: the environment is only torn down
 * after the agent process has actually exited, including when the agent is
 * killed for exceeding its own timeout. That ordering is the whole point -
 * an agent whose server disappears mid-experiment produces garbage evidence
 * rather than a failed trial.
 *
 * By default the agent runs inside a container that bind-mounts only its
 * research surface (see ./agent-container.ts). That boundary, not the
 * omission of paths from `agentEnvironment()`, is what keeps grader-private
 * material out of reach. Running the agent as a plain host process is still
 * possible but must be asked for by name -
 * `isolation.allowUnisolatedForDevelopment` - and everything produced that
 * way is marked as unisolated in the result.
 */

/** How long a killed agent gets to exit on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;

/** POSIX only: a detached child leads its own process group, so it can be killed as a tree. */
const GROUP_KILL = process.platform !== "win32";

/**
 * Signals the agent's whole process group rather than just the process it
 * spawned. An agent is typically a shell or a CLI that shells out, and
 * killing only the parent leaves the grandchild alive holding the stdout
 * pipe - which means "the agent finished" never fires and the environment is
 * held open until the grandchild happens to exit on its own.
 */
function killTree(child: { pid?: number; kill(signal: NodeJS.Signals): boolean }, signal: NodeJS.Signals) {
  if (GROUP_KILL && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone, or never created: fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

export type PostgresResearchAgentSpec = {
  /**
   * Executable to run. In the default isolated mode this is resolved *inside
   * the container*, so it must be something the image provides or something
   * that lives in a mounted directory (`$HR_PG_WORK_DIR`, `$HR_PG_SOURCE_DIR`).
   */
  command: string;
  args?: string[];
  /** Defaults to the agent's working directory (`$HR_PG_WORK_DIR` when isolated). */
  cwd?: string;
  /**
   * Extra variables; the injected PostgreSQL coordinates win on conflict. In
   * isolated mode a container inherits nothing from the host environment, so
   * anything the agent needs (a model API key, say) must be passed here
   * explicitly.
   */
  env?: Record<string, string>;
  /** Written to the agent's stdin, which is then closed. */
  stdin?: string;
  /** Prefix for the injected coordinates. Defaults to `HR_PG`. */
  envPrefix?: string;
  /**
   * Wall clock the agent gets. On expiry it is SIGTERMed, then SIGKILLed
   * (isolated mode: the container is `docker kill`ed), and the environment is
   * torn down only once it has exited.
   */
  timeoutMs?: number;
  /** Cap on captured stdout/stderr; older output is dropped. Defaults to 8 MiB. */
  maxOutputBytes?: number;
};

export type PostgresResearchAgentResult = {
  command: string;
  args: string[];
  cwd: string;
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  /** True when the agent was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  durationMs: number;
};

/**
 * How the agent process was actually confined. Recorded on every session so
 * evidence produced without a real boundary can never be mistaken for
 * evidence produced with one.
 *
 * The three facts are deliberately separate, because they fail separately:
 *
 * - `isolated` - was there a filesystem boundary at all (a container, versus
 *   `allowUnisolatedForDevelopment`)?
 * - `networkMode` - could the agent have reached a grader/host service? Mount
 *   isolation says nothing about this: on Docker Desktop a `bridge` container
 *   has `host.docker.internal`, and on Linux it has the default gateway, so
 *   an agent that cannot *read* `source-manifest.json` may still be able to
 *   *fetch* the same truth from a local HoneyRail service.
 * - `buildScoredEligible` - were the binaries produced by the pinned Linux
 *   build container, or by an un-scored host build?
 * - `runtimeScoredEligible` - did the *server* run inside the pinned Linux
 *   runtime container, or as host processes? A containerized build whose
 *   cluster then ran on the host is not a scored trial either: on a non-Linux
 *   host it cannot even happen, and on a Linux host it is a different
 *   confinement story from the one the scored path describes.
 *
 * `scoredEligible` is the conjunction of all four, and it is the single field
 * a grader should key on. Container *build* alone is explicitly not enough.
 */
export type PostgresResearchContainerIsolationRecord = {
  mode: "container";
  isolated: true;
  /**
   * The configured agent image reference. This stays a string for historical
   * session-record compatibility; immutable provenance is recorded separately
   * in imageIdentity.
   */
  image: string;
  /**
   * The immutable identity Docker resolved before launch. The agent container
   * is started by this image id, not by the mutable reference, so the recorded
   * identity corresponds to the image that actually executed the agent.
   */
  imageIdentity: ResearchAgentImageIdentity;
  imageIdentitySchemaVersion: 1;
  /**
   * The docker network the agent container ran on. `"none"` is the scored
   * default; anything else is recorded verbatim and makes `scoredEligible`
   * false. Absent for an unisolated development run, which had the host's
   * whole network.
   */
  networkMode: string;
  /**
   * True only when all of: a real container boundary, `networkMode: "none"`,
   * and a container-built (scored-eligible) PostgreSQL. Never inferred by a
   * consumer from the other fields - it is written here so an artifact that
   * carries this record carries the verdict with it.
   */
  scoredEligible: boolean;
  /** Mirrors PostgresBuildManifest.scoredEligible, so this record stands alone. */
  buildScoredEligible: boolean;
  /** Mirrors PostgresRuntimeRecord.scoredEligible - did the server run in a container? */
  runtimeScoredEligible: boolean;
  /** The runtime sidecar's own record: image identity, container, network, mounts. */
  runtime: PostgresRuntimeRecord;
  containerName: string;
  /** The exact `-v` specs, so a reviewer can see what was and was not exposed. */
  mounts: string[];
  /** Host path of this trial's build view. Grader-side; the agent saw a fixed neutral path. */
  buildViewDir: string;
  /** Present, and loud, whenever `scoredEligible` is false. Says which of the three failed. */
  warning?: string;
};

export type PostgresResearchUnisolatedIsolationRecord = {
  mode: "unisolated-development";
  isolated: false;
  image?: string;
  imageIdentity?: never;
  imageIdentitySchemaVersion?: never;
  networkMode?: never;
  scoredEligible: false;
  buildScoredEligible: boolean;
  runtimeScoredEligible: boolean;
  runtime: PostgresRuntimeRecord;
  warning: string;
};

export type PostgresResearchIsolationRecord =
  | PostgresResearchContainerIsolationRecord
  | PostgresResearchUnisolatedIsolationRecord;

/** Why a container-isolated session is nonetheless not scored-eligible. */
export function unscoredReasons(input: {
  networkMode: string;
  buildScoredEligible: boolean;
  runtimeScoredEligible?: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.networkMode !== "none") {
    reasons.push(
      `The agent container ran on docker network "${input.networkMode}" rather than "none", so it had a route to ` +
        "the host and to private networks (on Docker Desktop, host.docker.internal; on Linux, the bridge gateway). " +
        "Filesystem isolation does not constrain what an HTTP request can retrieve from a grader-side service."
    );
  }
  if (!input.buildScoredEligible) {
    reasons.push(
      'The PostgreSQL under research was not built by the pinned Linux build container (build.mode: "host"), ' +
        "so the agent did not exercise the artifact a scored trial produces."
    );
  }
  if (input.runtimeScoredEligible === false) {
    reasons.push(
      "The PostgreSQL server the agent queried ran as host processes rather than inside the pinned Linux runtime " +
        "container, so the cluster under research was not confined the way a scored trial's is."
    );
  }
  return reasons;
}

export type PostgresResearchSessionResult = {
  agent: PostgresResearchAgentResult;
  /** Exactly what was exported into the agent process. */
  agentEnvironment: Record<string, string>;
  isolation: PostgresResearchIsolationRecord;
  connection: PostgresConnectionInfo;
  /** Grader-side provenance: never handed to the agent. */
  source: PostgresSourceManifest;
  build: PostgresBuildManifest;
  runtime: ReturnType<PostgresResearchEnvironment["runtimeManifest"]>;
};

export type PostgresResearchIsolationOptions = {
  image?: string;
  /**
   * Defaults to "none" - the scored mode. The container gets no network stack
   * beyond its own loopback, so there is no gateway, no bridge and no
   * `host.docker.internal` through which a grader-side HTTP service could be
   * queried. The research cluster is unaffected: it is reached over the
   * bind-mounted Unix socket, which resolves through the mount namespace.
   *
   * "bridge" (or any other docker network) is allowed - a real research agent
   * usually needs outbound model-API access - but it is an explicit opt-in
   * and the resulting session records `scoredEligible: false`. There is
   * deliberately no restricted-egress mode here: a real one needs NET_ADMIN
   * inside a `--cap-drop=ALL` container plus IPv4+IPv6 policy, which is a
   * larger change than this round, and a half-built one would be worse than
   * an honest label.
   */
  network?: "none" | "bridge" | (string & {});
  memory?: string;
  pidsLimit?: number;
  /** Where per-trial build views are created; defaults next to the build cache. */
  buildViewsRoot?: string;
  /**
   * Runs the agent as a plain host process with no boundary at all, for local
   * development and CI without a docker daemon.
   *
   * This is not a fallback and is never chosen automatically: without it, a
   * host that cannot isolate fails loudly instead of quietly producing
   * unisolated results that look isolated. A session run this way records
   * `isolation.isolated: false` and a warning, and its output must not be
   * treated as a scored trial.
   */
  allowUnisolatedForDevelopment?: boolean;
};

export type PostgresResearchSessionOptions = WithPostgresResearchEnvironmentOptions & {
  isolation?: PostgresResearchIsolationOptions;
};

export const UNISOLATED_WARNING =
  "This agent ran as an unconfined host process (isolation.allowUnisolatedForDevelopment). " +
  "It could read grader-private manifests, the PostgreSQL source mirror and other trials' files. " +
  "Development only - not a scored trial.";

export function assertResearchAgentImageCompatible(input: {
  agentImage: ResearchAgentImageIdentity;
  build: PostgresBuildManifest;
}) {
  const { agentImage, build } = input;
  const agentPlatform = normalizedContainerPlatform(agentImage);
  if (agentPlatform.os !== "linux") {
    throw new PostgresResearchError(
      `Research agent image "${agentImage.reference}" targets ${agentPlatform.platform}; isolated PostgreSQL research agents must run on Linux.`
    );
  }
  // Host/development builds are already unscored. They do not give us a
  // reliable Linux artifact platform to reject against, so the isolation
  // record carries the unscored build reason instead of inventing one here.
  if (!build.scoredEligible) return;
  const buildPlatform = normalizedContainerPlatform({ os: build.platform, architecture: build.arch });
  if (!containerPlatformsCompatible(agentImage, buildPlatform)) {
    throw new PostgresResearchError(
      `Research agent image "${agentImage.reference}" targets ${agentPlatform.platform}, but the mounted PostgreSQL ` +
        `client/runtime artifacts target ${buildPlatform.platform}. Build or select an agent image for ` +
        `${buildPlatform.platform}.`
    );
  }
}

/**
 * Environment for an agent run *without* isolation: the operator's
 * environment minus every inherited `PG*` variable (so an ambient
 * PGHOST/PGPORT cannot redirect the agent at some other server), the research
 * build first on PATH, then the caller's extras, then the injected
 * coordinates - which are last because nothing may override them.
 */
function hostAgentProcessEnv(env: PostgresResearchEnvironment, agent: PostgresResearchAgentSpec, injected: Record<string, string>) {
  const processEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("PG")) continue;
    processEnv[key] = value;
  }
  processEnv.PATH = `${env.binDir}:${process.env.PATH ?? ""}`;
  return { ...processEnv, ...(agent.env ?? {}), ...injected };
}

function collect(limit: number) {
  const chunks: string[] = [];
  let size = 0;
  return {
    push(chunk: string) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit && chunks.length > 1) size -= chunks.shift()!.length;
    },
    text() {
      return chunks.join("");
    }
  };
}

/**
 * What to spawn, and how to stop it. Container and host launches differ only
 * here: the surrounding lifecycle - output capture, timeout, ordered teardown
 * - is identical, and deliberately so.
 */
type AgentLaunch = {
  /** Reported to the caller: the agent's own view of what it ran and where. */
  reported: { command: string; args: string[]; cwd: string };
  spawn: { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv; detached: boolean };
  /** Called on timeout, before the SIGTERM/SIGKILL escalation on the client process. */
  stop?: () => void;
};

type AgentIsolationLaunchConfig =
  | { mode: "unisolated-development" }
  | { mode: "container"; imageReference: string; imageIdentity: ResearchAgentImageIdentity };

/**
 * Runs the agent and resolves only once the process has exited. Never rejects
 * on a non-zero exit: an agent that failed is an observation, the same way a
 * failing SQL statement is.
 */
async function runAgentProcess(launch: AgentLaunch, agent: PostgresResearchAgentSpec): Promise<PostgresResearchAgentResult> {
  const limit = agent.maxOutputBytes ?? 1024 * 1024 * 8;
  const startedAt = nowIso();
  const started = Date.now();

  const child = spawn(launch.spawn.command, launch.spawn.args, {
    cwd: launch.spawn.cwd,
    env: launch.spawn.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: launch.spawn.detached
  });

  const stdout = collect(limit);
  const stderr = collect(limit);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
  child.stdin?.on("error", () => {});
  child.stdin?.end(agent.stdin ?? "");

  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  if (agent.timeoutMs) {
    killTimer = setTimeout(() => {
      timedOut = true;
      // In isolated mode this is `docker kill`: signalling the client alone
      // would leave the container - and therefore the agent - running.
      launch.stop?.();
      killTree(child, "SIGTERM");
      graceTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      graceTimer.unref?.();
    }, agent.timeoutMs);
    killTimer.unref?.();
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    // "close" rather than "exit": it fires after stdout/stderr have drained,
    // so nothing the agent printed is lost.
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  }).catch((error: Error) => {
    throw new PostgresResearchError(`Could not run research agent "${agent.command}": ${error.message}`);
  });

  if (killTimer) clearTimeout(killTimer);
  if (graceTimer) clearTimeout(graceTimer);

  return {
    ...launch.reported,
    ok: !timedOut && exit.code === 0,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    stdout: stdout.text(),
    stderr: stderr.text(),
    startedAt,
    durationMs: Date.now() - started
  };
}

function unisolatedLaunch(
  env: PostgresResearchEnvironment,
  agent: PostgresResearchAgentSpec,
  injected: Record<string, string>
): AgentLaunch {
  const args = [...(agent.args ?? [])];
  const cwd = agent.cwd ?? env.root;
  return {
    reported: { command: agent.command, args, cwd },
    spawn: { command: agent.command, args, cwd, env: hostAgentProcessEnv(env, agent, injected), detached: GROUP_KILL },
    stop: undefined
  };
}

/**
 * Stands up a research environment, starts PostgreSQL, runs `agent` against
 * the live cluster with the dynamic coordinates in its environment, waits
 * for it, and tears everything down afterwards - on success, on a non-zero
 * exit, on a thrown error, and on the agent's own timeout.
 *
 * The agent runs inside a container that bind-mounts only its research
 * surface. If no docker daemon is reachable this throws rather than silently
 * downgrading; pass `isolation.allowUnisolatedForDevelopment` to run without
 * a boundary on purpose.
 *
 * `options.timeoutMs` is a backstop on the whole session. Prefer
 * `agent.timeoutMs` for bounding the agent itself: it kills the agent and
 * *then* cleans up, whereas the session backstop rejects the caller while
 * the agent may still be running (JavaScript cannot abort an await in
 * flight), which is exactly the ordering this function exists to avoid.
 */
export async function runAgentInPostgresResearchEnvironment(
  spec: PostgresResearchSpec,
  agent: PostgresResearchAgentSpec,
  options: PostgresResearchSessionOptions = {}
): Promise<PostgresResearchSessionResult> {
  if (!String(agent.command || "").trim()) {
    throw new PostgresResearchError("A research agent spec requires a command");
  }
  const isolation = options.isolation ?? {};
  const runCommand = spec.runCommand;
  if (!isolation.allowUnisolatedForDevelopment && !(await dockerAvailable(runCommand))) {
    throw new PostgresResearchError(
      "No docker daemon is reachable, so the research agent cannot be isolated from grader-private state. " +
        "Start docker, or pass isolation.allowUnisolatedForDevelopment: true to run the agent as an unconfined " +
        "host process for local development (its results are marked unisolated and are not a scored trial)."
    );
  }
  const launchConfig: AgentIsolationLaunchConfig = isolation.allowUnisolatedForDevelopment
    ? { mode: "unisolated-development" }
    : {
        mode: "container",
        imageReference: isolation.image ?? DEFAULT_RESEARCH_IMAGE,
        // Resolve before materialization so a missing local image is a setup
        // error with no trial side effects. Platform compatibility needs the
        // build manifest, so it is checked inside the environment callback
        // after build and before starting PostgreSQL or the agent container.
        imageIdentity: await resolveResearchAgentImageIdentity(isolation.image ?? DEFAULT_RESEARCH_IMAGE, runCommand)
      };

  // Captured from inside the body so the runtime manifest can be taken after
  // cleanup has run - that is the only point at which it records what was
  // actually stopped and removed.
  let environment: PostgresResearchEnvironment | undefined;
  {
    const session = await withPostgresResearchEnvironment(
      // The environment owns this trial's randomized build view now, because
      // the runtime container mounts the same one - so the isolation option
      // has to reach it rather than being applied here.
      { ...spec, buildViewsRoot: spec.buildViewsRoot ?? isolation.buildViewsRoot },
      async (env) => {
        environment = env;

        if (launchConfig.mode === "unisolated-development") {
          await env.start();
          const injected = env.agentEnvironment(agent.envPrefix);
          const result = await runAgentProcess(unisolatedLaunch(env, agent, injected), agent);
          return {
            agent: result,
            agentEnvironment: injected,
            isolation: {
              mode: "unisolated-development" as const,
              isolated: false as const,
              scoredEligible: false as const,
              buildScoredEligible: env.buildManifest.scoredEligible,
              runtimeScoredEligible: env.runtimeIsolation().scoredEligible,
              runtime: env.runtimeIsolation(),
              warning: UNISOLATED_WARNING
            },
            connection: env.connectionInfo(),
            source: env.sourceManifest,
            build: env.buildManifest
          };
        }

        const agentImage = launchConfig.imageIdentity;
        assertResearchAgentImageCompatible({ agentImage, build: env.buildManifest });
        await env.start();

        const scratchDir = await createAgentScratchDir(env.root);
        // Docker creates a *directory* for a bind source that does not exist,
        // which would break pg_ctl's own -l target; the environment has
        // already created this, but make it explicit rather than assumed.
        await appendFile(env.logPath, "");

        const injected = containerAgentEnvironment(env.connectionInfo(), agent.envPrefix);
        const containerName = `honeyrail-pg-research-${randomUUID()}`;
        const containerArgs = buildResearchContainerArgs(
          {
            mounts: {
              sourceDir: env.sourceDir,
              dataDir: env.dataDir,
              socketDir: env.socketDir,
              logPath: env.logPath,
              scratchDir,
              // The same view the runtime container is running, so the agent
              // inspects literally the files the server is executing.
              buildViewDir: env.buildView.dir
            },
            command: [agent.command, ...(agent.args ?? [])],
            image: agentImage.id,
            network: isolation.network,
            memory: isolation.memory,
            pidsLimit: isolation.pidsLimit,
            interactive: true,
            env: { ...(agent.env ?? {}), ...injected }
          },
          containerName
        );
        if (agent.cwd) {
          const workdirIndex = containerArgs.indexOf("-w");
          containerArgs[workdirIndex + 1] = agent.cwd;
        }

        const result = await runAgentProcess(
          {
            reported: {
              command: agent.command,
              args: [...(agent.args ?? [])],
              cwd: agent.cwd ?? RESEARCH_CONTAINER_PATHS.scratch
            },
            spawn: { command: "docker", args: containerArgs, env: process.env, detached: false },
            stop: () => killResearchContainer(containerName)
          },
          agent
        );

        const networkMode = isolation.network ?? DEFAULT_RESEARCH_NETWORK;
        const buildScoredEligible = env.buildManifest.scoredEligible;
        const runtimeRecord = env.runtimeIsolation();
        const reasons = unscoredReasons({
          networkMode,
          buildScoredEligible,
          runtimeScoredEligible: runtimeRecord.scoredEligible
        });
        return {
          agent: result,
          agentEnvironment: injected,
          isolation: {
            mode: "container" as const,
            isolated: true as const,
            image: launchConfig.imageReference,
            imageIdentity: agentImage,
            imageIdentitySchemaVersion: 1 as const,
            networkMode,
            scoredEligible: reasons.length === 0,
            buildScoredEligible,
            runtimeScoredEligible: runtimeRecord.scoredEligible,
            runtime: runtimeRecord,
            containerName,
            mounts: containerArgs.filter((_value, index) => containerArgs[index - 1] === "-v"),
            buildViewDir: env.buildView.dir,
            ...(reasons.length ? { warning: `Not a scored trial. ${reasons.join(" ")}` } : {})
          },
          connection: env.connectionInfo(),
          source: env.sourceManifest,
          build: env.buildManifest
        };
      },
      options
    );
    // The build view, the runtime container, PGDATA and the socket directory
    // are all torn down by env.cleanup(), in that order, from
    // withPostgresResearchEnvironment's finally - i.e. only after the agent
    // process above has actually exited. That ordering is MUST 4 of the #182
    // fourth review and is not something this function may shortcut.
    return { ...session, runtime: environment!.runtimeManifest() };
  }
}
