# Historical PostgreSQL Corpus v0 (issue #201)

Issue #201 is the serial integration/freeze step over #199 and #200 (which themselves materialized Bugs 2 and 3 on top of #184's Bug 1 vertical slice). It does not add a new executor, a new orchestration layer, or a generic `EvalProvider`; `server/postgres/historical-corpus.ts` is a thin, generic aggregation over the already-sanitized per-task manifests that `materializeHistoricalPostgresTask()` (`historical-task.ts`) already produces for every task.

## Partition correction

#185's original provisional partition slotted Bug 3/#199 (`postgres-historical-003`) as HOLDOUT. That is stale: `docs/historical-postgres-task-v0.md`'s "Evaluation-partition note for case 003" records that case 003's real answer material (upstream bug id, both pinned revisions, expected oracle tuples) briefly existed in this repository's own public PR history (PR #204) before the operator-supplied private-truth loader was corrected. A case whose answer material was ever public cannot be sold as a pristine HOLDOUT case, regardless of the current loader's discipline.

Corpus v0 freezes with the corrected partition:

```text
TRAIN
  postgres-historical-001

FRONTIER
  postgres-historical-002
  postgres-historical-003

HOLDOUT
  (empty)
```

Every corpus manifest built by `buildHistoricalPostgresCorpusManifest()` carries this disclaimer verbatim as `holdoutNote`, and `validateHistoricalPostgresCorpusManifest()` rejects any manifest whose `holdoutNote` doesn't match it exactly:

> Corpus v0 is an engineering rediscovery corpus for Historical PostgreSQL MVP validation. It does not currently provide a pristine HOLDOUT generalization claim.

Future true-HOLDOUT cases must use operator-supplied private truth from inception (the pattern case 003 now follows via `loadHistoricalPostgres003PrivateTruth()`/`HONEYRAIL_PG_199_PRIVATE_TRUTH` - see `docs/historical-postgres-task-v0.md`) and must never expose real answer material in tracked/public files or PR history at any point, not even transiently. Git history in this repository is not rewritten to compensate for the case-003 exposure; the partition correction is the compensating control instead.

## Corpus manifest

`server/postgres/historical-corpus.ts` exports:

- `HISTORICAL_POSTGRES_CORPUS_PARTITIONS` - the frozen `taskId -> partition` map above. `buildHistoricalPostgresCorpusTaskEntry()` looks up a task's partition here and throws `HistoricalPostgresCorpusIntegrityError` for any unrecognized `taskId`, rather than defaulting one.
- `buildHistoricalPostgresCorpusTaskEntry(layout, provenanceReferences)` - builds one entry from a materialized task's `taskManifest`/`referenceManifest` only. Its type signature makes it impossible to pass `truthManifest` (grader-private truth) in at all, so no oracle content, revision, or upstream bug identity can reach a corpus manifest through this path.
- `buildHistoricalPostgresCorpusManifest({ corpusId, freezeDate, tasks })` - validates the task set (via `validateHistoricalPostgresCorpusManifest()`) and computes `corpusHash` over the canonicalized manifest using the exact same `canonicalize`/`stableJson`/`sha256` algorithm `historical-task.ts` already uses for every truth-bundle/task-definition hash (imported from there, not reimplemented).
- `assertHistoricalPostgresCorpusNotMutated(recorded, recomputed)` - the freeze/versioning rule (below).
- `validateHistoricalPostgresCorpusManifest(manifest)` - structural integrity check (required fields, exactly the frozen v0 task set, correct partitions, exact holdout disclaimer); throws `HistoricalPostgresCorpusIntegrityError`, never returns a boolean, so a malformed manifest can never be mistaken for a task grade.

Each task entry records only already-agent-sanitized fields: `sourceSnapshotHash`, `promptHash`, `taskDefinitionHash`, `truthBundleHash` (the hash only - never the bundle), `gradingProtocol`, `scaffoldingLevel`, `budget`, `buildProfile`, a shared `artifactContract` (identical across all three tasks, since all three share one generic materialize/grade/trial path - see `HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT`), and `provenanceReferences` (issue-tracker pointers such as `"#200"`, never a filesystem path or truth value). `outcomeVocabulary` is derived from an exhaustive `Record<HistoricalPostgresGradeStatus, true>` compile-time check against the real grading union in `historical-task.ts`, so it cannot silently go stale if a status is ever added or removed there.

## Freeze/versioning rule

- Corpus v0 must freeze before #180's pilot runs against it.
- Any change to a task's source snapshot, prompt, task manifest, private truth, grader, build assumptions, scaffolding, or evidence contract requires a new corpus version/hash - i.e. a new `corpusId` (e.g. bump `historical-postgres-corpus-v0` to `-v1`), not an in-place edit under the same id.
- `assertHistoricalPostgresCorpusNotMutated(recorded, recomputed)` enforces this mechanically: given the previously recorded (frozen, committed) manifest and a freshly recomputed one, it throws `HistoricalPostgresCorpusIntegrityError` naming the changed task entries whenever the two share a `corpusId` but disagree on `corpusHash` - silent in-place mutation under the same id. It is silent whenever the hash matches, or whenever `corpusId` genuinely differs (a legitimate new version).
- Pilot feedback from #180 must not mutate the active frozen corpus; #180 is a one-way consumer of the frozen manifest's hash.

## Producing the frozen manifest

`scripts/historical-postgres-201-freeze.ts` materializes all three real tasks (via the existing `historicalPostgres00{1,2,3}TaskSpec()` functions and `materializeHistoricalPostgresTask()`) against the real local PostgreSQL mirror and writes `corpus/historical-postgres-corpus-v0.json` - the committed, versioned freeze artifact. Like every other real-mirror entry point in this codebase (`scripts/historical-postgres-{184,199,200}.ts`), it fails loudly rather than partially freezing when required inputs are missing:

```sh
export HONEYRAIL_PG_184_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_184_REPRODUCER=/private/path/to/known-repro-001.sql   # optional, matches case 001's own script

export HONEYRAIL_PG_200_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_200_REPRODUCER=/private/path/to/known-repro-002.sql  # required, matches case 002's own script

export HONEYRAIL_PG_199_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_199_REPRODUCER=/private/path/to/known-repro-003.sql       # required
export HONEYRAIL_PG_199_PRIVATE_TRUTH=/private/path/to/pg-199-private-truth.json  # required

npm run historical-pg-201-freeze
```

The written file contains only hashes and the same class of sanitized fields already present in each task's own public `task-manifest.json` - never a revision, an upstream bug identifier, or oracle content.

## Corpus-level validation

`test/historical-postgres-corpus.test.ts` runs entirely against the synthetic fixture repo already used by `test/historical-postgres-task.test.ts` (`test/helpers/postgres-source-fixture.ts`) - no PostgreSQL mirror or Docker required - and covers: manifest canonicalization/hash stability, order-independence, partition correctness (no `HOLDOUT` slot), immutable-freeze enforcement (same id/different hash throws; same id/same hash and different id/different hash do not), integrity mismatches (missing task, duplicate task, unrecognized extra task, wrong holdout disclaimer), corpus-level leakage audit (the serialized manifest never contains any revision, upstream bug id, or oracle content from the underlying specs), the shared artifact contract, and the outcome vocabulary.

The real two-revision, real-mirror proof per task (that the historical ref reproduces and the reference ref does not, under each task's own oracle) is already covered per task by `test/historical-postgres-{199,200}-integration.test.ts` and `test/historical-postgres-integration.test.ts` (case 001/#184); #201 does not duplicate that grading logic, it only proves the three already-proven tasks compose into one consistent, hash-frozen corpus.
