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
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../utils.js";
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
 * How a submission is obtained for one archetype.
 *
 * `scripted` writes a predetermined shape and is **harness validation only**:
 * per `docs/evaluation-protocol.md` a scripted agent never becomes capability
 * evidence. `command` runs a real agent with the agent-visible workspace as
 * its cwd; the agent is expected to write `reproducer.sh` there and nothing
 * else is read from it.
 */
export type GraderLegibleCandidateProvider =
  | { kind: "scripted"; label: string; script: (archetype: GraderLegibleArchetype, condition: GraderLegibleCondition) => string }
  | { kind: "command"; label: string; command: string; args?: readonly string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number };

/**
 * `completed` is the only status that carries a capability outcome. The other
 * three are the separation #237 requires: a harness/infra failure, an
 * integrity violation and a missing/empty submission must never be counted as
 * "the agent built a badly shaped reproducer".
 */
export type GraderLegibleAttemptStatus = "completed" | "invalid_submission" | "integrity_error" | "infrastructure_error";

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
 */
export async function executeGraderLegibleSubmission(
  layout: GraderLegibleArchetypeLayout,
  options: { executions?: number; timeoutMs?: number } = {}
): Promise<{ validity: GraderLegibleExecutionValidity; runs: GraderLegibleRunObservation[] }> {
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
      return { validity: { valid: false, reason: `execution ${index} could not start: ${capture.spawnError}` }, runs };
    }
    if (capture.timedOut) {
      return { validity: { valid: false, reason: `execution ${index} exceeded ${timeoutMs}ms and was killed` }, runs };
    }
    runs.push({ stdout: capture.stdout, stderr: capture.stderr, exitStatus: capture.exitStatus });
  }

  return { validity: { valid: true }, runs };
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
}): Promise<GraderLegibleAttempt> {
  const { archetype, condition, provider, artifactDir, attemptId } = input;
  const intervention = graderLegibleIntervention(condition);
  const startedAt = nowIso();
  const startedMs = Date.now();

  const layout = await materializeGraderLegibleArchetype(archetype, artifactDir, intervention);
  const taskSurfaceHash = await hashAgentVisibleTaskSurface(layout.workspaceDir);

  let agentWallMs: number | null = null;
  let agentExitStatus: number | null = null;
  let agentTimedOut = false;
  let providerDiagnostic: string | null = null;

  if (provider.kind === "scripted") {
    await writeFile(join(layout.workspaceDir, GRADER_LEGIBLE_SUBMISSION_FILENAME), provider.script(archetype, condition));
  } else {
    const agentStartedMs = Date.now();
    const capture = await captureSpawn(provider.command, provider.args ?? [], {
      cwd: layout.workspaceDir,
      env: { ...process.env, ...(provider.env ?? {}) },
      timeoutMs: provider.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
    });
    agentWallMs = Date.now() - agentStartedMs;
    agentExitStatus = capture.exitStatus;
    agentTimedOut = capture.timedOut;
    await Promise.all([
      writeFile(join(artifactDir, "agent-stdout.txt"), capture.stdout),
      writeFile(join(artifactDir, "agent-stderr.txt"), capture.stderr)
    ]);
    if (capture.spawnError) providerDiagnostic = `agent command could not start: ${capture.spawnError}`;
    else if (capture.timedOut) providerDiagnostic = `agent command exceeded its ${provider.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS}ms budget`;
  }

  const finish = async (
    status: GraderLegibleAttemptStatus,
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
    return finish(status, null, [providerDiagnostic, validation.diagnostic].filter((value): value is string => Boolean(value)), {
      submissionBytes: null,
      fixtureInvocationCount: invocationLog.length,
      executionsCaptured: 0
    });
  }

  const { validity, runs } = await executeGraderLegibleSubmission(layout, { timeoutMs: input.submissionTimeoutMs });
  const invocationLog = await readGraderLegibleInvocationLog(layout.stateDir);
  const grade = gradeGraderLegibleSubmission({
    archetype,
    validity,
    runs,
    invocationLog,
    submissionBytes: validation.bytes
  });

  const status: GraderLegibleAttemptStatus = grade.result === "invalid_execution" ? "infrastructure_error" : "completed";
  return finish(status, grade, grade.diagnostics, {
    submissionBytes: validation.bytes,
    fixtureInvocationCount: invocationLog.length,
    executionsCaptured: runs.length
  });
}

/**
 * Content hash of a condition's agent-visible workspace, excluding
 * `INTERVENTION.md`. Two conditions of a valid paired run must produce the
 * same value: that is the machine-checkable form of "baseline and candidate
 * see the same task surface except for the intervention".
 */
export async function hashAgentVisibleTaskSurface(workspaceDir: string): Promise<string> {
  const names = (await readdir(workspaceDir)).filter((name) => name !== "INTERVENTION.md").sort();
  const entries: [string, string][] = [];
  for (const name of names) {
    entries.push([name, sha256(await readFile(join(workspaceDir, name)))]);
  }
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
  attempts: number;
  completed: number;
  graderLegible: number;
  /** Primary endpoint: grader-legible successes over completed attempts. `null` when the denominator is zero. */
  graderLegibleRate: number | null;
  /** Retained separately so non-capability outcomes never vanish into the rate. */
  nonCapabilityOutcomes: Record<Exclude<GraderLegibleAttemptStatus, "completed">, number>;
  failureStages: Record<string, number>;
};

function summarize(condition: GraderLegibleCondition, attempts: readonly GraderLegibleAttempt[]): GraderLegibleConditionSummary {
  const forCondition = attempts.filter((attempt) => attempt.condition === condition);
  const completed = forCondition.filter((attempt) => attempt.status === "completed");
  const graderLegible = completed.filter((attempt) => attempt.grade?.result === "grader_legible").length;
  const failureStages: Record<string, number> = {};
  for (const attempt of completed) {
    const stage = attempt.grade?.failureStage;
    if (stage) failureStages[stage] = (failureStages[stage] ?? 0) + 1;
  }
  const intervention = graderLegibleIntervention(condition);
  return {
    condition,
    interventionId: intervention.interventionId,
    interventionHash: intervention.interventionHash,
    attempts: forCondition.length,
    completed: completed.length,
    graderLegible,
    graderLegibleRate: completed.length === 0 ? null : graderLegible / completed.length,
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
  /** `true` only for real-agent providers. A scripted run is harness validation and must never be promoted to capability evidence. */
  capabilityEvidenceEligible: boolean;
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
        submissionTimeoutMs: input.submissionTimeoutMs
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
    archetypeSetHash: graderLegibleArchetypeSetHash(archetypes),
    archetypeIds: archetypes.map((archetype) => archetype.archetypeId),
    providerLabel: input.provider.label,
    capabilityEvidenceEligible: input.provider.kind === "command",
    pairedTaskSurfaceHash: sha256(stableJson(surfaceHashes)),
    executionsPerAttempt: GRADER_LEGIBLE_EXECUTIONS_PER_ATTEMPT,
    conditions: GRADER_LEGIBLE_CONDITIONS.map((condition) => summarize(condition, attempts)),
    attempts
  };

  const reportPath = join(input.artifactRoot, "experiment-report.json");
  const existing = await readFile(reportPath, "utf8").catch(() => null);
  if (existing) {
    const previous = JSON.parse(existing) as GraderLegibleExperimentReport;
    if (previous.experimentId !== report.experimentId || previous.archetypeSetHash !== report.archetypeSetHash) {
      throw new GraderLegiblePairingError(
        `experiment-report.json at this artifact root belongs to experiment "${previous.experimentId}" (archetype set ${previous.archetypeSetHash}). ` +
          "Refusing to overwrite retained evidence - use a fresh artifact root."
      );
    }
  }
  await writeJson(reportPath, report);
  return report;
}
