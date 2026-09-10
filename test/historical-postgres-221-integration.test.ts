import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  gradeHistoricalPostgresSubmission,
  historicalPostgresChange18574TaskSpec,
  materializeHistoricalPostgresTask,
  type HistoricalPostgresOracleAttribution
} from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_221_MIRROR || "").trim();
const knownReproducer = String(process.env.HONEYRAIL_PG_221_REPRODUCER || "").trim();
const knownFixEvidence = String(process.env.HONEYRAIL_PG_221_FIX_EVIDENCE || "").trim();

test("#221 known local PostgreSQL verification distinguishes the pinned introducing and fix commits", { skip: !mirror }, async () => {
  assert.ok(knownReproducer, "HONEYRAIL_PG_221_REPRODUCER is required whenever HONEYRAIL_PG_221_MIRROR configures this integration test");
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg221-integration-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
  await writeFile(
    join(workspace, "finding.json"),
    JSON.stringify({ status: "reproduced", summary: "Known local postgres-change-002 verification", reproducer: "repro.sql" })
  );
  const task = historicalPostgresChange18574TaskSpec(
    resolve(mirror),
    "E0",
    resolve(knownReproducer),
    knownFixEvidence ? resolve(knownFixEvidence) : undefined
  );
  const grade = await gradeHistoricalPostgresSubmission({
    task,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts")
  });
  assert.equal(grade.status, "rediscovered", JSON.stringify(grade, null, 2));
  assert.equal(grade.historical.reproduced, true);
  assert.equal(grade.reference.reproduced, false);

  assert.equal(grade.historical.attribution?.attributedTo, "historical");
  assert.equal(grade.historical.attribution?.historicalMatch.satisfied, true);
  const historicalMatch = (grade.historical.attribution as HistoricalPostgresOracleAttribution).historicalMatch;
  assert.equal(historicalMatch.observations.length, 2);
  assert.equal(grade.reference.attribution?.attributedTo, "reference");
  assert.equal(grade.reference.attribution?.referenceMatch.satisfied, true);

  const layout = await materializeHistoricalPostgresTask(task, join(root, "task-bundle"));
  const publicManifest = JSON.stringify(layout.taskManifest);
  assert.ok(!publicManifest.includes("18574"));
  assert.ok(!publicManifest.includes("BUG #18574"));
  assert.ok(!publicManifest.includes("cache lookup"));
  assert.ok(!("referenceRevision" in layout.taskManifest));
  assert.equal(layout.taskManifest.taskId, "postgres-change-002");
  assert.equal(layout.truthManifest.upstreamBug, "PostgreSQL BUG #18574");
  assert.equal(layout.truthManifest.referenceRevision, task.source.referenceRevision);
  assert.ok(layout.truthManifest.canonicalReproducerSha256);
  assert.equal(layout.truthManifest.canonicalReproducer, "verification/canonical-reproducer.sql");
  assert.ok(layout.truthManifest.behavioralOracle);
  assert.equal(layout.truthManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
  assert.equal(layout.referenceManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
});

test("#221 known local verification is deterministic across repeated runs", { skip: !mirror }, async () => {
  assert.ok(knownReproducer, "HONEYRAIL_PG_221_REPRODUCER is required whenever HONEYRAIL_PG_221_MIRROR configures this integration test");
  const task = historicalPostgresChange18574TaskSpec(resolve(mirror), "E0", resolve(knownReproducer), knownFixEvidence ? resolve(knownFixEvidence) : undefined);
  const statuses: string[] = [];
  for (let i = 0; i < 3; i++) {
    const root = await mkdtemp(join(tmpdir(), `honeyrail-pg221-determinism-${i}-`));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
    await writeFile(
      join(workspace, "finding.json"),
      JSON.stringify({ status: "reproduced", summary: "determinism check", reproducer: "repro.sql" })
    );
    const grade = await gradeHistoricalPostgresSubmission({ task, workspaceDir: workspace, artifactDir: join(root, "artifacts") });
    statuses.push(grade.status);
  }
  assert.deepEqual(statuses, ["rediscovered", "rediscovered", "rediscovered"]);
});
