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
  type HistoricalPostgresTaskLayout,
  type HistoricalPostgresTaskSpec,
  type HistoricalPostgresTrial
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
 *
 * Deliberately not a generic `EvalProvider`/`ManagedEnvironment` abstraction:
 * this is PostgreSQL-Corpus-v0-specific glue over the existing
 * `validateHistoricalPostgresCorpusManifest()` / `resolveHistoricalPostgresEnvironmentFingerprint()` /
 * `materializeHistoricalPostgresTask()` / `buildHistoricalPostgresCorpusTaskEntry()` /
 * `runHistoricalPostgresTrial()` - none of which this file reimplements.
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

export type HistoricalPostgresPreflightResult =
  | {
      ok: true;
      corpusManifest: HistoricalPostgresCorpusManifest;
      taskLayout: HistoricalPostgresTaskLayout;
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
 * The required #180 state transition: load/validate the frozen manifest,
 * resolve the current actual environment and compare, materialize the
 * selected task and compare it against its frozen corpus entry. Every
 * failure path returns `{ ok: false, failedDimension, diagnostics }` -
 * never throws for an expected integrity condition - so a caller can decide
 * to abort without a try/catch around a specific exception type per
 * dimension. Genuinely unexpected errors (e.g. materialization I/O failure)
 * are left to propagate, same as `materializeHistoricalPostgresTask()` itself.
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

  return { ok: true, corpusManifest: manifest, taskLayout, taskEntry, frozenTaskEntry, environmentFingerprint };
}

export type HistoricalPostgresPilotPreflightSummary =
  | { status: "passed" }
  | { status: "failed"; failedDimension: HistoricalPostgresPreflightFailureDimension; diagnostics: string[] };

export type HistoricalPostgresPilotResult = {
  pilotId: string;
  corpusId: string;
  corpusHash: string;
  taskId: string;
  partition: HistoricalPostgresCorpusPartition | null;
  preflight: HistoricalPostgresPilotPreflightSummary;
  frozenEnvironmentFingerprint: HistoricalPostgresEnvironmentFingerprint;
  environmentFingerprint?: HistoricalPostgresEnvironmentFingerprint;
  /** Never more than 1: `runHistoricalPostgresTrial()` is called at most once, and only after preflight passes. */
  agentRunCount: 0 | 1;
  /** Present iff preflight passed - a failed preflight never reaches `runHistoricalPostgresTrial()`. */
  trial?: HistoricalPostgresTrial;
  startedAt: string;
  finishedAt: string;
  diagnostics: string[];
};

/**
 * The thin #180 pilot wrapper/coordinator: `verify frozen input` then
 * `runHistoricalPostgresTrial()` - nothing else. Never modifies
 * `runHistoricalPostgresTrial()` itself, and contains no per-taskId branch;
 * the same wrapper serves postgres-historical-001/002/003 identically,
 * driven purely by whichever `taskSpec` the caller supplies.
 */
export async function runHistoricalPostgresPilotTrial(input: {
  corpusManifest: HistoricalPostgresCorpusManifest;
  expectedCorpusId?: string;
  expectedCorpusHash?: string;
  taskSpec: HistoricalPostgresTaskSpec;
  agent: PostgresResearchAgentSpec;
  artifactDir: string;
  session?: PostgresResearchSessionOptions;
  runSession?: typeof runAgentInPostgresResearchEnvironment;
  runCommand?: RunCommand;
  ambientEnv?: NodeJS.ProcessEnv;
  pilotId?: string;
}): Promise<HistoricalPostgresPilotResult> {
  const startedAt = nowIso();
  const pilotId = input.pilotId ?? `historical-pg-180-${input.taskSpec.taskId}-${Date.now()}`;
  await mkdir(input.artifactDir, { recursive: true });

  const preflight = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: input.corpusManifest,
    expectedCorpusId: input.expectedCorpusId,
    expectedCorpusHash: input.expectedCorpusHash,
    taskSpec: input.taskSpec,
    materializeRoot: join(input.artifactDir, "preflight-task-bundle"),
    runCommand: input.runCommand,
    ambientEnv: input.ambientEnv
  });
  await writeFile(join(input.artifactDir, "preflight-result.json"), `${JSON.stringify(preflight, null, 2)}\n`);

  if (!preflight.ok) {
    const result: HistoricalPostgresPilotResult = {
      pilotId,
      corpusId: input.corpusManifest.corpusId,
      corpusHash: input.corpusManifest.corpusHash,
      taskId: input.taskSpec.taskId,
      partition: null,
      preflight: { status: "failed", failedDimension: preflight.failedDimension, diagnostics: preflight.diagnostics },
      frozenEnvironmentFingerprint: input.corpusManifest.environmentFingerprint,
      environmentFingerprint: preflight.environmentFingerprint,
      agentRunCount: 0,
      startedAt,
      finishedAt: nowIso(),
      diagnostics: [`Preflight failed on dimension "${preflight.failedDimension}" - the agent was never started.`, ...preflight.diagnostics]
    };
    await writeFile(join(input.artifactDir, "pilot-result.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  const runSession = input.runSession ?? runAgentInPostgresResearchEnvironment;
  const trial = await runHistoricalPostgresTrial({
    task: input.taskSpec,
    agent: input.agent,
    artifactDir: join(input.artifactDir, "trial"),
    session: input.session,
    runSession
  });

  const result: HistoricalPostgresPilotResult = {
    pilotId,
    corpusId: input.corpusManifest.corpusId,
    corpusHash: input.corpusManifest.corpusHash,
    taskId: input.taskSpec.taskId,
    partition: preflight.frozenTaskEntry.partition,
    preflight: { status: "passed" },
    frozenEnvironmentFingerprint: input.corpusManifest.environmentFingerprint,
    environmentFingerprint: preflight.environmentFingerprint,
    agentRunCount: 1,
    trial,
    startedAt,
    finishedAt: nowIso(),
    diagnostics: trial.diagnostics
  };
  await writeFile(join(input.artifactDir, "pilot-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
