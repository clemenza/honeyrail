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
- `validateHistoricalPostgresCorpusManifest(manifest)` - full integrity check: every structural rule below (required fields, exactly the frozen v0 task set, correct partitions, exact holdout disclaimer, grading entry point, outcome vocabulary, artifact contract, expected hash-field formats), *and* recomputation of `corpusHash` from the manifest's own other fields, compared against the value the manifest claims. A manifest edited without updating its own `corpusHash` - a loaded, tampered/stale file, not just a malformed one - fails this even when every structural rule passes. Throws `HistoricalPostgresCorpusIntegrityError`, never returns a boolean, so a malformed or tampered manifest can never be mistaken for a task grade.
- `reconcileHistoricalPostgresCorpusFreeze({ existing, corpusId, freezeDate, environmentFingerprint, tasks })` - the actual freeze/re-freeze decision the freeze script defers to (see "Producing the frozen manifest" below): first freeze builds and returns a fresh manifest; a re-freeze under the same `corpusId` fully validates the existing on-disk manifest, recomputes a candidate from current inputs while preserving the recorded `freezeDate`, and either returns the existing manifest untouched (`action: "unchanged"`, a true no-op) or throws via `assertHistoricalPostgresCorpusNotMutated()`; a different `corpusId` at the same output path is refused outright rather than silently replacing a different corpus version.

Each task entry records only already-agent-sanitized fields: `sourceSnapshotHash`, `promptHash`, `taskDefinitionHash`, `truthBundleHash` (the hash only - never the bundle; this also covers `graderBundleVersion`, so a grader-semantics/version bump alone moves it), `agentWorkspaceHash` (the initial agent-visible `task/workspace/` scaffolding - never post-agent output), `buildContractHash` (the *declarative* build/runtime contract this task's `taskDefinitionHash` folds in - effective build mode, `BUILD_PROFILE_VERSION`, configure/initdb args, the effective `resolveBuildEnv()` pass-through - reusing `research-environment.ts`'s own resolvers rather than duplicating them; see "Resolved execution-environment fingerprint" below for what this alone cannot cover), `gradingProtocol`, `scaffoldingLevel`, `budget`, `buildProfile`, a shared `artifactContract` (identical across all three tasks, since all three share one generic materialize/grade/trial path - see `HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT`), and `provenanceReferences` (issue-tracker pointers such as `"#200"`, never a filesystem path or truth value). `outcomeVocabulary` is derived from an exhaustive `Record<HistoricalPostgresGradeStatus, true>` compile-time check against the real grading union in `historical-task.ts`, so it cannot silently go stale if a status is ever added or removed there.

## Resolved execution-environment fingerprint (#201 PR #206 second review, Blocking 1)

A declarative `buildContractHash` alone cannot detect every score-relevant environment change: `honeyrail-postgres-builder:latest`/`honeyrail-postgres-runtime:latest` are mutable tags, so a rebuilt or re-tagged image can keep the identical reference string while the daemon resolves a different, content-addressed image underneath it - and the compiler actually observed inside the build container is likewise only known once a docker daemon has been asked.

`historical-task.ts` exports `resolveHistoricalPostgresEnvironmentFingerprint({ build?, runtimeImage?, runCommand?, ambientEnv? })`, which reuses `resolveBuilderImageIdentity()`/`resolveRuntimeImageIdentity()` (content-addressed image ids, never a mutable tag alone) and `probeBuildContainerToolchain()` (the compiler actually observed inside the build container) from `build-container.ts`/`runtime-container.ts`, plus the same `defaultBuildMode()`/`resolveBuildEnv()`/`BUILD_PROFILE_VERSION` `buildContractHash` already uses. `runCommand` and `ambientEnv` are both injectable, so this is unit-testable against a fake docker responder with no real daemon and no mutation of global `process.env` (`test/historical-postgres-corpus.test.ts`).

This is a **corpus-level**, not per-task, field (`HistoricalPostgresCorpusManifest.environmentFingerprint`): it requires a real docker daemon, so - unlike `buildContractHash` - it is never resolved by `materializeHistoricalPostgresTask()` itself (which must stay usable against a synthetic fixture repo with no daemon at all, for every offline test in this codebase). It is instead resolved once by the real freeze script (`scripts/historical-postgres-201-freeze.ts`) and stored directly on the manifest, in the clear - none of it is private truth, and a reviewer/pilot needs to actually read it (which builder/runtime image, which compiler, which effective build env), not just compare it. Like every other field on the manifest, it participates in `corpusHash`, so a same-`corpusId` re-freeze under a changed resolved environment is rejected exactly like a changed task entry already is.

## Freeze/versioning rule

- Corpus v0 must freeze before #180's pilot runs against it.
- Any change to a task's source snapshot, prompt, task manifest, private truth, grader, build/runtime environment, scaffolding, or evidence contract requires a new corpus version/hash - i.e. a new `corpusId` (e.g. bump `historical-postgres-corpus-v0` to `-v1`), not an in-place edit under the same id.
- `assertHistoricalPostgresCorpusNotMutated(recorded, recomputed)` enforces this mechanically: given the previously recorded (frozen, committed) manifest and a freshly recomputed one, it throws `HistoricalPostgresCorpusIntegrityError` naming the changed task entries (and/or `environmentFingerprint`) whenever the two share a `corpusId` but disagree on `corpusHash` - silent in-place mutation under the same id. It is silent whenever the hash matches, or whenever `corpusId` genuinely differs (a legitimate new version).
- The freeze script (`scripts/historical-postgres-201-freeze.ts`) is idempotent by construction, via `reconcileHistoricalPostgresCorpusFreeze()`: re-running it against unchanged inputs (including an unchanged resolved environment) never rewrites the committed file - no new `freezeDate`, no new hash - and re-running it against changed inputs under the same `corpusId` fails loudly (`HistoricalPostgresCorpusIntegrityError`) instead of silently overwriting the frozen manifest.
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

`test/historical-postgres-corpus.test.ts` runs entirely against the synthetic fixture repo already used by `test/historical-postgres-task.test.ts` (`test/helpers/postgres-source-fixture.ts`), plus an injected fake `RunCommand` for the environment-fingerprint tests - no PostgreSQL mirror or real docker daemon required for any test in this file - and covers: manifest canonicalization/hash stability, order-independence, partition correctness (no `HOLDOUT` slot), immutable-freeze enforcement (same id/different hash throws; same id/same hash and different id/different hash do not), cross-manifest invariants (`taskManifest.hashes.taskDefinition`/`.truthBundle` must agree with the corresponding `referenceManifest` fields), freeze idempotency and same-`corpusId` mutation rejection across `reconcileHistoricalPostgresCorpusFreeze()` (agent-workspace contract, declarative build contract, resolved build/runtime execution environment, grader semantics/version, and an end-to-end task/truth-input change via the real materializer), the resolved-environment-fingerprint mechanism itself (effective build env, mutable-tag-vs-resolved-id, build profile version, effective mode, explicit override precedence - `resolveHistoricalPostgresEnvironmentFingerprint()` against a fake docker responder), loaded-manifest tamper detection (a structurally valid manifest whose `corpusHash` no longer matches its own contents, including one missing `environmentFingerprint` entirely), integrity mismatches (missing task, duplicate task, unrecognized extra task, wrong holdout disclaimer, malformed hash-field formats), corpus-level leakage audit (the serialized manifest never contains any revision, upstream bug id, or oracle content from the underlying specs), the shared artifact contract, and the outcome vocabulary.

The real two-revision, real-mirror proof per task (that the historical ref reproduces and the reference ref does not, under each task's own oracle) is already covered per task by `test/historical-postgres-{199,200}-integration.test.ts` and `test/historical-postgres-integration.test.ts` (case 001/#184); #201 does not duplicate that grading logic, it only proves the three already-proven tasks compose into one consistent, hash-frozen corpus.
