import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  historicalPostgres003TaskSpec,
  loadHistoricalPostgres003PrivateTruth,
  gradeHistoricalPostgresSubmission,
  materializeHistoricalPostgresTask,
  type HistoricalPostgresStructuredOracleAttribution
} from "../server/postgres/historical-task.js";

// ---------------------------------------------------------------------------
// Integration-config classifier
// ---------------------------------------------------------------------------

/**
 * Classifies the three required env-var inputs as UNCONFIGURED (none set),
 * PARTIALLY_CONFIGURED (some but not all set), or FULLY_CONFIGURED (all set).
 *
 * Exported so it can be unit-tested directly without needing Docker/a real
 * PostgreSQL mirror.
 */
export function classifyHistoricalPostgres199IntegrationConfig(env: {
  mirror: string;
  reproducer: string;
  privateTruthPath: string;
}): { state: "UNCONFIGURED" | "PARTIALLY_CONFIGURED" | "FULLY_CONFIGURED"; missing: string[] } {
  const all = [
    { key: "HONEYRAIL_PG_199_MIRROR", value: env.mirror },
    { key: "HONEYRAIL_PG_199_REPRODUCER", value: env.reproducer },
    { key: "HONEYRAIL_PG_199_PRIVATE_TRUTH", value: env.privateTruthPath }
  ];
  const missing = all.filter((e) => !e.value).map((e) => e.key);
  if (missing.length === 3) return { state: "UNCONFIGURED", missing };
  if (missing.length === 0) return { state: "FULLY_CONFIGURED", missing: [] };
  return { state: "PARTIALLY_CONFIGURED", missing };
}

// ---------------------------------------------------------------------------
// Unit tests for classifyHistoricalPostgres199IntegrationConfig
// Covers all 8 combinations of the three boolean inputs.
// ---------------------------------------------------------------------------

test("classifyHistoricalPostgres199IntegrationConfig: 0/3 set → UNCONFIGURED with all 3 missing", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({ mirror: "", reproducer: "", privateTruthPath: "" });
  assert.equal(result.state, "UNCONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_199_MIRROR", "HONEYRAIL_PG_199_PRIVATE_TRUTH", "HONEYRAIL_PG_199_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres199IntegrationConfig: only mirror set → PARTIALLY_CONFIGURED missing reproducer+privateTruth", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({ mirror: "/some/path", reproducer: "", privateTruthPath: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_199_PRIVATE_TRUTH", "HONEYRAIL_PG_199_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres199IntegrationConfig: only reproducer set → PARTIALLY_CONFIGURED missing mirror+privateTruth", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({ mirror: "", reproducer: "/some/repro.sql", privateTruthPath: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_199_MIRROR", "HONEYRAIL_PG_199_PRIVATE_TRUTH"].sort());
});

test("classifyHistoricalPostgres199IntegrationConfig: only privateTruth set → PARTIALLY_CONFIGURED missing mirror+reproducer", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({ mirror: "", reproducer: "", privateTruthPath: "/some/truth.json" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_199_MIRROR", "HONEYRAIL_PG_199_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres199IntegrationConfig: mirror+reproducer set (no privateTruth) → PARTIALLY_CONFIGURED missing privateTruth", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({ mirror: "/some/path", reproducer: "/some/repro.sql", privateTruthPath: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_199_PRIVATE_TRUTH"]);
});

test("classifyHistoricalPostgres199IntegrationConfig: mirror+privateTruth set (no reproducer) → PARTIALLY_CONFIGURED missing reproducer", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({ mirror: "/some/path", reproducer: "", privateTruthPath: "/some/truth.json" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_199_REPRODUCER"]);
});

test("classifyHistoricalPostgres199IntegrationConfig: reproducer+privateTruth set (no mirror) → PARTIALLY_CONFIGURED missing mirror", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({ mirror: "", reproducer: "/some/repro.sql", privateTruthPath: "/some/truth.json" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_199_MIRROR"]);
});

test("classifyHistoricalPostgres199IntegrationConfig: all 3 set → FULLY_CONFIGURED with 0 missing", () => {
  const result = classifyHistoricalPostgres199IntegrationConfig({
    mirror: "/some/path",
    reproducer: "/some/repro.sql",
    privateTruthPath: "/some/truth.json"
  });
  assert.equal(result.state, "FULLY_CONFIGURED");
  assert.deepEqual(result.missing, []);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL integration test
// ---------------------------------------------------------------------------

const mirror = String(process.env.HONEYRAIL_PG_199_MIRROR || "").trim();
const knownReproducer = String(process.env.HONEYRAIL_PG_199_REPRODUCER || "").trim();
const privateTruthPath = String(process.env.HONEYRAIL_PG_199_PRIVATE_TRUTH || "").trim();

const config = classifyHistoricalPostgres199IntegrationConfig({ mirror, reproducer: knownReproducer, privateTruthPath });

test(
  "#199 known local PostgreSQL verification distinguishes the pinned historical and corrected revisions",
  { skip: config.state === "UNCONFIGURED" ? "HONEYRAIL_PG_199_MIRROR, HONEYRAIL_PG_199_REPRODUCER, HONEYRAIL_PG_199_PRIVATE_TRUTH are not set" : false },
  async () => {
  // PARTIALLY_CONFIGURED: fail loudly — a partial configuration is a CI bug,
  // not a skip. The test must show up red, not as a silent skip, so the
  // missing env vars are surfaced immediately.
  if (config.state === "PARTIALLY_CONFIGURED") {
    assert.fail(
      `Integration test is partially configured — some but not all required env vars are set. ` +
      `Missing: ${config.missing.join(", ")}. ` +
      `Either set all three (HONEYRAIL_PG_199_MIRROR, HONEYRAIL_PG_199_REPRODUCER, HONEYRAIL_PG_199_PRIVATE_TRUTH) ` +
      `or none of them.`
    );
  }

  // FULLY_CONFIGURED — run the real integration.
  const privateTruth = await loadHistoricalPostgres003PrivateTruth(privateTruthPath);
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg199-integration-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
  await writeFile(
    join(workspace, "finding.json"),
    JSON.stringify({ status: "reproduced", summary: "Known local historical-003 verification", reproducer: "repro.sql" })
  );
  const task = historicalPostgres003TaskSpec(resolve(mirror), privateTruth, resolve(knownReproducer));
  const grade = await gradeHistoricalPostgresSubmission({
    task,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts")
  });
  assert.equal(grade.status, "rediscovered", JSON.stringify(grade, null, 2));
  assert.equal(grade.historical.reproduced, true);
  assert.equal(grade.reference.reproduced, false);

  // Both `reproduced` booleans above are structured-oracle-driven (see
  // resolveOracleReproduction), not the script's own exit status: the
  // historical run's captured stdout must return the exact expected buggy
  // tuple, and the reference run must be *positively* attributed to the
  // declared expected (fixed) tuple — not merely fail to match the
  // historical pattern for some unrelated reason.
  const historicalAttribution = grade.historical.attribution as HistoricalPostgresStructuredOracleAttribution | undefined;
  const referenceAttribution = grade.reference.attribution as HistoricalPostgresStructuredOracleAttribution | undefined;

  assert.equal(historicalAttribution?.attributedTo, "historical");
  assert.equal(historicalAttribution?.historicalMatch.satisfied, true);
  assert.equal(historicalAttribution?.historicalMatch.rows.length, 1);
  assert.equal(referenceAttribution?.attributedTo, "reference");
  assert.equal(referenceAttribution?.referenceMatch.satisfied, true);

  // The materialized task tree must not leak the bug identity or fixed ref
  // that the assertion above depends on grader-side.
  const layout = await materializeHistoricalPostgresTask(task, join(root, "task-bundle"));
  const publicManifest = JSON.stringify(layout.taskManifest);
  // Verify that the real private-truth values (from the loaded file) do NOT appear in task/
  assert.ok(!publicManifest.includes(privateTruth.upstreamBug));
  assert.ok(!publicManifest.includes(privateTruth.referenceRevision));
  assert.ok(!("referenceRevision" in layout.taskManifest));
  assert.equal(layout.taskManifest.taskId, "postgres-historical-003");
  assert.equal(layout.truthManifest.upstreamBug, privateTruth.upstreamBug);
  assert.equal(layout.truthManifest.commitFest, null);
  assert.equal(layout.truthManifest.referenceRevision, task.source.referenceRevision);
  assert.ok(layout.truthManifest.canonicalReproducerSha256);
  assert.equal(layout.truthManifest.canonicalReproducer, "verification/canonical-reproducer.sql");
  assert.ok(layout.truthManifest.structuredOracle);
  assert.equal(layout.truthManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
  assert.equal(layout.referenceManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
});
