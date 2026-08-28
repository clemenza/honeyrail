/**
 * Read-only view onto a scripts/dsh-evals-demo.ts (#93) output directory
 * (#118). This driver deliberately never creates a HoneyRail Run - per
 * #93's P0 amendment (following #103), a scored trial runs inside #105's
 * isolated container against a #104-built seed-root, never as a registered
 * honeyrail project - so its results only ever exist as local files
 * (state.json, cells/<trialId>/{manifest.json,container.log,seed-root/score.json})
 * under the driver's own --out directory. Nothing here reads or writes
 * anything through OrchestrationService/Store; it only parses those files
 * back into the same summaries scripts/dsh-evals-demo.ts already computes
 * via server/evals/dsh-report.ts, so the UI's numbers are guaranteed to
 * match the driver's own comparison-report.md.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { httpError } from "../route-context.js";
import {
  classifyDshOutcome,
  summarizeFixtureCells,
  summarizeProfiles,
  type DshTrialOutcome,
  type DshTrialRecord,
  type FixtureCellSummary,
  type ProfileSummary
} from "./dsh-report.js";
import type { TranscriptAuditHit } from "./transcript-audit.js";

export type DshEvalsState = {
  config: { image: string; smoke: boolean; dshVersion: string };
  profiles: Array<{ label: string; sha256: string }>;
  fixtures: string[];
  trials: DshTrialRecord[];
};

export type DshTrialRecordWithOutcome = DshTrialRecord & { outcome: DshTrialOutcome };

export type DshEvalsStateSummary = {
  outDir: string;
  config: DshEvalsState["config"];
  profiles: DshEvalsState["profiles"];
  fixtures: string[];
  profileSummaries: ProfileSummary[];
  fixtureCells: FixtureCellSummary[];
  trials: DshTrialRecordWithOutcome[];
};

export type DshTrialArtifacts = {
  trial: DshTrialRecordWithOutcome;
  scoreJson: unknown | null;
  containerLog: string | null;
  /** #140: dsh's raw session-event log, written by server/evals/dsh-transcript.ts - non-empty even for a trial that timed out, unlike containerLog. */
  transcript: string | null;
};

/** Same `~`/relative-path handling as project-helpers.ts's normalizeProjectPath - this is an operator pointing the console at their own local driver output, same trust level as registering a project's repoPath. */
export function normalizeDshOutDir(inputPath: unknown): string {
  const raw = String(inputPath || "").trim();
  if (!raw) throw httpError(400, "outDir is required");
  return resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

/**
 * `state.json` outlives the driver code that wrote it: a directory from an
 * older scripts/dsh-evals-demo.ts run (e.g. before #107 added
 * transcriptAuditHits, or before #126 replaced killMatrix with
 * killRate/killedByKind) is exactly what this read-only browser exists to
 * browse, and `JSON.parse(raw) as DshEvalsState` doesn't make that true - a
 * #114-shaped bug (trusting a parsed object to match a type assertion at
 * runtime) would just resurface here as soon as anyone loaded an old
 * directory, since classifyDshOutcome() unconditionally reads
 * `trial.transcriptAuditHits.length`. Backfill the fields newer than any
 * given trial record might be, rather than assume every persisted trial
 * matches the current schema exactly. A pre-#126 trial's killMatrix (the
 * dropped private-mutant-pool signal) has no replacement value to backfill
 * from - it's simply not carried forward, same as any other retired field.
 */
function normalizeTrial(raw: DshTrialRecord): DshTrialRecord {
  return {
    ...raw,
    transcriptAuditHits: normalizeTranscriptAuditHits(raw.transcriptAuditHits),
    killRate: raw.killRate ?? null,
    killedByKind: raw.killedByKind ?? null,
    pgAdjudicationTally: raw.pgAdjudicationTally ?? null
  };
}

/**
 * #131: pre-#131 state.json files carry transcriptAuditHits as bare pattern
 * name strings (e.g. "mutant"), not { pattern, excerpt, confidence } hit
 * objects - the low/high confidence split didn't exist yet. Treat every
 * such entry as "high" confidence: the conservative choice for old data,
 * since that's the classification browsing that directory always produced
 * before this fix, rather than silently reclassifying a historical run's
 * outcome as a side effect of loading it in the browser.
 */
function normalizeTranscriptAuditHits(raw: unknown): TranscriptAuditHit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry): TranscriptAuditHit =>
    typeof entry === "string" ? { pattern: entry, excerpt: "", confidence: "high" } : (entry as TranscriptAuditHit)
  );
}

async function readState(outDir: string): Promise<DshEvalsState> {
  const statePath = join(outDir, "state.json");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    throw httpError(
      404,
      `No state.json at ${statePath} - has "node --import tsx scripts/dsh-evals-demo.ts --out ${outDir}" been run yet? (${(error as Error).message})`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw httpError(500, `${statePath} is not valid JSON: ${(error as Error).message}`);
  }
  const state = parsed as Partial<DshEvalsState>;
  if (!Array.isArray(state.trials)) throw httpError(500, `${statePath} is missing a "trials" array`);
  return { ...state, trials: state.trials.map(normalizeTrial) } as DshEvalsState;
}

export async function summarizeDshEvalsState(outDir: string): Promise<DshEvalsStateSummary> {
  const state = await readState(outDir);
  return {
    outDir,
    config: state.config,
    profiles: state.profiles,
    fixtures: state.fixtures,
    profileSummaries: summarizeProfiles(state.trials),
    fixtureCells: summarizeFixtureCells(state.trials),
    trials: state.trials.map((trial) => ({ ...trial, outcome: classifyDshOutcome(trial) }))
  };
}

export async function readDshTrialArtifacts(outDir: string, trialId: string): Promise<DshTrialArtifacts> {
  const state = await readState(outDir);
  const trial = state.trials.find((candidate) => candidate.trialId === trialId);
  if (!trial) throw httpError(404, `No trial "${trialId}" in ${join(outDir, "state.json")}`);

  // Fixed, driver-known relative filenames only (see scripts/dsh-evals-demo.ts's
  // executeCell) - never a client-supplied path, so there's nothing here for a
  // trialId to traverse out of trial.artifactsDir with.
  const scoreJsonPath = join(trial.artifactsDir, "seed-root", "score.json");
  const containerLogPath = join(trial.artifactsDir, "container.log");
  const transcriptPath = join(trial.artifactsDir, "transcript.ndjson");

  const scoreJson = await readFile(scoreJsonPath, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const containerLog = await readFile(containerLogPath, "utf8").catch(() => null);
  const transcript = await readFile(transcriptPath, "utf8").catch(() => null);

  return { trial: { ...trial, outcome: classifyDshOutcome(trial) }, scoreJson, containerLog, transcript };
}
