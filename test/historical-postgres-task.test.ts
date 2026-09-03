import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_HISTORICAL_POSTGRES_REPRO_BYTES,
  gradeHistoricalPostgresSubmission,
  materializeHistoricalPostgresTask,
  validateHistoricalPostgresSubmission,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-task-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-historical-pg",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for correctness regressions."
  };
  return { root, spec };
}

test("historical task materialization keeps the scored tree and reference bundle separate", async () => {
  const { root, spec } = await fixture();
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  assert.equal(JSON.parse(await readFile(task.taskManifestPath, "utf8")).taskId, spec.taskId);
  assert.equal(JSON.parse(await readFile(task.referenceManifestPath, "utf8")).referenceRevision, spec.source.referenceRevision);
  await assert.rejects(readFile(join(task.workspaceDir, "reference-manifest.json"), "utf8"));
  await assert.rejects(readFile(join(task.sourceDir, ".git", "HEAD"), "utf8"));
  assert.ok(task.taskManifest.hashes.taskDefinition);
  assert.ok(task.taskManifest.hashes.referenceBundle);
});

test("historical grader deterministically classifies all submission outcomes", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "observed", reproducer: "repro.sql" }));
  const grade = async ({ revision }: { revision: string }) => ({ reproduced: revision === spec.source.historicalRevision });
  assert.equal((await gradeHistoricalPostgresSubmission({ task: spec, workspaceDir: workspace, artifactDir: join(root, "rediscovered"), gradeRevision: grade })).status, "rediscovered");
  assert.equal((await gradeHistoricalPostgresSubmission({ task: spec, workspaceDir: workspace, artifactDir: join(root, "miss"), gradeRevision: async () => ({ reproduced: false }) })).status, "miss");
  assert.equal((await gradeHistoricalPostgresSubmission({ task: spec, workspaceDir: workspace, artifactDir: join(root, "nonspecific"), gradeRevision: async () => ({ reproduced: true }) })).status, "invalid_submission");
  await writeFile(join(workspace, "finding.json"), "{}");
  const invalidArtifactDir = join(root, "invalid");
  assert.equal((await gradeHistoricalPostgresSubmission({ task: spec, workspaceDir: workspace, artifactDir: invalidArtifactDir, gradeRevision: grade })).status, "invalid_submission");
  assert.equal(JSON.parse(await readFile(join(invalidArtifactDir, "grade.json"), "utf8")).status, "invalid_submission");
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "observed", reproducer: "repro.sql" }));
  assert.equal((await gradeHistoricalPostgresSubmission({ task: spec, workspaceDir: workspace, artifactDir: join(root, "infra"), gradeRevision: async () => { throw new Error("runtime unavailable"); } })).status, "infrastructure_error");
});

test("historical submission validation rejects a reproducer that escapes the workspace", async () => {
  const { root } = await fixture();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "outside.sql"), "SELECT 1;\n");
  await symlink(join(root, "outside.sql"), join(workspace, "repro.sql"));
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "observed", reproducer: "repro.sql" }));
  const result = await validateHistoricalPostgresSubmission(workspace);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.integrity, true);
});

test("historical submission validation rejects an oversized reproducer before the grader reads it", async () => {
  const { root } = await fixture();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "repro.sql"), "x".repeat(MAX_HISTORICAL_POSTGRES_REPRO_BYTES + 1));
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "observed", reproducer: "repro.sql" }));
  const result = await validateHistoricalPostgresSubmission(workspace);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.integrity, true);
});
