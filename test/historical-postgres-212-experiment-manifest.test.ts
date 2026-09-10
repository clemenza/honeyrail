import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HistoricalPostgres212ExperimentManifestIntegrityError,
  assertHistoricalPostgres212ManifestUnchanged,
  buildHistoricalPostgres212ExperimentManifest,
  collectHistoricalPostgres212ConditionHashes,
  loadHistoricalPostgres212ExperimentManifest,
  writeHistoricalPostgres212ExperimentManifest,
  type HistoricalPostgres212ExperimentIdentity
} from "../server/postgres/historical-postgres-212-experiment-manifest.js";
import type { ContainerImageIdentity } from "../server/postgres/image-identity.js";

function fakeImage(): ContainerImageIdentity {
  return {
    reference: "honeyrail-postgres-research-agent-dsh:latest",
    id: `sha256:${"a".repeat(64)}`,
    digest: null,
    platform: "linux/arm64",
    os: "linux",
    architecture: "arm64",
    variant: null
  };
}

function fakeIdentity(overrides: Partial<HistoricalPostgres212ExperimentIdentity> = {}, artifactRoot: string): HistoricalPostgres212ExperimentIdentity {
  return {
    experimentId: "exp216-e0e3-dsh-2026-09-09",
    repositoryCommit: "7f5d0f76769cb4d4b729000265205ccec004de2d",
    taskId: "postgres-change-001",
    scaffoldingLevels: ["E0", "E1", "E2", "E3"],
    executionOrder: ["E0", "E1", "E2", "E3"],
    agentBackend: "DSH CLI, headless profile",
    agentImage: fakeImage(),
    postgresRevisions: { historical: "280a408b48d5ee42969f981bceb9e9426c3a344c", reference: "fadcc4e81bd99e6032ae042cae53be0c6eea7580" },
    agentTimeoutMs: 1_800_000,
    tokenToolBudgetPolicy: "not enforced by this path",
    isolationPolicy: { restrictedEgress: true, upstreamUrl: "https://api.deepseek.com", scoredEligibleExpected: true },
    trajectoryExpectation: "dsh",
    retryPolicy: "new attempt id per retry",
    artifactRoot,
    ...overrides
  };
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), "hp212-exp-manifest-"));
}

test("buildHistoricalPostgres212ExperimentManifest produces a schemaVersion 1 manifest with no per-condition hashes by default", async () => {
  const root = await tempDir();
  const manifest = buildHistoricalPostgres212ExperimentManifest({
    identity: fakeIdentity({}, root),
    dshVersion: "0.1.0-rc.7",
    modelProvider: "api.deepseek.com",
    modelVersion: "deepseek-v4-flash",
    engineeringDryRun: { path: `${root}/DRY-RUN-E0` }
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.engineeringDryRun?.excludedFromFormalLedger, true);
  assert.deepEqual(manifest.perConditionMaterializationHashes, {});
});

test("collectHistoricalPostgres212ConditionHashes omits levels without a materialized task-manifest.json", async () => {
  const root = await tempDir();
  await mkdir(join(root, "E0"), { recursive: true });
  await writeFile(join(root, "E0", "task-manifest.json"), JSON.stringify({ hashes: { sourceTree: "abc" } }));
  const hashes = await collectHistoricalPostgres212ConditionHashes(root, ["E0", "E1", "E2", "E3"]);
  assert.deepEqual(hashes, { E0: { sourceTree: "abc" } });
  assert.equal("E1" in hashes, false);
});

test("writeHistoricalPostgres212ExperimentManifest is idempotent and picks up newly materialized per-condition hashes", async () => {
  const root = await tempDir();
  const identity = fakeIdentity({}, root);
  const inputs = {
    identity,
    dshVersion: "0.1.0-rc.7",
    modelProvider: "api.deepseek.com",
    modelVersion: "deepseek-v4-flash",
    engineeringDryRun: { path: `${root}/DRY-RUN-E0` }
  };

  const first = await writeHistoricalPostgres212ExperimentManifest(root, inputs);
  assert.deepEqual(first.perConditionMaterializationHashes, {});

  await mkdir(join(root, "E0"), { recursive: true });
  await writeFile(join(root, "E0", "task-manifest.json"), JSON.stringify({ hashes: { sourceTree: "abc" } }));

  const second = await writeHistoricalPostgres212ExperimentManifest(root, inputs);
  assert.deepEqual(second.perConditionMaterializationHashes, { E0: { sourceTree: "abc" } });
  // createdAt is preserved across refreshes, not reset each call.
  assert.equal(second.createdAt, first.createdAt);

  const onDisk = await loadHistoricalPostgres212ExperimentManifest(root);
  assert.deepEqual(onDisk, second);
});

test("writeHistoricalPostgres212ExperimentManifest refuses to overwrite when an identity-defining field would change", async () => {
  const root = await tempDir();
  const inputs = {
    identity: fakeIdentity({}, root),
    dshVersion: "0.1.0-rc.7",
    modelProvider: "api.deepseek.com",
    modelVersion: "deepseek-v4-flash",
    engineeringDryRun: null
  };
  await writeHistoricalPostgres212ExperimentManifest(root, inputs);

  await assert.rejects(
    () =>
      writeHistoricalPostgres212ExperimentManifest(root, {
        ...inputs,
        identity: fakeIdentity({ agentTimeoutMs: 60_000 }, root)
      }),
    HistoricalPostgres212ExperimentManifestIntegrityError
  );
});

test("assertHistoricalPostgres212ManifestUnchanged does not throw when only createdAt or perConditionMaterializationHashes differ", async () => {
  const root = await tempDir();
  const identity = fakeIdentity({}, root);
  const existing = buildHistoricalPostgres212ExperimentManifest({
    identity,
    dshVersion: "0.1.0-rc.7",
    modelProvider: "api.deepseek.com",
    modelVersion: "deepseek-v4-flash",
    engineeringDryRun: null,
    perConditionMaterializationHashes: { E0: { sourceTree: "abc" } },
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  // Same identity, different createdAt/perConditionMaterializationHashes - must not throw.
  assert.doesNotThrow(() => assertHistoricalPostgres212ManifestUnchanged(existing, identity));
});
