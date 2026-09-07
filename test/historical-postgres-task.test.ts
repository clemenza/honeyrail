import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HISTORICAL_POSTGRES_REQUIRED_CORE_EVIDENCE,
  HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP,
  MAX_HISTORICAL_POSTGRES_REPRO_BYTES,
  MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES,
  MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES,
  gradeHistoricalPostgresSubmission,
  materializeHistoricalPostgresTask,
  measureHistoricalPostgresWorkspace,
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
function fakeSessionResult(overrides: {
  scoredEligible: boolean;
  agentOk: boolean;
  workspaceDir: string;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  agentEnvironment?: Record<string, string>;
  egressGateway?: { internalNetworkName: string; upstreamHost: string; internalVerified: boolean; imageIdentity: { reference: string; id: string } };
}): PostgresResearchSessionResult {
  return {
    agent: {
      command: "fake-agent",
      args: [],
      cwd: overrides.workspaceDir,
      ok: overrides.agentOk,
      exitCode: overrides.agentOk ? 0 : 1,
      signal: null,
      timedOut: overrides.timedOut ?? false,
      stdout: overrides.stdout ?? "",
      stderr: overrides.stderr ?? "",
      startedAt: new Date().toISOString(),
      durationMs: 1
    },
    workspaceDir: overrides.workspaceDir,
    agentEnvironment: overrides.agentEnvironment ?? {},
    isolation: {
      mode: "container",
      isolated: true,
      networkMode: overrides.scoredEligible ? "none" : "bridge",
      scoredEligible: overrides.scoredEligible,
      imageIdentity: { reference: "fake-agent-image:latest", id: `sha256:${"3".repeat(64)}` },
      egressGateway: overrides.egressGateway,
      buildScoredEligible: true,
      runtimeScoredEligible: true,
      ...(overrides.scoredEligible ? {} : { warning: "Not a scored trial. Fixture forced isolation.scoredEligible=false for this test." })
    },
    connection: {},
    source: {},
    build: {
      buildMode: "container",
      profileVersion: "test-profile-v1",
      configureArgs: [],
      buildEnv: {},
      builderImage: { reference: "fake-builder:latest", id: `sha256:${"1".repeat(64)}` },
      compiler: { command: "cc", version: "cc (GCC) 12.2.0", target: "x86_64-linux-gnu" }
    },
    runtime: {
      runtime: { image: { reference: "fake-runtime:latest", id: `sha256:${"2".repeat(64)}` } }
    }
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

// ---------------------------------------------------------------------------
// #209: bounded agent evidence must survive a workspace-limit integrity_error
// ---------------------------------------------------------------------------

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeManyFiles(dir: string, count: number, bytesEach: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const content = "x".repeat(bytesEach);
  for (let i = 0; i < count; i += 1) {
    await writeFile(join(dir, `file-${i}.txt`), content);
  }
}

test("#209: a file-count-over-limit workspace still retains stdout/stderr/sanitized-result/inventory, and skips the full workspace copy", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "over-file-limit-workspace");
  await writeManyFiles(workspace, MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES + 1, 1);

  const artifactDir = join(root, "over-file-limit-trial");
  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () =>
      fakeSessionResult({
        scoredEligible: true,
        agentOk: true,
        workspaceDir: workspace,
        stdout: "the agent's real investigation output",
        stderr: "the agent's real stderr output"
      })
  });

  assert.equal(trial.status, "integrity_error");
  assert.ok(trial.diagnostics.some((line) => line.includes("agent workspace exceeds limits")));

  assert.equal(await readFile(join(artifactDir, "agent-stdout.txt"), "utf8"), "the agent's real investigation output");
  assert.equal(await readFile(join(artifactDir, "agent-stderr.txt"), "utf8"), "the agent's real stderr output");

  const agentResult = JSON.parse(await readFile(join(artifactDir, "agent-result.json"), "utf8"));
  assert.equal(agentResult.schemaVersion, 1);
  assert.equal(agentResult.agent.ok, true);
  assert.equal(agentResult.agent.exitCode, 0);

  const inventory = JSON.parse(await readFile(join(artifactDir, "workspace-inventory.json"), "utf8"));
  assert.equal(inventory.totalFiles, MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES + 1);
  assert.equal(inventory.exceeded.files, true);
  assert.equal(inventory.exceeded.bytes, false);

  // The oversized workspace itself must never be fully copied into the artifact tree.
  assert.equal(await pathExists(join(artifactDir, "agent-workspace")), false);
  assert.ok(!trial.artifacts.some((path) => path.endsWith("agent-workspace")));
});

test("#209: a byte-count-over-limit workspace (files within limit) still retains evidence, with exceeded.bytes true and exceeded.files false", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "over-byte-limit-workspace");
  const bytesEach = Math.ceil(MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES / 5) + 1024;
  await writeManyFiles(workspace, 5, bytesEach);

  const artifactDir = join(root, "over-byte-limit-trial");
  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, stdout: "stdout-ok", stderr: "stderr-ok" })
  });

  assert.equal(trial.status, "integrity_error");
  assert.equal(await readFile(join(artifactDir, "agent-stdout.txt"), "utf8"), "stdout-ok");
  assert.equal(await readFile(join(artifactDir, "agent-stderr.txt"), "utf8"), "stderr-ok");
  assert.ok(await pathExists(join(artifactDir, "agent-result.json")));

  const inventory = JSON.parse(await readFile(join(artifactDir, "workspace-inventory.json"), "utf8"));
  assert.equal(inventory.totalFiles, 5);
  assert.equal(inventory.exceeded.files, false);
  assert.equal(inventory.exceeded.bytes, true);
  assert.equal(await pathExists(join(artifactDir, "agent-workspace")), false);
});

test("#209: a valid (within-limits) workspace is unaffected - full copy still occurs and grading/result semantics are unchanged", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "valid-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "Explicit agent miss." }));

  const artifactDir = join(root, "valid-trial");
  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.status, "completed");
  assert.equal(trial.grade?.status, "miss");
  assert.ok(await pathExists(join(artifactDir, "agent-workspace")));
  assert.ok(await pathExists(join(artifactDir, "agent-workspace", "finding.json")));
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-workspace")));

  const inventory = JSON.parse(await readFile(join(artifactDir, "workspace-inventory.json"), "utf8"));
  assert.equal(inventory.exceeded.files, false);
  assert.equal(inventory.exceeded.bytes, false);
  assert.equal(inventory.totalFiles, 1);
});

test("#209: agent-result.json never carries a secret from session.agentEnvironment (a raw-session dump would have)", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "sanitization-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const secretSentinel = "sk-fake-secret-sentinel-XYZ123";
  const artifactDir = join(root, "sanitization-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () =>
      fakeSessionResult({
        scoredEligible: true,
        agentOk: true,
        workspaceDir: workspace,
        agentEnvironment: { DEEPSEEK_API_KEY: secretSentinel }
      })
  });

  const agentResultRaw = await readFile(join(artifactDir, "agent-result.json"), "utf8");
  assert.ok(!agentResultRaw.includes(secretSentinel));
  assert.ok(!agentResultRaw.includes("agentEnvironment"));
  const inventoryRaw = await readFile(join(artifactDir, "workspace-inventory.json"), "utf8");
  assert.ok(!inventoryRaw.includes(secretSentinel));
});

test("#209: measureHistoricalPostgresWorkspace bounds largestFiles/topLevelEntries to the cap regardless of how many files/directories exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-workspace-inventory-"));
  const entryCount = HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP + 30;
  for (let i = 0; i < entryCount; i += 1) {
    await mkdir(join(root, `dir-${i}`), { recursive: true });
    await writeFile(join(root, `dir-${i}`, "file.txt"), "x".repeat(i + 1));
  }

  const measurement = await measureHistoricalPostgresWorkspace(root);
  assert.equal(measurement.totalFiles, entryCount);
  assert.ok(measurement.largestFiles.length <= HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP);
  assert.ok(measurement.topLevelEntries.length <= HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP);
  // Sorted descending by size - the single largest file (highest index) must lead.
  assert.equal(measurement.largestFiles[0].bytes, entryCount);
});

// ---------------------------------------------------------------------------
// PR #210 review, Blocking 1: evidence persistence must never overwrite the
// authoritative workspace-limit verdict.
// ---------------------------------------------------------------------------

test("PR #210 Blocking 1: a workspace-inventory.json write failure on an over-file-limit workspace still classifies as integrity_error, with the failure surfaced as a diagnostic and the other evidence still listed", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "over-limit-with-write-failure-workspace");
  await writeManyFiles(workspace, MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES + 1, 1);

  const artifactDir = join(root, "over-limit-with-write-failure-trial");
  await mkdir(artifactDir, { recursive: true });
  // Pre-occupy the exact path workspace-inventory.json needs with a
  // directory, so that specific write fails with EISDIR while every other
  // evidence write (which needs a different path) still succeeds - a
  // deterministic, no-mocking way to force one artifact's persistence to fail.
  await mkdir(join(artifactDir, "workspace-inventory.json"));

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, stdout: "stdout-ok", stderr: "stderr-ok" })
  });

  // The authoritative verdict must be exactly what it would have been with
  // no write failure at all - never reclassified to infrastructure_error.
  assert.equal(trial.status, "integrity_error");
  assert.equal(trial.scoredEligible, false);
  assert.ok(trial.diagnostics.some((line) => line.includes("agent workspace exceeds limits")));

  // Evidence that did persist is listed; evidence that failed is not falsely listed.
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-stdout.txt")));
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-stderr.txt")));
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-result.json")));
  assert.ok(!trial.artifacts.some((path) => path.endsWith("workspace-inventory.json")));

  // The write failure itself is surfaced, not swallowed.
  assert.ok(trial.diagnostics.some((line) => line.includes("evidence_warning") && line.includes("workspace-inventory.json")));

  // The artifacts that could be written are genuinely on disk and correct.
  assert.equal(await readFile(join(artifactDir, "agent-stdout.txt"), "utf8"), "stdout-ok");
  const agentResult = JSON.parse(await readFile(join(artifactDir, "agent-result.json"), "utf8"));
  assert.equal(agentResult.agent.ok, true);
});

test("PR #210 Blocking 1: an agent-stdout.txt write failure on an over-byte-limit workspace still classifies as integrity_error", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "over-byte-limit-with-write-failure-workspace");
  const bytesEach = Math.ceil(MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES / 5) + 1024;
  await writeManyFiles(workspace, 5, bytesEach);

  const artifactDir = join(root, "over-byte-limit-with-write-failure-trial");
  await mkdir(artifactDir, { recursive: true });
  await mkdir(join(artifactDir, "agent-stdout.txt"));

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.status, "integrity_error");
  assert.equal(trial.scoredEligible, false);
  assert.ok(!trial.artifacts.some((path) => path.endsWith("agent-stdout.txt")));
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-stderr.txt")));
  assert.ok(trial.diagnostics.some((line) => line.includes("evidence_warning") && line.includes("agent-stdout.txt")));
});

// ---------------------------------------------------------------------------
// PR #210 review, Blocking 2: agent-result.json must remain sufficient to
// explain isolation/execution attribution, and must exclude grader-private
// truth and unsafe host paths.
// ---------------------------------------------------------------------------

test("PR #210 Blocking 2: agent-result.json's isolation/executionEnvironment fields survive the projection", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "attribution-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const artifactDir = join(root, "attribution-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  const agentResult = JSON.parse(await readFile(join(artifactDir, "agent-result.json"), "utf8"));
  assert.equal(agentResult.schemaVersion, 1);
  assert.equal(agentResult.isolation.mode, "container");
  assert.equal(agentResult.isolation.isolated, true);
  assert.equal(agentResult.isolation.scoredEligible, true);
  assert.equal(agentResult.isolation.networkMode, "none");
  assert.equal(agentResult.isolation.imageIdentity.reference, "fake-agent-image:latest");
  assert.equal(agentResult.executionEnvironment.buildMode, "container");
  assert.equal(agentResult.executionEnvironment.compiler.command, "cc");
  assert.equal(agentResult.executionEnvironment.builderImage.reference, "fake-builder:latest");
  assert.equal(agentResult.executionEnvironment.runtimeImage.reference, "fake-runtime:latest");
});

test("PR #210 Blocking 2: agent-result.json never carries grader-private truth, pinned revisions, or host source paths", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "no-truth-leak-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const artifactDir = join(root, "no-truth-leak-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  const agentResultRaw = await readFile(join(artifactDir, "agent-result.json"), "utf8");
  assert.ok(!agentResultRaw.includes(spec.truth.upstreamBug));
  assert.ok(!agentResultRaw.includes(spec.source.historicalRevision));
  assert.ok(!agentResultRaw.includes(spec.source.referenceRevision));
  assert.ok(!agentResultRaw.includes(spec.source.repoPath));
  assert.ok(!agentResultRaw.includes(workspace));
});

// ---------------------------------------------------------------------------
// PR #210 review, Blocking 3: bounded top-N measurement and redaction of
// known-injected secret values from stdout/stderr/workspace-inventory paths.
// ---------------------------------------------------------------------------

test("PR #210 Blocking 3: a secret from agent.env is redacted from persisted stdout and stderr", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "redaction-stdout-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const secret = "sk-fake-secret-sentinel-abcdefghijklmnop";
  const artifactDir = join(root, "redaction-stdout-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture", env: { DEEPSEEK_API_KEY: secret } },
    artifactDir,
    runSession: async () =>
      fakeSessionResult({
        scoredEligible: true,
        agentOk: true,
        workspaceDir: workspace,
        stdout: `the agent printed its own key: ${secret}`,
        stderr: `a warning also echoed the key: ${secret}`
      })
  });

  const stdout = await readFile(join(artifactDir, "agent-stdout.txt"), "utf8");
  const stderr = await readFile(join(artifactDir, "agent-stderr.txt"), "utf8");
  assert.ok(!stdout.includes(secret));
  assert.ok(stdout.includes("[REDACTED]"));
  assert.ok(!stderr.includes(secret));
  assert.ok(stderr.includes("[REDACTED]"));
});

test("PR #210 Blocking 3: a secret embedded in a workspace filename is redacted from workspace-inventory.json", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "redaction-filename-workspace");
  await mkdir(workspace, { recursive: true });
  const secret = "sk-fake-secret-sentinel-qrstuvwxyz123456";
  await writeFile(join(workspace, `leaked-${secret}.txt`), "small file");
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const artifactDir = join(root, "redaction-filename-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture", env: { DEEPSEEK_API_KEY: secret } },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  const inventoryRaw = await readFile(join(artifactDir, "workspace-inventory.json"), "utf8");
  assert.ok(!inventoryRaw.includes(secret));
  assert.ok(inventoryRaw.includes("[REDACTED]"));
});

test("PR #210 Blocking 3: short, non-secret-length env values are not redacted (only sufficiently long known-injected values are treated as secrets)", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "short-env-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const artifactDir = join(root, "short-env-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture", env: { DSH_PERMISSION_MODE: "none" } },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, stdout: "network mode: none" })
  });

  const stdout = await readFile(join(artifactDir, "agent-stdout.txt"), "utf8");
  assert.equal(stdout, "network mode: none");
});

test("PR #210 Blocking 3: measurement reports exact totals for a workspace far larger than the inventory cap, with deterministic tie-breaking for equal-size entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-workspace-inventory-tiebreak-"));
  const entryCount = HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP * 4;
  // Every file the same size - the cap must still hold exactly
  // HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP entries, deterministically
  // ordered (ascending path) rather than depending on filesystem readdir order.
  for (let i = 0; i < entryCount; i += 1) {
    await writeFile(join(root, `file-${String(i).padStart(6, "0")}.txt`), "x".repeat(100));
  }

  const measurement = await measureHistoricalPostgresWorkspace(root);
  assert.equal(measurement.totalFiles, entryCount);
  assert.equal(measurement.totalBytes, entryCount * 100);
  assert.equal(measurement.largestFiles.length, HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP);
  const paths = measurement.largestFiles.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(paths[0], "file-000000.txt");
  // A root with far more than the cap of direct entries (each flat file is
  // its own top-level entry) still produces only capped topLevelEntries.
  assert.equal(measurement.topLevelEntries.length, HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP);

  // Re-running the measurement against the same on-disk state is deterministic.
  const again = await measureHistoricalPostgresWorkspace(root);
  assert.deepEqual(again.largestFiles, measurement.largestFiles);
  assert.deepEqual(again.topLevelEntries, measurement.topLevelEntries);
});

test("PR #210 Blocking 2: topLevelEntries are capped with deterministic tie-breaking for equal-size subtrees, and totals stay exact for a workspace with far more than the cap of top-level subdirectories", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-workspace-toplevel-tiebreak-"));
  const dirCount = HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP * 3;
  // Every subtree the same aggregate size - the cap must still hold exactly
  // HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP entries, ordered by ascending
  // path rather than filesystem readdir order.
  for (let i = 0; i < dirCount; i += 1) {
    const dirName = `dir-${String(i).padStart(6, "0")}`;
    await mkdir(join(root, dirName), { recursive: true });
    await writeFile(join(root, dirName, "a.txt"), "x".repeat(50));
    await writeFile(join(root, dirName, "b.txt"), "x".repeat(50));
  }

  const measurement = await measureHistoricalPostgresWorkspace(root);
  assert.equal(measurement.totalFiles, dirCount * 2);
  assert.equal(measurement.totalBytes, dirCount * 100);
  assert.equal(measurement.topLevelEntries.length, HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP);
  const topLevelPaths = measurement.topLevelEntries.map((entry) => entry.path);
  assert.deepEqual(topLevelPaths, [...topLevelPaths].sort());
  assert.equal(topLevelPaths[0], "dir-000000");
  for (const entry of measurement.topLevelEntries) {
    assert.equal(entry.fileCount, 2);
    assert.equal(entry.totalBytes, 100);
  }
});

test("PR #210 Blocking 3: symlinks are measured by lstat (never dereferenced) and do not crash the walk", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-workspace-inventory-symlink-"));
  await writeFile(join(root, "real-file.txt"), "x".repeat(5000));
  await symlink(join(root, "real-file.txt"), join(root, "link-to-real-file.txt"));

  const measurement = await measureHistoricalPostgresWorkspace(root);
  assert.equal(measurement.totalFiles, 2);
  // A symlink's own lstat size (the length of the link target string) is
  // nowhere near the 5000-byte target it points at - proves the target was
  // never dereferenced.
  const linkEntry = measurement.largestFiles.find((entry) => entry.path === "link-to-real-file.txt");
  assert.ok(linkEntry);
  assert.ok(linkEntry!.bytes < 5000);
});

// ---------------------------------------------------------------------------
// PR #210 review round 3, Blocking 1: an official scored capability sample
// must never enter the dataset unless its core evidence contract persisted.
// ---------------------------------------------------------------------------

test("PR #210 round 3 Blocking 1: a within-limit, scored-eligible, agent-ok trial with one failed core evidence write never grades - it becomes infrastructure_error, not an official miss/rediscovered", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "core-evidence-gate-workspace");
  await mkdir(workspace, { recursive: true });
  // A submission that would otherwise be graded "miss" - proving the gate
  // fires *before* grading, not that grading itself is broken.
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "would otherwise be a valid miss" }));

  const artifactDir = join(root, "core-evidence-gate-trial");
  await mkdir(artifactDir, { recursive: true });
  // Force exactly one core evidence artifact to fail deterministically.
  await mkdir(join(artifactDir, "agent-result.json"));

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, stdout: "stdout-ok", stderr: "stderr-ok" })
  });

  // Never an official completed capability result.
  assert.notEqual(trial.status, "completed");
  assert.equal(trial.status, "infrastructure_error");
  assert.equal(trial.grade, undefined);
  assert.equal(trial.scoredEligible, true);

  // Successful evidence remains listed; the failed artifact does not.
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-stdout.txt")));
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-stderr.txt")));
  assert.ok(trial.artifacts.some((path) => path.endsWith("workspace-inventory.json")));
  assert.ok(!trial.artifacts.some((path) => path.endsWith("agent-result.json")));

  // The diagnostic identifies exactly which core evidence artifact is missing.
  assert.ok(trial.diagnostics.some((line) => line.includes("core evidence") && line.includes("agent-result.json")));

  // The workspace was still copied (this is not the over-limit path) and the
  // successfully-written artifacts are genuinely correct on disk.
  assert.equal(await readFile(join(artifactDir, "agent-stdout.txt"), "utf8"), "stdout-ok");
});

test("PR #210 round 3 Blocking 1: HISTORICAL_POSTGRES_REQUIRED_CORE_EVIDENCE names exactly the four artifacts the gate checks", () => {
  assert.deepEqual([...HISTORICAL_POSTGRES_REQUIRED_CORE_EVIDENCE].sort(), ["agent-result.json", "agent-stderr.txt", "agent-stdout.txt", "workspace-inventory.json"].sort());
});

test("PR #210 round 3 Blocking 1: the over-limit evidence-write-failure path still classifies as integrity_error (unaffected by the new scored-path gate)", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "over-limit-still-integrity-workspace");
  await writeManyFiles(workspace, MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES + 1, 1);

  const artifactDir = join(root, "over-limit-still-integrity-trial");
  await mkdir(artifactDir, { recursive: true });
  await mkdir(join(artifactDir, "workspace-inventory.json"));

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.status, "integrity_error");
  assert.ok(trial.diagnostics.some((line) => line.includes("agent workspace exceeds limits")));
});

// ---------------------------------------------------------------------------
// PR #210 review round 3, Blocking 3: restricted-egress gateway provenance.
// ---------------------------------------------------------------------------

test("PR #210 round 3 Blocking 3: agent-result.json.isolation.egressGateway survives the safe projection with exact gateway identity, and no API-key sentinel leaks", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "egress-gateway-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const secret = "sk-fake-secret-sentinel-egress-abcdefgh";
  const gatewayImageId = `sha256:${"7".repeat(64)}`;
  const artifactDir = join(root, "egress-gateway-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture", env: { DEEPSEEK_API_KEY: secret } },
    artifactDir,
    runSession: async () =>
      fakeSessionResult({
        scoredEligible: true,
        agentOk: true,
        workspaceDir: workspace,
        egressGateway: {
          internalNetworkName: "honeyrail-pg-egress-net-fake-uuid",
          upstreamHost: "api.deepseek.com",
          internalVerified: true,
          imageIdentity: { reference: "honeyrail-postgres-egress-gateway:latest", id: gatewayImageId }
        }
      })
  });

  const agentResultRaw = await readFile(join(artifactDir, "agent-result.json"), "utf8");
  const agentResult = JSON.parse(agentResultRaw);
  assert.equal(agentResult.isolation.egressGateway.internalNetworkName, "honeyrail-pg-egress-net-fake-uuid");
  assert.equal(agentResult.isolation.egressGateway.upstreamHost, "api.deepseek.com");
  assert.equal(agentResult.isolation.egressGateway.internalVerified, true);
  assert.equal(agentResult.isolation.egressGateway.imageIdentity.id, gatewayImageId);
  assert.equal(agentResult.isolation.egressGateway.imageIdentity.reference, "honeyrail-postgres-egress-gateway:latest");
  assert.ok(!agentResultRaw.includes(secret));
});

test("PR #210 round 3 Blocking 3: agent-result.json.isolation.egressGateway is absent when the session provides no gateway (unisolated/non-restricted-egress runs)", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "no-egress-gateway-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const artifactDir = join(root, "no-egress-gateway-trial");
  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  const agentResult = JSON.parse(await readFile(join(artifactDir, "agent-result.json"), "utf8"));
  assert.equal(agentResult.isolation.egressGateway, undefined);
});

// ---------------------------------------------------------------------------
// PR #210 review round 4: DSH trajectory evidence must survive a timeout/
// blocked/over-limit trial, be redacted, and never gate scoring for a
// non-DSH agent.
// ---------------------------------------------------------------------------

/** Writes a minimal, uncompressed DSH raw-session JSONL log into the exact host path runHistoricalPostgresTrial() reads (artifactDir/dsh-home/sessions/*.jsonl). */
async function writeDshSessionLog(artifactDir: string, events: Array<Record<string, unknown>>): Promise<void> {
  const sessionsDir = join(artifactDir, "dsh-home", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "test-session.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function fakeBashToolCallAndResult(callId: string, command: string, resultText: string, startTime: number, endTime: number): Array<Record<string, unknown>> {
  return [
    { type: "tool/call", time: startTime, data: { turn: 1, step: 1, callId, name: "bash", arguments: JSON.stringify({ command }) } },
    {
      type: "tool/result",
      time: endTime,
      data: { turn: 1, step: 1, message: { source: { callId }, content: [{ type: "tool-result", content: [{ type: "text", text: resultText }] }] } }
    }
  ];
}

test("PR #210 round 4 (A): a timed-out (blocked) trial retains a non-empty agent-transcript.ndjson, independent of stdout", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "transcript-timeout-workspace");
  await mkdir(workspace, { recursive: true });

  const artifactDir = join(root, "transcript-timeout-trial");
  await writeDshSessionLog(artifactDir, [
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    ...fakeBashToolCallAndResult("c1", "ls /workspace/source", "file1.c\nfile2.c", 1100, 1400)
  ]);

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: false, timedOut: true, workspaceDir: workspace, stdout: "", stderr: "" })
  });

  assert.equal(trial.status, "blocked");
  assert.equal(await readFile(join(artifactDir, "agent-stdout.txt"), "utf8"), "");
  const transcriptRaw = await readFile(join(artifactDir, "agent-transcript.ndjson"), "utf8");
  assert.ok(transcriptRaw.trim().length > 0, "transcript must be non-empty even though stdout is empty");
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-transcript.ndjson")));
});

test("PR #210 round 4 (B): a workspace-over-limit (integrity_error) trial retains a non-empty agent-transcript.ndjson and workspace-inventory.json, with no full workspace copy", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "transcript-over-limit-workspace");
  await writeManyFiles(workspace, MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES + 1, 1);

  const artifactDir = join(root, "transcript-over-limit-trial");
  await writeDshSessionLog(artifactDir, [
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    { type: "step/end", time: 2000, data: { turn: 1, step: 1 } }
  ]);

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.status, "integrity_error");
  assert.equal(await pathExists(join(artifactDir, "agent-workspace")), false);
  const transcriptRaw = await readFile(join(artifactDir, "agent-transcript.ndjson"), "utf8");
  assert.ok(transcriptRaw.trim().length > 0);
  assert.ok(await pathExists(join(artifactDir, "workspace-inventory.json")));
});

test("PR #210 round 4 (C): a known secret embedded in a DSH raw event is redacted from agent-transcript.ndjson and agent-trajectory.jsonl", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "transcript-redaction-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const secret = "sk-fake-secret-sentinel-transcript-abcdef";
  const artifactDir = join(root, "transcript-redaction-trial");
  await writeDshSessionLog(artifactDir, fakeBashToolCallAndResult("c1", `echo ${secret}`, `ran with key ${secret}`, 1000, 1500));

  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture", env: { DEEPSEEK_API_KEY: secret } },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  const transcriptRaw = await readFile(join(artifactDir, "agent-transcript.ndjson"), "utf8");
  assert.ok(!transcriptRaw.includes(secret));
  assert.ok(transcriptRaw.includes("[REDACTED]"));
  const trajectoryRaw = await readFile(join(artifactDir, "agent-trajectory.jsonl"), "utf8");
  assert.ok(!trajectoryRaw.includes(secret));
  assert.ok(trajectoryRaw.includes("[REDACTED]"));
});

test("PR #210 round 4 (D): agent-trajectory.jsonl derives an ordered tool_call + shell_command pair from a completed bash call, without a fabricated exit code", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "trajectory-derivation-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "n/a" }));

  const artifactDir = join(root, "trajectory-derivation-trial");
  await writeDshSessionLog(artifactDir, fakeBashToolCallAndResult("c1", "psql -c 'select 1'", "1\n(1 row)", 1000, 1800));

  await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  const lines = (await readFile(join(artifactDir, "agent-trajectory.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const toolCall = lines.find((event) => event.kind === "tool_call");
  const shellCommand = lines.find((event) => event.kind === "shell_command");
  assert.ok(toolCall);
  assert.equal(toolCall.name, "bash");
  assert.ok(shellCommand);
  assert.equal(shellCommand.command, "psql -c 'select 1'");
  assert.equal(shellCommand.stdout, "1\n(1 row)");
  assert.ok(toolCall.seq < shellCommand.seq, "tool_call must precede its paired shell_command");
  // dsh 0.1.0-rc.7 never reliably populates a bash exit code (see
  // dsh-trajectory-bridge.ts's own provenance note) - null, not fabricated.
  assert.equal(shellCommand.exit_code, null);
});

test("PR #210 round 4: a scored trial with no DSH session data (transcript not_applicable) still grades normally - the core-evidence gate never fires for a non-DSH agent", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "no-dsh-session-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "a genuine miss" }));

  const artifactDir = join(root, "no-dsh-session-trial");
  const trial = await runHistoricalPostgresTrial({
    task: spec,
    // Analogous to #180's own deterministic stub agent - never writes to $DSH_HOME.
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.status, "completed");
  assert.equal(trial.grade?.status, "miss");
  assert.equal(await pathExists(join(artifactDir, "agent-transcript.ndjson")), false);
});

test("PR #210 round 4 (F): a scored-eligible, within-limit trial where DSH engaged but the transcript write fails never grades - infrastructure_error, transcript named as missing", async () => {
  const { root, spec } = await fixture();
  const workspace = join(root, "transcript-required-gate-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "would otherwise be a valid miss" }));

  const artifactDir = join(root, "transcript-required-gate-trial");
  await writeDshSessionLog(artifactDir, [{ type: "step/start", time: 1000, data: { turn: 1, step: 1 } }]);
  // Force the transcript write to fail deterministically.
  await mkdir(join(artifactDir, "agent-transcript.ndjson"));

  const trial = await runHistoricalPostgresTrial({
    task: spec,
    agent: { command: "unused-in-this-fixture" },
    artifactDir,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace })
  });

  assert.equal(trial.status, "infrastructure_error");
  assert.equal(trial.grade, undefined);
  assert.ok(!trial.artifacts.some((path) => path.endsWith("agent-transcript.ndjson")));
  assert.ok(trial.diagnostics.some((line) => line.includes("core evidence") && line.includes("agent-transcript.ndjson")));
  // The other three core artifacts still succeeded and remain listed.
  assert.ok(trial.artifacts.some((path) => path.endsWith("agent-result.json")));
  assert.ok(trial.artifacts.some((path) => path.endsWith("workspace-inventory.json")));
});
