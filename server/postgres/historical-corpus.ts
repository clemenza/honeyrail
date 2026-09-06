import {
  canonicalize,
  sha256,
  stableJson,
  type HistoricalPostgresGradeStatus,
  type HistoricalPostgresGradingProtocol,
  type HistoricalPostgresReferenceManifest,
  type HistoricalPostgresTaskManifest
} from "./historical-task.js";

/**
 * Corpus-v0 integration/freeze layer for issue #201. This module never reads
 * `HistoricalPostgresTruthManifest` (grader-private truth) - every field it
 * consumes comes from the *already-sanitized* `HistoricalPostgresTaskManifest`
 * / `HistoricalPostgresReferenceManifest` that `materializeHistoricalPostgresTask()`
 * writes into `task/` and `reference/reference-manifest.json` respectively, so
 * no private truth (revisions, upstream bug identity, oracle contents) can
 * leak into a corpus manifest by construction - there is no code path here
 * that could even read it.
 */

export const HISTORICAL_POSTGRES_CORPUS_SCHEMA_VERSION = 1;

export type HistoricalPostgresCorpusPartition = "TRAIN" | "FRONTIER" | "HOLDOUT";

/**
 * The corrected Corpus v0 partition (#201 partition correction). Bug 3/#199
 * (`postgres-historical-003`) was provisionally slotted as HOLDOUT in #185,
 * but `docs/historical-postgres-task-v0.md`'s "Evaluation-partition note for
 * case 003" records that its real answer material (upstream bug id, both
 * pinned revisions, expected oracle tuples) briefly existed in this
 * repository's public PR history (PR #204) before the operator-supplied
 * private-truth loader was corrected - so it cannot be sold as a pristine
 * HOLDOUT case. Corpus v0 therefore freezes with an empty HOLDOUT partition;
 * see `HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE` for the disclaimer this
 * carries into the frozen manifest itself, not just this comment.
 */
export const HISTORICAL_POSTGRES_CORPUS_PARTITIONS: Readonly<Record<string, HistoricalPostgresCorpusPartition>> = Object.freeze({
  "postgres-historical-001": "TRAIN",
  "postgres-historical-002": "FRONTIER",
  "postgres-historical-003": "FRONTIER"
});

export const HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE =
  "Corpus v0 is an engineering rediscovery corpus for Historical PostgreSQL MVP validation. " +
  "It does not currently provide a pristine HOLDOUT generalization claim.";

/**
 * Every task in this corpus is materialized, graded, and retains evidence
 * through the identical generic path (`materializeHistoricalPostgresTask()`,
 * `gradeHistoricalPostgresSubmission()`, `runHistoricalPostgresTrial()` in
 * `historical-task.ts`) - there is no per-task executor/runtime branch to
 * describe differently here, so the contract is one static value shared by
 * every entry, not something `buildHistoricalPostgresCorpusTaskEntry()`
 * derives per task.
 */
export const HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT = Object.freeze({
  agentVisible: Object.freeze(["task/prompt.md", "task/task-manifest.json", "task/source-manifest.json", "task/workspace/"]),
  agentSubmitted: Object.freeze(["finding.json", "<reproducer file>? (required only when finding.json status is \"reproduced\")"]),
  graderRetained: Object.freeze([
    "reference/truth.json",
    "reference/reference-manifest.json",
    "agent-result.json",
    "agent-stdout.txt",
    "agent-stderr.txt",
    "grader/historical/*",
    "grader/reference/*",
    "grader/grade.json"
  ])
});
export type HistoricalPostgresCorpusArtifactContract = typeof HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT;

export const HISTORICAL_POSTGRES_CORPUS_GRADING_ENTRY_POINT = Object.freeze([
  "materializeHistoricalPostgresTask",
  "gradeHistoricalPostgresSubmission",
  "runHistoricalPostgresTrial"
]);

/**
 * Outcome vocabulary the corpus manifest publishes. `EXHAUSTIVE_CHECK` is a
 * `Record<HistoricalPostgresGradeStatus, true>` literal, not a hand-copied
 * array: TypeScript rejects it at compile time (`tsc --noEmit`) if it is
 * missing a key from the real union (a status was added in
 * `historical-task.ts` and not reflected here) or has an extra one (a status
 * was removed there and this went stale) - so the corpus's advertised
 * vocabulary cannot silently drift from the real grading union in either
 * direction. `HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY` is then just
 * that same exhaustive key set, in the fixed presentation order below.
 */
const OUTCOME_VOCABULARY_EXHAUSTIVE_CHECK: Record<HistoricalPostgresGradeStatus, true> = {
  rediscovered: true,
  miss: true,
  blocked: true,
  invalid_submission: true,
  integrity_error: true,
  infrastructure_error: true
};
export const HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY: readonly HistoricalPostgresGradeStatus[] = (
  Object.keys(OUTCOME_VOCABULARY_EXHAUSTIVE_CHECK) as HistoricalPostgresGradeStatus[]
).sort() as HistoricalPostgresGradeStatus[];

export type HistoricalPostgresCorpusTaskEntry = {
  taskId: string;
  partition: HistoricalPostgresCorpusPartition;
  sourceSnapshotHash: string;
  promptHash: string;
  taskDefinitionHash: string;
  truthBundleHash: string;
  /** Hash of the initial agent-visible task/workspace scaffolding - see historical-task.ts's `agentWorkspaceHash`. */
  agentWorkspaceHash: string;
  /** Hash of the declarative build/runtime contract this task is scored under - see `resolveHistoricalPostgresBuildContract()`. */
  buildContractHash: string;
  gradingProtocol: HistoricalPostgresGradingProtocol;
  scaffoldingLevel: string;
  budget: Record<string, number>;
  buildProfile: string;
  artifactContract: HistoricalPostgresCorpusArtifactContract;
  /** Issue-tracker pointers only (e.g. "#178", "#200") - never truth, never a filesystem path. */
  provenanceReferences: string[];
};

/** SHA-256 hex digest shape - what every `*Hash` field on a corpus task entry must look like. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export class HistoricalPostgresCorpusIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalPostgresCorpusIntegrityError";
  }
}

/**
 * Builds one corpus entry from a materialized task's already-sanitized
 * manifests. Never accepts (and the type signature makes it impossible to
 * pass) `HistoricalPostgresTruthManifest`.
 */
export function buildHistoricalPostgresCorpusTaskEntry(
  layout: { taskManifest: HistoricalPostgresTaskManifest; referenceManifest: HistoricalPostgresReferenceManifest },
  provenanceReferences: string[]
): HistoricalPostgresCorpusTaskEntry {
  const { taskManifest, referenceManifest } = layout;
  if (taskManifest.taskId !== referenceManifest.taskId) {
    throw new HistoricalPostgresCorpusIntegrityError(
      `taskManifest.taskId (${taskManifest.taskId}) and referenceManifest.taskId (${referenceManifest.taskId}) disagree`
    );
  }
  const partition = HISTORICAL_POSTGRES_CORPUS_PARTITIONS[taskManifest.taskId];
  if (!partition) {
    throw new HistoricalPostgresCorpusIntegrityError(
      `no corpus partition is defined for taskId "${taskManifest.taskId}" - a corpus entry must never silently default a partition`
    );
  }
  if (taskManifest.hashes.taskDefinition !== referenceManifest.taskDefinitionHash) {
    throw new HistoricalPostgresCorpusIntegrityError(
      `taskManifest.hashes.taskDefinition and referenceManifest.taskDefinitionHash disagree for taskId "${taskManifest.taskId}"`
    );
  }
  // #201 PR #206 review, Blocking 3: the taskDefinition cross-check above
  // existed, but the equivalent check for the truth-bundle hash did not - a
  // taskManifest/referenceManifest pair disagreeing on *which* truth bundle
  // was actually used to grade could pass silently.
  if (taskManifest.hashes.truthBundle !== referenceManifest.truthBundleHash) {
    throw new HistoricalPostgresCorpusIntegrityError(
      `taskManifest.hashes.truthBundle and referenceManifest.truthBundleHash disagree for taskId "${taskManifest.taskId}"`
    );
  }
  return {
    taskId: taskManifest.taskId,
    partition,
    sourceSnapshotHash: taskManifest.hashes.sourceTree,
    promptHash: taskManifest.hashes.prompt,
    taskDefinitionHash: taskManifest.hashes.taskDefinition,
    truthBundleHash: taskManifest.hashes.truthBundle,
    agentWorkspaceHash: taskManifest.hashes.agentWorkspace,
    buildContractHash: taskManifest.hashes.buildContract,
    gradingProtocol: referenceManifest.gradingProtocol,
    scaffoldingLevel: taskManifest.scaffoldingLevel,
    budget: taskManifest.budget,
    buildProfile: taskManifest.buildProfile,
    artifactContract: HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT,
    provenanceReferences: [...provenanceReferences]
  };
}

export type HistoricalPostgresCorpusManifest = {
  schemaVersion: 1;
  corpusId: string;
  freezeDate: string;
  gradingEntryPoint: readonly string[];
  outcomeVocabulary: readonly HistoricalPostgresGradeStatus[];
  holdoutNote: string;
  tasks: HistoricalPostgresCorpusTaskEntry[];
  corpusHash: string;
};

const EXPECTED_CORPUS_TASK_IDS = Object.keys(HISTORICAL_POSTGRES_CORPUS_PARTITIONS).sort();
/**
 * `sourceSnapshotHash` is `materializePostgresSource()`'s git tree object id
 * (SHA-1, 40 hex chars) - not one of this module's own SHA-256 hashes - so it
 * gets its own pattern rather than being lumped in with the SHA-256 fields
 * below it validates alongside.
 */
const REQUIRED_TASK_ENTRY_SHA256_HASH_FIELDS = ["promptHash", "taskDefinitionHash", "truthBundleHash", "agentWorkspaceHash", "buildContractHash"] as const;
const GIT_SHA1_HEX = /^[0-9a-f]{40}$/i;

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (stableJson(actual) !== stableJson(expected)) throw new HistoricalPostgresCorpusIntegrityError(message);
}

/**
 * Structural validation shared by both the pre-hash build path and the
 * loaded-from-disk path below: required fields, exactly the frozen v0 task
 * set (no fewer, no more, no duplicates), correct partitions, the exact
 * required holdout disclaimer, the fixed grading entry point / outcome
 * vocabulary, and - per task - the shared artifact contract and the expected
 * SHA-256 hex shape of every `*Hash` field ("expected hash field formats
 * where practical" - #201 PR #206 review, Blocking 3). Throws
 * `HistoricalPostgresCorpusIntegrityError` - never returns a boolean - so a
 * missing/malformed corpus can never be silently treated as a task outcome.
 */
function validateHistoricalPostgresCorpusManifestStructure(
  manifest: Pick<HistoricalPostgresCorpusManifest, "schemaVersion" | "corpusId" | "freezeDate" | "gradingEntryPoint" | "outcomeVocabulary" | "holdoutNote" | "tasks">
): void {
  if (manifest.schemaVersion !== HISTORICAL_POSTGRES_CORPUS_SCHEMA_VERSION) {
    throw new HistoricalPostgresCorpusIntegrityError(`corpus manifest schemaVersion must be ${HISTORICAL_POSTGRES_CORPUS_SCHEMA_VERSION}, got ${String(manifest.schemaVersion)}`);
  }
  if (typeof manifest.corpusId !== "string" || !manifest.corpusId.trim()) {
    throw new HistoricalPostgresCorpusIntegrityError("corpus manifest corpusId must be a non-empty string");
  }
  if (typeof manifest.freezeDate !== "string" || !manifest.freezeDate.trim() || Number.isNaN(Date.parse(manifest.freezeDate))) {
    throw new HistoricalPostgresCorpusIntegrityError("corpus manifest freezeDate must be a non-empty, parseable date string");
  }
  assertDeepEqual(manifest.gradingEntryPoint, HISTORICAL_POSTGRES_CORPUS_GRADING_ENTRY_POINT, "corpus manifest gradingEntryPoint does not match the required generic entry points");
  assertDeepEqual(manifest.outcomeVocabulary, HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY, "corpus manifest outcomeVocabulary does not match the required grade-status vocabulary");
  if (manifest.holdoutNote !== HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE) {
    throw new HistoricalPostgresCorpusIntegrityError("corpus manifest holdoutNote does not match the required Corpus v0 disclaimer");
  }

  const ids = manifest.tasks.map((task) => task.taskId);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    throw new HistoricalPostgresCorpusIntegrityError(`corpus manifest has duplicate task ids: ${ids.join(", ")}`);
  }
  const actualIds = [...uniqueIds].sort();
  if (actualIds.length !== EXPECTED_CORPUS_TASK_IDS.length || actualIds.some((id, index) => id !== EXPECTED_CORPUS_TASK_IDS[index])) {
    throw new HistoricalPostgresCorpusIntegrityError(
      `corpus manifest task set does not match the frozen v0 set. expected [${EXPECTED_CORPUS_TASK_IDS.join(", ")}], got [${actualIds.join(", ")}]`
    );
  }
  for (const task of manifest.tasks) {
    const expectedPartition = HISTORICAL_POSTGRES_CORPUS_PARTITIONS[task.taskId];
    if (task.partition !== expectedPartition) {
      throw new HistoricalPostgresCorpusIntegrityError(
        `taskId "${task.taskId}" has partition "${task.partition}" but the frozen v0 partition is "${expectedPartition}"`
      );
    }
    if (!task.gradingProtocol || typeof task.gradingProtocol !== "string") {
      throw new HistoricalPostgresCorpusIntegrityError(`taskId "${task.taskId}" is missing a gradingProtocol`);
    }
    if (!task.scaffoldingLevel || typeof task.scaffoldingLevel !== "string") {
      throw new HistoricalPostgresCorpusIntegrityError(`taskId "${task.taskId}" is missing a scaffoldingLevel`);
    }
    if (!task.buildProfile || typeof task.buildProfile !== "string") {
      throw new HistoricalPostgresCorpusIntegrityError(`taskId "${task.taskId}" is missing a buildProfile`);
    }
    if (!task.budget || typeof task.budget !== "object" || Array.isArray(task.budget)) {
      throw new HistoricalPostgresCorpusIntegrityError(`taskId "${task.taskId}" budget must be an object`);
    }
    if (!Array.isArray(task.provenanceReferences) || task.provenanceReferences.some((ref) => typeof ref !== "string")) {
      throw new HistoricalPostgresCorpusIntegrityError(`taskId "${task.taskId}" provenanceReferences must be an array of strings`);
    }
    if (typeof task.sourceSnapshotHash !== "string" || !GIT_SHA1_HEX.test(task.sourceSnapshotHash)) {
      throw new HistoricalPostgresCorpusIntegrityError(`taskId "${task.taskId}" field "sourceSnapshotHash" must be a 40-character git tree SHA-1, got: ${String(task.sourceSnapshotHash)}`);
    }
    for (const field of REQUIRED_TASK_ENTRY_SHA256_HASH_FIELDS) {
      const value = task[field];
      if (typeof value !== "string" || !SHA256_HEX.test(value)) {
        throw new HistoricalPostgresCorpusIntegrityError(`taskId "${task.taskId}" field "${field}" must be a 64-character SHA-256 hex digest, got: ${String(value)}`);
      }
    }
    assertDeepEqual(task.artifactContract, HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT, `taskId "${task.taskId}" artifactContract does not match the shared generic contract`);
  }
}

/** Deterministic content covered by `corpusHash` - tasks are re-sorted here so reordering entries never itself moves the hash. */
function corpusHashInput(manifest: Omit<HistoricalPostgresCorpusManifest, "corpusHash">): Omit<HistoricalPostgresCorpusManifest, "corpusHash"> {
  return { ...manifest, tasks: [...manifest.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId)) };
}

/**
 * Computes `corpusHash` via the identical canonicalize+sha256 algorithm
 * every per-task truth/task-definition hash in `historical-task.ts` already
 * uses - imported from there rather than re-implemented, so the two can
 * never silently diverge.
 */
function computeHistoricalPostgresCorpusHash(manifest: Omit<HistoricalPostgresCorpusManifest, "corpusHash">): string {
  return sha256(stableJson(corpusHashInput(manifest)));
}

/**
 * Full integrity validation for a corpus manifest that already carries a
 * `corpusHash` - the "loaded a frozen manifest from disk" path (#201 PR #206
 * review, Blocking 3): every structural check in
 * `validateHistoricalPostgresCorpusManifestStructure()`, *and* recomputation
 * of `corpusHash` from the manifest's own other fields, compared against the
 * value the manifest itself claims. A manifest whose contents were edited
 * without updating its own `corpusHash` - accidentally or adversarially -
 * fails this even if every structural check above passes, closing #201's
 * "validate hashes before each run; reject mismatches as invalid/integrity
 * failures" requirement, which the structural-only checks alone did not
 * enforce.
 */
export function validateHistoricalPostgresCorpusManifest(manifest: HistoricalPostgresCorpusManifest): void {
  validateHistoricalPostgresCorpusManifestStructure(manifest);
  if (typeof manifest.corpusHash !== "string" || !SHA256_HEX.test(manifest.corpusHash)) {
    throw new HistoricalPostgresCorpusIntegrityError("corpus manifest corpusHash must be a 64-character SHA-256 hex digest");
  }
  const { corpusHash, ...withoutHash } = manifest;
  const recomputed = computeHistoricalPostgresCorpusHash(withoutHash);
  if (recomputed !== corpusHash) {
    throw new HistoricalPostgresCorpusIntegrityError(
      `corpus manifest is stale or tampered: recorded corpusHash ${corpusHash} does not match its own recomputed contents (${recomputed})`
    );
  }
}

/**
 * Builds and hashes the corpus manifest. Entries are sorted by `taskId` in
 * the stored representation (for deterministic, diff-friendly on-disk
 * output); `computeHistoricalPostgresCorpusHash()` re-sorts defensively
 * regardless, so hash stability never depends on caller-supplied array
 * order. Validates the assembled manifest against its own strict validator
 * (`validateHistoricalPostgresCorpusManifest()`) before returning it, so
 * whatever this function hands back is guaranteed to already pass the same
 * check a consumer loading it from disk would run.
 */
export function buildHistoricalPostgresCorpusManifest(input: {
  corpusId: string;
  freezeDate: string;
  tasks: HistoricalPostgresCorpusTaskEntry[];
}): HistoricalPostgresCorpusManifest {
  const tasks = [...input.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId));
  const shape = {
    schemaVersion: HISTORICAL_POSTGRES_CORPUS_SCHEMA_VERSION as 1,
    corpusId: input.corpusId,
    freezeDate: input.freezeDate,
    gradingEntryPoint: HISTORICAL_POSTGRES_CORPUS_GRADING_ENTRY_POINT,
    outcomeVocabulary: HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY,
    holdoutNote: HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE,
    tasks
  };
  validateHistoricalPostgresCorpusManifestStructure(shape);
  const manifest: HistoricalPostgresCorpusManifest = { ...shape, corpusHash: computeHistoricalPostgresCorpusHash(shape) };
  validateHistoricalPostgresCorpusManifest(manifest);
  return manifest;
}

/**
 * The freeze/versioning rule (#201 required deliverable 2): a recomputed
 * manifest under the *same* `corpusId` must hash identically to the recorded
 * (frozen, committed) one. A mismatch under the same id is silent in-place
 * mutation and must fail validation - never a silent re-freeze. A genuinely
 * new corpus version uses a new `corpusId` (e.g. `-v1`), which this function
 * does not object to; that is what "any change ... requires a new corpus
 * version/hash" means in practice, not that `corpusId` itself is forbidden to
 * ever change.
 */
export function assertHistoricalPostgresCorpusNotMutated(
  recorded: HistoricalPostgresCorpusManifest,
  recomputed: HistoricalPostgresCorpusManifest
): void {
  if (recorded.corpusId !== recomputed.corpusId) return;
  if (recorded.corpusHash === recomputed.corpusHash) return;
  const recordedById = new Map(recorded.tasks.map((task) => [task.taskId, task]));
  const recomputedById = new Map(recomputed.tasks.map((task) => [task.taskId, task]));
  const changedTaskIds = [...new Set([...recordedById.keys(), ...recomputedById.keys()])]
    .filter((taskId) => stableJson(canonicalize(recordedById.get(taskId))) !== stableJson(canonicalize(recomputedById.get(taskId))))
    .sort();
  throw new HistoricalPostgresCorpusIntegrityError(
    `corpus "${recorded.corpusId}" was silently mutated in place: recorded hash ${recorded.corpusHash} does not match recomputed hash ${recomputed.corpusHash}. ` +
      `Any change to a task's source snapshot, prompt, task manifest, private truth, grader, build assumptions, scaffolding, or budget requires a new corpus version/id, not an in-place edit under the same id. ` +
      `Changed/added/removed task entries: ${changedTaskIds.length ? changedTaskIds.join(", ") : "(non-task-level fields, e.g. freezeDate/holdoutNote/gradingEntryPoint/outcomeVocabulary)"}`
  );
}

export type HistoricalPostgresCorpusFreezeResult =
  | { action: "created"; manifest: HistoricalPostgresCorpusManifest }
  | { action: "unchanged"; manifest: HistoricalPostgresCorpusManifest };

/**
 * The real freeze/re-freeze decision (#201 PR #206 review, Blocking 1): the
 * freeze entry point (`scripts/historical-postgres-201-freeze.ts`) previously
 * wrote a fresh `freezeDate`/hash unconditionally on every invocation, so two
 * back-to-back runs against unchanged inputs could still overwrite the same
 * `corpusId` with a different hash - `assertHistoricalPostgresCorpusNotMutated()`
 * existed but was never actually called from the real freeze path. This
 * function is that path's decision logic, pulled out so it is directly
 * testable with temporary paths/fixtures rather than only via the real
 * multi-minute PostgreSQL-mirror script:
 *
 * - **No `existing` manifest** (first freeze): builds and returns a new one.
 * - **`existing` present, same `corpusId`**: fully validates `existing`
 *   (`validateHistoricalPostgresCorpusManifest()` - a stale/tampered on-disk
 *   file is rejected before it is ever treated as "the recorded truth"),
 *   recomputes a candidate manifest from the *current* task inputs using
 *   `existing.freezeDate` (never a fresh timestamp - that field must not
 *   drift on a no-op re-freeze), and calls
 *   `assertHistoricalPostgresCorpusNotMutated(existing, recomputed)`. If the
 *   two match, returns `{ action: "unchanged", manifest: existing }` - the
 *   caller must not rewrite the file, so a repeated run is a true no-op, not
 *   merely "produces the same bytes if it did rewrite them." If they
 *   disagree, `assertHistoricalPostgresCorpusNotMutated()` throws.
 * - **`existing` present, different `corpusId`**: refuses outright. A
 *   genuinely new corpus version must go to a new output path/version, never
 *   silently replace a different corpus under the same file.
 */
export function reconcileHistoricalPostgresCorpusFreeze(input: {
  existing: HistoricalPostgresCorpusManifest | undefined;
  corpusId: string;
  freezeDate: string;
  tasks: HistoricalPostgresCorpusTaskEntry[];
}): HistoricalPostgresCorpusFreezeResult {
  if (!input.existing) {
    return { action: "created", manifest: buildHistoricalPostgresCorpusManifest({ corpusId: input.corpusId, freezeDate: input.freezeDate, tasks: input.tasks }) };
  }
  validateHistoricalPostgresCorpusManifest(input.existing);
  if (input.existing.corpusId !== input.corpusId) {
    throw new HistoricalPostgresCorpusIntegrityError(
      `refusing to freeze corpusId "${input.corpusId}" over an existing manifest recorded under a different corpusId "${input.existing.corpusId}" at the same output path. ` +
        `A genuinely new corpus version must be written to a new output path, never silently replace a different corpus under the same file.`
    );
  }
  const recomputed = buildHistoricalPostgresCorpusManifest({ corpusId: input.corpusId, freezeDate: input.existing.freezeDate, tasks: input.tasks });
  assertHistoricalPostgresCorpusNotMutated(input.existing, recomputed);
  return { action: "unchanged", manifest: input.existing };
}
