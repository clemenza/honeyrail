import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_HISTORICAL_POSTGRES_REPRO_BYTES,
  gradeHistoricalPostgresSubmission,
  materializeHistoricalPostgresTask,
  runHistoricalPostgresTrial,
  validateHistoricalPostgresSubmission,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import type { PostgresResearchSessionResult } from "../server/postgres/research-session.js";
import { createAdditionalSyntheticCommit, createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";
import { readTreeAsText } from "./helpers/read-tree-as-text.js";

/**
 * A minimal fixture standing in for `runAgentInPostgresResearchEnvironment()`,
 * so `runHistoricalPostgresTrial()`'s own control flow - including the
 * scoredEligible gate - can be exercised without Docker. Only the fields the
 * production code actually reads are given real values; everything else is a
 * placeholder, hence the `as unknown as` cast.
 */
function fakeSessionResult(overrides: { scoredEligible: boolean; agentOk: boolean; workspaceDir: string; timedOut?: boolean }): PostgresResearchSessionResult {
  return {
    agent: {
      command: "fake-agent",
      args: [],
      cwd: overrides.workspaceDir,
      ok: overrides.agentOk,
      exitCode: overrides.agentOk ? 0 : 1,
      signal: null,
      timedOut: overrides.timedOut ?? false,
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      durationMs: 1
    },
    workspaceDir: overrides.workspaceDir,
    agentEnvironment: {},
    isolation: {
      mode: "container",
      isolated: true,
      networkMode: overrides.scoredEligible ? "none" : "bridge",
      scoredEligible: overrides.scoredEligible,
      buildScoredEligible: true,
      runtimeScoredEligible: true,
      ...(overrides.scoredEligible ? {} : { warning: "Not a scored trial. Fixture forced isolation.scoredEligible=false for this test." })
    },
    connection: {},
    source: {},
    build: {},
    runtime: {}
  } as unknown as PostgresResearchSessionResult;
}

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
  return { root, repo, spec };
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
  assert.equal(truthManifest.canonicalReproducer, null);
  assert.equal(truthManifest.canonicalReproducerSha256, null);
  assert.ok(truthManifest.bundleHash);
  assert.ok(truthManifest.expectedBehaviorSha256);
  await assert.rejects(readFile(join(task.referenceDir, "verification", "canonical-reproducer.sql"), "utf8"));

  await assert.rejects(readFile(join(task.workspaceDir, "reference-manifest.json"), "utf8"));
  await assert.rejects(readFile(join(task.workspaceDir, "truth.json"), "utf8"));
  await assert.rejects(readFile(join(task.sourceDir, ".git", "HEAD"), "utf8"));
  assert.ok(task.taskManifest.hashes.taskDefinition);
  assert.ok(task.taskManifest.hashes.truthBundle);
});

test("historical task truth bundle hash covers the bug identity and both revisions, not just shape", async () => {
  const { root, repo, spec } = await fixture();
  const baseline = await materializeHistoricalPostgresTask(spec, join(root, "baseline"));

  const bugChanged = await materializeHistoricalPostgresTask({ ...spec, truth: { ...spec.truth, upstreamBug: "a completely different bug" } }, join(root, "bug-changed"));

  // A revision guaranteed distinct from spec.source.referenceRevision: a
  // child commit's hash is chained through its parent's, so - unlike two
  // independently created repos, whose initial commits share no parent and
  // can coincide when content, author/committer and even the timestamp's
  // second all happen to match (a real flake seen on a fast CI runner) -
  // this cannot collide regardless of timing. Asserted explicitly so a
  // future fixture regression fails loudly here rather than showing up only
  // as an unrelated, hard-to-diagnose bundleHash mismatch below.
  const differentReferenceRevision = await createAdditionalSyntheticCommit(repo.repoPath, "truth-hash-reference-change");
  assert.notEqual(differentReferenceRevision, spec.source.referenceRevision);
  const revisionChanged = await materializeHistoricalPostgresTask(
    { ...spec, source: { ...spec.source, referenceRevision: differentReferenceRevision } },
    join(root, "revision-changed")
  );
  const reproPath = join(root, "known-repro.sql");
  const reproAContents = "SELECT 1;\n";
  await writeFile(reproPath, reproAContents);
  const anotherReproPath = join(root, "another-repro.sql");
  const reproBContents = "SELECT 2;\n";
  await writeFile(anotherReproPath, reproBContents);
  const reproA = await materializeHistoricalPostgresTask({ ...spec, truth: { ...spec.truth, knownReproducerPath: reproPath } }, join(root, "repro-a"));
  const reproB = await materializeHistoricalPostgresTask({ ...spec, truth: { ...spec.truth, knownReproducerPath: anotherReproPath } }, join(root, "repro-b"));
  const oraclePattern = { historical: [{ label: "x", matches: "^x$" }], reference: [{ label: "x", matches: "^y$" }] };
  const oracleDeclared = await materializeHistoricalPostgresTask({ ...spec, truth: { ...spec.truth, behavioralOracle: oraclePattern } }, join(root, "oracle-declared"));

  // Each of these actually re-materializes and re-hashes the bundle (not a
  // fabricated tampered copy), so a bundleHash implementation that ignored
  // any of these fields - e.g. a constant, or one hashing only shape
  // metadata - would fail this test.
  assert.notEqual(bugChanged.truthManifest.bundleHash, baseline.truthManifest.bundleHash);
  assert.notEqual(revisionChanged.truthManifest.bundleHash, baseline.truthManifest.bundleHash);
  assert.notEqual(reproA.truthManifest.bundleHash, reproB.truthManifest.bundleHash);
  assert.notEqual(reproA.truthManifest.bundleHash, baseline.truthManifest.bundleHash);
  // A declared behavioral oracle is truth material too: it moves the hash.
  // Its absence omits the key entirely (Policy A - see below), rather than
  // recording it as null, so a legacy spec's serialized bundle stays exactly
  // as it always was.
  assert.notEqual(oracleDeclared.truthManifest.bundleHash, baseline.truthManifest.bundleHash);
  assert.deepEqual(oracleDeclared.truthManifest.behavioralOracle, oraclePattern);
  // Key presence itself is conditional (Policy A / #200 third review round):
  // a spec that declares no oracle must not gain a "behavioralOracle": null
  // key at all, not just a null value - this file uses node:assert/strict,
  // where `equal` is `strictEqual`, so `undefined` would not satisfy `null`.
  assert.ok(!("behavioralOracle" in baseline.truthManifest));

  // The retained file and manifest path must reflect which canonical
  // reproducer produced each bundle, not just its hash.
  assert.equal(reproA.truthManifest.canonicalReproducer, "verification/canonical-reproducer.sql");
  assert.equal(reproB.truthManifest.canonicalReproducer, "verification/canonical-reproducer.sql");
  assert.notEqual(reproA.truthManifest.canonicalReproducerSha256, reproB.truthManifest.canonicalReproducerSha256);
  assert.equal(await readFile(join(reproA.referenceDir, "verification", "canonical-reproducer.sql"), "utf8"), reproAContents);
  assert.equal(await readFile(join(reproB.referenceDir, "verification", "canonical-reproducer.sql"), "utf8"), reproBContents);
});

test("historical task materialization retains the canonical reproducer file, grader-private, without leaking it to the agent", async () => {
  const { root, spec } = await fixture();
  const reproPath = join(root, "known-repro.sql");
  const reproContents = "SELECT 1;\n";
  await writeFile(reproPath, reproContents);
  const task = await materializeHistoricalPostgresTask(
    { ...spec, truth: { ...spec.truth, knownReproducerPath: reproPath } },
    join(root, "case-with-known-repro")
  );
  assert.equal(task.truthManifest.canonicalReproducer, "verification/canonical-reproducer.sql");
  assert.ok(task.truthManifest.canonicalReproducerSha256);

  const retained = await readFile(join(task.referenceDir, "verification", "canonical-reproducer.sql"), "utf8");
  assert.equal(retained, reproContents);

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

test("no file anywhere under task/ leaks either revision, the bug identity, or a grader-private path", async () => {
  const { root, spec } = await fixture();
  const reproPath = join(root, "known-repro.sql");
  const reproContents = "SELECT 1;\n";
  await writeFile(reproPath, reproContents);
  const task = await materializeHistoricalPostgresTask(
    { ...spec, truth: { ...spec.truth, knownReproducerPath: reproPath } },
    join(root, "case")
  );
  const files = await readTreeAsText(task.taskDir);
  // Covers task-manifest.json, source-manifest.json, prompt.md and
  // workspace/README.md at minimum - readTreeAsText walks the whole tree, so
  // any future file added under task/ is covered automatically too.
  const coveredNames = files.map((file) => file.relativePath);
  assert.ok(coveredNames.includes("task-manifest.json"));
  assert.ok(coveredNames.includes("source-manifest.json"));
  assert.ok(coveredNames.includes("prompt.md"));
  assert.ok(coveredNames.some((name) => name.startsWith("workspace/README")));
  // The canonical verification reproducer must never itself appear under
  // task/, by name or by any relative path pointing at it.
  assert.ok(!coveredNames.includes("canonical-reproducer.sql"));
  assert.ok(!coveredNames.some((name) => name.includes("canonical-reproducer")));

  const secrets: Record<string, string> = {
    "historical revision": spec.source.historicalRevision,
    "reference revision": spec.source.referenceRevision,
    "upstream bug id": "99999",
    "CommitFest id": "1234",
    "grader-private mirror path": spec.source.repoPath,
    "canonical reproducer hash": task.truthManifest.canonicalReproducerSha256!,
    "canonical reproducer relative path": task.truthManifest.canonicalReproducer!,
    "canonical reproducer contents": reproContents,
    "canonical reproducer host path": reproPath
  };
  for (const file of files) {
    for (const [label, secret] of Object.entries(secrets)) {
      assert.ok(!file.text.includes(secret), `task/${file.relativePath} leaked ${label}`);
    }
  }
  await assert.rejects(readFile(join(task.sourceDir, ".git", "HEAD"), "utf8"));

  // The retained canonical reproducer must exist only under reference/.
  const referenceFiles = await readTreeAsText(task.referenceDir);
  const canonicalReproducerFile = referenceFiles.find((file) => file.relativePath === "verification/canonical-reproducer.sql");
  assert.ok(canonicalReproducerFile);
  assert.equal(canonicalReproducerFile!.text, reproContents);
});

test("public source-manifest.json is sanitized; full provenance stays grader-side", async () => {
  const { root, spec } = await fixture();
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const publicSourceManifest = JSON.parse(await readFile(join(task.taskDir, "source-manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(publicSourceManifest).sort(), ["gitDirPresent", "schemaVersion", "sourceHash"]);
  assert.equal(publicSourceManifest.gitDirPresent, false);
  assert.ok(!("repoPath" in publicSourceManifest));
  assert.ok(!("ref" in publicSourceManifest));
  assert.ok(!("resolvedCommit" in publicSourceManifest));
  assert.ok(!("sourceDir" in publicSourceManifest));

  const fullSourceManifest = JSON.parse(await readFile(join(task.referenceDir, "source-manifest.json"), "utf8"));
  assert.equal(fullSourceManifest.repoPath, spec.source.repoPath);
  assert.equal(fullSourceManifest.ref, spec.source.historicalRevision);
  assert.equal(fullSourceManifest.sourceHash, publicSourceManifest.sourceHash);
});

test("a run whose isolation is not scored-eligible never reports a completed scored grade", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "unscored-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "Explicit agent miss." }));

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir: join(root, "unscored-trial"),
    runSession: async () => fakeSessionResult({ scoredEligible: false, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.scoredEligible, false);
  assert.notEqual(trial.status, "completed");
  assert.equal(trial.status, "unscored");
  // The grader still ran (useful diagnostic) and correctly saw the explicit
  // not-reproduced submission, but that must not be mistaken for a score.
  assert.equal(trial.grade?.status, "miss");
  assert.ok(trial.diagnostics.some((line) => line.toLowerCase().includes("not a scored trial")));
});

test("a scored-eligible run with the same submission is reported as completed", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "scored-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "Explicit agent miss." }));

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir: join(root, "scored-trial"),
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.scoredEligible, true);
  assert.equal(trial.status, "completed");
  assert.equal(trial.grade?.status, "miss");
});

test("an agent that never produced agent.ok=true is blocked regardless of scoredEligible", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "blocked-workspace");
  await mkdir(workspace, { recursive: true });

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir: join(root, "blocked-trial"),
    runSession: async () => fakeSessionResult({ scoredEligible: false, agentOk: false, workspaceDir: workspace })
  });

  assert.equal(trial.status, "blocked");
  assert.equal(trial.scoredEligible, false);
  assert.equal(trial.grade, undefined);
});
