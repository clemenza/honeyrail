import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveHistoricalPostgresTaskSpecFromEnv } from "../server/postgres/historical-postgres-task-env.js";
import { materializeHistoricalPostgresTask } from "../server/postgres/historical-task.js";
import { createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

/**
 * PR #208 review, Blocking 3: `scripts/historical-postgres-180-pilot.ts` and
 * `scripts/historical-pg-evals.ts` (#198's TrialSet runner) must share this
 * one resolver rather than each keeping its own per-taskId env-var branching.
 * These tests exercise the shared seam directly.
 */

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-historical-001 requires HONEYRAIL_PG_184_MIRROR", async () => {
  await assert.rejects(() => resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-001", {}), /HONEYRAIL_PG_184_MIRROR/);
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-historical-001 resolves with only a mirror (reproducer optional)", async () => {
  const spec = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-001", { HONEYRAIL_PG_184_MIRROR: "/tmp/some-mirror" });
  assert.equal(spec.taskId, "postgres-historical-001");
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-historical-002 requires both mirror and reproducer", async () => {
  await assert.rejects(
    () => resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-002", { HONEYRAIL_PG_200_MIRROR: "/tmp/some-mirror" }),
    /HONEYRAIL_PG_200_MIRROR and HONEYRAIL_PG_200_REPRODUCER/
  );
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-historical-002 resolves once both are set", async () => {
  const spec = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-002", {
    HONEYRAIL_PG_200_MIRROR: "/tmp/some-mirror",
    HONEYRAIL_PG_200_REPRODUCER: "/tmp/some-reproducer.sql"
  });
  assert.equal(spec.taskId, "postgres-historical-002");
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-historical-003 requires mirror, reproducer, and private truth", async () => {
  await assert.rejects(
    () => resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-003", { HONEYRAIL_PG_199_MIRROR: "/tmp/some-mirror" }),
    /HONEYRAIL_PG_199_MIRROR, HONEYRAIL_PG_199_REPRODUCER, and HONEYRAIL_PG_199_PRIVATE_TRUTH/
  );
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-historical-003 resolves given a valid private-truth file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg199-private-truth-"));
  const privateTruthPath = join(dir, "private-truth.json");
  await writeFile(
    privateTruthPath,
    JSON.stringify({
      upstreamBug: "Synthetic upstream #99999",
      historicalRevision: "0000000000000000000000000000000000000000",
      referenceRevision: "1111111111111111111111111111111111111111",
      structuredOracle: { historical: { rows: [["historical-row"]] }, reference: { rows: [["reference-row"]] } }
    })
  );
  const spec = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-003", {
    HONEYRAIL_PG_199_MIRROR: "/tmp/some-mirror",
    HONEYRAIL_PG_199_REPRODUCER: "/tmp/some-reproducer.sql",
    HONEYRAIL_PG_199_PRIVATE_TRUTH: privateTruthPath
  });
  assert.equal(spec.taskId, "postgres-historical-003");
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-change-001 requires its mirror and private truth", async () => {
  await assert.rejects(
    () => resolveHistoricalPostgresTaskSpecFromEnv("postgres-change-001", {}),
    /HONEYRAIL_PG_212_MIRROR and HONEYRAIL_PG_212_PRIVATE_TRUTH/
  );
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-change-001 keeps the reproducer optional and rejects invalid scaffolding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg212-env-"));
  const privateTruthPath = join(dir, "private-truth.json");
  await writeFile(
    privateTruthPath,
    JSON.stringify({
      upstreamBug: "Synthetic private upstream identity",
      historicalRevision: "a".repeat(40),
      referenceRevision: "b".repeat(40),
      introducingCommit: "a".repeat(40),
      structuredOracle: { historical: { rows: [["historical-row"]] }, reference: { rows: [["reference-row"]] } }
    })
  );
  const env = {
    HONEYRAIL_PG_212_MIRROR: "/tmp/some-mirror",
    HONEYRAIL_PG_212_PRIVATE_TRUTH: privateTruthPath
  };
  const spec = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-change-001", env);
  assert.equal(spec.taskId, "postgres-change-001");
  assert.equal(spec.truth.knownReproducerPath, undefined);
  await assert.rejects(
    () => resolveHistoricalPostgresTaskSpecFromEnv("postgres-change-001", { ...env, HONEYRAIL_PG_212_SCAFFOLDING: "E4" }),
    /HONEYRAIL_PG_212_SCAFFOLDING/
  );
});

test("resolveHistoricalPostgresTaskSpecFromEnv: postgres-change-001 passes explicit fix evidence through the shared normal path", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg212-resolver-evidence-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const privateTruthPath = join(root, "private-truth.json");
  const fixEvidencePath = join(root, "private-fix-evidence.diff");
  await writeFile(
    privateTruthPath,
    JSON.stringify({
      upstreamBug: "Synthetic private upstream identity",
      historicalRevision: repo.laterRef,
      // This is deliberately unresolved. Successful materialization proves
      // the resolver supplied the explicit evidence rather than falling back
      // to the automatic historical-vs-reference git diff.
      referenceRevision: "0".repeat(40),
      introducingCommit: repo.laterRef,
      structuredOracle: { historical: { rows: [["historical-row"]] }, reference: { rows: [["reference-row"]] } }
    })
  );
  await writeFile(fixEvidencePath, "private focused fix evidence\n");

  const spec = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-change-001", {
    HONEYRAIL_PG_212_MIRROR: repo.repoPath,
    HONEYRAIL_PG_212_PRIVATE_TRUTH: privateTruthPath,
    HONEYRAIL_PG_212_FIX_EVIDENCE: fixEvidencePath,
    HONEYRAIL_PG_212_SCAFFOLDING: "E2"
  });
  assert.equal(spec.truth.knownFixEvidencePath, fixEvidencePath);
  const layout = await materializeHistoricalPostgresTask(spec, join(root, "task-bundle"));
  assert.equal(layout.truthManifest.fixEvidence, "expected-behavior/fix-evidence");
});

test("resolveHistoricalPostgresTaskSpecFromEnv: an unknown task id is rejected clearly", async () => {
  await assert.rejects(() => resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-999", {}), /No task-spec resolver registered for taskId "postgres-historical-999"/);
});
