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
  gradingProtocol: HistoricalPostgresGradingProtocol;
  scaffoldingLevel: string;
  budget: Record<string, number>;
  buildProfile: string;
  artifactContract: HistoricalPostgresCorpusArtifactContract;
  /** Issue-tracker pointers only (e.g. "#178", "#200") - never truth, never a filesystem path. */
  provenanceReferences: string[];
};

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
  return {
    taskId: taskManifest.taskId,
    partition,
    sourceSnapshotHash: taskManifest.hashes.sourceTree,
    promptHash: taskManifest.hashes.prompt,
    taskDefinitionHash: taskManifest.hashes.taskDefinition,
    truthBundleHash: taskManifest.hashes.truthBundle,
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
 * Validates a manifest's own internal shape - required fields, exactly the
 * frozen v0 task set (no fewer, no more, no duplicates), and the exact
 * required holdout disclaimer. Used both by `buildHistoricalPostgresCorpusManifest()`
 * before it ever computes a hash, and standalone by any consumer (e.g. #180's
 * pilot) before trusting a manifest it loaded from disk. Throws
 * `HistoricalPostgresCorpusIntegrityError` - never returns a boolean - so a
 * missing/malformed corpus can never be silently treated as a task outcome.
 */
export function validateHistoricalPostgresCorpusManifest(manifest: Pick<HistoricalPostgresCorpusManifest, "tasks" | "holdoutNote">): void {
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
  }
  if (manifest.holdoutNote !== HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE) {
    throw new HistoricalPostgresCorpusIntegrityError("corpus manifest holdoutNote does not match the required Corpus v0 disclaimer");
  }
}

/**
 * Builds and hashes the corpus manifest. `corpusHash` is computed over every
 * field above it via the identical canonicalize+sha256 algorithm every
 * per-task truth/task-definition hash in `historical-task.ts` already uses -
 * imported from there rather than re-implemented, so the two can never
 * silently diverge. Entries are sorted by `taskId` first so hash stability
 * does not depend on caller-supplied array order.
 */
export function buildHistoricalPostgresCorpusManifest(input: {
  corpusId: string;
  freezeDate: string;
  tasks: HistoricalPostgresCorpusTaskEntry[];
}): HistoricalPostgresCorpusManifest {
  const tasks = [...input.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId));
  validateHistoricalPostgresCorpusManifest({ tasks, holdoutNote: HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE });
  const shape = {
    schemaVersion: 1 as const,
    corpusId: input.corpusId,
    freezeDate: input.freezeDate,
    gradingEntryPoint: HISTORICAL_POSTGRES_CORPUS_GRADING_ENTRY_POINT,
    outcomeVocabulary: HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY,
    holdoutNote: HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE,
    tasks
  };
  return { ...shape, corpusHash: sha256(stableJson(shape)) };
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
