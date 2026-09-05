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

const mirror = String(process.env.HONEYRAIL_PG_199_MIRROR || "").trim();
const knownReproducer = String(process.env.HONEYRAIL_PG_199_REPRODUCER || "").trim();
const privateTruthPath = String(process.env.HONEYRAIL_PG_199_PRIVATE_TRUTH || "").trim();

// Both mirror and private truth file are required for this integration test.
// Skip when either is absent (same guard pattern as the existing MIRROR skip).
const skipReason = !mirror ? "HONEYRAIL_PG_199_MIRROR not set" : !privateTruthPath ? "HONEYRAIL_PG_199_PRIVATE_TRUTH not set" : "";

test("#199 known local PostgreSQL verification distinguishes the pinned historical and corrected revisions", { skip: !!skipReason }, async () => {
  assert.ok(knownReproducer, "HONEYRAIL_PG_199_REPRODUCER is required whenever HONEYRAIL_PG_199_MIRROR configures this integration test");
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
