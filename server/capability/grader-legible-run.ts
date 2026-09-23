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
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { nowIso, runCommandSafe } from "../utils.js";
import {
  GRADER_LEGIBLE_CONTAINER_PATHS,
  buildGraderLegibleContainerArgs
} from "./grader-legible-container.js";
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
      /** The run fills in `provider`, `isolationPolicy` and `enforcedBudgets` from what it already knows. */
      realAgentIdentity?: Omit<GraderLegibleRealAgentIdentity, "provider" | "isolationPolicy" | "enforcedBudgets">;
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

  // Re-presenting the task means presenting it clean. `assertFreshOrMatchingArtifactRoot`
  // has already refused any root belonging to a different experiment, so the only
  // thing that can be here is this attempt's own previous run - and layering on top
  // of it would corrupt the result twice over: the prior agent's `reproducer.sh`
  // would enter `taskSurfaceHash` and fail the paired-surface check, and the
  // retained `state/` invocation log would keep counting across runs.
  await rm(artifactDir, { recursive: true, force: true });

  const layout = await materializeGraderLegibleArchetype(archetype, artifactDir, intervention, input.archetypeSet);
  const taskSurfaceHash = await hashAgentVisibleTaskSurface(layout.workspaceDir);

  let agentWallMs: number | null = null;
  let agentExitStatus: number | null = null;
  let agentTimedOut = false;
  let agentSpawnFailed = false;
  let providerDiagnostic: string | null = null;

  if (provider.kind === "scripted") {
    await writeFile(join(layout.workspaceDir, GRADER_LEGIBLE_SUBMISSION_FILENAME), provider.script(archetype, condition));
  } else {
    // Created only now, so it cannot enter `taskSurfaceHash` above and break
    // the paired-surface comparison for every archetype at once.
    const investigationStateDir = join(layout.workspaceDir, GRADER_LEGIBLE_INVESTIGATION_STATE_DIRNAME);
    await mkdir(investigationStateDir, { recursive: true });

    const agentTimeoutMs = provider.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const agentStartedMs = Date.now();
    const capture = provider.isolation
      ? await runIsolatedAgentCommand(provider, provider.isolation, layout, agentTimeoutMs)
      : await captureSpawn(provider.command, provider.args ?? [], {
          cwd: layout.workspaceDir,
          // Unisolated: the host environment is inherited as before, because an
          // agent launched this way is an operator smoke test and typically
          // needs its own credentials and toolchain. `HONEYRAIL_FIXTURE_STATE`
          // is supplied so the agent can actually run the fixture, but it is
          // overridable - an unisolated run makes no isolation claim at all.
          env: { HONEYRAIL_FIXTURE_STATE: investigationStateDir, ...process.env, ...(provider.env ?? {}) },
          timeoutMs: agentTimeoutMs
        });
    agentWallMs = Date.now() - agentStartedMs;
    agentExitStatus = capture.exitStatus;
    agentTimedOut = capture.timedOut;
    agentSpawnFailed = Boolean(capture.spawnError);
    await Promise.all([
      writeFile(join(artifactDir, "agent-stdout.txt"), capture.stdout),
      writeFile(join(artifactDir, "agent-stderr.txt"), capture.stderr)
    ]);
    if (capture.spawnError) providerDiagnostic = `agent command could not start: ${capture.spawnError}`;
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
      : providerDiagnostic
        ? "infrastructure_error"
        : "invalid_submission";
    // An agent killed at its wall-clock budget spent a budget the harness
    // enforced; only a spawn failure is the harness's own fault.
    const primaryCause: GraderLegibleAttemptCause = validation.integrity
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
 * Runs the agent command inside a container that sees only the workspace and
 * the fixture bin. See `grader-legible-container.ts` for why a cwd alone is not
 * a boundary.
 *
 * The container name is derived, not taken from `attemptId`: an attempt id
 * contains `:` separators that docker rejects in a `--name`.
 */
async function runIsolatedAgentCommand(
  provider: Extract<GraderLegibleCandidateProvider, { kind: "command" }>,
  isolation: GraderLegibleIsolation,
  layout: GraderLegibleArchetypeLayout,
  timeoutMs: number
): Promise<SpawnCapture> {
  const containerName = `honeyrail-cap-glo-${randomUUID().slice(0, 12)}`;
  const args = buildGraderLegibleContainerArgs(
    {
      mounts: { workspaceDir: layout.workspaceDir, binDir: layout.binDir },
      command: [provider.command, ...(provider.args ?? [])],
      image: isolation.image,
      network: isolation.network,
      env: {
        HONEYRAIL_FIXTURE_STATE: `${GRADER_LEGIBLE_CONTAINER_PATHS.workspace}/${GRADER_LEGIBLE_INVESTIGATION_STATE_DIRNAME}`,
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
  return capture;
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
  await assertFreshOrMatchingArtifactRoot(input.artifactRoot, input.experimentId, archetypeSetHash);
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
    capabilityEvidenceEligible:
      input.provider.kind === "command" && Boolean(input.provider.realAgentIdentity) && input.provider.isolation !== undefined,
    realAgentIdentity: describeRealAgent(input.provider, input.submissionTimeoutMs),
    pairedTaskSurfaceHash: sha256(stableJson(surfaceHashes)),
    executionsPerAttempt: GRADER_LEGIBLE_EXECUTIONS_PER_ATTEMPT,
    conditions: GRADER_LEGIBLE_CONDITIONS.map((condition) => summarize(condition, attempts)),
    attempts
  };

  await writeJson(join(input.artifactRoot, "experiment-report.json"), report);
  return report;
}

/**
 * Refuses to start a run into an artifact root that already holds evidence.
 *
 * This is a **preflight**, and that placement is the whole point. The check
 * used to run after the attempt loop, comparing the finished report against
 * whatever was on disk - by which time every attempt had already re-materialized
 * its condition directory over the previous run's, overwriting `reproducer.sh`,
 * `agent-stdout.txt` and the captured `runs/` of retained evidence the error
 * then claimed to be protecting. Fail-closed has to mean "before the first
 * mutation", not "before the last write".
 *
 * An empty or absent root is fresh. A root holding *this* experiment's own
 * report is a deliberate idempotent rerun and stays allowed, which is what the
 * freeze script depends on.
 */
export async function assertFreshOrMatchingArtifactRoot(
  artifactRoot: string,
  experimentId: string,
  archetypeSetHash: string
): Promise<void> {
  const contents = await readdir(artifactRoot).catch(() => null);
  if (contents === null || contents.length === 0) return;

  const existing = await readFile(join(artifactRoot, "experiment-report.json"), "utf8").catch(() => null);
  if (!existing) {
    throw new GraderLegiblePairingError(
      `Artifact root "${artifactRoot}" is not empty (${contents.length} entr${contents.length === 1 ? "y" : "ies"}) and holds no experiment-report.json. ` +
        "Refusing to run: whatever is there would be overwritten attempt by attempt. Use a fresh artifact root."
    );
  }

  const previous = JSON.parse(existing) as GraderLegibleExperimentReport;
  if (previous.experimentId !== experimentId || previous.archetypeSetHash !== archetypeSetHash) {
    throw new GraderLegiblePairingError(
      `experiment-report.json at this artifact root belongs to experiment "${previous.experimentId}" (archetype set ${previous.archetypeSetHash}). ` +
        "Refusing to overwrite retained evidence - use a fresh artifact root."
    );
  }
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
  submissionTimeoutMs: number | undefined
): GraderLegibleRealAgentIdentity | null {
  if (provider.kind !== "command" || !provider.realAgentIdentity) return null;
  const declared = provider.realAgentIdentity;
  return {
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
