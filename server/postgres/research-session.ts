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
  createBuildView,
  defaultBuildViewsRoot,
  dockerAvailable,
  killResearchContainer,
  removeBuildView,
  DEFAULT_RESEARCH_IMAGE,
  RESEARCH_CONTAINER_PATHS,
  type BuildView
} from "./agent-container.js";

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
 */
export type PostgresResearchIsolationRecord = {
  mode: "container" | "unisolated-development";
  /** False only in the explicitly opted-into development mode. */
  isolated: boolean;
  image?: string;
  network?: string;
  containerName?: string;
  /** The exact `-v` specs, so a reviewer can see what was and was not exposed. */
  mounts?: string[];
  /** Host path of this trial's build view. Grader-side; the agent saw a fixed neutral path. */
  buildViewDir?: string;
  /** Present, and loud, whenever `isolated` is false. */
  warning?: string;
};

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
   * "bridge" (default) so a research agent can reach its own model API. The
   * container has its own network namespace and therefore no route to the
   * host's loopback: the research cluster is reachable only through the
   * bind-mounted Unix socket. "none" removes outbound access as well.
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
  if (!isolation.allowUnisolatedForDevelopment && !(await dockerAvailable())) {
    throw new PostgresResearchError(
      "No docker daemon is reachable, so the research agent cannot be isolated from grader-private state. " +
        "Start docker, or pass isolation.allowUnisolatedForDevelopment: true to run the agent as an unconfined " +
        "host process for local development (its results are marked unisolated and are not a scored trial)."
    );
  }

  // Captured from inside the body so the runtime manifest can be taken after
  // cleanup has run - that is the only point at which it records what was
  // actually stopped and removed.
  let environment: PostgresResearchEnvironment | undefined;
  let buildView: BuildView | undefined;
  try {
    const session = await withPostgresResearchEnvironment(
      spec,
      async (env) => {
        environment = env;
        await env.start();

        if (isolation.allowUnisolatedForDevelopment) {
          const injected = env.agentEnvironment(agent.envPrefix);
          const result = await runAgentProcess(unisolatedLaunch(env, agent, injected), agent);
          return {
            agent: result,
            agentEnvironment: injected,
            isolation: {
              mode: "unisolated-development" as const,
              isolated: false,
              warning: UNISOLATED_WARNING
            },
            connection: env.connectionInfo(),
            source: env.sourceManifest,
            build: env.buildManifest
          };
        }

        const scratchDir = await createAgentScratchDir(env.root);
        // Docker creates a *directory* for a bind source that does not exist,
        // which would break pg_ctl's own -l target; the server has already
        // created this, but make it explicit rather than assumed.
        await appendFile(env.logPath, "");
        buildView = await createBuildView(
          env.installDir,
          isolation.buildViewsRoot ?? defaultBuildViewsRoot(env.buildManifest.cacheRoot)
        );

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
              buildViewDir: buildView.dir
            },
            command: [agent.command, ...(agent.args ?? [])],
            image: isolation.image,
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

        return {
          agent: result,
          agentEnvironment: injected,
          isolation: {
            mode: "container" as const,
            isolated: true,
            image: isolation.image ?? DEFAULT_RESEARCH_IMAGE,
            network: isolation.network ?? "bridge",
            containerName,
            mounts: containerArgs.filter((_value, index) => containerArgs[index - 1] === "-v"),
            buildViewDir: buildView.dir
          },
          connection: env.connectionInfo(),
          source: env.sourceManifest,
          build: env.buildManifest
        };
      },
      options
    );
    return { ...session, runtime: environment!.runtimeManifest() };
  } finally {
    // The view is a per-trial artifact of the boundary, not part of the
    // shared cache, so it goes away with the trial - on every exit path.
    await removeBuildView(buildView);
  }
}
