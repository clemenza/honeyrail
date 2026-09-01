import { spawn } from "node:child_process";
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
 * Nothing here knows what is being researched. The agent gets connection and
 * filesystem coordinates (see agentEnvironment()) and nothing else: no ref,
 * no commit, no source hash, no cache key, and no path into HoneyRail's
 * attachment tree.
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
  /** Executable to run - an agent CLI, a shell script, a driver of your own. */
  command: string;
  args?: string[];
  /** Defaults to the environment's agent-visible root. */
  cwd?: string;
  /** Extra variables; the injected PostgreSQL coordinates win on conflict. */
  env?: Record<string, string>;
  /** Written to the agent's stdin, which is then closed. */
  stdin?: string;
  /** Prefix for the injected coordinates. Defaults to `HR_PG`. */
  envPrefix?: string;
  /**
   * Wall clock the agent gets. On expiry it is SIGTERMed, then SIGKILLed,
   * and the environment is torn down only once it has exited.
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

export type PostgresResearchSessionResult = {
  agent: PostgresResearchAgentResult;
  /** Exactly what was exported into the agent process. */
  agentEnvironment: Record<string, string>;
  connection: PostgresConnectionInfo;
  /** Grader-side provenance: never handed to the agent. */
  source: PostgresSourceManifest;
  build: PostgresBuildManifest;
  runtime: ReturnType<PostgresResearchEnvironment["runtimeManifest"]>;
};

export type PostgresResearchSessionOptions = WithPostgresResearchEnvironmentOptions;

/**
 * Environment for the agent process: the operator's environment minus every
 * inherited `PG*` variable (so an ambient PGHOST/PGPORT cannot redirect the
 * agent at some other server), the research build first on PATH, then the
 * caller's extras, then the injected coordinates - which are last because
 * nothing may override them.
 */
function agentProcessEnv(env: PostgresResearchEnvironment, agent: PostgresResearchAgentSpec, injected: Record<string, string>) {
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
 * Runs the agent against an already-started environment and resolves only
 * once the process has exited. Never rejects on a non-zero exit: an agent
 * that failed is an observation, the same way a failing SQL statement is.
 */
async function runAgentProcess(
  env: PostgresResearchEnvironment,
  agent: PostgresResearchAgentSpec,
  injected: Record<string, string>
): Promise<PostgresResearchAgentResult> {
  const args = [...(agent.args ?? [])];
  const cwd = agent.cwd ?? env.root;
  const limit = agent.maxOutputBytes ?? 1024 * 1024 * 8;
  const startedAt = nowIso();
  const started = Date.now();

  const child = spawn(agent.command, args, {
    cwd,
    env: agentProcessEnv(env, agent, injected),
    stdio: ["pipe", "pipe", "pipe"],
    detached: GROUP_KILL
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
    command: agent.command,
    args,
    cwd,
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

/**
 * Stands up a research environment, starts PostgreSQL, runs `agent` against
 * the live cluster with the dynamic coordinates in its environment, waits
 * for it, and tears everything down afterwards - on success, on a non-zero
 * exit, on a thrown error, and on the agent's own timeout.
 *
 * `options.timeoutMs` is a backstop on the whole session. Prefer
 * `agent.timeoutMs` for bounding the agent itself: it kills the process and
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
  // Captured from inside the body so the runtime manifest can be taken after
  // cleanup has run - that is the only point at which it records what was
  // actually stopped and removed.
  let environment: PostgresResearchEnvironment | undefined;
  const session = await withPostgresResearchEnvironment(
    spec,
    async (env) => {
      environment = env;
      await env.start();
      const injected = env.agentEnvironment(agent.envPrefix);
      const result = await runAgentProcess(env, agent, injected);
      return {
        agent: result,
        agentEnvironment: injected,
        connection: env.connectionInfo(),
        source: env.sourceManifest,
        build: env.buildManifest
      };
    },
    options
  );
  return { ...session, runtime: environment!.runtimeManifest() };
}
