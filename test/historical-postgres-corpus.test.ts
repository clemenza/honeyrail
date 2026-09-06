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
  reconcileHistoricalPostgresCorpusFreeze,
  validateHistoricalPostgresCorpusManifest,
  type HistoricalPostgresCorpusManifest,
  type HistoricalPostgresCorpusTaskEntry
} from "../server/postgres/historical-corpus.js";
import {
  hashHistoricalPostgresEnvironmentFingerprint,
  materializeHistoricalPostgresTask,
  resolveHistoricalPostgresEnvironmentFingerprint,
  sha256,
  stableJson,
  type HistoricalPostgresEnvironmentFingerprint,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import type { RunCommand } from "../server/postgres/runtime.js";
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

/**
 * A structurally valid, entirely synthetic environment fingerprint for tests
 * that are not themselves exercising the fingerprint mechanism - the freeze
 * idempotency / mutation-rejection / tamper-detection tests below care about
 * the *tasks* half of the manifest, so they all share this one fixed value
 * rather than each resolving one for real (which would need docker). The
 * dedicated "resolved execution-environment fingerprint" section further
 * down tests the resolver itself, with an injected fake docker responder.
 */
const FAKE_ENVIRONMENT_FINGERPRINT: HistoricalPostgresEnvironmentFingerprint = {
  buildMode: "container",
  buildProfileVersion: "test-profile-v1",
  configureArgs: ["--without-readline", "--without-zlib", "--without-icu"],
  initdbArgs: ["-A", "trust", "-U", "postgres", "--no-locale"],
  buildEnv: {},
  builderImage: { reference: "honeyrail-postgres-builder:latest", id: `sha256:${"a".repeat(64)}` },
  runtimeImage: { reference: "honeyrail-postgres-runtime:latest", id: `sha256:${"b".repeat(64)}` },
  compiler: { command: "cc", version: "cc (GCC) 12.2.0", target: "x86_64-linux-gnu" }
};

/**
 * A fake `RunCommand` for `resolveHistoricalPostgresEnvironmentFingerprint()`
 * that answers both `docker image inspect <image>` (builder and runtime,
 * distinguished by which reference string is asked about) and the
 * toolchain-probe `docker run ... /bin/sh -c "..."` - without any real
 * docker daemon. The probe script's own delimiter is extracted from the
 * script text itself (rather than hardcoding build-container.ts's private
 * `PROBE_FIELD` constant), so this stays correct even if that constant's
 * literal value ever changes.
 */
function fakeDockerEnvironmentRunCommand(options: {
  builderId: string;
  runtimeId: string;
  compilerVersion?: string;
  compilerTarget?: string;
  make?: string;
}): RunCommand {
  return (async (command: string, args: string[] = []) => {
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
      const image = String(args[2] ?? "");
      const id = image.includes("runtime") ? options.runtimeId : options.builderId;
      const inspected = [{ Id: id, RepoDigests: [], Os: "linux", Architecture: "amd64" }];
      return { ok: true, stdout: `${JSON.stringify(inspected)}\n`, stderr: "", code: 0 };
    }
    if (command === "docker" && args[0] === "run") {
      const script = String(args[args.length - 1] ?? "");
      const delimiterMatch = /echo '([^']+)'/.exec(script);
      const delimiter = delimiterMatch?.[1] ?? "@@FIELD@@";
      const stdout = [
        options.compilerVersion ?? "cc (GCC) 12.2.0",
        delimiter,
        options.compilerTarget ?? "x86_64-linux-gnu",
        delimiter,
        options.make ?? "GNU Make 4.3"
      ].join("\n");
      return { ok: true, stdout, stderr: "", code: 0 };
    }
    throw new Error(`fakeDockerEnvironmentRunCommand: unexpected command "${command} ${args.join(" ")}"`);
  }) as unknown as RunCommand;
}

const FAKE_RUN_COMMAND = fakeDockerEnvironmentRunCommand({ builderId: `sha256:${"1".repeat(64)}`, runtimeId: `sha256:${"2".repeat(64)}` });

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
// Cross-manifest invariants (#201 PR #206 review, Blocking 3)
// ---------------------------------------------------------------------------

test("buildHistoricalPostgresCorpusTaskEntry rejects a taskManifest/referenceManifest pair whose taskDefinition hashes disagree", async () => {
  const { root, specs } = await corpusFixture();
  const layout = await materializeHistoricalPostgresTask(specs[0], join(root, "task-definition-mismatch"));
  const tamperedLayout = { ...layout, taskManifest: { ...layout.taskManifest, hashes: { ...layout.taskManifest.hashes, taskDefinition: "0".repeat(64) } } };
  assert.throws(
    () => buildHistoricalPostgresCorpusTaskEntry(tamperedLayout, []),
    (error: unknown) => error instanceof HistoricalPostgresCorpusIntegrityError && /taskDefinition/.test((error as Error).message)
  );
});

test("buildHistoricalPostgresCorpusTaskEntry rejects a taskManifest/referenceManifest pair whose truthBundle hashes disagree", async () => {
  const { root, specs } = await corpusFixture();
  const layout = await materializeHistoricalPostgresTask(specs[0], join(root, "truth-bundle-mismatch"));
  const tamperedLayout = { ...layout, taskManifest: { ...layout.taskManifest, hashes: { ...layout.taskManifest.hashes, truthBundle: "0".repeat(64) } } };
  assert.throws(
    () => buildHistoricalPostgresCorpusTaskEntry(tamperedLayout, []),
    (error: unknown) => error instanceof HistoricalPostgresCorpusIntegrityError && /truthBundle/.test((error as Error).message)
  );
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
  const first = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const second = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  assert.equal(first.corpusHash, second.corpusHash);
  assert.deepEqual(first, second);
});

test("buildHistoricalPostgresCorpusManifest hash is independent of input task array order", async () => {
  const { entries } = await corpusFixture();
  const forward = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const reversed = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: [...entries].reverse()
  });
  assert.equal(forward.corpusHash, reversed.corpusHash);
});

test("changing one task entry's hash moves the corpus hash", async () => {
  const { entries } = await corpusFixture();
  const baseline = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-002" ? { ...entry, truthBundleHash: "0".repeat(64) } : entry));
  const changed = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: mutated
  });
  assert.notEqual(baseline.corpusHash, changed.corpusHash);
});

test("changing freezeDate alone moves the corpus hash", async () => {
  const { entries } = await corpusFixture();
  const a = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const b = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-02T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  assert.notEqual(a.corpusHash, b.corpusHash);
});

test("changing environmentFingerprint alone moves the corpus hash", async () => {
  const { entries } = await corpusFixture();
  const a = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const rebuiltBuilder = { ...FAKE_ENVIRONMENT_FINGERPRINT, builderImage: { ...FAKE_ENVIRONMENT_FINGERPRINT.builderImage, id: `sha256:${"c".repeat(64)}` } };
  const b = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: rebuiltBuilder,
    tasks: entries
  });
  assert.notEqual(a.corpusHash, b.corpusHash);
});

// ---------------------------------------------------------------------------
// Immutable freeze enforcement
// ---------------------------------------------------------------------------

test("assertHistoricalPostgresCorpusNotMutated throws on same corpusId with a different hash", async () => {
  const { entries } = await corpusFixture();
  const recorded = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-003" ? { ...entry, truthBundleHash: "1".repeat(64) } : entry));
  const recomputed = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: mutated
  });
  assert.throws(
    () => assertHistoricalPostgresCorpusNotMutated(recorded, recomputed),
    (error: unknown) => error instanceof HistoricalPostgresCorpusIntegrityError && /postgres-historical-003/.test((error as Error).message)
  );
});

test("assertHistoricalPostgresCorpusNotMutated is silent when the recomputed manifest matches exactly", async () => {
  const { entries } = await corpusFixture();
  const recorded = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const recomputed = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  assert.doesNotThrow(() => assertHistoricalPostgresCorpusNotMutated(recorded, recomputed));
});

test("assertHistoricalPostgresCorpusNotMutated allows a genuinely new corpus version under a different corpusId", async () => {
  const { entries } = await corpusFixture();
  const recorded = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-001" ? { ...entry, truthBundleHash: "2".repeat(64) } : entry));
  const nextVersion = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v1",
    freezeDate: "2026-02-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: mutated
  });
  assert.doesNotThrow(() => assertHistoricalPostgresCorpusNotMutated(recorded, nextVersion));
});

// ---------------------------------------------------------------------------
// Freeze idempotency and same-corpusId mutation rejection (#201 PR #206
// review, Blocking 1): `reconcileHistoricalPostgresCorpusFreeze()` is the
// real freeze/re-freeze decision the freeze script defers to - these tests
// exercise it directly, not just its `assertHistoricalPostgresCorpusNotMutated()`
// building block.
// ---------------------------------------------------------------------------

test("reconcileHistoricalPostgresCorpusFreeze: first invocation creates; a second invocation against unchanged inputs is a true no-op (idempotent freeze)", async () => {
  const { entries } = await corpusFixture();
  const first = reconcileHistoricalPostgresCorpusFreeze({
    existing: undefined,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  assert.equal(first.action, "created");
  assert.equal(first.manifest.freezeDate, "2026-01-01T00:00:00.000Z");

  // Simulates a second real invocation: same corpusId, same task inputs, but
  // a freshly-generated `freezeDate` (exactly what `new Date().toISOString()`
  // would produce on a later run) - it must be ignored, not adopted.
  const second = reconcileHistoricalPostgresCorpusFreeze({
    existing: first.manifest,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-06-15T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  assert.equal(second.action, "unchanged");
  assert.deepEqual(second.manifest, first.manifest);
  assert.equal(second.manifest.freezeDate, "2026-01-01T00:00:00.000Z");
  assert.equal(second.manifest.corpusHash, first.manifest.corpusHash);
});

test("reconcileHistoricalPostgresCorpusFreeze: refuses to silently replace a manifest recorded under a different corpusId at the same output path", async () => {
  const { entries } = await corpusFixture();
  const first = reconcileHistoricalPostgresCorpusFreeze({
    existing: undefined,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  assert.throws(
    () =>
      reconcileHistoricalPostgresCorpusFreeze({
        existing: first.manifest,
        corpusId: "historical-postgres-corpus-v1",
        freezeDate: "2026-02-01T00:00:00.000Z",
        environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
        tasks: entries
      }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("reconcileHistoricalPostgresCorpusFreeze: same corpusId rejects when the agent-visible workspace contract changes", async () => {
  const { entries } = await corpusFixture();
  const first = reconcileHistoricalPostgresCorpusFreeze({
    existing: undefined,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-002" ? { ...entry, agentWorkspaceHash: "a".repeat(64) } : entry));
  assert.throws(
    () =>
      reconcileHistoricalPostgresCorpusFreeze({
        existing: first.manifest,
        corpusId: "historical-postgres-corpus-v0",
        freezeDate: "2026-06-15T00:00:00.000Z",
        environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
        tasks: mutated
      }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("reconcileHistoricalPostgresCorpusFreeze: same corpusId rejects when the declarative build contract changes", async () => {
  const { entries } = await corpusFixture();
  const first = reconcileHistoricalPostgresCorpusFreeze({
    existing: undefined,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-001" ? { ...entry, buildContractHash: "b".repeat(64) } : entry));
  assert.throws(
    () =>
      reconcileHistoricalPostgresCorpusFreeze({
        existing: first.manifest,
        corpusId: "historical-postgres-corpus-v0",
        freezeDate: "2026-06-15T00:00:00.000Z",
        environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
        tasks: mutated
      }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("reconcileHistoricalPostgresCorpusFreeze: same corpusId rejects when the resolved build/runtime execution environment changes", async () => {
  const { entries } = await corpusFixture();
  const first = reconcileHistoricalPostgresCorpusFreeze({
    existing: undefined,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  // Same builder tag/reference, different resolved image id - the exact
  // Problem A shape from #201 PR #206 second review, Blocking 1.
  const rebuiltEnvironment: HistoricalPostgresEnvironmentFingerprint = {
    ...FAKE_ENVIRONMENT_FINGERPRINT,
    builderImage: { ...FAKE_ENVIRONMENT_FINGERPRINT.builderImage, id: `sha256:${"d".repeat(64)}` }
  };
  assert.throws(
    () =>
      reconcileHistoricalPostgresCorpusFreeze({
        existing: first.manifest,
        corpusId: "historical-postgres-corpus-v0",
        freezeDate: "2026-06-15T00:00:00.000Z",
        environmentFingerprint: rebuiltEnvironment,
        tasks: entries
      }),
    (error: unknown) => error instanceof HistoricalPostgresCorpusIntegrityError && /environmentFingerprint/.test((error as Error).message)
  );
});

test("reconcileHistoricalPostgresCorpusFreeze: same corpusId rejects when grader semantics/version changes (truthBundleHash moves)", async () => {
  const { entries } = await corpusFixture();
  const first = reconcileHistoricalPostgresCorpusFreeze({
    existing: undefined,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  // A grader-semantics/version bump (HISTORICAL_POSTGRES_GRADER_BUNDLE_VERSION)
  // changes bundleHash/truthBundleHash without touching gradingProtocol - see
  // the dedicated bundleHash-coverage test below for the mechanism itself.
  const mutated = entries.map((entry) => (entry.taskId === "postgres-historical-003" ? { ...entry, truthBundleHash: "c".repeat(64) } : entry));
  assert.throws(
    () =>
      reconcileHistoricalPostgresCorpusFreeze({
        existing: first.manifest,
        corpusId: "historical-postgres-corpus-v0",
        freezeDate: "2026-06-15T00:00:00.000Z",
        environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
        tasks: mutated
      }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("reconcileHistoricalPostgresCorpusFreeze: same corpusId rejects an end-to-end task-input/truth change (real materializer, not a manual field edit)", async () => {
  const { root, repo, entries } = await corpusFixture();

  const first = reconcileHistoricalPostgresCorpusFreeze({
    existing: undefined,
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });

  const changedSpec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #10001 - revised", commitFest: 1001 },
    prompt: "Investigate case 001."
  };
  const changedLayout = await materializeHistoricalPostgresTask(changedSpec, join(root, "reconcile-changed-001"));
  const changedEntry = buildHistoricalPostgresCorpusTaskEntry(changedLayout, ["#reconcile"]);
  const originalEntry = entries.find((entry) => entry.taskId === "postgres-historical-001")!;
  assert.notEqual(changedEntry.truthBundleHash, originalEntry.truthBundleHash);

  const changedTasks = entries.map((entry) => (entry.taskId === "postgres-historical-001" ? changedEntry : entry));
  assert.throws(
    () =>
      reconcileHistoricalPostgresCorpusFreeze({
        existing: first.manifest,
        corpusId: "historical-postgres-corpus-v0",
        freezeDate: "2026-06-15T00:00:00.000Z",
        environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
        tasks: changedTasks
      }),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("graderBundleVersion participates in bundleHash: a grader-semantics/version bump forces a different truth bundle hash", async () => {
  const { specs, root } = await corpusFixture();
  const layout = await materializeHistoricalPostgresTask(specs[0], join(root, "grader-bundle-version"));
  const { bundleHash, ...shape } = layout.truthManifest;
  assert.equal(sha256(stableJson(shape)), bundleHash);
  const bumped = { ...shape, graderBundleVersion: shape.graderBundleVersion + 1 };
  assert.notEqual(sha256(stableJson(bumped)), bundleHash);
});

// ---------------------------------------------------------------------------
// Resolved execution-environment fingerprint (#201 PR #206 second review,
// Blocking 1): `resolveHistoricalPostgresEnvironmentFingerprint()` is the
// grader/operator-side step that covers what the declarative
// `buildContractHash` cannot without a docker daemon - resolved
// builder/runtime image content identity and the compiler actually observed
// inside the build container. Every test here uses an injected fake
// `RunCommand` and/or an injected `ambientEnv` object - no real docker daemon
// and no mutation of global `process.env`.
// ---------------------------------------------------------------------------

test("effective build env: CFLAGS=-O0 vs CFLAGS=-O2 (injected environment, not process.env) produce different fingerprints", async () => {
  const o0 = await resolveHistoricalPostgresEnvironmentFingerprint({ runCommand: FAKE_RUN_COMMAND, ambientEnv: { CFLAGS: "-O0" } });
  const o2 = await resolveHistoricalPostgresEnvironmentFingerprint({ runCommand: FAKE_RUN_COMMAND, ambientEnv: { CFLAGS: "-O2" } });
  assert.equal(o0.buildEnv.CFLAGS, "-O0");
  assert.equal(o2.buildEnv.CFLAGS, "-O2");
  assert.notEqual(hashHistoricalPostgresEnvironmentFingerprint(o0), hashHistoricalPostgresEnvironmentFingerprint(o2));
});

test("mutable image identity: same builder reference/tag, different resolved image id produces a different fingerprint", async () => {
  const before = await resolveHistoricalPostgresEnvironmentFingerprint({
    runCommand: fakeDockerEnvironmentRunCommand({ builderId: `sha256:${"1".repeat(64)}`, runtimeId: `sha256:${"2".repeat(64)}` }),
    ambientEnv: {}
  });
  // Simulates rebuilding/re-tagging the same mutable `:latest` reference: the
  // reference string this resolves against never changes (no build spec
  // override), only what the daemon now reports as the image's content id.
  const afterRebuild = await resolveHistoricalPostgresEnvironmentFingerprint({
    runCommand: fakeDockerEnvironmentRunCommand({ builderId: `sha256:${"9".repeat(64)}`, runtimeId: `sha256:${"2".repeat(64)}` }),
    ambientEnv: {}
  });
  assert.equal(before.builderImage.reference, afterRebuild.builderImage.reference);
  assert.notEqual(before.builderImage.id, afterRebuild.builderImage.id);
  assert.notEqual(hashHistoricalPostgresEnvironmentFingerprint(before), hashHistoricalPostgresEnvironmentFingerprint(afterRebuild));
});

test("build profile/version: a different buildProfileVersion produces a different fingerprint hash", async () => {
  const fingerprint = await resolveHistoricalPostgresEnvironmentFingerprint({ runCommand: FAKE_RUN_COMMAND, ambientEnv: {} });
  const bumped: HistoricalPostgresEnvironmentFingerprint = { ...fingerprint, buildProfileVersion: `${fingerprint.buildProfileVersion}-bumped` };
  assert.notEqual(hashHistoricalPostgresEnvironmentFingerprint(fingerprint), hashHistoricalPostgresEnvironmentFingerprint(bumped));
});

test("effective build mode: environment-resolved mode differences (HONEYRAIL_PG_BUILD_MODE) are reflected in the fingerprint", async () => {
  const containerMode = await resolveHistoricalPostgresEnvironmentFingerprint({
    runCommand: FAKE_RUN_COMMAND,
    ambientEnv: { HONEYRAIL_PG_BUILD_MODE: "container" }
  });
  const hostMode = await resolveHistoricalPostgresEnvironmentFingerprint({
    runCommand: FAKE_RUN_COMMAND,
    ambientEnv: { HONEYRAIL_PG_BUILD_MODE: "host" }
  });
  assert.equal(containerMode.buildMode, "container");
  assert.equal(hostMode.buildMode, "host");
  assert.notEqual(hashHistoricalPostgresEnvironmentFingerprint(containerMode), hashHistoricalPostgresEnvironmentFingerprint(hostMode));
});

test("an explicit build.mode override wins over the ambient HONEYRAIL_PG_BUILD_MODE, exactly like the real build path", async () => {
  const resolved = await resolveHistoricalPostgresEnvironmentFingerprint({
    build: { mode: "host" },
    runCommand: FAKE_RUN_COMMAND,
    ambientEnv: { HONEYRAIL_PG_BUILD_MODE: "container" }
  });
  assert.equal(resolved.buildMode, "host");
});

// ---------------------------------------------------------------------------
// Integrity mismatch: missing/duplicate/malformed manifest, never a task grade
// ---------------------------------------------------------------------------

/**
 * `buildHistoricalPostgresCorpusManifest()` always returns a manifest that
 * already passes its own `corpusHash`; each test below builds a genuinely
 * valid manifest first, then mutates a field *without* recomputing
 * `corpusHash` - the real "loaded a frozen manifest from disk" tamper shape
 * (#201 PR #206 review, Blocking 3) - and confirms
 * `validateHistoricalPostgresCorpusManifest()` rejects the result, whether or
 * not the specific structural check also independently catches it.
 */
async function validManifest() {
  const { entries } = await corpusFixture();
  return buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
}

test("validateHistoricalPostgresCorpusManifest rejects a missing task (stale corpusHash)", async () => {
  const manifest = await validManifest();
  const tampered: HistoricalPostgresCorpusManifest = { ...manifest, tasks: manifest.tasks.filter((task) => task.taskId !== "postgres-historical-003") };
  assert.throws(() => validateHistoricalPostgresCorpusManifest(tampered), HistoricalPostgresCorpusIntegrityError);
});

test("validateHistoricalPostgresCorpusManifest rejects a duplicate taskId (stale corpusHash)", async () => {
  const manifest = await validManifest();
  const tampered: HistoricalPostgresCorpusManifest = { ...manifest, tasks: [...manifest.tasks, manifest.tasks[0]] };
  assert.throws(() => validateHistoricalPostgresCorpusManifest(tampered), HistoricalPostgresCorpusIntegrityError);
});

test("validateHistoricalPostgresCorpusManifest rejects a manifest with an unrecognized extra task (stale corpusHash)", async () => {
  const manifest = await validManifest();
  const tampered: HistoricalPostgresCorpusManifest = { ...manifest, tasks: [...manifest.tasks, { ...manifest.tasks[0], taskId: "postgres-historical-004" }] };
  assert.throws(() => validateHistoricalPostgresCorpusManifest(tampered), HistoricalPostgresCorpusIntegrityError);
});

test("validateHistoricalPostgresCorpusManifest rejects a wrong/missing holdout disclaimer (stale corpusHash)", async () => {
  const manifest = await validManifest();
  const tampered: HistoricalPostgresCorpusManifest = { ...manifest, holdoutNote: "This corpus has a pristine HOLDOUT set." };
  assert.throws(() => validateHistoricalPostgresCorpusManifest(tampered), HistoricalPostgresCorpusIntegrityError);
});

test("validateHistoricalPostgresCorpusManifest (loaded-manifest tamper detection): any field edited without updating corpusHash is rejected", async () => {
  const manifest = await validManifest();
  // A structurally-valid-looking edit (a real hex hash, just the wrong one)
  // that none of the individual structural checks above would catch on its
  // own - only the corpusHash recomputation closes this gap.
  const tampered: HistoricalPostgresCorpusManifest = {
    ...manifest,
    tasks: manifest.tasks.map((task) => (task.taskId === "postgres-historical-002" ? { ...task, truthBundleHash: "f".repeat(64) } : task))
  };
  assert.throws(
    () => validateHistoricalPostgresCorpusManifest(tampered),
    (error: unknown) => error instanceof HistoricalPostgresCorpusIntegrityError && /stale or tampered/.test((error as Error).message)
  );
});

test("validateHistoricalPostgresCorpusManifest rejects malformed hash field formats", async () => {
  const manifest = await validManifest();
  const tampered = { ...manifest, tasks: manifest.tasks.map((task) => (task.taskId === "postgres-historical-001" ? { ...task, sourceSnapshotHash: "not-a-hash" } : task)) };
  assert.throws(() => validateHistoricalPostgresCorpusManifest(tampered as HistoricalPostgresCorpusManifest), HistoricalPostgresCorpusIntegrityError);
});

test("validateHistoricalPostgresCorpusManifest rejects a malformed environmentFingerprint (stale corpusHash)", async () => {
  const manifest = await validManifest();
  const tampered = { ...manifest, environmentFingerprint: { ...manifest.environmentFingerprint, builderImage: { reference: "", id: "" } } };
  assert.throws(() => validateHistoricalPostgresCorpusManifest(tampered as HistoricalPostgresCorpusManifest), HistoricalPostgresCorpusIntegrityError);
});

test("validateHistoricalPostgresCorpusManifest rejects a manifest entirely missing environmentFingerprint (a pre-fix frozen manifest) with a clean integrity error, not a raw TypeError", async () => {
  const manifest = await validManifest();
  const { environmentFingerprint: _dropped, ...withoutFingerprint } = manifest;
  assert.throws(
    () => validateHistoricalPostgresCorpusManifest(withoutFingerprint as unknown as HistoricalPostgresCorpusManifest),
    HistoricalPostgresCorpusIntegrityError
  );
});

test("validateHistoricalPostgresCorpusManifest accepts a genuinely unmodified manifest", async () => {
  const manifest = await validManifest();
  assert.doesNotThrow(() => validateHistoricalPostgresCorpusManifest(manifest));
});

test("buildHistoricalPostgresCorpusManifest itself refuses to build an invalid manifest rather than silently freezing it", async () => {
  const { entries } = await corpusFixture();
  const incomplete = entries.filter((entry) => entry.taskId !== "postgres-historical-002");
  assert.throws(
    () =>
      buildHistoricalPostgresCorpusManifest({
        corpusId: "historical-postgres-corpus-v0",
        freezeDate: "2026-01-01T00:00:00.000Z",
        environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
        tasks: incomplete
      }),
    HistoricalPostgresCorpusIntegrityError
  );
});

// ---------------------------------------------------------------------------
// Corpus-level isolation/leakage audit
// ---------------------------------------------------------------------------

test("the frozen corpus manifest never leaks revisions, upstream bug identifiers, or grader-private paths", async () => {
  const { specs, entries, repo } = await corpusFixture();
  const manifest = buildHistoricalPostgresCorpusManifest({
    corpusId: "historical-postgres-corpus-v0",
    freezeDate: "2026-01-01T00:00:00.000Z",
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
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
    environmentFingerprint: FAKE_ENVIRONMENT_FINGERPRINT,
    tasks: entries
  });
  assert.deepEqual(manifest.outcomeVocabulary, HISTORICAL_POSTGRES_CORPUS_OUTCOME_VOCABULARY);
  assert.ok(manifest.gradingEntryPoint.includes("materializeHistoricalPostgresTask"));
  assert.ok(manifest.gradingEntryPoint.includes("gradeHistoricalPostgresSubmission"));
  assert.ok(manifest.gradingEntryPoint.includes("runHistoricalPostgresTrial"));
  assert.equal(manifest.holdoutNote, HISTORICAL_POSTGRES_CORPUS_HOLDOUT_NOTE);
});
