import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { commitfest7059TaskSpec, gradeHistoricalPostgresSubmission } from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_184_MIRROR || "").trim();
const knownReproducer = String(process.env.HONEYRAIL_PG_184_REPRODUCER || "").trim();

test("#184 known local PostgreSQL verification distinguishes the pinned historical and corrected revisions", { skip: !mirror }, async () => {
  assert.ok(knownReproducer, "HONEYRAIL_PG_184_REPRODUCER is required whenever HONEYRAIL_PG_184_MIRROR configures this integration test");
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg184-integration-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
  await writeFile(
    join(workspace, "finding.json"),
    JSON.stringify({ status: "reproduced", summary: "Known local #19560 verification", reproducer: "repro.sql" })
  );
  const grade = await gradeHistoricalPostgresSubmission({
    task: commitfest7059TaskSpec(resolve(mirror)),
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts")
  });
  assert.equal(grade.status, "rediscovered", JSON.stringify(grade, null, 2));
  assert.equal(grade.historical.reproduced, true);
  assert.equal(grade.reference.reproduced, false);
});
