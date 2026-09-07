import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../utils.js";
import { canonicalize, stableJson, type HistoricalPostgresGradeStatus, type HistoricalPostgresGradingPath, type HistoricalPostgresTaskSpec } from "./historical-task.js";
import type { HistoricalPostgresCorpusManifest, HistoricalPostgresCorpusPartition } from "./historical-corpus.js";
import {
  runHistoricalPostgresPilotTrial,
  sanitizeHistoricalPostgresPilotEvidence,
  type HistoricalPostgresPilotEvidence,
  type HistoricalPostgresPilotProfileKind,
  type HistoricalPostgresPilotResult,
  type HistoricalPostgresPilotStatus
} from "./historical-postgres-preflight.js";

/**
 * Issue #198: the TrialSet Runner MVP / implementation child of #180.
 *
 * This module is deliberately an orchestration/reporting layer over the
 * authoritative single-trial boundary PR #207 introduced,
 * `runHistoricalPostgresPilotTrial()` - it owns none of corpus integrity
 * validation, environment fingerprint validation, task-entry validation,
 * execution binding, dataset eligibility, official score eligibility,
 * Historical PG grading, PostgreSQL lifecycle, or restricted-egress scoring
 * policy. Every real cell this module drives calls that function exactly
 * once and trusts its `datasetEligible`/`officialScoredResult` verdict
 * outright - this file never recomputes eligibility from `trial.status`,
 * `grade.status`, network mode, or `executionBinding` directly.
 */

export const HISTORICAL_PG_TRIALSET_RUNNER_VERSION = "historical-pg-evals-v1";

export const HISTORICAL_PG_TRIALSET_PROFILE_PATCH_FILENAME = "cordis.patch.yml";

/** DSH's own default upstream - see server/postgres/research-session.ts's DEFAULT_RESTRICTED_EGRESS_ENV_VAR docstring. */
export const HISTORICAL_PG_TRIALSET_DEFAULT_UPSTREAM_URL = "https://api.deepseek.com";

export const HISTORICAL_PG_TRIALSET_DEFAULT_AGENT_IMAGE = "honeyrail-postgres-research-agent-dsh:latest";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type TrialSetProfileSpec = {
  profileId: string;
  /** Administrative provenance only - never part of the experiment identity fingerprint (content is what matters). */
  sourcePath: string;
  content: string;
  profileHash: string;
};

export function computeProfileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function loadTrialSetProfile(profileId: string, sourcePath: string): Promise<TrialSetProfileSpec> {
  const content = await readFile(sourcePath, "utf8");
  return { profileId, sourcePath, content, profileHash: computeProfileHash(content) };
}

export function assertUniqueProfileIds(profiles: readonly { profileId: string }[]): void {
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.profileId)) {
      throw new Error(`Duplicate profile id "${profile.profileId}" - each --profiles entry must use a distinct id.`);
    }
    seen.add(profile.profileId);
  }
}

// ---------------------------------------------------------------------------
// Task selection
// ---------------------------------------------------------------------------

export type TrialSetTaskSelection = { taskId: string; partition: HistoricalPostgresCorpusPartition };

/** Resolves and validates `--tasks` entries against the frozen corpus manifest - unknown taskId is rejected clearly, never silently skipped. */
export function resolveTrialSetTaskSelection(corpusManifest: HistoricalPostgresCorpusManifest, taskIds: readonly string[]): TrialSetTaskSelection[] {
  const byId = new Map(corpusManifest.tasks.map((task) => [task.taskId, task]));
  return taskIds.map((taskId) => {
    const entry = byId.get(taskId);
    if (!entry) {
      throw new Error(
        `Unknown task id "${taskId}" - not present in corpus "${corpusManifest.corpusId}" (available: ${[...byId.keys()].sort().join(", ")}).`
      );
    }
    return { taskId: entry.taskId, partition: entry.partition };
  });
}

// ---------------------------------------------------------------------------
// Experiment identity / manifest
// ---------------------------------------------------------------------------

/** Exactly the fields that define "the same experiment" for resume purposes. Deliberately excludes createdAt/repositoryCommit/sourcePath - administrative provenance that legitimately differs across a resumed run without changing what is being measured. */
export type TrialSetExperimentIdentityInput = {
  corpusId: string;
  corpusHash: string;
  tasks: TrialSetTaskSelection[];
  profiles: Array<{ profileId: string; profileHash: string }>;
  trialsPerCell: number;
  agentImage: string;
  isolationPolicy: { restrictedEgress: boolean; upstreamUrl?: string; network?: string };
  runnerVersion: string;
};

function normalizedIdentityInput(input: TrialSetExperimentIdentityInput): TrialSetExperimentIdentityInput {
  return {
    ...input,
    tasks: [...input.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    profiles: [...input.profiles].sort((a, b) => a.profileId.localeCompare(b.profileId))
  };
}

/** Content-addressed: identical inputs always produce the identical experimentId, and any identity-relevant change (profile content, corpus hash, budget/model/trial definition) changes it. */
export function computeExperimentId(input: TrialSetExperimentIdentityInput): string {
  return createHash("sha256").update(stableJson(canonicalize(normalizedIdentityInput(input)))).digest("hex");
}

export type TrialSetExperimentManifest = TrialSetExperimentIdentityInput & {
  schemaVersion: 1;
  experimentId: string;
  createdAt: string;
  repositoryCommit: string;
  profileSources: Array<{ profileId: string; profileHash: string; sourcePath: string }>;
};

export function buildExperimentManifest(input: {
  identity: TrialSetExperimentIdentityInput;
  repositoryCommit: string;
  profiles: readonly TrialSetProfileSpec[];
  createdAt?: string;
}): TrialSetExperimentManifest {
  return {
    ...input.identity,
    schemaVersion: 1,
    experimentId: computeExperimentId(input.identity),
    createdAt: input.createdAt ?? nowIso(),
    repositoryCommit: input.repositoryCommit,
    profileSources: input.profiles.map((profile) => ({ profileId: profile.profileId, profileHash: profile.profileHash, sourcePath: profile.sourcePath }))
  };
}

export class TrialSetExperimentIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrialSetExperimentIdentityMismatchError";
  }
}

/** Fails closed rather than silently resuming into incompatible state - see historical-pg-trialset's module docstring and #198's required resume semantics. */
export function assertCompatibleExperimentManifest(existing: TrialSetExperimentManifest, current: TrialSetExperimentManifest): void {
  if (existing.experimentId !== current.experimentId) {
    throw new TrialSetExperimentIdentityMismatchError(
      `The existing experiment at this --out directory is "${existing.experimentId}" (created ${existing.createdAt}), but the current ` +
        `configuration resolves to a different experiment "${current.experimentId}". Refusing to resume with mismatched identity - ` +
        "a profile, corpus, task selection, trial count, agent image, or isolation policy changed. Use a different --out directory, " +
        "or restore the exact original inputs."
    );
  }
}

// ---------------------------------------------------------------------------
// Matrix planning
// ---------------------------------------------------------------------------

export type TrialSetCellIdentity = {
  cellId: string;
  taskId: string;
  partition: HistoricalPostgresCorpusPartition;
  profileId: string;
  profileHash: string;
  trialIndex: number;
};

function cellId(taskId: string, profileId: string, trialIndex: number): string {
  return `${taskId}__${profileId}__trial-${trialIndex}`;
}

/**
 * Deterministic `task x profile x trial` expansion. Tasks and profiles are
 * normalized to id order internally, so the resulting cell list (and every
 * cellId in it) is stable regardless of the order `--tasks`/`--profiles` were
 * given on the command line.
 */
export function planTrialSetCells(input: {
  tasks: readonly TrialSetTaskSelection[];
  profiles: readonly { profileId: string; profileHash: string }[];
  trialsPerCell: number;
}): TrialSetCellIdentity[] {
  if (!Number.isInteger(input.trialsPerCell) || input.trialsPerCell < 1) {
    throw new Error(`trialsPerCell must be a positive integer, got ${input.trialsPerCell}`);
  }
  const tasks = [...input.tasks].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const profiles = [...input.profiles].sort((a, b) => a.profileId.localeCompare(b.profileId));
  const cells: TrialSetCellIdentity[] = [];
  for (const task of tasks) {
    for (const profile of profiles) {
      for (let trialIndex = 1; trialIndex <= input.trialsPerCell; trialIndex += 1) {
        cells.push({
          cellId: cellId(task.taskId, profile.profileId, trialIndex),
          taskId: task.taskId,
          partition: task.partition,
          profileId: profile.profileId,
          profileHash: profile.profileHash,
          trialIndex
        });
      }
    }
  }
  return cells;
}

/**
 * Default `--tasks` selection when the operator gave none: every corpus task
 * normally, but only TRAIN-partition tasks under `--smoke` - so a smoke run
 * with no explicit `--tasks` cannot accidentally exercise a FRONTIER task
 * (see #198's TRAIN/FRONTIER discipline). An operator who explicitly passes
 * `--tasks postgres-historical-002` is unaffected either way - this only
 * fills in the *default*, and is not a hardcoded permanent FRONTIER ban.
 */
export function defaultTaskIdSelection(corpusManifest: HistoricalPostgresCorpusManifest, options: { smoke: boolean }): string[] {
  const tasks = options.smoke ? corpusManifest.tasks.filter((task) => task.partition === "TRAIN") : corpusManifest.tasks;
  return tasks.map((task) => task.taskId);
}

/** Cells already present in state (any status - including a failed/errored one) are never re-planned as pending; see #198's no-automatic-retry resume rule. */
export function selectPendingCells(cells: readonly TrialSetCellIdentity[], state: TrialSetState): TrialSetCellIdentity[] {
  return cells.filter((cell) => !state.cells[cell.cellId]);
}

// ---------------------------------------------------------------------------
// Per-cell record (adapts sanitized pilot evidence - never a parallel truth model)
// ---------------------------------------------------------------------------

export type TrialSetCellRecord = {
  experimentId: string;
  cellId: string;
  taskId: string;
  partition: HistoricalPostgresCorpusPartition;
  profileId: string;
  profileHash: string;
  trialIndex: number;

  pilotId: string;
  profileKind: HistoricalPostgresPilotProfileKind;
  artifactDir: string;

  pilotStatus: HistoricalPostgresPilotStatus;
  /** Authoritative denominator membership - see buildTrialSetAggregateReport(). Never recomputed from pilotStatus/gradeStatus/executionBindingOverall. */
  datasetEligible: boolean;
  /** Authoritative outcome when datasetEligible - "N/A" otherwise. */
  officialScoredResult: HistoricalPostgresGradeStatus | "N/A";

  executionBindingOverall: HistoricalPostgresPilotEvidence["executionBinding"]["overall"]["status"];
  scoredEligible?: boolean;
  gradingPath?: HistoricalPostgresGradingPath;
  gradeStatus?: HistoricalPostgresGradeStatus;

  agentOk?: boolean;
  agentExitCode?: number | null;
  agentTimedOut?: boolean;
  wallTimeMs: number;
  startedAt: string;
  finishedAt: string;

  diagnostics: string[];
};

export function buildTrialSetCellRecord(input: {
  experimentId: string;
  identity: TrialSetCellIdentity;
  artifactDir: string;
  pilot: HistoricalPostgresPilotResult;
}): TrialSetCellRecord {
  const evidence = sanitizeHistoricalPostgresPilotEvidence(input.pilot);
  const wallTimeMs = Date.parse(evidence.finishedAt) - Date.parse(evidence.startedAt);
  return {
    experimentId: input.experimentId,
    cellId: input.identity.cellId,
    taskId: input.identity.taskId,
    partition: input.identity.partition,
    profileId: input.identity.profileId,
    profileHash: input.identity.profileHash,
    trialIndex: input.identity.trialIndex,

    pilotId: evidence.pilotId,
    profileKind: evidence.profileKind,
    artifactDir: input.artifactDir,

    pilotStatus: evidence.status,
    datasetEligible: evidence.datasetEligible,
    officialScoredResult: evidence.officialScoredResult,

    executionBindingOverall: evidence.executionBinding.overall.status,
    scoredEligible: evidence.scoredEligible,
    gradingPath: evidence.grade?.gradingPath,
    gradeStatus: evidence.grade?.status,

    agentOk: evidence.agent?.ok,
    agentExitCode: evidence.agent?.exitCode,
    agentTimedOut: evidence.agent?.timedOut,
    wallTimeMs: Number.isFinite(wallTimeMs) ? wallTimeMs : 0,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,

    diagnostics: [...evidence.diagnostics]
  };
}

// ---------------------------------------------------------------------------
// DSH cell execution - reuses runHistoricalPostgresPilotTrial() exactly once per cell.
// ---------------------------------------------------------------------------

/**
 * Builds the in-container shell command that writes the effective profile
 * content to `cordis.patch.yml` and then execs
 * `dsh --profile headless --patch cordis.patch.yml <prompt>` - the validated
 * launch shape from docs/dsh-adapter-notes.md and the #197 restricted-egress
 * path, reused unchanged.
 *
 * The profile content and prompt travel as environment variables
 * (`PostgresResearchAgentSpec.env`, the documented extensibility point - see
 * research-session.ts) rather than being interpolated into the script text,
 * so neither can break shell quoting or require escaping: `printf '%s'
 * "$VAR"` and `dsh ... "$VAR"` both treat the variable's value as inert data.
 * The task prompt itself is never supplied by this module - it already
 * arrives via `HONEYRAIL_TASK_PROMPT`, injected automatically by
 * `runHistoricalPostgresTrial()` for every agent session.
 */
function buildDshAgentCommand(): { command: string; args: string[] } {
  const script =
    `printf '%s' "$HR_TRIALSET_PROFILE_CONTENT" > ${HISTORICAL_PG_TRIALSET_PROFILE_PATCH_FILENAME} && ` +
    `exec dsh --profile headless --patch ${HISTORICAL_PG_TRIALSET_PROFILE_PATCH_FILENAME} "$HONEYRAIL_TASK_PROMPT"`;
  return { command: "sh", args: ["-c", script] };
}

export type ExecuteTrialSetCellInput = {
  identity: TrialSetCellIdentity;
  experimentId: string;
  corpusManifest: HistoricalPostgresCorpusManifest;
  taskSpec: HistoricalPostgresTaskSpec;
  profile: TrialSetProfileSpec;
  artifactDir: string;
  apiKey: string;
  agentImage: string;
  upstreamUrl: string;
  agentTimeoutMs: number;
  sessionTimeoutMs: number;
  /** Injectable for tests - defaults to the real #207 pilot boundary. */
  runPilotTrial?: typeof runHistoricalPostgresPilotTrial;
};

export async function executeTrialSetCell(input: ExecuteTrialSetCellInput): Promise<TrialSetCellRecord> {
  await mkdir(input.artifactDir, { recursive: true });
  const runPilotTrial = input.runPilotTrial ?? runHistoricalPostgresPilotTrial;
  const { command, args } = buildDshAgentCommand();
  const pilot = await runPilotTrial({
    corpusManifest: input.corpusManifest,
    taskSpec: input.taskSpec,
    // Real DSH agent cells are always profileKind "agent" - never "smoke_stub",
    // which exists only for #180's own deterministic pipeline-integrity check.
    profileKind: "agent",
    agent: {
      command,
      args,
      env: {
        DEEPSEEK_API_KEY: input.apiKey,
        DSH_PERMISSION_MODE: "danger-full-access",
        HR_TRIALSET_PROFILE_CONTENT: input.profile.content
      },
      timeoutMs: input.agentTimeoutMs
    },
    artifactDir: input.artifactDir,
    session: {
      isolation: {
        image: input.agentImage,
        restrictedEgress: { upstreamUrl: input.upstreamUrl }
      },
      timeoutMs: input.sessionTimeoutMs
    }
  });
  return buildTrialSetCellRecord({ experimentId: input.experimentId, identity: input.identity, artifactDir: input.artifactDir, pilot });
}

// ---------------------------------------------------------------------------
// State / resume
// ---------------------------------------------------------------------------

export type TrialSetState = {
  schemaVersion: 1;
  experimentId: string;
  cells: Record<string, TrialSetCellRecord>;
};

export function emptyTrialSetState(experimentId: string): TrialSetState {
  return { schemaVersion: 1, experimentId, cells: {} };
}

export class TrialSetStateCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrialSetStateCorruptError";
  }
}

export async function loadTrialSetState(statePath: string): Promise<TrialSetState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as TrialSetState).schemaVersion !== 1 ||
      typeof (parsed as TrialSetState).experimentId !== "string" ||
      typeof (parsed as TrialSetState).cells !== "object"
    ) {
      throw new Error("missing/invalid schemaVersion, experimentId, or cells");
    }
    return parsed as TrialSetState;
  } catch (error) {
    throw new TrialSetStateCorruptError(`state.json at "${statePath}" is corrupted or incompatible: ${(error as Error).message}`, { cause: error });
  }
}

/** Write-to-temp-then-rename: a truncated/partial write is never observable at `statePath` - a reader always sees either the previous complete state or the new one. */
export async function writeTrialSetStateAtomic(statePath: string, state: TrialSetState): Promise<void> {
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, statePath);
}

// ---------------------------------------------------------------------------
// Aggregate / comparison report
// ---------------------------------------------------------------------------

export type TrialSetProfileSummary = {
  profileId: string;
  eligibleTrials: number;
  rediscovered: number;
  miss: number;
  /** null when eligibleTrials === 0 - never reported as 0% (a misleading "0 rediscoveries out of 0 attempts" result). */
  rediscoveryRate: number | null;
  nonDataset: { blocked: number; invalidSubmission: number; infrastructure: number; integrity: number; unscored: number; other: number };
};

function bucketNonDataset(record: TrialSetCellRecord): keyof TrialSetProfileSummary["nonDataset"] {
  if (record.pilotStatus === "blocked") return "blocked";
  if (record.pilotStatus === "infrastructure_error") return "infrastructure";
  if (record.pilotStatus === "integrity_error") return "integrity";
  if (record.pilotStatus === "unscored") return "unscored";
  if (record.pilotStatus === "completed" && record.gradeStatus === "invalid_submission") return "invalidSubmission";
  return "other";
}

/**
 * The one place this module computes a summary metric, and it is a
 * pass-through of #207's own verdicts, never a second classifier: the
 * denominator is exactly `datasetEligible === true`, and the outcome split is
 * exactly `officialScoredResult` - `trial.status`/`grade.status`/network
 * mode/`executionBinding` never participate here.
 */
export function summarizeTrialSetProfile(profileId: string, records: readonly TrialSetCellRecord[]): TrialSetProfileSummary {
  const summary: TrialSetProfileSummary = {
    profileId,
    eligibleTrials: 0,
    rediscovered: 0,
    miss: 0,
    rediscoveryRate: null,
    nonDataset: { blocked: 0, invalidSubmission: 0, infrastructure: 0, integrity: 0, unscored: 0, other: 0 }
  };
  for (const record of records) {
    if (record.profileId !== profileId) continue;
    if (record.datasetEligible) {
      summary.eligibleTrials += 1;
      if (record.officialScoredResult === "rediscovered") summary.rediscovered += 1;
      else if (record.officialScoredResult === "miss") summary.miss += 1;
    } else {
      summary.nonDataset[bucketNonDataset(record)] += 1;
    }
  }
  summary.rediscoveryRate = summary.eligibleTrials > 0 ? summary.rediscovered / summary.eligibleTrials : null;
  return summary;
}

function formatRate(rate: number | null): string {
  return rate === null ? "N/A" : `${(rate * 100).toFixed(1)}%`;
}

export function buildHistoricalPgTrialSetReport(input: { manifest: TrialSetExperimentManifest; records: readonly TrialSetCellRecord[] }): string {
  const { manifest, records } = input;
  const profileIds = [...new Set(manifest.profiles.map((profile) => profile.profileId))].sort();
  const summaries = profileIds.map((profileId) => summarizeTrialSetProfile(profileId, records));

  const lines: string[] = [];
  lines.push("# Historical PG TrialSet comparison report");
  lines.push("");
  lines.push(`Generated: ${nowIso()}`);
  lines.push(`Experiment: \`${manifest.experimentId}\` (created ${manifest.createdAt}, runner ${manifest.runnerVersion})`);
  lines.push(`Repository commit: \`${manifest.repositoryCommit}\``);
  lines.push(`Corpus: \`${manifest.corpusId}\` @ \`${manifest.corpusHash}\``);
  lines.push(`Agent image: \`${manifest.agentImage}\``);
  lines.push(
    `Isolation: ${manifest.isolationPolicy.restrictedEgress ? `restricted-egress (upstream \`${manifest.isolationPolicy.upstreamUrl}\`)` : `network=${manifest.isolationPolicy.network ?? "none"}`}`
  );
  lines.push(`Tasks: ${manifest.tasks.map((task) => `${task.taskId} (${task.partition})`).join(", ")}`);
  lines.push(`Profiles: ${manifest.profileSources.map((profile) => `${profile.profileId}=${profile.sourcePath} (\`${profile.profileHash.slice(0, 12)}\`)`).join(", ")}`);
  lines.push(`Trials per cell: ${manifest.trialsPerCell}`);
  lines.push("");
  lines.push("## Historical Bug Rediscovery Rate @ Budget");
  lines.push("");
  lines.push("Denominator: `datasetEligible === true` pilot cells only. Outcome: `officialScoredResult`. Never derived from trial/grade status, network mode, or execution binding directly.");
  lines.push("");
  lines.push("| Profile | Eligible | Rediscovered | Miss | Rate | Blocked | Invalid | Infra | Integrity | Unscored | Other |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const summary of summaries) {
    lines.push(
      `| ${summary.profileId} | ${summary.eligibleTrials} | ${summary.rediscovered} | ${summary.miss} | ${formatRate(summary.rediscoveryRate)} | ` +
        `${summary.nonDataset.blocked} | ${summary.nonDataset.invalidSubmission} | ${summary.nonDataset.infrastructure} | ${summary.nonDataset.integrity} | ${summary.nonDataset.unscored} | ${summary.nonDataset.other} |`
    );
  }
  lines.push("");
  lines.push("## Per-cell evidence");
  lines.push("");
  lines.push("Every aggregate cell traces back to its own pilot artifact directory - never summarized without that reference.");
  lines.push("");
  lines.push("| Cell | Task | Partition | Profile | Trial | Pilot status | datasetEligible | officialScoredResult | Wall time | pilotId | Artifact dir |");
  lines.push("|---|---|---|---|---:|---|---|---|---:|---|---|");
  const sortedRecords = [...records].sort((a, b) => a.cellId.localeCompare(b.cellId));
  for (const record of sortedRecords) {
    lines.push(
      `| ${record.cellId} | ${record.taskId} | ${record.partition} | ${record.profileId} | ${record.trialIndex} | ${record.pilotStatus} | ` +
        `${record.datasetEligible} | ${record.officialScoredResult} | ${Math.round(record.wallTimeMs / 1000)}s | \`${record.pilotId}\` | \`${record.artifactDir}\` |`
    );
    if (record.diagnostics.length) {
      lines.push(`  - diagnostics: ${record.diagnostics.join(" / ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
