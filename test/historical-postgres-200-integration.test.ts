import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { historicalPostgres002TaskSpec, gradeHistoricalPostgresSubmission, materializeHistoricalPostgresTask } from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_200_MIRROR || "").trim();
const knownReproducer = String(process.env.HONEYRAIL_PG_200_REPRODUCER || "").trim();

test("#200 known local PostgreSQL verification distinguishes the pinned historical and corrected revisions", { skip: !mirror }, async () => {
  assert.ok(knownReproducer, "HONEYRAIL_PG_200_REPRODUCER is required whenever HONEYRAIL_PG_200_MIRROR configures this integration test");
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg200-integration-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
  await writeFile(
    join(workspace, "finding.json"),
    JSON.stringify({ status: "reproduced", summary: "Known local historical-002 verification", reproducer: "repro.sql" })
  );
  const task = historicalPostgres002TaskSpec(resolve(mirror), resolve(knownReproducer));
  const grade = await gradeHistoricalPostgresSubmission({
    task,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts")
  });
  assert.equal(grade.status, "rediscovered", JSON.stringify(grade, null, 2));
  assert.equal(grade.historical.reproduced, true);
  assert.equal(grade.reference.reproduced, false);

  // Both `reproduced` booleans above are oracle-driven (see
  // resolveOracleReproduction), not the script's own exit status: the
  // historical run's captured stderr must actually match the declared
  // stale-plan signature, in order, and the reference run must be
  // *positively* attributed to the declared expected (fixed) baseline - not
  // merely fail to match the historical pattern for some unrelated reason.
  assert.equal(grade.historical.attribution?.attributedTo, "historical");
  assert.equal(grade.historical.attribution?.historicalMatch.satisfied, true);
  assert.equal(grade.historical.attribution?.historicalMatch.observations.length, 2);
  assert.equal(grade.reference.attribution?.attributedTo, "reference");
  assert.equal(grade.reference.attribution?.referenceMatch.satisfied, true);

  // The materialized task tree must not leak the bug identity or fixed ref
  // that the assertion above depends on grader-side.
  const layout = await materializeHistoricalPostgresTask(task, join(root, "task-bundle"));
  const publicManifest = JSON.stringify(layout.taskManifest);
  assert.ok(!publicManifest.includes("18574"));
  assert.ok(!publicManifest.includes("BUG #18574"));
  assert.ok(!publicManifest.includes("cache lookup"));
  assert.ok(!("referenceRevision" in layout.taskManifest));
  assert.equal(layout.taskManifest.taskId, "postgres-historical-002");
  assert.equal(layout.truthManifest.upstreamBug, "PostgreSQL BUG #18574");
  assert.equal(layout.truthManifest.commitFest, null);
  assert.equal(layout.truthManifest.referenceRevision, task.source.referenceRevision);
  assert.ok(layout.truthManifest.canonicalReproducerSha256);
  assert.equal(layout.truthManifest.canonicalReproducer, "verification/canonical-reproducer.sql");
  assert.ok(layout.truthManifest.behavioralOracle);
  assert.equal(layout.truthManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
  assert.equal(layout.referenceManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
});
