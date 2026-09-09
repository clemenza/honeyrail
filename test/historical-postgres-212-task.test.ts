import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  gradeHistoricalPostgresSubmission,
  historicalPostgresChange16867TaskPrompt,
  historicalPostgresChange16867TaskSpec,
  historicalPostgresChange16867Spec,
  historicalPostgresChange16867HarnessProfile,
  loadHistoricalPostgresChange16867PrivateTruth,
  materializeHistoricalPostgresTask,
  resolveOracleReproduction,
  type HistoricalPostgresChange16867PrivateTruth,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { createSyntheticPostgresSourceRepo, createAdditionalSyntheticCommit } from "./helpers/postgres-source-fixture.js";
import { readTreeAsText } from "./helpers/read-tree-as-text.js";
import { SYNTHETIC_ORACLE } from "./helpers/synthetic-oracle-fixture.js";

// Synthetic private truth for unit tests. Never contains real upstream
// revisions, bug ids, or expected tuples. Uses domain-neutral placeholder
// tokens; no PostgreSQL transaction-isolation vocabulary.
const SYNTHETIC_16867_PRIVATE_TRUTH: HistoricalPostgresChange16867PrivateTruth = {
  upstreamBug: "Synthetic BUG #16867",
  historicalRevision: "a".repeat(40),
  referenceRevision: "b".repeat(40),
  introducingCommit: "e".repeat(40),
  structuredOracle: {
    historical: { rows: [["synthetic-historical-value"]] },
    reference: { rows: [["synthetic-reference-value"]] }
  }
};

// ---------------------------------------------------------------------------
// Identity and structure
// ---------------------------------------------------------------------------

test("historicalPostgresChange16867TaskSpec carries operator-supplied private truth behind an opaque task id", () => {
  const spec = historicalPostgresChange16867TaskSpec("/unused/repo/path", SYNTHETIC_16867_PRIVATE_TRUTH, "E0");
  assert.equal(spec.taskId, "postgres-change-001");
  assert.equal(spec.source.historicalRevision, SYNTHETIC_16867_PRIVATE_TRUTH.historicalRevision);
  assert.equal(spec.source.referenceRevision, SYNTHETIC_16867_PRIVATE_TRUTH.referenceRevision);
  assert.equal(spec.truth.upstreamBug, SYNTHETIC_16867_PRIVATE_TRUTH.upstreamBug);
  assert.equal(spec.truth.commitFest, undefined);
  assert.ok(spec.prompt.trim().length > 0);
  assert.ok(spec.changeContext, "changeContext must be present");
  assert.ok(spec.changeContext!.spec.trim().length > 0);
  assert.equal(spec.changeContext!.introducingCommit, SYNTHETIC_16867_PRIVATE_TRUTH.introducingCommit);
  assert.ok(spec.changeContext!.harnessProfile);
});

test("historicalPostgresChange16867TaskSpec declares a structured oracle from private truth", () => {
  const spec = historicalPostgresChange16867TaskSpec("/unused/repo/path", SYNTHETIC_16867_PRIVATE_TRUTH, "E0");
  const oracle = spec.truth.structuredOracle;
  assert.ok(oracle, "structuredOracle must be present");
  assert.ok(Array.isArray(oracle!.historical.rows));
  assert.ok(Array.isArray(oracle!.reference.rows));
  assert.deepEqual(oracle!.historical, SYNTHETIC_16867_PRIVATE_TRUTH.structuredOracle.historical);
  assert.deepEqual(oracle!.reference, SYNTHETIC_16867_PRIVATE_TRUTH.structuredOracle.reference);
  assert.notDeepEqual(oracle!.historical.rows, oracle!.reference.rows);
  assert.equal(spec.truth.behavioralOracle, undefined);
});

test("historicalPostgresChange16867TaskSpec supports all scaffolding levels", () => {
  for (const level of ["E0", "E1", "E2", "E3"] as const) {
    const spec = historicalPostgresChange16867TaskSpec("/unused/repo/path", SYNTHETIC_16867_PRIVATE_TRUTH, level);
    assert.equal(spec.scaffoldingLevel, level);
    assert.ok(spec.changeContext, `changeContext must be present at ${level}`);
  }
});

// ---------------------------------------------------------------------------
// SPEC content integrity: contemporaneous-context rule
// ---------------------------------------------------------------------------

test("spec.md content does not contain prohibited hindsight markers", () => {
  const specContent = historicalPostgresChange16867Spec();
  const prohibited = [
    "SAVEPOINT",
    "unreleased savepoint",
    "subtransaction",
    "TBLOCK_SUBCOMMIT",
    "nested transaction state",
    "missing switch branch",
    "enumerate every blockState",
    "BUG #16867"
  ];
  for (const marker of prohibited) {
    assert.ok(
      !specContent.includes(marker),
      `spec.md contains prohibited hindsight marker: "${marker}"`
    );
  }
});

test("spec.md is contemporaneous requirement text, not an operator-authored test strategy", () => {
  const specContent = historicalPostgresChange16867Spec().toLowerCase();
  for (const marker of [
    "scope of verification",
    "test surface should cover",
    "every combination",
    "interaction with other transaction control",
    "both chaining verbs"
  ]) {
    assert.ok(!specContent.includes(marker), `spec.md leaks test methodology: ${marker}`);
  }
});

test("E3 HarnessProfile preserves the Historical PostgreSQL self-asserting exit contract", () => {
  const profile = historicalPostgresChange16867HarnessProfile().toLowerCase();
  assert.match(profile, /exit[s]? successfully \(status 0\) only when the suspected\s+correctness violation is observed/);
  assert.match(profile, /invariant holds, the same script must exit non-zero/);
  assert.equal(profile.includes("exit with status 0 when the invariant holds"), false);
  assert.equal(profile.includes("explicit `\\q 1`) if and only if the invariant is violated"), false);
  for (const marker of [
    "default_transaction_isolation",
    "show transaction_isolation",
    "savepoint",
    "tblock_subcommit",
    "bug #16867"
  ]) {
    assert.equal(profile.includes(marker), false, `HarnessProfile leaks target-specific marker: ${marker}`);
  }
});

test("prompt does not leak bug identity, fix SHA, or hindsight terminology", () => {
  const prompt = historicalPostgresChange16867TaskPrompt();
  for (const marker of [
    "16867",
    "8a55cb5b",
    "COMMIT AND CHAIN",
    "ROLLBACK AND CHAIN",
    "SAVEPOINT",
    "TBLOCK_SUBCOMMIT",
    "subtransaction"
  ]) {
    assert.ok(!prompt.toLowerCase().includes(marker.toLowerCase()), `prompt leaks feature-specific marker: ${marker}`);
  }
});

// ---------------------------------------------------------------------------
// E0-E3 materialization visibility
// ---------------------------------------------------------------------------

test("E0: no change-context artifacts are materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-e0-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  // Use repo.ref as introducing commit (it exists in the repo)
  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const spec = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E0");
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(!taskFiles.some(f => f.relativePath === "spec.md"), "spec.md must not exist at E0");
  assert.ok(!taskFiles.some(f => f.relativePath === "change-set.diff"), "change-set.diff must not exist at E0");
  assert.ok(!taskFiles.some(f => f.relativePath === "harness-profile.md"), "harness-profile.md must not exist at E0");
  // Manifest should not have change-context artifact references
  assert.ok(!("spec" in task.taskManifest.artifacts));
  assert.ok(!("changeSet" in task.taskManifest.artifacts));
  assert.ok(!("harnessProfile" in task.taskManifest.artifacts));
});

test("E1: only spec.md is materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-e1-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const spec = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E1");
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(taskFiles.some(f => f.relativePath === "spec.md"), "spec.md must exist at E1");
  assert.ok(!taskFiles.some(f => f.relativePath === "change-set.diff"), "change-set.diff must not exist at E1");
  assert.ok(!taskFiles.some(f => f.relativePath === "harness-profile.md"), "harness-profile.md must not exist at E1");
  // Verify spec content matches
  const specFile = taskFiles.find(f => f.relativePath === "spec.md")!;
  assert.ok(specFile.text.includes("Transaction Chaining"));
  // Manifest artifact reference
  assert.equal(task.taskManifest.artifacts.spec, "spec.md");
  assert.ok(!("changeSet" in task.taskManifest.artifacts));
  assert.ok(!("harnessProfile" in task.taskManifest.artifacts));
});

test("E2: spec.md and change-set.diff are materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-e2-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const spec = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E2");
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(taskFiles.some(f => f.relativePath === "spec.md"), "spec.md must exist at E2");
  assert.ok(taskFiles.some(f => f.relativePath === "change-set.diff"), "change-set.diff must exist at E2");
  assert.ok(!taskFiles.some(f => f.relativePath === "harness-profile.md"), "harness-profile.md must not exist at E2");
  // The diff should contain actual content (introducing commit diff)
  const diffFile = taskFiles.find(f => f.relativePath === "change-set.diff")!;
  assert.ok(diffFile.text.length > 0, "change-set.diff must not be empty");
  // Manifest artifact references
  assert.equal(task.taskManifest.artifacts.spec, "spec.md");
  assert.equal(task.taskManifest.artifacts.changeSet, "change-set.diff");
  assert.ok(!("harnessProfile" in task.taskManifest.artifacts));
});

test("E3: spec.md, change-set.diff, and harness-profile.md are materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-e3-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const spec = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E3");
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(taskFiles.some(f => f.relativePath === "spec.md"), "spec.md must exist at E3");
  assert.ok(taskFiles.some(f => f.relativePath === "change-set.diff"), "change-set.diff must exist at E3");
  assert.ok(taskFiles.some(f => f.relativePath === "harness-profile.md"), "harness-profile.md must exist at E3");
  const harnessFile = taskFiles.find(f => f.relativePath === "harness-profile.md")!;
  assert.ok(harnessFile.text.includes("HarnessProfile"));
  // Manifest artifact references
  assert.equal(task.taskManifest.artifacts.spec, "spec.md");
  assert.equal(task.taskManifest.artifacts.changeSet, "change-set.diff");
  assert.equal(task.taskManifest.artifacts.harnessProfile, "harness-profile.md");
});

// ---------------------------------------------------------------------------
// Policy A: legacy task hashes must not move
// ---------------------------------------------------------------------------

test("Policy A: case 001 truth bundle is byte-for-byte identical after changeContext support was added", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-policy-a-001-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "PostgreSQL #19560", commitFest: 7059 },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a join-planning correctness regression."
  };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  // changeContext-related keys must be absent — not present-as-null — for a
  // legacy spec that doesn't declare changeContext.
  assert.ok(!("changeContext" in task.taskManifest.artifacts));
  assert.ok(!("spec" in task.taskManifest.artifacts));
  assert.ok(!("changeSet" in task.taskManifest.artifacts));
  assert.ok(!("harnessProfile" in task.taskManifest.artifacts));
  assert.ok(!JSON.stringify(task.taskManifest).includes('"spec"'));
  assert.ok(!JSON.stringify(task.taskManifest).includes('"changeSet"'));
  assert.ok(!JSON.stringify(task.taskManifest).includes('"harnessProfile"'));

  // Verify truth bundle shape is unchanged
  assert.ok(!("structuredOracle" in task.truthManifest));
  assert.ok(!("behavioralOracle" in task.truthManifest));
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-exit-status-v1");

  // Reconstruct the pre-#212 truthShape and confirm hashes match
  const { bundleHash: _current, ...currentWithoutBundleHash } = task.truthManifest;
  const pristineShape = {
    schemaVersion: 1 as const,
    taskId: spec.taskId,
    upstreamBug: spec.truth.upstreamBug,
    commitFest: spec.truth.commitFest,
    historicalRevision: task.truthManifest.historicalRevision,
    referenceRevision: task.truthManifest.referenceRevision,
    gradingProtocol: "submitted-reproducer-exit-status-v1" as const,
    graderBundleVersion: task.truthManifest.graderBundleVersion,
    canonicalReproducer: task.truthManifest.canonicalReproducer,
    canonicalReproducerSha256: task.truthManifest.canonicalReproducerSha256,
    expectedBehaviorSha256: task.truthManifest.expectedBehaviorSha256,
    taskDefinitionHash: task.truthManifest.taskDefinitionHash
  };
  assert.deepEqual(Object.keys(currentWithoutBundleHash).sort(), Object.keys(pristineShape).sort());
  assert.deepEqual(currentWithoutBundleHash, pristineShape);

  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([l], [r]) => l.localeCompare(r))
          .map(([k, v]) => [k, canonicalize(v)])
      );
    }
    return value;
  }
  const pristineHash = createHash("sha256").update(JSON.stringify(canonicalize(pristineShape), null, 2)).digest("hex");
  assert.equal(pristineHash, task.truthManifest.bundleHash);
});

test("Policy A: case 001 taskDefinitionHash is byte-for-byte identical after changeContext support was added", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-policy-a-001-td-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "PostgreSQL #19560", commitFest: 7059 },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a join-planning correctness regression."
  };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  // Reconstruct the pre-#212 taskDefinition (no changeContext key)
  const taskDefinition = {
    schemaVersion: 1 as const,
    taskId: spec.taskId,
    sourceRevision: repo.ref,
    referenceRevision: repo.laterRef,
    sourceTree: task.taskManifest.hashes.sourceTree,
    promptHash: task.taskManifest.hashes.prompt,
    scaffoldingLevel: "minimal",
    budget: {},
    buildProfile: "host",
    agentWorkspaceHash: task.taskManifest.hashes.agentWorkspace,
    buildContractHash: task.taskManifest.hashes.buildContract
  };
  // Must NOT contain a "changeContext" key
  assert.ok(!("changeContext" in taskDefinition));
  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([l], [r]) => l.localeCompare(r))
          .map(([k, v]) => [k, canonicalize(v)])
      );
    }
    return value;
  }
  const expectedHash = createHash("sha256").update(JSON.stringify(canonicalize(taskDefinition), null, 2)).digest("hex");
  assert.equal(expectedHash, task.truthManifest.taskDefinitionHash);
});

// ---------------------------------------------------------------------------
// changeContext hashes are folded into taskDefinitionHash
// ---------------------------------------------------------------------------

test("changeContext hashes are part of taskDefinitionHash: different scaffolding levels produce different hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-cc-hash-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const specE0 = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E0");
  const specE1 = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E1");
  const specE2 = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E2");
  const specE3 = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E3");

  const [taskE0, taskE1, taskE2, taskE3] = await Promise.all([
    materializeHistoricalPostgresTask(specE0, join(root, "e0")),
    materializeHistoricalPostgresTask(specE1, join(root, "e1")),
    materializeHistoricalPostgresTask(specE2, join(root, "e2")),
    materializeHistoricalPostgresTask(specE3, join(root, "e3"))
  ]);

  // Each level exposes different artifacts, so taskDefinitionHash must differ
  const hashes = new Set([
    taskE0.truthManifest.taskDefinitionHash,
    taskE1.truthManifest.taskDefinitionHash,
    taskE2.truthManifest.taskDefinitionHash,
    taskE3.truthManifest.taskDefinitionHash
  ]);
  assert.equal(hashes.size, 4, "all four scaffolding levels must produce distinct taskDefinitionHash values");
});

// ---------------------------------------------------------------------------
// Grading protocol: structured oracle
// ---------------------------------------------------------------------------

test("postgres-change-001 materializes under the structured-oracle grading protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-protocol-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const spec = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E1");
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
  assert.equal(task.referenceManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
  assert.ok("structuredOracle" in task.truthManifest);
  assert.deepEqual(task.truthManifest.structuredOracle, spec.truth.structuredOracle);
  assert.ok(!("behavioralOracle" in task.truthManifest));
});

// ---------------------------------------------------------------------------
// resolveOracleReproduction: structured oracle dispatch
// ---------------------------------------------------------------------------

test("resolveOracleReproduction: structured oracle for 16867 — historical stdout gives reproduced: true", () => {
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-resolve-16867",
    source: { repoPath: "/unused", historicalRevision: "a".repeat(40), referenceRevision: "b".repeat(40) },
    truth: { upstreamBug: "Synthetic #16867", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test."
  };
  const execution = { ok: true, stdout: "alpha|x|y\n", stderr: "", exitCode: 0 as const, durationMs: 5 };
  const { reproduced, attribution } = resolveOracleReproduction({ execution, revision: "a".repeat(40), spec });
  assert.equal(reproduced, true);
  assert.equal(attribution?.attributedTo, "historical");
});

test("resolveOracleReproduction: structured oracle for 16867 — reference stdout gives reproduced: false", () => {
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-resolve-16867b",
    source: { repoPath: "/unused", historicalRevision: "a".repeat(40), referenceRevision: "b".repeat(40) },
    truth: { upstreamBug: "Synthetic #16867b", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test."
  };
  const execution = { ok: false, stdout: "beta|m|n\n", stderr: "", exitCode: 3 as const, durationMs: 5 };
  const { reproduced, attribution } = resolveOracleReproduction({ execution, revision: "b".repeat(40), spec });
  assert.equal(reproduced, false);
  assert.equal(attribution?.attributedTo, "reference");
});

// ---------------------------------------------------------------------------
// gradeHistoricalPostgresSubmission: structured oracle end-to-end
// ---------------------------------------------------------------------------

function gradeRevisionWith(
  fn: (revision: string) => { ok: boolean; stdout: string; exitCode: number }
) {
  return async ({ revision, spec }: { revision: string; reproducerPath: string; artifactDir: string; spec: HistoricalPostgresTaskSpec }) => {
    const ex = fn(revision);
    const execution = { ok: ex.ok, stdout: ex.stdout, stderr: "", exitCode: ex.exitCode, durationMs: 10 };
    const { reproduced, attribution } = resolveOracleReproduction({ execution, revision, spec });
    return { reproduced, execution, attribution };
  };
}

test("gradeHistoricalPostgresSubmission: structured oracle for 16867 — full rediscovery path", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-rediscovered-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "Bug reproduced", reproducer: "repro.sql" }));
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");

  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-structured-grade-16867",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic #16867", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test."
  };
  const grade = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts"),
    gradeRevision: gradeRevisionWith((revision) =>
      revision === repo.ref
        ? { ok: true, stdout: "alpha|x|y\n", exitCode: 0 }
        : { ok: false, stdout: "beta|m|n\n", exitCode: 3 }
    )
  });
  assert.equal(grade.status, "rediscovered", JSON.stringify(grade, null, 2));
  assert.equal(grade.historical.reproduced, true);
  assert.equal(grade.reference.reproduced, false);
  assert.equal(grade.historical.attribution?.attributedTo, "historical");
  assert.equal(grade.reference.attribution?.attributedTo, "reference");
});

// ---------------------------------------------------------------------------
// Recursive leak test
// ---------------------------------------------------------------------------

test("no file anywhere under the materialized task/ tree leaks the bug identity, revisions, introducing commit, or expected oracle tuples", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-leak-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const reproPath = join(root, "known-repro.sql");
  const fixEvidencePath = join(root, "future-regression-test-material.diff");
  const reproContents =
    "\\set ON_ERROR_STOP off\n" +
    "-- synthetic-canonical-reproducer for 16867 leak test\n" +
    "SELECT 1;\n";
  const fixEvidenceContents = "future-regression-test-material\n-- grader-private fix evidence for 16867\n";
  await writeFile(reproPath, reproContents);
  await writeFile(fixEvidencePath, fixEvidenceContents);

  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const spec = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E3", reproPath, fixEvidencePath);
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  const taskFiles = await readTreeAsText(task.taskDir);
  const secrets: Record<string, string> = {
    "raw upstream identity token": "16867",
    "upstream bug id": privateTruth.upstreamBug,
    "historical revision": spec.source.historicalRevision,
    "reference revision": spec.source.referenceRevision,
    "introducing commit": privateTruth.introducingCommit,
    "grader-private mirror path": spec.source.repoPath,
    "canonical reproducer host path": reproPath,
    "canonical reproducer contents": reproContents,
    "canonical reproducer hash": task.truthManifest.canonicalReproducerSha256!,
    "fix-evidence host path": fixEvidencePath,
    "fix-evidence contents": fixEvidenceContents,
    "fix-evidence hash": task.truthManifest.fixEvidenceSha256!,
    "future regression-test material": "future-regression-test-material",
    "historical expected tuple field 0": privateTruth.structuredOracle.historical.rows[0][0],
    "reference expected tuple field 0": privateTruth.structuredOracle.reference.rows[0][0]
  };

  for (const file of taskFiles) {
    for (const [label, secret] of Object.entries(secrets)) {
      assert.ok(!file.text.includes(secret), `task/${file.relativePath} leaked ${label}`);
    }
  }

  assert.ok(!taskFiles.some((file) => file.text.includes("canonical-reproducer.sql")));
  assert.ok(!taskFiles.some((file) => file.text.includes("truth.json")));
  assert.equal(JSON.parse(await readFile(join(task.taskDir, "source-manifest.json"), "utf8")).gitDirPresent, false);

  // Verify the canonical reproducer IS retained grader-side under reference/
  const referenceFiles = await readTreeAsText(task.referenceDir);
  const retained = referenceFiles.find((file) => file.relativePath === "verification/canonical-reproducer.sql");
  assert.ok(retained);
  assert.equal(retained!.text, reproContents);
});

test("change-set.diff at E2+ does not leak the historical or reference revision SHAs", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-diff-leak-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const privateTruth: HistoricalPostgresChange16867PrivateTruth = {
    ...SYNTHETIC_16867_PRIVATE_TRUTH,
    historicalRevision: repo.laterRef,
    referenceRevision: repo.ref,
    introducingCommit: repo.laterRef
  };
  const spec = historicalPostgresChange16867TaskSpec(repo.repoPath, privateTruth, "E2");
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const diffContent = await readFile(join(task.taskDir, "change-set.diff"), "utf8");
  // The diff is the introducing commit's diff, NOT diff between historical and
  // reference. It should not contain either pinned revision SHA.
  assert.ok(!diffContent.includes(spec.source.historicalRevision));
  assert.ok(!diffContent.includes(spec.source.referenceRevision));
});

// ---------------------------------------------------------------------------
// loadHistoricalPostgresChange16867PrivateTruth validation
// ---------------------------------------------------------------------------

async function writePrivateTruth(dir: string, content: unknown): Promise<string> {
  const path = join(dir, "private-truth.json");
  await writeFile(path, JSON.stringify(content));
  return path;
}

test("loadHistoricalPostgresChange16867PrivateTruth: rejects non-40-hex historicalRevision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-212-loader-"));
  const path = await writePrivateTruth(dir, {
    upstreamBug: "Synthetic BUG #test",
    historicalRevision: "not-a-sha",
    referenceRevision: "d".repeat(40),
    introducingCommit: "e".repeat(40),
    structuredOracle: {
      historical: { rows: [["alpha"]] },
      reference: { rows: [["beta"]] }
    }
  });
  await assert.rejects(
    () => loadHistoricalPostgresChange16867PrivateTruth(path),
    /40-character commit SHA/i
  );
});

test("loadHistoricalPostgresChange16867PrivateTruth: rejects non-40-hex introducingCommit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-212-loader-"));
  const path = await writePrivateTruth(dir, {
    upstreamBug: "Synthetic BUG #test",
    historicalRevision: "c".repeat(40),
    referenceRevision: "d".repeat(40),
    introducingCommit: "short",
    structuredOracle: {
      historical: { rows: [["alpha"]] },
      reference: { rows: [["beta"]] }
    }
  });
  await assert.rejects(
    () => loadHistoricalPostgresChange16867PrivateTruth(path),
    /40-character commit SHA/i
  );
});

test("loadHistoricalPostgresChange16867PrivateTruth: rejects missing upstreamBug", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-212-loader-"));
  const path = await writePrivateTruth(dir, {
    upstreamBug: "",
    historicalRevision: "c".repeat(40),
    referenceRevision: "d".repeat(40),
    introducingCommit: "e".repeat(40),
    structuredOracle: {
      historical: { rows: [["alpha"]] },
      reference: { rows: [["beta"]] }
    }
  });
  await assert.rejects(
    () => loadHistoricalPostgresChange16867PrivateTruth(path),
    /missing or empty.*upstreamBug/i
  );
});

test("loadHistoricalPostgresChange16867PrivateTruth: rejects overlapping oracle sides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-212-loader-"));
  const path = await writePrivateTruth(dir, {
    upstreamBug: "Synthetic BUG #test",
    historicalRevision: "c".repeat(40),
    referenceRevision: "d".repeat(40),
    introducingCommit: "e".repeat(40),
    structuredOracle: {
      historical: { rows: [["same"]] },
      reference: { rows: [["same"]] }
    }
  });
  await assert.rejects(
    () => loadHistoricalPostgresChange16867PrivateTruth(path),
    /overlap/i
  );
});

test("loadHistoricalPostgresChange16867PrivateTruth: rejects a field containing the separator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-212-loader-"));
  const path = await writePrivateTruth(dir, {
    upstreamBug: "Synthetic BUG #test",
    historicalRevision: "c".repeat(40),
    referenceRevision: "d".repeat(40),
    introducingCommit: "e".repeat(40),
    structuredOracle: {
      historical: { rows: [["alpha|x"]] },
      reference: { rows: [["beta"]] }
    }
  });
  await assert.rejects(
    () => loadHistoricalPostgresChange16867PrivateTruth(path),
    /field separator/i
  );
});

// ---------------------------------------------------------------------------
// checkedTaskSpec: changeContext validation
// ---------------------------------------------------------------------------

test("checkedTaskSpec rejects empty changeContext.spec", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-validate-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-bad-cc",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic #bad", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test.",
    changeContext: {
      spec: "",
      introducingCommit: repo.laterRef
    }
  };
  await assert.rejects(
    () => materializeHistoricalPostgresTask(spec, join(root, "case")),
    /changeContext\.spec is required/i
  );
});

test("checkedTaskSpec rejects non-40-hex changeContext.introducingCommit", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-validate-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-bad-cc2",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic #bad", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test.",
    changeContext: {
      spec: "Some spec content.",
      introducingCommit: "not-a-sha"
    }
  };
  await assert.rejects(
    () => materializeHistoricalPostgresTask(spec, join(root, "case")),
    /40-character commit SHA/i
  );
});

test("checkedTaskSpec rejects unknown change-oriented scaffolding levels", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-scaffolding-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-invalid-scaffolding",
    source: { repoPath: repo.repoPath, historicalRevision: repo.laterRef, referenceRevision: repo.ref },
    truth: { upstreamBug: "Synthetic #scaffolding", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test.",
    scaffoldingLevel: "E4",
    changeContext: { spec: "Contemporaneous context.", introducingCommit: repo.laterRef }
  };
  await assert.rejects(
    () => materializeHistoricalPostgresTask(spec, join(root, "case")),
    /scaffoldingLevel.*E0, E1, E2, or E3/i
  );
});

test("checkedTaskSpec requires a HarnessProfile for E3", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-harness-profile-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-missing-harness",
    source: { repoPath: repo.repoPath, historicalRevision: repo.laterRef, referenceRevision: repo.ref },
    truth: { upstreamBug: "Synthetic #harness", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test.",
    scaffoldingLevel: "E3",
    changeContext: { spec: "Contemporaneous context.", introducingCommit: repo.laterRef }
  };
  await assert.rejects(
    () => materializeHistoricalPostgresTask(spec, join(root, "case")),
    /harnessProfile is required when scaffoldingLevel is E3/i
  );
});

test("HistoricalChangeTask rejects a source revision that resolves differently from its introducing change", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-212-causal-binding-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-causal-mismatch",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic #causal", structuredOracle: SYNTHETIC_ORACLE },
    build: { mode: "host" },
    prompt: "Test.",
    scaffoldingLevel: "E2",
    changeContext: {
      spec: "Contemporaneous context.",
      introducingCommit: repo.laterRef
    }
  };
  await assert.rejects(
    () => materializeHistoricalPostgresTask(spec, join(root, "case")),
    /must resolve to the same commit/i
  );
});
