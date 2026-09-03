import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { nowIso, runCommandSafe } from "../utils.js";
import {
  DEFAULT_CANCEL_GRACE_MS,
  PostgresResearchError,
  PostgresResearchTimeoutError,
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
  terminateResearchContainer,
  CONTAINER_TERMINATION_WORST_CASE_MS,
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
export const KILL_GRACE_MS = 5000;

/**
 * Headroom added on top of the mechanical worst case below, absorbing
 * ordinary JS/process scheduling overhead across several sequential awaits
 * rather than assuming they cost nothing (#188 review, third round).
 */
export const CANCELLATION_SAFETY_MARGIN_MS = 5000;

/**
 * The floor `runAgentInPostgresResearchEnvironment()` enforces on a
 * caller-supplied `cancelGraceMs` (#188 review, third round): the supported
 * agent-cancellation path's own worst case - `terminateResearchContainer()`
 * exhausting all three of its sequential kill/rm/inspect attempts, then the
 * local client needing the full `KILL_GRACE_MS` to die - plus a safety
 * margin. Below this, a merely-slow-but-successful cancellation could be
 * mistaken for `cancelGraceExceeded`, which is supposed to mean the body
 * never settled at all - recreating the #188 race this whole file exists to
 * close, just with a caller-chosen deadline instead of the default one.
 *
 * `withPostgresResearchEnvironment()` itself enforces no such floor - it is
 * generic and cannot know what an arbitrary body needs - so this validation
 * belongs here, in the one place that knows this path's own budget.
 */
export const MIN_AGENT_CANCEL_GRACE_MS = CONTAINER_TERMINATION_WORST_CASE_MS + KILL_GRACE_MS + CANCELLATION_SAFETY_MARGIN_MS;

/**
 * Asserted at import time rather than only documented, so
 * `DEFAULT_CANCEL_GRACE_MS` (research-environment.ts) and this module's own
 * constants cannot silently drift apart: the *default* budget must itself
 * satisfy the minimum this module requires of an explicit override.
 */
if (DEFAULT_CANCEL_GRACE_MS < MIN_AGENT_CANCEL_GRACE_MS) {
  throw new Error(
    `research-session.ts: DEFAULT_CANCEL_GRACE_MS (${DEFAULT_CANCEL_GRACE_MS}) must be at least ` +
      `MIN_AGENT_CANCEL_GRACE_MS (${MIN_AGENT_CANCEL_GRACE_MS} = CONTAINER_TERMINATION_WORST_CASE_MS ` +
      `${CONTAINER_TERMINATION_WORST_CASE_MS} + KILL_GRACE_MS ${KILL_GRACE_MS} + CANCELLATION_SAFETY_MARGIN_MS ` +
      `${CANCELLATION_SAFETY_MARGIN_MS}), or the default itself would not satisfy the floor this module enforces ` +
      "on an explicit cancelGraceMs override (#188)"
  );
}

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
  /** True when the agent was killed for exceeding `timeoutMs`, or for the outer session deadline. */
  timedOut: boolean;
  /**
   * Which deadline actually caused the kill, when `timedOut` is true: the
   * agent's own `timeoutMs`, or the session's outer `options.timeoutMs`
   * (#188). First cause wins - whichever timer fires first decides this
   * field, and the other cannot re-fire against an already-killed agent.
   * Absent when `timedOut` is false.
   */
  timeoutSource?: "agent" | "session";
  /**
   * Set when `timedOut` is true in isolated mode and the explicit
   * `docker kill` request (see `AgentLaunch.stop`, `terminateResearchContainer()`)
   * did not succeed - a daemon/client failure, or an unexpected non-zero
   * result other than "already gone" (#188 review). This is recorded rather
   * than swallowed: cancellation still escalates to the local client process
   * regardless (see `runAgentProcess`), but a failed termination request
   * must not be indistinguishable from a successful one just because the
   * local client eventually exited too.
   */
  terminationError?: string;
  /**
   * Set when `timedOut` is true: `false` specifically means a container
   * termination was requested but could not be *confirmed* (`launch.stop()`
   * threw - see `terminationError`) - not merely that a first attempt
   * failed, since `terminateResearchContainer()` itself escalates before
   * giving up (#188 review, third round). `true` when cancellation is
   * confirmed complete - a container termination that succeeded, or
   * unisolated mode, which has no separate container to confirm and whose
   * "close" event *is* the confirmation.
   */
  confirmedStopped?: boolean;
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
  /**
   * Called on timeout and *awaited* before the SIGTERM/SIGKILL escalation on
   * the client process (#188 review). In isolated mode this is
   * `terminateResearchContainer()`: awaiting it, rather than firing it and
   * moving on, is what makes "the agent container has stopped" an observed
   * fact by the time cancellation proceeds, rather than an assumption resting
   * on the local `docker run` client happening to exit soon after. A
   * rejection is caught by the caller and recorded, not swallowed.
   */
  stop?: () => Promise<void> | void;
};

type AgentIsolationLaunchConfig =
  | { mode: "unisolated-development" }
  | { mode: "container"; imageReference: string; imageIdentity: ResearchAgentImageIdentity };

/**
 * Runs the agent and resolves only once the process has exited. Never rejects
 * on a non-zero exit: an agent that failed is an observation, the same way a
 * failing SQL statement is.
 *
 * `signal`, when given, is the *session's* outer deadline
 * (withPostgresResearchEnvironment()'s AbortSignal, #188) - a second,
 * independent cause of the same kill sequence `agent.timeoutMs` already
 * drives. `requestCancel()` below is the single place either cause goes
 * through, so the two can never double-kill: the first to fire wins, records
 * which one it was on `timeoutSource`, and hands the second (including one
 * arriving at the same tick) the same in-flight cancellation promise rather
 * than starting a second one.
 *
 * Exported for direct, deterministic unit testing of the cancellation
 * semantics without standing up a full research environment or a container.
 */
export async function runAgentProcess(
  launch: AgentLaunch,
  agent: PostgresResearchAgentSpec,
  signal?: AbortSignal
): Promise<PostgresResearchAgentResult> {
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
  let timeoutSource: "agent" | "session" | undefined;
  let terminationError: string | undefined;
  let confirmedStopped: boolean | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  let cancellationPromise: Promise<void> | undefined;

  /**
   * Awaits `launch.stop()` (in isolated mode, `terminateResearchContainer()`,
   * which only resolves successfully once container absence is *confirmed*)
   * to completion, then escalates SIGTERM/SIGKILL on the local client
   * process regardless of whether it succeeded. Never called directly -
   * always through `requestCancel()` below.
   */
  async function cancel(source: "agent" | "session"): Promise<void> {
    timedOut = true;
    timeoutSource = source;
    try {
      await launch.stop?.();
      confirmedStopped = true;
    } catch (error) {
      // Recorded, not swallowed (#188 review): a failed termination request
      // must not be indistinguishable from a successful one just because the
      // local client eventually exits too, from the escalation below.
      terminationError = (error as Error).message;
      confirmedStopped = false;
    }
    // Still escalated even when unconfirmed: this is a best-effort nudge at
    // the local client, not a claim that the underlying container is gone -
    // markAgentTerminationUnconfirmed() (research-session.ts's caller) is
    // what actually keeps cleanup from proceeding destructively.
    killTree(child, "SIGTERM");
    graceTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    graceTimer.unref?.();
  }

  /**
   * The single entry point either timeout cause calls, and the single place
   * that can never double-kill: only the *first* call actually starts
   * `cancel()` - `cancellationPromise` is assigned once, synchronously,
   * before any `await` - and every caller, including one arriving after
   * cancellation is already under way, gets back that same promise.
   *
   * That shared promise is also the fix for #188's second review: the local
   * child closing does not, by itself, prove a *requested* cancellation has
   * settled - the agent can exit at the same moment as the timeout, the
   * docker CLI can die for an unrelated reason, or the container can exit on
   * its own while `launch.stop()` is still resolving. `runAgentProcess` below
   * awaits `cancellationPromise`, if one was started, in addition to waiting
   * for the child to close - not instead of it - so cleanup can never begin
   * while a termination request this function made is still in flight,
   * regardless of which of the two settles last.
   */
  function requestCancel(source: "agent" | "session"): Promise<void> {
    if (!cancellationPromise) cancellationPromise = cancel(source);
    return cancellationPromise;
  }

  if (agent.timeoutMs) {
    killTimer = setTimeout(() => void requestCancel("agent"), agent.timeoutMs);
    killTimer.unref?.();
  }
  const onAbort = () => void requestCancel("session");
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      // "close" rather than "exit": it fires after stdout/stderr have drained,
      // so nothing the agent printed is lost.
      child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
      child.once("error", reject);
    });
    if (cancellationPromise) {
      // The child closing (above) is not proof that our own cancellation
      // request has settled - see requestCancel()'s doc comment. Awaiting it
      // here, after the close event and not merely alongside it, closes that
      // race regardless of which of the two actually finishes last.
      await cancellationPromise;
    }
  } catch (error) {
    throw new PostgresResearchError(`Could not run research agent "${agent.command}": ${(error as Error).message}`);
  } finally {
    if (killTimer) clearTimeout(killTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  return {
    ...launch.reported,
    ok: !timedOut && exit.code === 0,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    ...(timedOut ? { timeoutSource, confirmedStopped } : {}),
    ...(terminationError ? { terminationError } : {}),
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
  // Rejected before any side effect (no environment created, no docker
  // reachability check), same as the command check above: an unsafe
  // cancelGraceMs is a configuration error, not a trial outcome (#188
  // review, third round). withPostgresResearchEnvironment() enforces no
  // floor of its own - it is generic and cannot know what an arbitrary body
  // needs - so this is the one place that can validate it against this
  // path's own supported cancellation budget.
  if (options.cancelGraceMs !== undefined && options.cancelGraceMs < MIN_AGENT_CANCEL_GRACE_MS) {
    throw new PostgresResearchError(
      `cancelGraceMs=${options.cancelGraceMs}ms is too small for the supported agent cancellation path; minimum is ` +
        `${MIN_AGENT_CANCEL_GRACE_MS}ms (container termination escalation up to ${CONTAINER_TERMINATION_WORST_CASE_MS}ms, ` +
        `local-process kill grace ${KILL_GRACE_MS}ms, safety margin ${CANCELLATION_SAFETY_MARGIN_MS}ms). Omit ` +
        "cancelGraceMs to use the default, or raise it to at least this value."
    );
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
  // Captured the moment runAgentProcess() resolves, from inside the body -
  // i.e. before a session timeout's Promise.race can discard the body's own
  // return value - so a failed termination request survives even when the
  // outer call rejects (#188 review, second round, Blocking 3).
  let agentTermination: { timeoutSource: "agent" | "session"; terminationError?: string; confirmedStopped?: boolean } | undefined;
  try {
    const session = await withPostgresResearchEnvironment(
      // The environment owns this trial's randomized build view now, because
      // the runtime container mounts the same one - so the isolation option
      // has to reach it rather than being applied here.
      { ...spec, buildViewsRoot: spec.buildViewsRoot ?? isolation.buildViewsRoot },
      async (env, signal) => {
        environment = env;

        if (launchConfig.mode === "unisolated-development") {
          await env.start();
          const injected = env.agentEnvironment(agent.envPrefix);
          const result = await runAgentProcess(unisolatedLaunch(env, agent, injected), agent, signal);
          // Unisolated mode has no separate container to confirm - the
          // process closing *is* the confirmation - so confirmedStopped is
          // always true here and markAgentTerminationUnconfirmed() is never
          // reached on this branch.
          if (result.timedOut) {
            agentTermination = {
              timeoutSource: result.timeoutSource!,
              terminationError: result.terminationError,
              confirmedStopped: result.confirmedStopped
            };
          }
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
            stop: async () => {
              const termination = await terminateResearchContainer(containerName, runCommand ?? runCommandSafe);
              if (!termination.ok) {
                throw new PostgresResearchError(`agent container ${containerName}: ${termination.error}`);
              }
            }
          },
          agent,
          signal
        );
        if (result.timedOut) {
          agentTermination = {
            timeoutSource: result.timeoutSource!,
            terminationError: result.terminationError,
            confirmedStopped: result.confirmedStopped
          };
          // Fail closed (#188 review, third round): the container's own
          // absence could not be confirmed, so PGDATA, the socket directory,
          // the build view and the runtime container - all bind-mounted into
          // it too - must not be torn down out from under it. env.cleanup()
          // (called from withPostgresResearchEnvironment's finally, after
          // this body has settled) checks this and skips its destructive
          // steps entirely rather than reporting a normal teardown.
          if (result.confirmedStopped === false) env.markAgentTerminationUnconfirmed();
        }

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
  } catch (error) {
    // A session timeout rejects rather than resolving (options.timeoutMs is
    // a hard backstop on the whole call, unlike agent.timeoutMs, which is an
    // observation on the returned result) - but by the time it is thrown,
    // withPostgresResearchEnvironment's finally has already run env.cleanup(),
    // and `environment` was captured from inside the body. Attaching the
    // manifest here means a session timeout is never an evidence-free
    // rejection: cleanup.sessionTimedOut and cleanup.errors are still visible
    // to whatever catches this (#188).
    if (error instanceof PostgresResearchTimeoutError) {
      if (environment) error.runtimeManifest = environment.runtimeManifest();
      // Likewise for the agent's own cancellation outcome: absent when no
      // agent cancellation was ever observed to start (e.g. the timeout hit
      // before runAgentProcess() was even reached), present - including a
      // failed terminationError - whenever one was.
      if (agentTermination) error.agentTermination = agentTermination;
    }
    throw error;
  }
}
