import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT,
  HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE,
  HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY,
  HISTORICAL_POSTGRES_CORPUS_PARTITIONS,
  HistoricalPostgresCorpusIntegrityError,
  assertHistoricalPostgresCorpusNotMutated,
  buildHistoricalPostgresCorpusManifest,
  buildHistoricalPostgresCorpusTaskEntry,
  validateHistoricalPostgresCorpusManifest,
  type HistoricalPostgresCorpusManifest,
  type HistoricalPostgresCorpusTaskEntry
} from "../server/postgres/historical-corpus.js";
import { materializeHistoricalPostgresTask, type HistoricalPostgresTaskSpec } from "../server/postgres/historical-task.js";
import { createAdditionalSyntheticCommit, createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

/**
 * Three synthetic specs, one per real grading protocol (plain exit-status,
 * behavioral/regex oracle, structured-output oracle), materialized through
 * the exact same generic `materializeHistoricalPostgresTask()` every real
 * task uses - proves the corpus layer (and the underlying materializer) has
 * no per-task branch, without needing the real PostgreSQL mirror or Docker.
 * Task ids are the real frozen corpus ids so partition lookup succeeds.
 */
async function corpusFixture() {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-corpus-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const fixedForCase002 = await createAdditionalSyntheticCommit(repo.repoPath, "case-002-fixed");
  const fixedForCase003 = await createAdditionalSyntheticCommit(repo.repoPath, "case-003-fixed");

  const specs: HistoricalPostgresTaskSpec[] = [
    {
      taskId: "postgres-historical-001",
      source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
      truth: { upstreamBug: "Synthetic upstream #10001", commitFest: 1001 },
      prompt: "Investigate case 001."
    },
    {
      taskId: "postgres-historical-002",
      source: { repoPath: repo.repoPath, historicalRevision: repo.laterRef, referenceRevision: fixedForCase002 },
      truth: {
        upstreamBug: "Synthetic upstream #10002",
        behavioralOracle: {
          historical: [{ label: "first", matches: "^synthetic historical error$" }],
          reference: [{ label: "first", matches: "^synthetic reference error$" }]
        }
      },
      prompt: "Investigate case 002."
    },
    {
      taskId: "postgres-historical-003",
      source: { repoPath: repo.repoPath, historicalRevision: fixedForCase002, referenceRevision: fixedForCase003 },
      truth: {
        upstreamBug: "Synthetic upstream #10003",
        structuredOracle: { historical: { rows: [["historical-row"]] }, reference: { rows: [["reference-row"]] } }
      },
      prompt: "Investigate case 003."
    }
  ];

  const entries: HistoricalPostgresCorpusTaskEntry[] = [];
  for (const spec of specs) {
    const layout = await materializeHistoricalPostgresTask(spec, join(root, spec.taskId));
    entries.push(buildHistoricalPostgresCorpusTaskEntry(layout, [`#${spec.taskId}`]));
  }
  return { root, repo, specs, entries };
}

// ---------------------------------------------------------------------------
// Partition correctness (#201 partition correction)
// ---------------------------------------------------------------------------

test("Corpus v0 partition has no HOLDOUT slot anywhere", () => {
  const partitions = Object.values(HISTORICAL_POSTGRES_CORPUS_PARTITIONS);
  assert.ok(!partitions.includes("HOLDOUT"), `expected no HOLDOUT partition, got: ${partitions.join(", ")}`);
  assert.deepEqual(HISTORICAL_POSTGRES_CORPUS_PARTITIONS, {
    "postgres-historical-001": "TRAIN",
    "postgres-historical-002": "FRONTIER",
    "postgres-historical-003": "FRONTIER"
  });
});

test("all three task entries materialize with the corrected partition", async () => {
  const { entries } = await corpusFixture();
  const byId = new Map(entries.map((entry) => [entry.taskId, entry]));
  assert.equal(byId.get("postgres-historical-001")?.partition, "TRAIN");
  assert.equal(byId.get("postgres-historical-002")?.partition, "FRONTIER");
  assert.equal(byId.get("postgres-historical-003")?.partition, "FRONTIER");
});

test("buildHistoricalPostgresCorpusTaskEntry refuses an unknown taskId rather than defaulting a partition", async () => {
  const { root, repo } = await corpusFixture();
  const unknownSpec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-999",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #99999" },
    prompt: "Investigate case 999."
  };
  const layout = await materializeHistoricalPostgresTask(unknownSpec, join(root, "unknown-case"));
  assert.throws(() => buildHistoricalPostgresCorpusTaskEntry(layout, []), HistoricalPostgresCorpusIntegrityError);
});

// ---------------------------------------------------------------------------
// Task materialization through the shared generic path (no bug-specific branch)
// ---------------------------------------------------------------------------

test("all three entries share an identical, generic artifact contract regardless of grading protocol", async () => {
  const { entries } = await corpusFixture();
  assert.equal(entries.length, 3);
  const distinctProtocols = new Set(entries.map((entry) => entry.gradingProtocol));
  assert.equal(distinctProtocols.size, 3, "the three synthetic tasks should exercise three distinct grading protocols");
  for (const entry of entries) {
    assert.equal(entry.artifactContract, HISTORICAL_POSTGRES_CORPUS_ARTIFACT_CONTRACT);
  }
});

test("corpus entries expose only shape-level fields shared by every entry (same keys regardless of taskId)", async () => {
  const { entries } = await corpusFixture();
  const [first, ...rest] = entries;
  const expectedKeys = Object.keys(first).sort();
  for (const entry of rest) {
    assert.deepEqual(Object.keys(entry).sort(), expectedKeys);
  }
});

// ---------------------------------------------------------------------------
// Manifest canonicalization / hash stability / repeated-run stability
// ---------------------------------------------------------------------------

test("buildHistoricalPostgresCorpusManifest is deterministic across repeated runs on the same inputs", async () => {
  const { entries } = await corpusFixture();
  const first = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const second = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  assert.equal(first.corpusHash, second.corpusHash);
  assert.deepEqual(first, second);
});

test("buildHistoricalPostgresCorpusManifest hash is independent of input task array order", async () => {
  const { entries } = await corpusFixture();
  const forward = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const reversed = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: [...entries].reverse() });
  assert.equal(forward.corpusHash, reversed.corpusHash);
});

test("changing one task entry's hash moves the corpus hash", async () => {
  const { entries } = await corpusFixture();
  const baseline = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-002" ? { ...entry, truthBundleHash: "0".repeat(64) } : entry));
  const changed = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: mutated });
  assert.notEqual(baseline.corpusHash, changed.corpusHash);
});

test("changing freezeDate alone moves the corpus hash", async () => {
  const { entries } = await corpusFixture();
  const a = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const b = buildHistoricalPostgresCorpusManifest({ corpusId: "test-corpus-v0", freezeDate: "2026-01-02T00:00:00.000Z", tasks: entries });
  assert.notEqual(a.corpusHash, b.corpusHash);
});

// ---------------------------------------------------------------------------
// Immutable freeze enforcement
// ---------------------------------------------------------------------------

test("assertHistoricalPostgresCorpusNotMutated throws on same corpusId with a different hash", async () => {
  const { entries } = await corpusFixture();
  const recorded = buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-003" ? { ...entry, truthBundleHash: "1".repeat(64) } : entry));
  const recomputed = buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: mutated });
  assert.throws(
    () => assertHistoricalPostgresCorpusNotMutated(recorded, recomputed),
    (error: unknown) => error instanceof HistoricalPostgresCorpusIntegrityError && /postgres-historical-003/.test((error as Error).message)
  );
});

test("assertHistoricalPostgresCorpusNotMutated is silent when the recomputed manifest matches exactly", async () => {
  const { entries } = await corpusFixture();
  const recorded = buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const recomputed = buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  assert.doesNotThrow(() => assertHistoricalPostgresCorpusNotMutated(recorded, recomputed));
});

test("assertHistoricalPostgresCorpusNotMutated allows a genuinely new corpus version under a different corpusId", async () => {
  const { entries } = await corpusFixture();
  const recorded = buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-001" ? { ...entry, truthBundleHash: "2".repeat(64) } : entry));
  const nextVersion = buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v1", freezeDate: "2026-02-01T00:00:00.000Z", tasks: mutated });
  assert.doesNotThrow(() => assertHistoricalPostgresCorpusNotMutated(recorded, nextVersion));
});

// ---------------------------------------------------------------------------
// Integrity mismatch: missing/duplicate/malformed manifest, never a task grade
// ---------------------------------------------------------------------------

test("validateHistoricalPostgresCorpusManifest rejects a missing task", async () => {
  const { entries } = await corpusFixture();
  const incomplete = entries.filter((entry) => entry.taskId !== "postgres-historical-003");
  assert.throws(
    () => validateHistoricalPostgresCorpusManifest({ tasks: incomplete, holdoutNote: HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("validateHistoricalPostgresCorpusManifest rejects a duplicate taskId", async () => {
  const { entries } = await corpusFixture();
  const duplicated = [...entries, entries[0]];
  assert.throws(
    () => validateHistoricalPostgresCorpusManifest({ tasks: duplicated, holdoutNote: HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("validateHistoricalPostgresCorpusManifest rejects a manifest with an unrecognized extra task", async () => {
  const { entries } = await corpusFixture();
  const extra = [...entries, { ...entries[0], taskId: "postgres-historical-004" }];
  assert.throws(
    () => validateHistoricalPostgresCorpusManifest({ tasks: extra, holdoutNote: HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("validateHistoricalPostgresCorpusManifest rejects a wrong/missing holdout disclaimer", async () => {
  const { entries } = await corpusFixture();
  assert.throws(
    () => validateHistoricalPostgresCorpusManifest({ tasks: entries, holdoutNote: "This corpus has a pristine HOLDOUT set." }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("buildHistoricalPostgresCorpusManifest itself refuses to build an invalid manifest rather than silently freezing it", async () => {
  const { entries } = await corpusFixture();
  const incomplete = entries.filter((entry) => entry.taskId !== "postgres-historical-002");
  assert.throws(
    () => buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: incomplete }),
    HistoricalPostgresCorpusIntegrityError
  );
});

// ---------------------------------------------------------------------------
// Corpus-level isolation/leakage audit
// ---------------------------------------------------------------------------

test("the frozen corpus manifest never leaks revisions, upstream bug identifiers, or grader-private paths", async () => {
  const { specs, entries, repo } = await corpusFixture();
  const manifest = buildHistoricalPostgresCorpusManifest({ corpusId: "historical-postgres-corpus-v0", freezeDate: "2026-01-01T00:00:00.000Z", tasks: entries });
  const serialized = JSON.stringify(manifest);
  const secrets: Record<string, string> = {
    "case-001 historical revision": specs[0].source.historicalRevision,
    "case-001 reference revision": specs[0].source.referenceRevision,
    "case-002 reference revision": specs[1].source.referenceRevision,
    "case-003 historical revision": specs[2].source.historicalRevision,
    "case-003 reference revision": specs[2].source.referenceRevision,
    "case-001 upstream bug id": "10001",
    "case-002 upstream bug id": "10002",
    "case-003 upstream bug id": "10003",
    "case-001 CommitFest id": "1001",
    "grader-private mirror path": repo.repoPath,
    "case-002 behavioral oracle text": "synthetic historical error",
    "case-003 structured oracle row": "historical-row"
  };
  for (const [label, secret] of Object.entries(secrets)) {
    assert.ok(!serialized.includes(secret), `corpus manifest leaked ${label}`);
  }
});

// ---------------------------------------------------------------------------
// Outcome vocabulary / grading entry point
// ---------------------------------------------------------------------------

test("outcome vocabulary is exactly the 6 known grade statuses, once each", () => {
  assert.deepEqual(
    [...HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY].sort(),
    ["blocked", "infrastructure_error", "integrity_error", "invalid_submission", "miss", "rediscovered"]
  );
  assert.equal(new Set(HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY).size, HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY.length);
});

test("frozen manifest publishes the outcome vocabulary and grading entry point", async () => {
  const { entries } = await corpusFixture();
  const manifest: HistoricalPostgresCorpusManifest = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    tasks: entries
  });
  assert.deepEqual(manifest.outcomeVocabulary, HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY);
  assert.ok(manifest.gradingEntryPoint.includes("materializeHistoricalPostgresTask"));
  assert.ok(manifest.gradingEntryPoint.includes("gradeHistoricalPostgresSubmission"));
  assert.ok(manifest.gradingEntryPoint.includes("runHistoricalPostgresTrial"));
  assert.equal(manifest.holdoutNote, HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE);
});
