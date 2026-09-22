/**
 * Materialization for the #237 grader-legible-observable archetypes.
 *
 * Layout under `<root>/<archetypeId>/`:
 *
 * ```text
 * archetype-manifest.json   operator-side identity + hashes (never truth)
 * bin/<fixtureCommand>      the synthetic system under test (on PATH)
 * state/                    grader-owned fixture state (invocations.log, counters)
 * workspace/                the ONLY agent-visible directory
 *   BRIEF.md
 *   SUBMISSION-CONTRACT.md
 *   INTERVENTION.md         candidate condition only
 * runs/<index>/cwd/         one scratch cwd per externally captured execution
 * ```
 *
 * The split matters: `bin/` and `state/` sit outside `workspace/` so the
 * fixture's invocation log - the observation that drives failure-stage
 * attribution - is owned by the harness rather than produced by the agent.
 * The archetype's `failureClass`, its expected observation contract and its
 * reference candidate shapes are never written into `workspace/`; the
 * manifest records only a hash of the observation contract, so retained
 * artifacts stay identity-complete without carrying grader truth (the same
 * discipline as `materializeHistoricalPostgresTask()`).
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256, stableJson } from "../postgres/historical-task.js";
import {
  graderLegibleArchetypeHash,
  graderLegibleArchetypeSetHash,
  type GraderLegibleArchetype
} from "./grader-legible-archetypes.js";
import type { GraderLegibleIntervention } from "./grader-legible-intervention.js";

export type GraderLegibleArchetypeLayout = {
  archetypeId: string;
  root: string;
  /** Agent-visible directory; also where the submitted reproducer is expected. */
  workspaceDir: string;
  /** Prepended to PATH for every execution. Not agent-visible as a directory listing target. */
  binDir: string;
  /** Grader-owned fixture state (`invocations.log`, per-fixture counters). */
  stateDir: string;
  runsDir: string;
  manifestPath: string;
};

/** The single artifact an agent submits. Mirrors the in-workspace, single-file discipline of the Historical PG reproducer contract. */
export const GRADER_LEGIBLE_SUBMISSION_FILENAME = "reproducer.sh";

/** Submitted reproducers are small by construction; a larger file is an integrity failure, not a capability miss. */
export const MAX_GRADER_LEGIBLE_SUBMISSION_BYTES = 16 * 1024;

export const GRADER_LEGIBLE_INVOCATION_LOG = "invocations.log";

async function writeText(path: string, body: string): Promise<void> {
  await writeFile(path, body.endsWith("\n") ? body : `${body}\n`);
}

/**
 * Materializes one archetype. Idempotent for the fixture/brief content, but
 * it never clears `state/` or `runs/`: a caller that wants a clean slate uses
 * a fresh root, so an accidental re-materialization can't quietly erase
 * retained raw observations.
 */
export async function materializeGraderLegibleArchetype(
  archetype: GraderLegibleArchetype,
  root: string,
  intervention?: GraderLegibleIntervention
): Promise<GraderLegibleArchetypeLayout> {
  const workspaceDir = join(root, "workspace");
  const binDir = join(root, "bin");
  const stateDir = join(root, "state");
  const runsDir = join(root, "runs");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(runsDir, { recursive: true })
  ]);

  const fixturePath = join(binDir, archetype.fixtureCommand);
  await writeText(fixturePath, archetype.fixtureProgram);
  await chmod(fixturePath, 0o755);

  await writeText(join(workspaceDir, "BRIEF.md"), buildBrief(archetype));
  await writeText(join(workspaceDir, "SUBMISSION-CONTRACT.md"), buildSubmissionContract(archetype));
  if (intervention && intervention.body.trim()) {
    await writeText(join(workspaceDir, "INTERVENTION.md"), intervention.body);
  }

  const manifestPath = join(root, "archetype-manifest.json");
  await writeFile(
    manifestPath,
    `${stableJson({
      schemaVersion: 1,
      archetypeId: archetype.archetypeId,
      failureClass: archetype.failureClass,
      fixtureCommand: archetype.fixtureCommand,
      submissionFilename: GRADER_LEGIBLE_SUBMISSION_FILENAME,
      archetypeHash: graderLegibleArchetypeHash(archetype),
      archetypeSetHash: graderLegibleArchetypeSetHash(),
      // Identity without truth: the expected observation itself is never
      // written to disk, only its content hash.
      observationContractHash: sha256(stableJson(archetype.observationContract)),
      interventionId: intervention?.interventionId ?? null,
      interventionHash: intervention?.interventionHash ?? null
    })}\n`
  );

  return { archetypeId: archetype.archetypeId, root, workspaceDir, binDir, stateDir, runsDir, manifestPath };
}

function buildBrief(archetype: GraderLegibleArchetype): string {
  return [
    `# Capability task: ${archetype.archetypeId}`,
    "",
    archetype.publicBrief,
    "",
    `The \`${archetype.fixtureCommand}\` command is on your PATH. It is a small deterministic fixture with no network and no side effects beyond its own bookkeeping.`,
    "",
    `Write your reproducer to \`${GRADER_LEGIBLE_SUBMISSION_FILENAME}\` in this directory. Read \`SUBMISSION-CONTRACT.md\` before you submit, and validate your artifact against it.`
  ].join("\n");
}

function buildSubmissionContract(archetype: GraderLegibleArchetype): string {
  return [
    "# Submission contract",
    "",
    `Write a single POSIX shell script to \`${GRADER_LEGIBLE_SUBMISSION_FILENAME}\` in this directory (at most ${MAX_GRADER_LEGIBLE_SUBMISSION_BYTES} bytes).`,
    "",
    archetype.publicSubmissionContract
  ].join("\n");
}

export type GraderLegibleSubmissionValidation =
  | { ok: true; script: string; bytes: number }
  | { ok: false; diagnostic: string; integrity: boolean };

/**
 * Validates the submitted artifact before any execution. A missing or
 * oversized submission is reported distinctly from a badly shaped one: the
 * former never reaches the grader's capability judgement at all.
 *
 * `readFile` on the workspace-joined path (rather than an agent-supplied path)
 * removes the traversal surface the Historical PG contract has to validate
 * explicitly - there is no agent-chosen filename here.
 */
export async function validateGraderLegibleSubmission(workspaceDir: string): Promise<GraderLegibleSubmissionValidation> {
  const path = join(workspaceDir, GRADER_LEGIBLE_SUBMISSION_FILENAME);
  let script: string;
  try {
    script = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, integrity: false, diagnostic: `${GRADER_LEGIBLE_SUBMISSION_FILENAME} is missing or unreadable: ${(error as Error).message}` };
  }
  const bytes = Buffer.byteLength(script, "utf8");
  if (bytes === 0) return { ok: false, integrity: false, diagnostic: `${GRADER_LEGIBLE_SUBMISSION_FILENAME} is empty` };
  if (bytes > MAX_GRADER_LEGIBLE_SUBMISSION_BYTES) {
    return {
      ok: false,
      integrity: true,
      diagnostic: `${GRADER_LEGIBLE_SUBMISSION_FILENAME} exceeds the ${MAX_GRADER_LEGIBLE_SUBMISSION_BYTES} byte limit (${bytes} bytes)`
    };
  }
  return { ok: true, script, bytes };
}

/** Reads the fixture's grader-owned invocation log. An absent log means the fixture was never called. */
export async function readGraderLegibleInvocationLog(stateDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(stateDir, GRADER_LEGIBLE_INVOCATION_LOG), "utf8");
    return raw.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
