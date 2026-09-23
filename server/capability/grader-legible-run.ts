/**
 * Execution and paired-run orchestration for the #237 grader-legible-observable
 * Capability Lab archetypes.
 *
 * Responsibilities, in the order #237's required validation lists them:
 *
 * - materialize baseline and candidate conditions from the *same* archetype
 *   set, differing in exactly one file (`assertPairedTaskSurface()` proves it);
 * - obtain a submission (a scripted shape for harness validation, or a real
 *   agent command);
 * - execute it repeatedly and capture raw stdout/stderr/exit status **outside**
 *   the agent, into operator-side artifacts;
 * - grade deterministically via `gradeGraderLegibleSubmission()`;
 * - keep infrastructure/integrity/invalid-submission outcomes separable from
 *   capability misses, and retain every attempt.
 *
 * It is not a generic experiment framework: there is one task family, one
 * grader, two conditions, and no provider abstraction beyond "scripted shape
 * or one agent command".
 *
 * When a provider requests isolation, the chain a report's
 * `capabilityEvidenceEligible` stands on is, in order:
 *
 *   1. image identity resolved  - the tag names an image that exists locally,
 *      and the content-addressed id it resolved to is retained;
 *   2. isolated execution established - proven *per attempt*, by a marker file
 *      the container itself writes before the agent process starts (see
 *      `CONTAINER_STARTED_MARKER`);
 *   3. the agent process ran inside it;
 *   4. every attempt's evidence retained, whatever its outcome.
 *
 * Step 1 is not step 2. An image can exist and `docker run` still fail before
 * any container exists - a network that is not defined, a daemon hiccup - and
 * that failure leaves exactly the same on-disk trace as "the agent ran and
 * wrote nothing". Only step 2's marker separates them.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { nowIso, runCommandSafe } from "../utils.js";
import {
  GRADER_LEGIBLE_CONTAINER_PATHS,
  GRADER_LEGIBLE_DEFAULT_NETWORK,
  buildGraderLegibleContainerArgs,
  graderLegibleImageEntrypoint
} from "./grader-legible-container.js";
import { startGraderLegibleFacadeBroker } from "./grader-legible-facade.js";
import { resolveImageIdentity, type ContainerImageIdentity } from "../postgres/image-identity.js";
import { sha256, stableJson } from "../postgres/historical-task.js";
import {
  GRADER_LEGIBLE_ARCHETYPES,
  graderLegibleArchetypeHash,
  graderLegibleArchetypeSetHash,
  type GraderLegibleArchetype
} from "./grader-legible-archetypes.js";
import {
  GRADER_LEGIBLE_SUBMISSION_FILENAME,
  materializeGraderLegibleArchetype,
  readGraderLegibleInvocationLog,
  validateGraderLegibleSubmission,
  type GraderLegibleArchetypeLayout
} from "./grader-legible-fixture.js";
import {
  GRADER_LEGIBLE_CONDITIONS,
  graderLegibleIntervention,
  type GraderLegibleCondition
} from "./grader-legible-intervention.js";
import {
  gradeGraderLegibleSubmission,
  type GraderLegibleExecutionValidity,
  type GraderLegibleGrade,
  type GraderLegibleRunObservation
} from "./grader-legible-grader.js";

/** Every archetype's contract requires cross-run determinism, so one execution is never enough. */
export const GRADER_LEGIBLE_EXECUTIONS_PER_ATTEMPT = 2;
export const DEFAULT_SUBMISSION_TIMEOUT_MS = 30_000;
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;

type SpawnCapture = { stdout: string; stderr: string; exitStatus: number | null; timedOut: boolean; spawnError: string | null };

/**
 * Filename, inside the facade channel directory, that the container touches
 * before it execs the agent command.
 *
 * The channel is already bind-mounted read-write in both directions, so this
 * needs no new mount, and the broker ignores it: it polls for
 * `*.request.json` only. Its presence on the host after `docker run` returns is
 * the only evidence available here that a container actually started - that the
 * image was found, the network attached and the mounts applied. `docker run`'s
 * exit status cannot answer that: a failure to create the container and an
 * agent that ran and exited nonzero are both just a nonzero exit.
 */
const CONTAINER_STARTED_MARKER = "container-started.marker";

/** A `SpawnCapture` plus the per-attempt proof that the container really ran. */
type IsolatedSpawnCapture = SpawnCapture & { isolationEstablished: boolean };

function captureSpawn(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<SpawnCapture> {
  return new Promise((resolve) => {
    // `detached` puts the child in its own process group so a timeout can kill
    // the whole tree. Killing only the shell would leave its own children
    // (a `sleep`, a stray background job) holding the stdout pipe open, and
    // the capture would block until they finished anyway - which is exactly
    // the budget the timeout exists to enforce.
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone, or the group could not be signalled; fall back to the
        // direct kill and let the close handler report whatever was captured.
        child.kill("SIGKILL");
      }
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitStatus: null, timedOut, spawnError: (error as Error).message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitStatus: code, timedOut, spawnError: null });
    });
  });
}

/**
 * The directory the *investigation* phase uses as `HONEYRAIL_FIXTURE_STATE`.
 *
 * Every fixture requires that variable to point at a writable directory, so
 * without one a real agent command cannot run the fixture at all - it can only
 * guess at the behavior it is supposed to expose. This is deliberately **not**
 * `layout.stateDir`: that directory is grader-owned and its invocation log is
 * the evidence that drives failure-stage attribution for the *graded*
 * executions, which `executeGraderLegibleSubmission()` still runs against the
 * real `stateDir`. What accumulates here is only the agent's own exploratory
 * invocations, so it is safe to place inside the agent-visible workspace and
 * safe for the agent to read back.
 *
 * It is created after the attempt's `taskSurfaceHash` is captured, so it never
 * enters the paired-surface comparison.
 */
export const GRADER_LEGIBLE_INVESTIGATION_STATE_DIRNAME = ".fixture-investigation-state";

/**
 * Opt-in container isolation for a real agent command. Absent means the agent
 * runs on the host with the workspace as its cwd, which is not a filesystem
 * boundary - see `grader-legible-container.ts`.
 */
export type GraderLegibleIsolation = {
  /** Operator-supplied; there is no default and no implicit `docker pull`. */
  image: string;
  network?: "none" | "bridge" | (string & {});
};

/**
 * Who the agent was, recorded in the report so a capability number is
 * attributable. Mirrors the "Real-agent pilot" evidence-level row in
 * `docs/evaluation-protocol.md` without building a provider framework: it is a
 * declaration the operator signs, not a runtime capability.
 *
 * It carries **no secrets**. `provider.env` and `process.env` are never copied
 * here - a model API key lives in exactly those places, and this object is
 * serialized into retained evidence.
 */
export type GraderLegibleRealAgentIdentity = {
  provider: "command";
  model: string;
  agentName: string;
  agentVersion: string;
  isolationPolicy: "docker" | "none";
  /**
   * The three isolation facts, present only when isolation was actually
   * resolved against the local daemon before the first attempt ran.
   *
   * `imageReference` is the operator's tag, which is mutable;
   * `resolvedImageId` is the content-addressed id that actually ran, so a
   * retained report still identifies the agent after the tag has moved.
   * `network` is the policy applied, defaulted here rather than left implicit.
   */
  imageReference?: string;
  resolvedImageId?: string;
  network?: string;
  /** Basename only: a full host path would leak the operator's layout into evidence. */
  commandIdentity: string;
  repositoryCommit: string;
  enforcedBudgets: { agentTimeoutMs: number; submissionTimeoutMs: number };
};

/**
 * How a submission is obtained for one archetype.
 *
 * `scripted` writes a predetermined shape and is **harness validation only**:
 * per `docs/evaluation-protocol.md` a scripted agent never becomes capability
 * evidence. `command` runs a real agent that is expected to write
 * `reproducer.sh` into the agent-visible workspace; nothing else is read from
 * it.
 *
 * `isolation` and `realAgentIdentity` are both optional so today's smoke-test
 * command providers keep working, and both are required before a run counts as
 * capability evidence (see `capabilityEvidenceEligible`).
 */
export type GraderLegibleCandidateProvider =
  | { kind: "scripted"; label: string; script: (archetype: GraderLegibleArchetype, condition: GraderLegibleCondition) => string }
  | {
      kind: "command";
      label: string;
      command: string;
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      isolation?: GraderLegibleIsolation;
      /**
       * The run fills in `provider`, `isolationPolicy`, `enforcedBudgets` and
       * the isolation facts from what it already knows. The image fields are
       * not declarable here on purpose: an operator-declared image id would be
       * a claim, and the point of resolving it is that it is an observation.
       */
      realAgentIdentity?: Omit<
        GraderLegibleRealAgentIdentity,
        "provider" | "isolationPolicy" | "enforcedBudgets" | "imageReference" | "resolvedImageId" | "network"
      >;
    };

/**
 * `completed` is the only status that carries a capability outcome. The other
 * three are the separation #237 requires: a harness/infra failure, an
 * integrity violation and a missing/empty submission must never be counted as
 * "the agent built a badly shaped reproducer".
 */
export type GraderLegibleAttemptStatus = "completed" | "invalid_submission" | "integrity_error" | "infrastructure_error";

/**
 * Why an attempt ended where it did, in the shared vocabulary of
 * `docs/evaluation-protocol.md`.
 *
 * `status` answers "which bucket does this attempt fall in"; this answers "who
 * or what is accountable", and the two are not the same question. The case
 * that forced the split: an agent that burns its whole wall-clock budget and is
 * killed currently lands in `infrastructure_error`, which reads as "the harness
 * broke". It did not - the agent spent a budget the harness enforced, which the
 * protocol calls `agent_resource_limit`. Attributing that to infrastructure
 * inflates the excluded-for-harness-reasons count and deflates the end-to-end
 * denominator, which is exactly the accounting the protocol's A/E/D split
 * exists to prevent.
 *
 * The first eight members are the protocol's failure-cause vocabulary verbatim.
 * The last two are the completed-attempt outcomes: a completed attempt has no
 * *failure* cause, but every attempt needs a value here for the counts to sum
 * to A.
 */
export type GraderLegibleAttemptCause =
  | "agent_budget_exhausted"
  | "agent_invalid_submission"
  | "agent_resource_limit"
  | "external_block"
  | "harness_or_evaluator"
  | "infrastructure"
  | "isolation_or_integrity"
  | "unknown"
  | "completed_capability_miss"
  | "completed_success";

export type GraderLegibleAttempt = {
  attemptId: string;
  condition: GraderLegibleCondition;
  archetypeId: string;
  failureClass: string;
  archetypeHash: string;
  interventionId: string;
  interventionHash: string;
  providerLabel: string;
  /**
   * Hash of the agent-visible workspace as *presented*, captured immediately
   * after materialization and before any submission exists. Comparing the
   * post-run workspace instead would fold the submitted script itself into the
   * "task surface", so two conditions could never match.
   */
  taskSurfaceHash: string;
  status: GraderLegibleAttemptStatus;
  /** Accountability for this attempt's outcome, in protocol vocabulary. See `GraderLegibleAttemptCause`. */
  primaryCause: GraderLegibleAttemptCause;
  /** Present only when `status === "completed"`. */
  grade: GraderLegibleGrade | null;
  diagnostics: string[];
  telemetry: {
    startedAt: string;
    endedAt: string;
    wallMs: number;
    agentWallMs: number | null;
    agentExitStatus: number | null;
    agentTimedOut: boolean;
    /**
     * Whether a container demonstrably started for this attempt, proven by the
     * marker it wrote from inside. `null` when the provider claimed no
     * isolation, where the question does not apply.
     */
    isolationEstablished: boolean | null;
    submissionBytes: number | null;
    fixtureInvocationCount: number;
    executionsCaptured: number;
  };
  artifactDir: string;
};

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${stableJson(value)}\n`);
}

/**
 * Runs the submitted reproducer `GRADER_LEGIBLE_EXECUTIONS_PER_ATTEMPT` times
 * and returns the externally captured observations.
 *
 * Each execution gets a fresh scratch cwd but shares the fixture state
 * directory, which is what makes the determinism requirement real: a fixture
 * whose raw output rotates between calls (archetype 6) will differ across
 * executions unless the submission imposes a stable projection.
 *
 * The environment is constructed, not inherited: PATH points at the fixture
 * bin plus the standard system directories, and nothing else is passed
 * through. An inherited environment would make captured output depend on the
 * operator's shell.
 *
 * `executionFailure` discriminates *why* an execution was rejected. The
 * grader's `validity` deliberately carries only a human-readable reason, but
 * cause attribution needs the machine-readable distinction: a submission killed
 * at its budget is the agent's resource limit, while one that could not be
 * spawned at all is the harness's infrastructure.
 */
export type GraderLegibleExecutionFailure = "timeout" | "spawn_error";

export async function executeGraderLegibleSubmission(
  layout: GraderLegibleArchetypeLayout,
  options: { executions?: number; timeoutMs?: number } = {}
): Promise<{
  validity: GraderLegibleExecutionValidity;
  runs: GraderLegibleRunObservation[];
  executionFailure: GraderLegibleExecutionFailure | null;
}> {
  const executions = options.executions ?? GRADER_LEGIBLE_EXECUTIONS_PER_ATTEMPT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SUBMISSION_TIMEOUT_MS;
  const submissionPath = join(layout.workspaceDir, GRADER_LEGIBLE_SUBMISSION_FILENAME);
  const runs: GraderLegibleRunObservation[] = [];

  for (let index = 0; index < executions; index += 1) {
    const cwd = join(layout.runsDir, String(index), "cwd");
    await mkdir(cwd, { recursive: true });
    const capture = await captureSpawn("/bin/sh", [submissionPath], {
      cwd,
      env: {
        PATH: `${layout.binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HONEYRAIL_FIXTURE_STATE: layout.stateDir
      },
      timeoutMs
    });
    await Promise.all([
      writeFile(join(layout.runsDir, String(index), "stdout.txt"), capture.stdout),
      writeFile(join(layout.runsDir, String(index), "stderr.txt"), capture.stderr),
      writeFile(join(layout.runsDir, String(index), "exit-status.txt"), `${capture.exitStatus === null ? "null" : capture.exitStatus}\n`)
    ]);
    if (capture.spawnError) {
      return {
        validity: { valid: false, reason: `execution ${index} could not start: ${capture.spawnError}` },
        runs,
        executionFailure: "spawn_error"
      };
    }
    if (capture.timedOut) {
      return {
        validity: { valid: false, reason: `execution ${index} exceeded ${timeoutMs}ms and was killed` },
        runs,
        executionFailure: "timeout"
      };
    }
    runs.push({ stdout: capture.stdout, stderr: capture.stderr, exitStatus: capture.exitStatus });
  }

  return { validity: { valid: true }, runs, executionFailure: null };
}

/**
 * One full attempt: materialize, obtain a submission, execute, grade, retain.
 *
 * Every exit path writes `attempt.json`. A retained failed attempt is the
 * point - the protocol forbids replacing or dropping one - so nothing here
 * throws on a bad outcome; it records it.
 */
export async function runGraderLegibleAttempt(input: {
  archetype: GraderLegibleArchetype;
  condition: GraderLegibleCondition;
  provider: GraderLegibleCandidateProvider;
  artifactDir: string;
  attemptId: string;
  submissionTimeoutMs?: number;
  /** The task set this attempt belongs to, so the manifest records the identity the run actually had. */
  archetypeSet?: readonly GraderLegibleArchetype[];
}): Promise<GraderLegibleAttempt> {
  const { archetype, condition, provider, artifactDir, attemptId } = input;
  const intervention = graderLegibleIntervention(condition);
  const startedAt = nowIso();
  const startedMs = Date.now();

  // Nothing is removed here. `assertArtifactRootUnused()` has already refused
  // any artifact root that holds a single entry, so an attempt directory under
  // it cannot pre-exist; a recursive delete at this point could only ever
  // destroy retained evidence, which is the one thing the protocol forbids.
  const layout = await materializeGraderLegibleArchetype(archetype, artifactDir, intervention, input.archetypeSet);
  const taskSurfaceHash = await hashAgentVisibleTaskSurface(layout.workspaceDir);

  let agentWallMs: number | null = null;
  let agentExitStatus: number | null = null;
  let agentTimedOut = false;
  let agentSpawnFailed = false;
  let providerDiagnostic: string | null = null;
  // `null` where the question does not apply: a scripted provider, or a command
  // provider that never asked for isolation and therefore claims none.
  let isolationEstablished: boolean | null = null;

  if (provider.kind === "scripted") {
    await writeFile(join(layout.workspaceDir, GRADER_LEGIBLE_SUBMISSION_FILENAME), provider.script(archetype, condition));
  } else {
    // Created only now, so it cannot enter `taskSurfaceHash` above and break
    // the paired-surface comparison for every archetype at once.
    const investigationStateDir = join(layout.workspaceDir, GRADER_LEGIBLE_INVESTIGATION_STATE_DIRNAME);
    await mkdir(investigationStateDir, { recursive: true });

    const agentTimeoutMs = provider.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const agentStartedMs = Date.now();
    const isolatedCapture: IsolatedSpawnCapture | null = provider.isolation
      ? await runIsolatedAgentCommand(provider, provider.isolation, layout, investigationStateDir, agentTimeoutMs)
      : null;
    const capture: SpawnCapture =
      isolatedCapture ??
      (await captureSpawn(provider.command, provider.args ?? [], {
        cwd: layout.workspaceDir,
        // Unisolated: the host environment is inherited as before, because an
        // agent launched this way is an operator smoke test and typically
        // needs its own credentials and toolchain. `HONEYRAIL_FIXTURE_STATE`
        // is supplied so the agent can actually run the fixture, but it is
        // overridable - an unisolated run makes no isolation claim at all.
        env: { HONEYRAIL_FIXTURE_STATE: investigationStateDir, ...process.env, ...(provider.env ?? {}) },
        timeoutMs: agentTimeoutMs
      }));
    agentWallMs = Date.now() - agentStartedMs;
    agentExitStatus = capture.exitStatus;
    agentTimedOut = capture.timedOut;
    agentSpawnFailed = Boolean(capture.spawnError);
    isolationEstablished = isolatedCapture?.isolationEstablished ?? null;
    await Promise.all([
      writeFile(join(artifactDir, "agent-stdout.txt"), capture.stdout),
      writeFile(join(artifactDir, "agent-stderr.txt"), capture.stderr)
    ]);
    if (isolationEstablished === false) {
      providerDiagnostic =
        "container did not start: isolation was not established (docker run failed before the agent process began - " +
        "check network policy and image availability)";
    } else if (capture.spawnError) providerDiagnostic = `agent command could not start: ${capture.spawnError}`;
    else if (capture.timedOut) providerDiagnostic = `agent command exceeded its ${agentTimeoutMs}ms budget`;
  }

  const finish = async (
    status: GraderLegibleAttemptStatus,
    primaryCause: GraderLegibleAttemptCause,
    grade: GraderLegibleGrade | null,
    diagnostics: string[],
    extra: { submissionBytes: number | null; fixtureInvocationCount: number; executionsCaptured: number }
  ): Promise<GraderLegibleAttempt> => {
    const attempt: GraderLegibleAttempt = {
      attemptId,
      condition,
      archetypeId: archetype.archetypeId,
      failureClass: archetype.failureClass,
      archetypeHash: graderLegibleArchetypeHash(archetype),
      interventionId: intervention.interventionId,
      interventionHash: intervention.interventionHash,
      providerLabel: provider.label,
      taskSurfaceHash,
      status,
      primaryCause,
      grade,
      diagnostics,
      telemetry: {
        startedAt,
        endedAt: nowIso(),
        wallMs: Date.now() - startedMs,
        agentWallMs,
        agentExitStatus,
        agentTimedOut,
        isolationEstablished,
        ...extra
      },
      artifactDir
    };
    await writeJson(join(artifactDir, "attempt.json"), attempt);
    return attempt;
  };

  const validation = await validateGraderLegibleSubmission(layout.workspaceDir);
  if (!validation.ok) {
    const invocationLog = await readGraderLegibleInvocationLog(layout.stateDir);
    // An agent that never started, or timed out before writing anything, is an
    // infrastructure outcome; an agent that ran and produced no usable artifact
    // is an invalid submission. Both stay out of the capability denominator.
    const status: GraderLegibleAttemptStatus = validation.integrity
      ? "integrity_error"
      : isolationEstablished === false || providerDiagnostic
        ? "infrastructure_error"
        : "invalid_submission";
    // A container that never started is never an invalid submission: there was
    // no agent process to submit anything, so it is checked ahead of the
    // timeout and spawn-error branches and does not depend on what the
    // provider diagnostic happens to say.
    //
    // Below that: an agent killed at its wall-clock budget spent a budget the
    // harness enforced; only a spawn failure is the harness's own fault.
    const primaryCause: GraderLegibleAttemptCause = validation.integrity
      ? "isolation_or_integrity"
      : isolationEstablished === false
        ? "isolation_or_integrity"
        : agentTimedOut
          ? "agent_resource_limit"
          : agentSpawnFailed
            ? "infrastructure"
            : "agent_invalid_submission";
    return finish(
      status,
      primaryCause,
      null,
      [providerDiagnostic, validation.diagnostic].filter((value): value is string => Boolean(value)),
      {
        submissionBytes: null,
        fixtureInvocationCount: invocationLog.length,
        executionsCaptured: 0
      }
    );
  }

  const { validity, runs, executionFailure } = await executeGraderLegibleSubmission(layout, { timeoutMs: input.submissionTimeoutMs });
  const invocationLog = await readGraderLegibleInvocationLog(layout.stateDir);
  const grade = gradeGraderLegibleSubmission({
    archetype,
    validity,
    runs,
    invocationLog,
    submissionBytes: validation.bytes
  });

  const status: GraderLegibleAttemptStatus = grade.result === "invalid_execution" ? "infrastructure_error" : "completed";
  // A reproducer that hangs is the agent's artifact exceeding a budget, not a
  // harness fault - the same distinction the agent-phase mapping draws above.
  const primaryCause: GraderLegibleAttemptCause =
    grade.result === "invalid_execution"
      ? executionFailure === "timeout"
        ? "agent_resource_limit"
        : "infrastructure"
      : grade.result === "grader_legible"
        ? "completed_success"
        : "completed_capability_miss";
  return finish(status, primaryCause, grade, grade.diagnostics, {
    submissionBytes: validation.bytes,
    fixtureInvocationCount: invocationLog.length,
    executionsCaptured: runs.length
  });
}

/**
 * Runs the agent command inside a container that sees only the workspace, the
 * generic facade client and the facade channel. See
 * `grader-legible-container.ts` for why a cwd alone is not a boundary, and
 * `grader-legible-facade.ts` for why the real fixture is not mounted at all.
 *
 * The broker is started before the container and stopped in a `finally`,
 * whatever the container did: a leaked broker would keep an interval alive for
 * the rest of the process, polling a directory nobody writes to.
 *
 * The container name is derived, not taken from `attemptId`: an attempt id
 * contains `:` separators that docker rejects in a `--name`.
 *
 * The returned `isolationEstablished` is the per-attempt half of the isolation
 * claim: `true` only when the container itself wrote `CONTAINER_STARTED_MARKER`
 * into the shared channel, which it can only do from inside a container that
 * actually started.
 */
async function runIsolatedAgentCommand(
  provider: Extract<GraderLegibleCandidateProvider, { kind: "command" }>,
  isolation: GraderLegibleIsolation,
  layout: GraderLegibleArchetypeLayout,
  investigationStateDir: string,
  timeoutMs: number
): Promise<IsolatedSpawnCapture> {
  const containerName = `honeyrail-cap-glo-${randomUUID().slice(0, 12)}`;
  const facadeDir = join(layout.root, "facade-channel");
  await mkdir(facadeDir, { recursive: true });
  const broker = startGraderLegibleFacadeBroker({
    facadeDir,
    // The REAL fixture directory. It is opened by this process only and is
    // never passed to `buildGraderLegibleContainerArgs()`.
    binDir: layout.binDir,
    stateDir: investigationStateDir,
    timeoutMs
  });
  try {
    return await runContainer();
  } finally {
    await broker.stop();
  }

  async function runContainer(): Promise<IsolatedSpawnCapture> {
  // `sh -c SCRIPT NAME ARG...`: inside SCRIPT, `$0` is the unused placeholder,
  // `$1` the marker path, and after `shift` the rest of `$@` is the real
  // command and its arguments, `exec`'d so the agent keeps pid 1 and the
  // container's exit status stays the agent's own. The only new requirement on
  // the operator's image is `/bin/sh`.
  //
  // The wrapper has to take the `--entrypoint` slot - appended as CMD it would
  // become *arguments to* an image that declares an entrypoint rather than the
  // program run - so the image's own entrypoint is read back and re-exec'd
  // ahead of `command`, reproducing exactly the argv docker would have built.
  const markerContainerPath = `${GRADER_LEGIBLE_CONTAINER_PATHS.facade}/${CONTAINER_STARTED_MARKER}`;
  const markerHostPath = join(facadeDir, CONTAINER_STARTED_MARKER);
  const imageEntrypoint = await graderLegibleImageEntrypoint(isolation.image);
  const args = buildGraderLegibleContainerArgs(
    {
      mounts: { workspaceDir: layout.workspaceDir, facadeBinDir: layout.facadeBinDir, facadeDir },
      entrypoint: "sh",
      command: [
        "-c",
        'touch "$1"; shift; exec "$@"',
        "_",
        markerContainerPath,
        ...imageEntrypoint,
        provider.command,
        ...(provider.args ?? [])
      ],
      image: isolation.image,
      network: isolation.network,
      // No `HONEYRAIL_FIXTURE_STATE` here. The fixture no longer runs inside
      // the container, so an in-container path for its state directory would
      // be a variable that points at nothing; the broker supplies the real
      // investigation state dir when it spawns the fixture on the host.
      env: {
        // Explicitly constructed. Spreading `process.env` here would ship the
        // operator's whole environment - API keys included - into a container
        // whose argv is retained as evidence.
        ...Object.fromEntries(
          Object.entries(provider.env ?? {})
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        )
      }
    },
    containerName
  );

  const capture = await captureSpawn("docker", args, { cwd: layout.workspaceDir, env: process.env, timeoutMs });
  if (capture.timedOut) {
    // The timeout SIGKILLs the `docker run` client, which detaches from but
    // does not stop the container. Without this the agent keeps running past
    // the budget the report claims was enforced, still writing into the
    // workspace the grader is about to read.
    await runCommandSafe("docker", ["rm", "-f", containerName], { timeout: 30_000 });
  }
  // Checked whatever the outcome was, including a timeout: an agent that hit
  // its budget still ran inside a container, and that is a resource limit, not
  // a failure of isolation.
  const isolationEstablished = (await stat(markerHostPath).catch(() => null)) !== null;
  await rm(markerHostPath, { force: true });
  return { ...capture, isolationEstablished };
  }
}

/**
 * Content hash of a condition's agent-visible workspace, excluding
 * `INTERVENTION.md`. Two conditions of a valid paired run must produce the
 * same value: that is the machine-checkable form of "baseline and candidate
 * see the same task surface except for the intervention".
 *
 * The walk recurses. A top-level-only listing would `readFile` a directory and
 * throw today, and would silently ignore its contents the moment an archetype
 * presented a subdirectory - so a divergence nested one level down would pass
 * the pairing check that exists to catch exactly that.
 */
export async function hashAgentVisibleTaskSurface(workspaceDir: string): Promise<string> {
  const entries: [string, string][] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const dirents = (await readdir(dir, { withFileTypes: true }))
      .filter((dirent) => !(prefix === "" && dirent.name === "INTERVENTION.md"))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const dirent of dirents) {
      const relative = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) await walk(join(dir, dirent.name), relative);
      else entries.push([relative, sha256(await readFile(join(dir, dirent.name)))]);
    }
  };
  await walk(workspaceDir, "");
  return sha256(stableJson(entries));
}

export class GraderLegiblePairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraderLegiblePairingError";
  }
}

/**
 * Directory-level form of the pairing check, for two *as-presented*
 * workspaces. `runGraderLegiblePairedExperiment()` uses each attempt's
 * recorded `taskSurfaceHash` instead, because by the time an attempt finishes
 * its workspace also holds the submitted script and any scratch files the
 * agent left behind.
 */
export async function assertPairedTaskSurface(baselineWorkspace: string, candidateWorkspace: string): Promise<string> {
  const [baseline, candidate] = await Promise.all([
    hashAgentVisibleTaskSurface(baselineWorkspace),
    hashAgentVisibleTaskSurface(candidateWorkspace)
  ]);
  if (baseline !== candidate) {
    throw new GraderLegiblePairingError(
      `Paired conditions do not share a task surface (baseline ${baseline}, candidate ${candidate}). ` +
        "Refusing to report a paired comparison: the only permitted difference between conditions is INTERVENTION.md."
    );
  }
  return baseline;
}

export type GraderLegibleConditionSummary = {
  condition: GraderLegibleCondition;
  interventionId: string;
  interventionHash: string;
  /** `A` in protocol terms: every formal attempt, whatever its outcome. */
  attempts: number;
  /** `E` in protocol terms: attempts eligible for a capability judgement. */
  completed: number;
  /** `D` in protocol terms: valid grader-legible constructions. */
  graderLegible: number;
  /**
   * `D/E`: **conditional** rediscovery - how often the agent succeeded *given*
   * it got as far as a gradeable submission. It is not the headline number: it
   * silently excludes every attempt that failed earlier, so an agent that times
   * out nine times in ten and succeeds on the tenth scores 1.0 here. `null`
   * when the denominator is zero.
   */
  graderLegibleRate: number | null;
  /**
   * `D/A`: **end-to-end budget success**, the honest headline. Same numerator,
   * denominator of every attempt made, so pre-grading failures cost what they
   * actually cost. `null` only when no attempt was made at all.
   */
  endToEndBudgetSuccessRate: number | null;
  /** Retained separately so non-capability outcomes never vanish into the rate. */
  nonCapabilityOutcomes: Record<Exclude<GraderLegibleAttemptStatus, "completed">, number>;
  /** Protocol-vocabulary accountability counts. Sums to `attempts`. */
  causeCounts: Record<GraderLegibleAttemptCause, number>;
  failureStages: Record<string, number>;
};

const GRADER_LEGIBLE_ATTEMPT_CAUSES: readonly GraderLegibleAttemptCause[] = [
  "agent_budget_exhausted",
  "agent_invalid_submission",
  "agent_resource_limit",
  "external_block",
  "harness_or_evaluator",
  "infrastructure",
  "isolation_or_integrity",
  "unknown",
  "completed_capability_miss",
  "completed_success"
];

function summarize(condition: GraderLegibleCondition, attempts: readonly GraderLegibleAttempt[]): GraderLegibleConditionSummary {
  const forCondition = attempts.filter((attempt) => attempt.condition === condition);
  const completed = forCondition.filter((attempt) => attempt.status === "completed");
  const graderLegible = completed.filter((attempt) => attempt.grade?.result === "grader_legible").length;
  const failureStages: Record<string, number> = {};
  for (const attempt of completed) {
    const stage = attempt.grade?.failureStage;
    if (stage) failureStages[stage] = (failureStages[stage] ?? 0) + 1;
  }
  const causeCounts = Object.fromEntries(
    GRADER_LEGIBLE_ATTEMPT_CAUSES.map((cause) => [cause, forCondition.filter((attempt) => attempt.primaryCause === cause).length])
  ) as Record<GraderLegibleAttemptCause, number>;
  const intervention = graderLegibleIntervention(condition);
  return {
    condition,
    interventionId: intervention.interventionId,
    interventionHash: intervention.interventionHash,
    attempts: forCondition.length,
    completed: completed.length,
    graderLegible,
    graderLegibleRate: completed.length === 0 ? null : graderLegible / completed.length,
    endToEndBudgetSuccessRate: forCondition.length === 0 ? null : graderLegible / forCondition.length,
    causeCounts,
    nonCapabilityOutcomes: {
      invalid_submission: forCondition.filter((attempt) => attempt.status === "invalid_submission").length,
      integrity_error: forCondition.filter((attempt) => attempt.status === "integrity_error").length,
      infrastructure_error: forCondition.filter((attempt) => attempt.status === "infrastructure_error").length
    },
    failureStages
  };
}

export type GraderLegibleExperimentReport = {
  schemaVersion: 1;
  experimentId: string;
  createdAt: string;
  archetypeSetHash: string;
  archetypeIds: readonly string[];
  providerLabel: string;
  /**
   * `true` only when the run meets every precondition for the number to mean
   * what a capability claim says it means: a real agent command (not a
   * scripted shape), a declared agent identity, and an explicit isolation
   * decision. A command provider alone is not enough - that was true of a
   * provider pointed at `/bin/false` with no isolation and no attribution.
   */
  capabilityEvidenceEligible: boolean;
  /** Who the agent was. `null` for scripted runs and undeclared command providers. Never contains secrets. */
  realAgentIdentity: GraderLegibleRealAgentIdentity | null;
  pairedTaskSurfaceHash: string;
  executionsPerAttempt: number;
  conditions: GraderLegibleConditionSummary[];
  attempts: GraderLegibleAttempt[];
};

/**
 * Runs the full paired baseline-vs-candidate experiment across the archetype
 * set and writes `experiment-report.json` at `artifactRoot`.
 *
 * Refuses to overwrite an existing report whose identity-defining fields
 * differ, the same fail-closed discipline as
 * `assertHistoricalPostgres212ManifestUnchanged()`: a rerun into a used
 * artifact root must be a deliberate new root, not a silent replacement of
 * retained evidence.
 */
export async function runGraderLegiblePairedExperiment(input: {
  experimentId: string;
  artifactRoot: string;
  provider: GraderLegibleCandidateProvider;
  archetypes?: readonly GraderLegibleArchetype[];
  submissionTimeoutMs?: number;
}): Promise<GraderLegibleExperimentReport> {
  const archetypes = input.archetypes ?? GRADER_LEGIBLE_ARCHETYPES;
  const archetypeSetHash = graderLegibleArchetypeSetHash(archetypes);
  await assertArtifactRootUnused(input.artifactRoot);

  // Resolve the isolation image *before* the first attempt, and let a failure
  // propagate. A missing image or an unreachable daemon used to surface as the
  // first attempt's `docker run` failing, after which the loop carried on and
  // produced a report for a provider that declared isolation and never got it.
  // Reuses the generic resolver the PostgreSQL research path already shares,
  // rather than a second copy of image-inspection logic.
  const imageIdentity =
    input.provider.kind === "command" && input.provider.isolation
      ? await resolveImageIdentity(input.provider.isolation.image, {
          buildHint: "docker build -t <image> docker/capability-grader-legible-agent-stub (or your own operator image)"
        })
      : null;

  await mkdir(input.artifactRoot, { recursive: true });

  const attempts: GraderLegibleAttempt[] = [];
  const surfaceHashes: string[] = [];

  for (const archetype of archetypes) {
    const perCondition: Partial<Record<GraderLegibleCondition, GraderLegibleAttempt>> = {};
    for (const condition of GRADER_LEGIBLE_CONDITIONS) {
      const attempt = await runGraderLegibleAttempt({
        archetype,
        condition,
        provider: input.provider,
        artifactDir: join(input.artifactRoot, condition, archetype.archetypeId),
        attemptId: `${input.experimentId}:${condition}:${archetype.archetypeId}`,
        submissionTimeoutMs: input.submissionTimeoutMs,
        archetypeSet: archetypes
      });
      attempts.push(attempt);
      perCondition[condition] = attempt;
    }
    const baseline = perCondition.baseline!;
    const candidate = perCondition.candidate!;
    if (baseline.taskSurfaceHash !== candidate.taskSurfaceHash) {
      throw new GraderLegiblePairingError(
        `Paired conditions for "${archetype.archetypeId}" were not presented the same task surface ` +
          `(baseline ${baseline.taskSurfaceHash}, candidate ${candidate.taskSurfaceHash}). ` +
          "Refusing to report a paired comparison: the only permitted difference between conditions is INTERVENTION.md."
      );
    }
    surfaceHashes.push(baseline.taskSurfaceHash);
  }

  const report: GraderLegibleExperimentReport = {
    schemaVersion: 1,
    experimentId: input.experimentId,
    createdAt: nowIso(),
    archetypeSetHash,
    archetypeIds: archetypes.map((archetype) => archetype.archetypeId),
    providerLabel: input.provider.label,
    // Isolation must be *verified*, not merely configured - which is what
    // `isolation !== undefined` alone said, and why a `docker run` that failed
    // before creating any container could still produce an "eligible" report.
    // So: a real agent identity, a requested isolation whose image actually
    // resolved, and no attempt that was supposed to run isolated and did not.
    // `null` passes because it only occurs for an unisolated provider, which
    // the `isolation !== undefined` clause has already excluded.
    capabilityEvidenceEligible:
      input.provider.kind === "command" &&
      Boolean(input.provider.realAgentIdentity) &&
      input.provider.isolation !== undefined &&
      imageIdentity !== null &&
      attempts.every((attempt) => attempt.telemetry.isolationEstablished !== false),
    realAgentIdentity: describeRealAgent(input.provider, input.submissionTimeoutMs, imageIdentity),
    pairedTaskSurfaceHash: sha256(stableJson(surfaceHashes)),
    executionsPerAttempt: GRADER_LEGIBLE_EXECUTIONS_PER_ATTEMPT,
    conditions: GRADER_LEGIBLE_CONDITIONS.map((condition) => summarize(condition, attempts)),
    attempts
  };

  await writeJson(join(input.artifactRoot, "experiment-report.json"), report);
  return report;
}

/**
 * Refuses to start a run into an artifact root that holds anything at all.
 *
 * This is a **preflight**, and that placement is half the point. The check
 * originally ran after the attempt loop, comparing the finished report against
 * whatever was on disk - by which time every attempt had already re-materialized
 * its condition directory over the previous run's, overwriting `reproducer.sh`,
 * `agent-stdout.txt` and the captured `runs/` of the retained evidence the
 * error then claimed to be protecting. Fail-closed has to mean "before the
 * first mutation", not "before the last write".
 *
 * The other half is that there is **no matching exception**. A previous version
 * allowed a rerun whose `experimentId` and archetype set matched the report
 * already there, and called that an idempotent rerun. It was not idempotent: it
 * deleted and re-created every attempt directory, so a rerun that crashed
 * halfway left the root holding a mixture of two runs' evidence with a report
 * describing neither. "Same inputs" does not make destroying an evidence root
 * safe, because the evidence is not a function of the inputs - it is what
 * happened.
 *
 * So: any entry at all, and the run is refused. A retry uses a fresh root and a
 * new `experimentId`, which also keeps the predecessor's evidence available for
 * comparison. Nothing in the repo depends on the old behavior; in particular
 * `npm run capability-glo-237-freeze` writes only
 * `corpus/capability-grader-legible-intervention-v1.json` and never opens an
 * experiment artifact root.
 */
export async function assertArtifactRootUnused(artifactRoot: string): Promise<void> {
  const contents = await readdir(artifactRoot).catch(() => null);
  if (contents === null || contents.length === 0) return;
  throw new GraderLegiblePairingError(
    `Artifact root "${artifactRoot}" already holds ${contents.length} entr${contents.length === 1 ? "y" : "ies"}. ` +
      "Refusing to run: a used artifact root is retained evidence, and re-running into it - even for the same experiment - " +
      "would overwrite it attempt by attempt. Use a fresh artifact root and a new experiment id."
  );
}

/**
 * Builds the report's agent attribution from what the operator declared plus
 * what the run itself knows (isolation policy, enforced budgets).
 *
 * Only declared fields are copied. `provider.env` and `process.env` are never
 * touched here: the operator's model API key lives in one of them, and this
 * object is written into retained evidence that gets shared.
 */
function describeRealAgent(
  provider: GraderLegibleCandidateProvider,
  submissionTimeoutMs: number | undefined,
  imageIdentity: ContainerImageIdentity | null
): GraderLegibleRealAgentIdentity | null {
  if (provider.kind !== "command" || !provider.realAgentIdentity) return null;
  const declared = provider.realAgentIdentity;
  return {
    // Only present for an isolated provider, and then only because the
    // preflight resolved it. A tag is mutable; the id is what actually ran.
    ...(provider.isolation && imageIdentity
      ? {
          imageReference: provider.isolation.image,
          resolvedImageId: imageIdentity.id,
          network: provider.isolation.network ?? GRADER_LEGIBLE_DEFAULT_NETWORK
        }
      : {}),
    provider: "command",
    model: declared.model,
    agentName: declared.agentName,
    agentVersion: declared.agentVersion,
    isolationPolicy: provider.isolation ? "docker" : "none",
    // Basename, even when the operator declared a path: the evidence records
    // which binary ran, not where this machine keeps it.
    commandIdentity: basename(declared.commandIdentity),
    repositoryCommit: declared.repositoryCommit,
    enforcedBudgets: {
      agentTimeoutMs: provider.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      submissionTimeoutMs: submissionTimeoutMs ?? DEFAULT_SUBMISSION_TIMEOUT_MS
    }
  };
}
