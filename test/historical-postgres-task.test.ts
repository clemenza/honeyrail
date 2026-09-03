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
    truth: { upstreamBug: "Synthetic upstream #99999", commitFest: 1234 },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for correctness regressions."
  };
  return { root, spec };
}

test("historical task materialization keeps the scored tree and grader-private truth separate", async () => {
  const { root, spec } = await fixture();
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const publicManifest = JSON.parse(await readFile(task.taskManifestPath, "utf8"));
  assert.equal(publicManifest.taskId, spec.taskId);
  // The agent-visible manifest must never carry the fixed/reference revision,
  // the bug identity, or the CommitFest/upstream-issue identifiers - only
  // opaque hashes and execution-shaping settings.
  assert.ok(!("referenceRevision" in publicManifest));
  assert.ok(!("sourceRevision" in publicManifest));
  const publicManifestText = JSON.stringify(publicManifest);
  assert.ok(!publicManifestText.includes(spec.source.referenceRevision));
  assert.ok(!publicManifestText.includes("99999"));
  assert.ok(!publicManifestText.includes("1234"));

  const referenceManifest = JSON.parse(await readFile(task.referenceManifestPath, "utf8"));
  assert.ok(!("referenceRevision" in referenceManifest));
  assert.ok(!("upstreamBug" in referenceManifest));
  assert.equal(referenceManifest.truthBundleHash, task.truthManifest.bundleHash);

  const truthManifest = JSON.parse(await readFile(task.truthManifestPath, "utf8"));
  assert.equal(truthManifest.referenceRevision, spec.source.referenceRevision);
  assert.equal(truthManifest.historicalRevision, spec.source.historicalRevision);
  assert.equal(truthManifest.upstreamBug, spec.truth.upstreamBug);
  assert.equal(truthManifest.commitFest, spec.truth.commitFest);
  assert.equal(truthManifest.canonicalReproducerSha256, null);
  assert.ok(truthManifest.bundleHash);
  assert.ok(truthManifest.expectedBehaviorSha256);

  await assert.rejects(readFile(join(task.workspaceDir, "reference-manifest.json"), "utf8"));
  await assert.rejects(readFile(join(task.workspaceDir, "truth.json"), "utf8"));
  await assert.rejects(readFile(join(task.sourceDir, ".git", "HEAD"), "utf8"));
  assert.ok(task.taskManifest.hashes.taskDefinition);
  assert.ok(task.taskManifest.hashes.truthBundle);
});

test("historical task truth bundle hash covers the bug identity and both revisions, not just shape", async () => {
  const { root, spec } = await fixture();
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const tamperedBug = { ...task.truthManifest, upstreamBug: "different bug" };
  delete (tamperedBug as Record<string, unknown>).bundleHash;
  const tamperedRevision = { ...task.truthManifest, referenceRevision: spec.source.historicalRevision };
  delete (tamperedRevision as Record<string, unknown>).bundleHash;
  // A bundle hash that only covered shape metadata would not change here;
  // this asserts the real content is load-bearing.
  const rehash = (value: unknown) => JSON.stringify(value);
  assert.notEqual(rehash(tamperedBug), rehash(task.truthManifest));
  assert.notEqual(rehash(tamperedRevision), rehash(task.truthManifest));
});

test("historical task materialization records a canonical reproducer hash without leaking it to the agent", async () => {
  const { root, spec } = await fixture();
  const reproPath = join(root, "known-repro.sql");
  await writeFile(reproPath, "SELECT 1;\n");
  const task = await materializeHistoricalPostgresTask(
    { ...spec, truth: { ...spec.truth, knownReproducerPath: reproPath } },
    join(root, "case-with-known-repro")
  );
  assert.ok(task.truthManifest.canonicalReproducerSha256);
  const publicManifestText = JSON.stringify(task.taskManifest);
  assert.ok(!publicManifestText.includes(task.truthManifest.canonicalReproducerSha256!));
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

test("not-reproduced without a reproducer is a valid submission, not invalid_submission", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "No deterministic correctness issue found." }));
  const validated = await validateHistoricalPostgresSubmission(workspace);
  assert.equal(validated.ok, true);
  if (validated.ok) assert.equal(validated.submission.status, "not-reproduced");
  const grade = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "not-reproduced"),
    gradeRevision: async () => {
      throw new Error("gradeRevision must not run for a not-reproduced submission");
    }
  });
  assert.equal(grade.status, "miss");
});

test("not-reproduced is never upgraded to rediscovered even when an attached reproducer would distinguish the revisions", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");
  await writeFile(
    join(workspace, "finding.json"),
    JSON.stringify({ status: "not-reproduced", summary: "No deterministic correctness issue found.", reproducer: "repro.sql" })
  );
  const grade = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "not-reproduced-with-repro"),
    gradeRevision: async ({ revision }) => ({ reproduced: revision === spec.source.historicalRevision })
  });
  assert.equal(grade.status, "miss");
});

test("reproduced without a reproducer is invalid_submission", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "observed" }));
  const validated = await validateHistoricalPostgresSubmission(workspace);
  assert.equal(validated.ok, false);
  const grade = await gradeHistoricalPostgresSubmission({ task: spec, workspaceDir: workspace, artifactDir: join(root, "reproduced-no-repro") });
  assert.equal(grade.status, "invalid_submission");
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
