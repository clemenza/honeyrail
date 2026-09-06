import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../utils.js";
import {
  buildHistoricalPostgresCorpusTaskEntry,
  validateHistoricalPostgresCorpusManifest,
  HistoricalPostgresCorpusIntegrityError,
  type HistoricalPostgresCorpusManifest,
  type HistoricalPostgresCorpusPartition,
  type HistoricalPostgresCorpusTaskEntry
} from "./historical-corpus.js";
import {
  canonicalize,
  materializeHistoricalPostgresTask,
  resolveHistoricalPostgresEnvironmentFingerprint,
  runHistoricalPostgresTrial,
  stableJson,
  type HistoricalPostgresEnvironmentFingerprint,
  type HistoricalPostgresGradeStatus,
  type HistoricalPostgresTaskSpec,
  type HistoricalPostgresTrial,
  type HistoricalPostgresTrialExecutionEnvironment
} from "./historical-task.js";
import {
  runAgentInPostgresResearchEnvironment,
  type PostgresResearchAgentSpec,
  type PostgresResearchSessionOptions
} from "./research-session.js";
import type { RunCommand } from "./runtime.js";

/**
 * Issue #180: before any scored Historical PostgreSQL pilot trial starts an
 * agent, this module proves the frozen Corpus v0 manifest, the actual
 * build/runtime environment, and the actual materialized task all still
 * match what was frozen. A mismatch on any dimension aborts here, before
 * `runHistoricalPostgresTrial()` (and therefore any agent process/container)
 * is ever invoked - never folded into the agent rediscovery-miss vocabulary.
 * It also binds that verified environment to the environment the trial
 * *actually executed under* (PR #207 review, P0 2), and gates whether a
 * completed run is eligible for the Historical PostgreSQL capability dataset
 * at all (PR #207 review, P0 3).
 *
 * Deliberately not a generic `EvalProvider`/`ManagedEnvironment` abstraction:
 * this is PostgreSQL-Corpus-v0-specific glue over the existing
 * `validateHistoricalPostgresCorpusManifest()` / `resolveHistoricalPostgresEnvironmentFingerprint()` /
 * `materializeHistoricalPostgresTask()` / `buildHistoricalPostgresCorpusTaskEntry()` /
 * `runHistoricalPostgresTrial()` - none of which this file reimplements.
 *
 * Everything this module *persists* (`preflight-result.json`,
 * `pilot-result.json`) is deliberately a separate, explicitly whitelisted
 * evidence projection (`sanitizeHistoricalPostgresPreflightEvidence()` /
 * `sanitizeHistoricalPostgresPilotEvidence()`), never the rich in-memory
 * result: the in-memory result is convenient for a caller/test to introspect
 * in full, but must never itself be the thing written to disk or printed,
 * since some of what it carries downstream (`trial.grade`'s per-revision
 * observations) embeds the grader-private pinned revisions (PR #207 review,
 * P0 1).
 */

/** The Corpus v0 identity this pilot is pinned to (#180). Never silently accept a different corpus. */
export const HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_ID = "historical-postgres-corpus-v0";
export const HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_HASH = "066df0141a13a4b79e78d5737341ce2be82b36f72d1df9c1ec1ac3ae8cdd76f0";

export type HistoricalPostgresPreflightFailureDimension =
  | "manifestIntegrity"
  | "corpusId"
  | "corpusHash"
  | "environmentFingerprint"
  | "taskEntry";

/**
 * Deliberately does *not* carry `HistoricalPostgresTaskLayout`: that layout
 * includes the grader-private `truthManifest` (upstream bug identity, both
 * pinned revisions, canonical-reproducer/fix-evidence paths) and private
 * filesystem paths (`sourceDir`, `truthManifestPath`, the private mirror
 * `repoPath` woven through `referenceManifest`'s provenance). Nothing
 * downstream of this function needs the layout - only the already-sanitized
 * `taskEntry` it derives (see `buildHistoricalPostgresCorpusTaskEntry()`,
 * which by construction can never carry truth).
 */
export type HistoricalPostgresPreflightResult =
  | {
      ok: true;
      corpusManifest: HistoricalPostgresCorpusManifest;
      taskEntry: HistoricalPostgresCorpusTaskEntry;
      frozenTaskEntry: HistoricalPostgresCorpusTaskEntry;
      environmentFingerprint: HistoricalPostgresEnvironmentFingerprint;
    }
  | {
      ok: false;
      failedDimension: HistoricalPostgresPreflightFailureDimension;
      diagnostics: string[];
      environmentFingerprint?: HistoricalPostgresEnvironmentFingerprint;
    };

/** Exactly the 12 task-entry fields #180 requires the pilot to compare - never `provenanceReferences` (administrative only). */
const COMPARED_TASK_ENTRY_FIELDS = [
  "taskId",
  "partition",
  "sourceSnapshotHash",
  "promptHash",
  "taskDefinitionHash",
  "truthBundleHash",
  "agentWorkspaceHash",
  "buildContractHash",
  "gradingProtocol",
  "scaffoldingLevel",
  "budget",
  "artifactContract"
] as const satisfies readonly (keyof HistoricalPostgresCorpusTaskEntry)[];

function fieldEqual(actual: unknown, expected: unknown): boolean {
  return stableJson(canonicalize(actual)) === stableJson(canonicalize(expected));
}

/** Named diagnostics for exactly which contract dimension of a task entry disagrees - never the entries' underlying private truth (none of these 12 fields carry it). */
function diffCorpusTaskEntry(frozen: HistoricalPostgresCorpusTaskEntry, actual: HistoricalPostgresCorpusTaskEntry): string[] {
  const diffs: string[] = [];
  for (const field of COMPARED_TASK_ENTRY_FIELDS) {
    if (!fieldEqual(actual[field], frozen[field])) {
      diffs.push(`taskEntry.${field}: expected ${stableJson(canonicalize(frozen[field]))}, got ${stableJson(canonicalize(actual[field]))}`);
    }
  }
  return diffs;
}

/** Named diagnostics for exactly which resolved build/runtime identity dimension disagrees - all fields here are already-public build metadata, never truth. */
function diffEnvironmentFingerprint(
  frozen: HistoricalPostgresEnvironmentFingerprint,
  actual: HistoricalPostgresEnvironmentFingerprint
): string[] {
  const diffs: string[] = [];
  const compareField = (label: string, expected: unknown, got: unknown) => {
    if (!fieldEqual(got, expected)) {
      diffs.push(`environmentFingerprint.${label}: expected ${stableJson(canonicalize(expected))}, got ${stableJson(canonicalize(got))}`);
    }
  };
  compareField("buildMode", frozen.buildMode, actual.buildMode);
  compareField("buildProfileVersion", frozen.buildProfileVersion, actual.buildProfileVersion);
  compareField("configureArgs", frozen.configureArgs, actual.configureArgs);
  compareField("initdbArgs", frozen.initdbArgs, actual.initdbArgs);
  const buildEnvKeys = new Set([...Object.keys(frozen.buildEnv), ...Object.keys(actual.buildEnv)]);
  for (const key of [...buildEnvKeys].sort()) {
    compareField(`buildEnv.${key}`, frozen.buildEnv[key], actual.buildEnv[key]);
  }
  compareField("builderImage.reference", frozen.builderImage.reference, actual.builderImage.reference);
  compareField("builderImage.id", frozen.builderImage.id, actual.builderImage.id);
  compareField("runtimeImage.reference", frozen.runtimeImage.reference, actual.runtimeImage.reference);
  compareField("runtimeImage.id", frozen.runtimeImage.id, actual.runtimeImage.id);
  compareField("compiler.command", frozen.compiler.command, actual.compiler.command);
  compareField("compiler.version", frozen.compiler.version, actual.compiler.version);
  compareField("compiler.target", frozen.compiler.target, actual.compiler.target);
  return diffs;
}

/**
 * Named diagnostics for which execution-time identity dimension disagrees
 * with the environment a separate, earlier preflight resolution verified
 * (#180 P0 2 / PR #207 review): two independent resolutions of a mutable
 * image tag can disagree if the tag was repointed in between. `initdbArgs`
 * is intentionally absent - it is a fixed declarative constant, never
 * independently re-resolved at execution time, so it cannot be part of this
 * TOCTOU surface (see `HistoricalPostgresTrialExecutionEnvironment`).
 */
function diffExecutionEnvironment(frozen: HistoricalPostgresEnvironmentFingerprint, actual: HistoricalPostgresTrialExecutionEnvironment): string[] {
  const diffs: string[] = [];
  const compareField = (label: string, expected: unknown, got: unknown) => {
    if (!fieldEqual(got, expected)) {
      diffs.push(`executionEnvironment.${label}: preflight-verified ${stableJson(canonicalize(expected))}, actual execution used ${stableJson(canonicalize(got))}`);
    }
  };
  compareField("buildMode", frozen.buildMode, actual.buildMode);
  compareField("buildProfileVersion", frozen.buildProfileVersion, actual.buildProfileVersion);
  compareField("configureArgs", frozen.configureArgs, actual.configureArgs);
  const buildEnvKeys = new Set([...Object.keys(frozen.buildEnv), ...Object.keys(actual.buildEnv)]);
  for (const key of [...buildEnvKeys].sort()) {
    compareField(`buildEnv.${key}`, frozen.buildEnv[key], actual.buildEnv[key]);
  }
  compareField("builderImage.reference", frozen.builderImage.reference, actual.builderImage?.reference ?? null);
  compareField("builderImage.id", frozen.builderImage.id, actual.builderImage?.id ?? null);
  compareField("runtimeImage.reference", frozen.runtimeImage.reference, actual.runtimeImage?.reference ?? null);
  compareField("runtimeImage.id", frozen.runtimeImage.id, actual.runtimeImage?.id ?? null);
  compareField("compiler.command", frozen.compiler.command, actual.compiler.command);
  compareField("compiler.version", frozen.compiler.version, actual.compiler.version);
  compareField("compiler.target", frozen.compiler.target, actual.compiler.target);
  return diffs;
}

/**
 * The required #180 state transition: load/validate the frozen manifest,
 * resolve the current actual environment and compare, materialize the
 * selected task and compare it against its frozen corpus entry. Every
 * failure path returns `{ ok: false, failedDimension, diagnostics }` -
 * never throws for an expected integrity condition - so a caller can decide
 * to abort without a try/catch around a specific exception type per
 * dimension. Genuinely unexpected errors (e.g. materialization I/O failure)
 * are left to propagate; `runHistoricalPostgresPilotTrial()` below is what
 * catches those and normalizes them to a pilot-level `infrastructure_error`.
 */
export async function verifyHistoricalPostgresFrozenTrialInput(input: {
  corpusManifest: HistoricalPostgresCorpusManifest;
  expectedCorpusId?: string;
  expectedCorpusHash?: string;
  taskSpec: HistoricalPostgresTaskSpec;
  materializeRoot: string;
  runCommand?: RunCommand;
  ambientEnv?: NodeJS.ProcessEnv;
}): Promise<HistoricalPostgresPreflightResult> {
  const expectedCorpusId = input.expectedCorpusId ?? HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_ID;
  const expectedCorpusHash = input.expectedCorpusHash ?? HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_HASH;
  const manifest = input.corpusManifest;

  try {
    validateHistoricalPostgresCorpusManifest(manifest);
  } catch (error) {
    if (error instanceof HistoricalPostgresCorpusIntegrityError) {
      return { ok: false, failedDimension: "manifestIntegrity", diagnostics: [error.message] };
    }
    throw error;
  }

  if (manifest.corpusId !== expectedCorpusId) {
    return {
      ok: false,
      failedDimension: "corpusId",
      diagnostics: [`corpus manifest corpusId "${manifest.corpusId}" does not match the expected pinned corpusId "${expectedCorpusId}"`]
    };
  }
  if (manifest.corpusHash !== expectedCorpusHash) {
    return {
      ok: false,
      failedDimension: "corpusHash",
      diagnostics: [`corpus manifest corpusHash "${manifest.corpusHash}" does not match the expected pinned corpusHash "${expectedCorpusHash}"`]
    };
  }

  const environmentFingerprint = await resolveHistoricalPostgresEnvironmentFingerprint({
    build: input.taskSpec.build,
    runCommand: input.runCommand,
    ambientEnv: input.ambientEnv
  });
  const environmentDiffs = diffEnvironmentFingerprint(manifest.environmentFingerprint, environmentFingerprint);
  if (environmentDiffs.length > 0) {
    return { ok: false, failedDimension: "environmentFingerprint", diagnostics: environmentDiffs, environmentFingerprint };
  }

  const taskLayout = await materializeHistoricalPostgresTask(input.taskSpec, input.materializeRoot);
  const frozenTaskEntry = manifest.tasks.find((task) => task.taskId === taskLayout.taskManifest.taskId);
  if (!frozenTaskEntry) {
    return {
      ok: false,
      failedDimension: "taskEntry",
      diagnostics: [`no frozen corpus entry exists for taskId "${taskLayout.taskManifest.taskId}"`],
      environmentFingerprint
    };
  }
  const taskEntry = buildHistoricalPostgresCorpusTaskEntry(taskLayout, [...frozenTaskEntry.provenanceReferences]);
  const taskDiffs = diffCorpusTaskEntry(frozenTaskEntry, taskEntry);
  if (taskDiffs.length > 0) {
    return { ok: false, failedDimension: "taskEntry", diagnostics: taskDiffs, environmentFingerprint };
  }

  return { ok: true, corpusManifest: manifest, taskEntry, frozenTaskEntry, environmentFingerprint };
}

/** The explicit, whitelisted evidence shape persisted for a preflight attempt - see the module-level note on why this is never the raw `HistoricalPostgresPreflightResult`. */
export type HistoricalPostgresPreflightEvidence =
  | {
      ok: true;
      corpusId: string;
      corpusHash: string;
      taskId: string;
      partition: HistoricalPostgresCorpusPartition;
      taskEntry: HistoricalPostgresCorpusTaskEntry;
      environmentFingerprint: HistoricalPostgresEnvironmentFingerprint;
    }
  | {
      ok: false;
      failedDimension: HistoricalPostgresPreflightFailureDimension;
      diagnostics: string[];
      environmentFingerprint?: HistoricalPostgresEnvironmentFingerprint;
    };

export function sanitizeHistoricalPostgresPreflightEvidence(result: HistoricalPostgresPreflightResult): HistoricalPostgresPreflightEvidence {
  if (result.ok) {
    return {
      ok: true,
      corpusId: result.corpusManifest.corpusId,
      corpusHash: result.corpusManifest.corpusHash,
      taskId: result.taskEntry.taskId,
      partition: result.taskEntry.partition,
      taskEntry: result.taskEntry,
      environmentFingerprint: result.environmentFingerprint
    };
  }
  return {
    ok: false,
    failedDimension: result.failedDimension,
    diagnostics: [...result.diagnostics],
    environmentFingerprint: result.environmentFingerprint
  };
}

export type HistoricalPostgresPilotPreflightSummary =
  | { status: "passed" }
  | { status: "failed"; failedDimension: HistoricalPostgresPreflightFailureDimension; diagnostics: string[] }
  /** Preflight itself could not complete (docker unavailable, image-inspect/compiler-probe/materialization I/O failure) - not a proven contract mismatch. */
  | { status: "error"; diagnostics: string[] };

/**
 * Whether the environment a completed trial *actually executed under*
 * matches the one preflight verified beforehand (#180 P0 2). `"unverified"`
 * means no comparison was possible (preflight failed, so no trial ran; or
 * the trial itself never obtained a session to report execution identity
 * from).
 */
export type HistoricalPostgresExecutionBinding = { status: "unverified" } | { status: "verified" } | { status: "mismatched"; diagnostics: string[] };

/** Which kind of agent profile produced this pilot attempt. A stub is real, useful harness evidence, but never enters the Historical PostgreSQL capability dataset - see `datasetEligible`. */
export type HistoricalPostgresPilotProfileKind = "smoke_stub" | "agent";

/** The normalized pilot-level outcome (#180 P1 4): every attempt lands in exactly one of these, and neither `integrity_error` nor `infrastructure_error` is ever an agent `miss`. */
export type HistoricalPostgresPilotStatus = "completed" | "unscored" | "blocked" | "integrity_error" | "infrastructure_error";

export type HistoricalPostgresPilotResult = {
  pilotId: string;
  profileKind: HistoricalPostgresPilotProfileKind;
  corpusId: string;
  corpusHash: string;
  taskId: string;
  partition: HistoricalPostgresCorpusPartition | null;
  preflight: HistoricalPostgresPilotPreflightSummary;
  frozenEnvironmentFingerprint: HistoricalPostgresEnvironmentFingerprint;
  environmentFingerprint?: HistoricalPostgresEnvironmentFingerprint;
  executionEnvironment?: HistoricalPostgresTrialExecutionEnvironment;
  executionBinding: HistoricalPostgresExecutionBinding;
  status: HistoricalPostgresPilotStatus;
  /** Never more than 1: `runHistoricalPostgresTrial()` is called at most once, and only after preflight passes. */
  agentRunCount: 0 | 1;
  /** False whenever `status` is not a genuinely bound, non-stub `"completed"` result - see `HistoricalPostgresPilotStatus`/`profileKind`. */
  datasetEligible: boolean;
  /** The real grade status only when `datasetEligible` is true; `"N/A"` otherwise - a caller must never read `trial.grade` directly to decide "was this scored". */
  officialScoredResult: HistoricalPostgresGradeStatus | "N/A";
  /** Present iff preflight passed - a failed preflight never reaches `runHistoricalPostgresTrial()`. Rich, unsanitized detail for in-memory/test use only - see `sanitizeHistoricalPostgresPilotEvidence()` for what actually gets persisted. */
  trial?: HistoricalPostgresTrial;
  startedAt: string;
  finishedAt: string;
  diagnostics: string[];
};

/** The explicit, whitelisted evidence shape persisted for a pilot attempt - see the module-level note on why this is never the raw `HistoricalPostgresPilotResult` (whose `trial.grade` can embed grader-private pinned revisions). */
export type HistoricalPostgresPilotEvidence = {
  pilotId: string;
  profileKind: HistoricalPostgresPilotProfileKind;
  corpusId: string;
  corpusHash: string;
  taskId: string;
  partition: HistoricalPostgresCorpusPartition | null;
  preflight: HistoricalPostgresPilotPreflightSummary;
  frozenEnvironmentFingerprint: HistoricalPostgresEnvironmentFingerprint;
  environmentFingerprint?: HistoricalPostgresEnvironmentFingerprint;
  executionEnvironment?: HistoricalPostgresTrialExecutionEnvironment;
  executionBinding: HistoricalPostgresExecutionBinding;
  status: HistoricalPostgresPilotStatus;
  agentRunCount: 0 | 1;
  datasetEligible: boolean;
  officialScoredResult: HistoricalPostgresGradeStatus | "N/A";
  scoredEligible?: boolean;
  grade?: { status: HistoricalPostgresGradeStatus; diagnostics: string[]; gradedAt: string };
  agent?: { ok: boolean; exitCode: number | null; timedOut: boolean; durationMs: number };
  workspaceDir?: string;
  artifacts: string[];
  startedAt: string;
  finishedAt: string;
  diagnostics: string[];
};

/** Only the fields safe to disclose from a session's raw agent record (`Record<string, unknown>`) - never stdout/stderr/cwd/command. */
function sanitizeAgentSummary(agent: Record<string, unknown> | undefined): HistoricalPostgresPilotEvidence["agent"] {
  if (!agent || typeof agent.ok !== "boolean") return undefined;
  return {
    ok: agent.ok,
    exitCode: typeof agent.exitCode === "number" ? agent.exitCode : null,
    timedOut: Boolean(agent.timedOut),
    durationMs: typeof agent.durationMs === "number" ? agent.durationMs : 0
  };
}

export function sanitizeHistoricalPostgresPilotEvidence(result: HistoricalPostgresPilotResult): HistoricalPostgresPilotEvidence {
  return {
    pilotId: result.pilotId,
    profileKind: result.profileKind,
    corpusId: result.corpusId,
    corpusHash: result.corpusHash,
    taskId: result.taskId,
    partition: result.partition,
    preflight: result.preflight,
    frozenEnvironmentFingerprint: result.frozenEnvironmentFingerprint,
    environmentFingerprint: result.environmentFingerprint,
    executionEnvironment: result.executionEnvironment,
    executionBinding: result.executionBinding,
    status: result.status,
    agentRunCount: result.agentRunCount,
    datasetEligible: result.datasetEligible,
    officialScoredResult: result.officialScoredResult,
    scoredEligible: result.trial?.scoredEligible,
    grade: result.trial?.grade
      ? { status: result.trial.grade.status, diagnostics: [...result.trial.grade.diagnostics], gradedAt: result.trial.grade.gradedAt }
      : undefined,
    agent: sanitizeAgentSummary(result.trial?.agent),
    workspaceDir: result.trial?.workspaceDir,
    artifacts: result.trial?.artifacts ?? [],
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    diagnostics: [...result.diagnostics]
  };
}

/**
 * The pilot-level outcome classifier (#180 P0 2 / P0 3 / P1 4, PR #207
 * review): a completed, scored-eligible trial is only ever an *official*
 * scored result when its execution is bound to the preflight-verified
 * environment *and* it came from a real agent profile, never a smoke stub.
 */
function classifyPilotOutcome(input: {
  trial: HistoricalPostgresTrial;
  executionBinding: HistoricalPostgresExecutionBinding;
  profileKind: HistoricalPostgresPilotProfileKind;
}): { status: HistoricalPostgresPilotStatus; datasetEligible: boolean; officialScoredResult: HistoricalPostgresGradeStatus | "N/A" } {
  const { trial, executionBinding, profileKind } = input;
  if (trial.status === "integrity_error" || trial.status === "infrastructure_error" || trial.status === "blocked" || trial.status === "unscored") {
    return { status: trial.status, datasetEligible: false, officialScoredResult: "N/A" };
  }
  // trial.status === "completed"
  if (executionBinding.status === "mismatched") {
    return { status: "integrity_error", datasetEligible: false, officialScoredResult: "N/A" };
  }
  if (profileKind === "smoke_stub") {
    return { status: "completed", datasetEligible: false, officialScoredResult: "N/A" };
  }
  return { status: "completed", datasetEligible: true, officialScoredResult: trial.grade!.status };
}

/**
 * The thin #180 pilot wrapper/coordinator: `verify frozen input` then
 * `runHistoricalPostgresTrial()` - nothing else. Never modifies
 * `runHistoricalPostgresTrial()` itself, and contains no per-taskId branch;
 * the same wrapper serves postgres-historical-001/002/003 identically,
 * driven purely by whichever `taskSpec` the caller supplies.
 *
 * `pilotId` is resolved *before* the artifact root is created, and every
 * attempt's evidence is nested under its own `<artifactDir>/<pilotId>/`
 * subdirectory (#180 P1 5) - two attempts against the same parent
 * `artifactDir` never overwrite each other's evidence, including two
 * attempts that both fail before a `pilotId` was explicitly supplied.
 */
export async function runHistoricalPostgresPilotTrial(input: {
  corpusManifest: HistoricalPostgresCorpusManifest;
  expectedCorpusId?: string;
  expectedCorpusHash?: string;
  taskSpec: HistoricalPostgresTaskSpec;
  agent: PostgresResearchAgentSpec;
  artifactDir: string;
  /** Defaults to `"agent"` - the real, dataset-eligible profile. Set `"smoke_stub"` for a deterministic harness-validation agent that must never enter the capability dataset. */
  profileKind?: HistoricalPostgresPilotProfileKind;
  session?: PostgresResearchSessionOptions;
  runSession?: typeof runAgentInPostgresResearchEnvironment;
  runCommand?: RunCommand;
  ambientEnv?: NodeJS.ProcessEnv;
  pilotId?: string;
}): Promise<HistoricalPostgresPilotResult> {
  const startedAt = nowIso();
  const profileKind = input.profileKind ?? "agent";
  const pilotId = input.pilotId ?? `historical-pg-180-${input.taskSpec.taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const pilotRoot = join(input.artifactDir, pilotId);
  const frozenEnvironmentFingerprint = input.corpusManifest.environmentFingerprint;

  const writeEvidenceBestEffort = async (result: HistoricalPostgresPilotResult) => {
    try {
      await writeFile(join(pilotRoot, "pilot-result.json"), `${JSON.stringify(sanitizeHistoricalPostgresPilotEvidence(result), null, 2)}\n`);
    } catch {
      // Best effort only (#180 P1 4): the in-memory result returned to the
      // caller is correct regardless of whether this write succeeds.
    }
  };

  let preflight: HistoricalPostgresPreflightResult;
  try {
    await mkdir(pilotRoot, { recursive: true });
    preflight = await verifyHistoricalPostgresFrozenTrialInput({
      corpusManifest: input.corpusManifest,
      expectedCorpusId: input.expectedCorpusId,
      expectedCorpusHash: input.expectedCorpusHash,
      taskSpec: input.taskSpec,
      materializeRoot: join(pilotRoot, "preflight-task-bundle"),
      runCommand: input.runCommand,
      ambientEnv: input.ambientEnv
    });
  } catch (error) {
    // #180 P1 4: an infrastructure failure *during* preflight (docker
    // unavailable, image-inspect/compiler-probe/materialization I/O failure)
    // must still normalize to a stable pilot-level status with evidence
    // written, not an uncaught throw that leaves no pilot-result.json at all.
    const result: HistoricalPostgresPilotResult = {
      pilotId,
      profileKind,
      corpusId: input.corpusManifest.corpusId,
      corpusHash: input.corpusManifest.corpusHash,
      taskId: input.taskSpec.taskId,
      partition: null,
      preflight: { status: "error", diagnostics: [(error as Error).message] },
      frozenEnvironmentFingerprint,
      executionBinding: { status: "unverified" },
      status: "infrastructure_error",
      agentRunCount: 0,
      datasetEligible: false,
      officialScoredResult: "N/A",
      startedAt,
      finishedAt: nowIso(),
      diagnostics: [`Preflight could not complete: ${(error as Error).message}`]
    };
    await writeEvidenceBestEffort(result);
    return result;
  }

  try {
    await writeFile(join(pilotRoot, "preflight-result.json"), `${JSON.stringify(sanitizeHistoricalPostgresPreflightEvidence(preflight), null, 2)}\n`);
  } catch {
    // Best effort only, same as writeEvidenceBestEffort above.
  }

  if (!preflight.ok) {
    const result: HistoricalPostgresPilotResult = {
      pilotId,
      profileKind,
      corpusId: input.corpusManifest.corpusId,
      corpusHash: input.corpusManifest.corpusHash,
      taskId: input.taskSpec.taskId,
      partition: null,
      preflight: { status: "failed", failedDimension: preflight.failedDimension, diagnostics: preflight.diagnostics },
      frozenEnvironmentFingerprint,
      environmentFingerprint: preflight.environmentFingerprint,
      executionBinding: { status: "unverified" },
      status: "integrity_error",
      agentRunCount: 0,
      datasetEligible: false,
      officialScoredResult: "N/A",
      startedAt,
      finishedAt: nowIso(),
      diagnostics: [`Preflight failed on dimension "${preflight.failedDimension}" - the agent was never started.`, ...preflight.diagnostics]
    };
    await writeEvidenceBestEffort(result);
    return result;
  }

  const runSession = input.runSession ?? runAgentInPostgresResearchEnvironment;
  const trial = await runHistoricalPostgresTrial({
    task: input.taskSpec,
    agent: input.agent,
    artifactDir: join(pilotRoot, "trial"),
    session: input.session,
    runSession
  });

  const executionEnvironment = trial.executionEnvironment;
  let executionBinding: HistoricalPostgresExecutionBinding = { status: "unverified" };
  if (executionEnvironment) {
    const bindingDiffs = diffExecutionEnvironment(preflight.environmentFingerprint, executionEnvironment);
    executionBinding = bindingDiffs.length > 0 ? { status: "mismatched", diagnostics: bindingDiffs } : { status: "verified" };
  }

  const { status, datasetEligible, officialScoredResult } = classifyPilotOutcome({ trial, executionBinding, profileKind });

  const result: HistoricalPostgresPilotResult = {
    pilotId,
    profileKind,
    corpusId: input.corpusManifest.corpusId,
    corpusHash: input.corpusManifest.corpusHash,
    taskId: input.taskSpec.taskId,
    partition: preflight.frozenTaskEntry.partition,
    preflight: { status: "passed" },
    frozenEnvironmentFingerprint,
    environmentFingerprint: preflight.environmentFingerprint,
    executionEnvironment,
    executionBinding,
    status,
    agentRunCount: 1,
    datasetEligible,
    officialScoredResult,
    trial,
    startedAt,
    finishedAt: nowIso(),
    diagnostics: [
      ...(executionBinding.status === "mismatched"
        ? ["Execution-time environment did not match the preflight-verified environment - no official scored result.", ...executionBinding.diagnostics]
        : []),
      ...(profileKind === "smoke_stub" && status === "completed"
        ? ["profileKind=smoke_stub: not eligible for the Historical PostgreSQL capability dataset."]
        : []),
      ...trial.diagnostics
    ]
  };
  await writeEvidenceBestEffort(result);
  return result;
}
