import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveHistoricalPostgresTaskSpecFromEnv } from "../server/postgres/historical-postgres-task-env.js";

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

test("resolveHistoricalPostgresTaskSpecFromEnv: an unknown task id is rejected clearly", async () => {
  await assert.rejects(() => resolveHistoricalPostgresTaskSpecFromEnv("postgres-historical-999", {}), /No task-spec resolver registered for taskId "postgres-historical-999"/);
});
