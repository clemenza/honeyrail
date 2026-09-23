/**
 * Materialization for the #237 grader-legible-observable archetypes.
 *
 * Layout under `<root>/<archetypeId>/`:
 *
 * ```text
 * archetype-manifest.json   operator-side identity + hashes (never truth)
 * bin/<fixtureCommand>      the synthetic system under test (never agent-visible)
 * facade-bin/<fixtureCommand>  generic facade client, the agent's PATH entry
 * state/                    grader-owned fixture state (invocations.log, counters)
 * workspace/                the agent-visible workspace
 *   BRIEF.md
 *   SUBMISSION-CONTRACT.md
 *   INTERVENTION.md         candidate condition only
 * runs/<index>/cwd/         one scratch cwd per externally captured execution
 * ```
 *
 * The split matters: `bin/` and `state/` sit outside `workspace/` so the
 * fixture's invocation log - the observation that drives failure-stage
 * attribution - is owned by the harness rather than produced by the agent.
 *
 * This layout *describes* the split; it does not enforce it. Nothing here is
 * a filesystem boundary, so for a real agent command the separation is only
 * as real as the environment the agent runs in: `grader-legible-container.ts`
 * bind-mounts `workspace/` and `facade-bin/` and nothing else, and an
 * unisolated run has no boundary at all and must not claim one.
 *
 * `bin/` and `facade-bin/` hold files with the *same names* and unrelated
 * contents. `bin/<fixtureCommand>` is the archetype's real program, whose
 * source is the discriminating truth the agent is asked to discover; it is
 * used by the host-side graded executions and by the facade broker, and is
 * never mounted into any container. `facade-bin/<fixtureCommand>` is the
 * generic client from `grader-legible-facade.ts`, byte-identical across
 * archetypes, and is what an isolated agent finds on PATH.
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
import { GRADER_LEGIBLE_FACADE_CLIENT } from "./grader-legible-facade.js";

export type GraderLegibleArchetypeLayout = {
  archetypeId: string;
  root: string;
  /** Agent-visible directory; also where the submitted reproducer is expected. */
  workspaceDir: string;
  /**
   * The real fixture. Prepended to PATH for the harness's own graded
   * executions and opened by the facade broker. Never mounted into a
   * container: its contents are the archetype's discriminating truth.
   */
  binDir: string;
  /**
   * The generic facade client, one file per archetype named after the
   * fixture. This is the directory an isolated agent gets on PATH in place of
   * `binDir`. Built unconditionally, so an unisolated smoke run and an
   * isolated run materialize the same tree.
   */
  facadeBinDir: string;
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
  intervention?: GraderLegibleIntervention,
  /**
   * The task set this materialization is actually part of. Defaults to the
   * full six-archetype set. A run over a subset (a single-archetype test, a
   * partial pilot) would otherwise stamp every manifest with the full set's
   * hash, so the retained artifact would assert a task-set identity the run
   * never had.
   */
  archetypeSet?: readonly GraderLegibleArchetype[]
): Promise<GraderLegibleArchetypeLayout> {
  const workspaceDir = join(root, "workspace");
  const binDir = join(root, "bin");
  const facadeBinDir = join(root, "facade-bin");
  const stateDir = join(root, "state");
  const runsDir = join(root, "runs");
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(facadeBinDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(runsDir, { recursive: true })
  ]);

  const fixturePath = join(binDir, archetype.fixtureCommand);
  await writeText(fixturePath, archetype.fixtureProgram);
  await chmod(fixturePath, 0o755);

  // Same name, no shared content: the facade client is a constant and carries
  // nothing about this archetype, so an agent that reads it learns only that
  // its invocations are forwarded.
  const facadePath = join(facadeBinDir, archetype.fixtureCommand);
  await writeFile(facadePath, GRADER_LEGIBLE_FACADE_CLIENT);
  await chmod(facadePath, 0o755);

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
      archetypeSetHash: graderLegibleArchetypeSetHash(archetypeSet),
      // Identity without truth: the expected observation itself is never
      // written to disk, only its content hash.
      observationContractHash: sha256(stableJson(archetype.observationContract)),
      interventionId: intervention?.interventionId ?? null,
      interventionHash: intervention?.interventionHash ?? null
    })}\n`
  );

  return { archetypeId: archetype.archetypeId, root, workspaceDir, binDir, facadeBinDir, stateDir, runsDir, manifestPath };
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
