import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HISTORICAL_POSTGRES_18574_FIX_COMMIT,
  HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT,
  historicalPostgres002TaskSpec,
  historicalPostgresBug18574BehavioralOracle,
  historicalPostgresChange16867HarnessProfile,
  historicalPostgresChange18574Spec,
  historicalPostgresChange18574TaskPrompt,
  historicalPostgresChange18574TaskSpec,
  materializeHistoricalPostgresTask,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";
import { readTreeAsText } from "./helpers/read-tree-as-text.js";

/** Rewrites a spec built against the real PostgreSQL revisions to point at a synthetic repo's commits, mirroring the pattern historical-postgres-212-task.test.ts and historical-postgres-002-task.test.ts already use. */
function withSyntheticRevisions(
  spec: HistoricalPostgresTaskSpec,
  repo: { repoPath: string; ref: string; laterRef: string }
): HistoricalPostgresTaskSpec {
  return {
    ...spec,
    source: { ...spec.source, repoPath: repo.repoPath, historicalRevision: repo.laterRef, referenceRevision: repo.ref },
    ...(spec.changeContext ? { changeContext: { ...spec.changeContext, introducingCommit: repo.laterRef } } : {})
  };
}

// ---------------------------------------------------------------------------
// Identity and structure
// ---------------------------------------------------------------------------

test("historicalPostgresChange18574TaskSpec carries the confirmed #18574 identity behind an opaque task id", () => {
  const spec = historicalPostgresChange18574TaskSpec("/unused/repo/path", "E0");
  assert.equal(spec.taskId, "postgres-change-002");
  assert.equal(spec.source.historicalRevision, HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT);
  assert.equal(spec.source.referenceRevision, HISTORICAL_POSTGRES_18574_FIX_COMMIT);
  assert.equal(spec.truth.upstreamBug, "PostgreSQL BUG #18574");
  assert.equal(spec.truth.commitFest, undefined);
  assert.ok(spec.prompt.trim().length > 0);
  assert.ok(spec.changeContext, "changeContext must be present");
  assert.ok(spec.changeContext!.spec.trim().length > 0);
  assert.equal(spec.changeContext!.introducingCommit, HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT);
  assert.ok(spec.changeContext!.harnessProfile);
});

test("historicalPostgresChange18574TaskSpec declares a behavioral oracle, not a structured oracle", () => {
  const spec = historicalPostgresChange18574TaskSpec("/unused/repo/path", "E0");
  assert.ok(spec.truth.behavioralOracle, "behavioralOracle must be present");
  assert.equal(spec.truth.structuredOracle, undefined);
});

test("historicalPostgresChange18574TaskSpec supports all scaffolding levels", () => {
  for (const level of ["E0", "E1", "E2", "E3"] as const) {
    const spec = historicalPostgresChange18574TaskSpec("/unused/repo/path", level);
    assert.equal(spec.scaffoldingLevel, level);
    assert.ok(spec.changeContext, `changeContext must be present at ${level}`);
  }
});

test("knownReproducerPath and knownFixEvidencePath pass through to truth for provenance hashing", () => {
  const spec = historicalPostgresChange18574TaskSpec("/unused/repo/path", "E2", "/private/known-repro.sql", "/private/fix-evidence.diff");
  assert.equal(spec.truth.knownReproducerPath, "/private/known-repro.sql");
  assert.equal(spec.truth.knownFixEvidencePath, "/private/fix-evidence.diff");
});

// ---------------------------------------------------------------------------
// Reuse, not duplication: behavioral oracle and HarnessProfile
// ---------------------------------------------------------------------------

test("the change-oriented behavioral oracle is byte-for-byte identical to historicalPostgres002TaskSpec's own oracle", () => {
  const blindDiscoverySpec = historicalPostgres002TaskSpec("/unused/repo/path");
  const changeSpec = historicalPostgresChange18574TaskSpec("/unused/repo/path", "E0");
  assert.deepEqual(changeSpec.truth.behavioralOracle, blindDiscoverySpec.truth.behavioralOracle);
  assert.deepEqual(changeSpec.truth.behavioralOracle, historicalPostgresBug18574BehavioralOracle());
});

test("the E3 HarnessProfile is byte-for-byte identical to the frozen postgres-change-001 HarnessProfile", () => {
  const spec = historicalPostgresChange18574TaskSpec("/unused/repo/path", "E3");
  assert.equal(spec.changeContext!.harnessProfile, historicalPostgresChange16867HarnessProfile());
});

// ---------------------------------------------------------------------------
// SPEC and prompt content integrity: contemporaneous-context rule
// ---------------------------------------------------------------------------

test("spec.md content does not contain prohibited hindsight markers", () => {
  const specContent = historicalPostgresChange18574Spec();
  const prohibited = [
    "18574",
    "Song Hongyu",
    "stale",
    "drop",
    "recreate",
    "cache lookup failed",
    "OID",
    "BUG #18574"
  ];
  for (const marker of prohibited) {
    assert.ok(
      !specContent.toLowerCase().includes(marker.toLowerCase()),
      `spec.md contains prohibited hindsight marker: "${marker}"`
    );
  }
});

test("prompt does not leak bug identity, fix commit, reporter name, or hindsight terminology", () => {
  const prompt = historicalPostgresChange18574TaskPrompt();
  for (const marker of [
    "18574",
    "Song Hongyu",
    "make_callstmt_target",
    HISTORICAL_POSTGRES_18574_FIX_COMMIT,
    HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT,
    "stale",
    "cache lookup failed"
  ]) {
    assert.ok(!prompt.toLowerCase().includes(marker.toLowerCase()), `prompt leaks bug-specific marker: ${marker}`);
  }
});

// ---------------------------------------------------------------------------
// E0-E3 materialization visibility
// ---------------------------------------------------------------------------

test("E0: no change-context artifacts are materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-e0-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec = withSyntheticRevisions(historicalPostgresChange18574TaskSpec("unused", "E0"), repo);
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(!taskFiles.some((f) => f.relativePath === "spec.md"), "spec.md must not exist at E0");
  assert.ok(!taskFiles.some((f) => f.relativePath === "change-set.diff"), "change-set.diff must not exist at E0");
  assert.ok(!taskFiles.some((f) => f.relativePath === "harness-profile.md"), "harness-profile.md must not exist at E0");
  assert.ok(!("spec" in task.taskManifest.artifacts));
  assert.ok(!("changeSet" in task.taskManifest.artifacts));
  assert.ok(!("harnessProfile" in task.taskManifest.artifacts));
});

test("E1: only spec.md is materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-e1-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec = withSyntheticRevisions(historicalPostgresChange18574TaskSpec("unused", "E1"), repo);
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(taskFiles.some((f) => f.relativePath === "spec.md"), "spec.md must exist at E1");
  assert.ok(!taskFiles.some((f) => f.relativePath === "change-set.diff"), "change-set.diff must not exist at E1");
  assert.ok(!taskFiles.some((f) => f.relativePath === "harness-profile.md"), "harness-profile.md must not exist at E1");
  const specFile = taskFiles.find((f) => f.relativePath === "spec.md")!;
  assert.ok(specFile.text.includes("Repeated CALL/DO Plan Caching"));
  assert.equal(task.taskManifest.artifacts.spec, "spec.md");
  assert.ok(!("changeSet" in task.taskManifest.artifacts));
  assert.ok(!("harnessProfile" in task.taskManifest.artifacts));
});

test("E2: spec.md and change-set.diff are materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-e2-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec = withSyntheticRevisions(historicalPostgresChange18574TaskSpec("unused", "E2"), repo);
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(taskFiles.some((f) => f.relativePath === "spec.md"), "spec.md must exist at E2");
  assert.ok(taskFiles.some((f) => f.relativePath === "change-set.diff"), "change-set.diff must exist at E2");
  assert.ok(!taskFiles.some((f) => f.relativePath === "harness-profile.md"), "harness-profile.md must not exist at E2");
  const diffFile = taskFiles.find((f) => f.relativePath === "change-set.diff")!;
  assert.ok(diffFile.text.length > 0, "change-set.diff must not be empty");
  assert.equal(task.taskManifest.artifacts.spec, "spec.md");
  assert.equal(task.taskManifest.artifacts.changeSet, "change-set.diff");
  assert.ok(!("harnessProfile" in task.taskManifest.artifacts));
});

test("E3: spec.md, change-set.diff, and harness-profile.md are materialized", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-e3-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec = withSyntheticRevisions(historicalPostgresChange18574TaskSpec("unused", "E3"), repo);
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const taskFiles = await readTreeAsText(task.taskDir);
  assert.ok(taskFiles.some((f) => f.relativePath === "spec.md"), "spec.md must exist at E3");
  assert.ok(taskFiles.some((f) => f.relativePath === "change-set.diff"), "change-set.diff must exist at E3");
  assert.ok(taskFiles.some((f) => f.relativePath === "harness-profile.md"), "harness-profile.md must exist at E3");
  const harnessFile = taskFiles.find((f) => f.relativePath === "harness-profile.md")!;
  assert.equal(harnessFile.text.trim(), `${historicalPostgresChange16867HarnessProfile().trim()}`);
  assert.equal(task.taskManifest.artifacts.spec, "spec.md");
  assert.equal(task.taskManifest.artifacts.changeSet, "change-set.diff");
  assert.equal(task.taskManifest.artifacts.harnessProfile, "harness-profile.md");
});

// ---------------------------------------------------------------------------
// Hash coverage
// ---------------------------------------------------------------------------

test("changeContext hashes are part of taskDefinitionHash: different scaffolding levels produce different hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-cc-hash-"));
  const repo = await createSyntheticPostgresSourceRepo(root);

  const [taskE0, taskE1, taskE2, taskE3] = await Promise.all(
    (["E0", "E1", "E2", "E3"] as const).map((level, index) =>
      materializeHistoricalPostgresTask(
        withSyntheticRevisions(historicalPostgresChange18574TaskSpec("unused", level), repo),
        join(root, `e${index}`)
      )
    )
  );

  const hashes = new Set([
    taskE0.truthManifest.taskDefinitionHash,
    taskE1.truthManifest.taskDefinitionHash,
    taskE2.truthManifest.taskDefinitionHash,
    taskE3.truthManifest.taskDefinitionHash
  ]);
  assert.equal(hashes.size, 4, "all four scaffolding levels must produce distinct taskDefinitionHash values");
});

// ---------------------------------------------------------------------------
// Grading protocol: behavioral oracle
// ---------------------------------------------------------------------------

test("postgres-change-002 materializes under the behavioral-oracle grading protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-protocol-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec = withSyntheticRevisions(historicalPostgresChange18574TaskSpec("unused", "E1"), repo);
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
  assert.equal(task.referenceManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
  assert.ok("behavioralOracle" in task.truthManifest);
  assert.deepEqual(task.truthManifest.behavioralOracle, spec.truth.behavioralOracle);
});

// ---------------------------------------------------------------------------
// Leakage/integrity
// ---------------------------------------------------------------------------

test("no file anywhere under the materialized task/ tree leaks the bug identity, revisions, reproducer, or fix evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-leak-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const reproPath = join(root, "known-repro.sql");
  const fixEvidencePath = join(root, "fix-evidence.diff");
  const reproContents = "\\set ON_ERROR_STOP off\n-- synthetic-canonical-reproducer for 18574 leak test\nSELECT 1;\n";
  const fixEvidenceContents = "synthetic-fix-evidence\n-- grader-private fix evidence for 18574\n";
  await writeFile(reproPath, reproContents);
  await writeFile(fixEvidencePath, fixEvidenceContents);

  const spec = withSyntheticRevisions(
    historicalPostgresChange18574TaskSpec("unused", "E3", reproPath, fixEvidencePath),
    repo
  );
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  const taskFiles = await readTreeAsText(task.taskDir);
  const secrets: Record<string, string> = {
    "raw upstream identity token": "18574",
    "reporter name": "Song Hongyu",
    "real introducing commit (unused here, but must never leak from constants)": HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT,
    "real fix commit (unused here, but must never leak from constants)": HISTORICAL_POSTGRES_18574_FIX_COMMIT,
    "grader-private mirror path": repo.repoPath,
    "canonical reproducer host path": reproPath,
    "canonical reproducer contents": reproContents,
    "canonical reproducer hash": task.truthManifest.canonicalReproducerSha256!,
    "fix-evidence host path": fixEvidencePath,
    "fix-evidence contents": fixEvidenceContents,
    "fix-evidence hash": task.truthManifest.fixEvidenceSha256!,
    "oracle second-CALL historical pattern": "cache lookup failed"
  };

  for (const file of taskFiles) {
    for (const [label, secret] of Object.entries(secrets)) {
      assert.ok(!file.text.includes(secret), `task/${file.relativePath} leaked ${label}`);
    }
  }

  assert.ok(!taskFiles.some((file) => file.text.includes("canonical-reproducer.sql")));
  assert.ok(!taskFiles.some((file) => file.text.includes("truth.json")));
  assert.equal(JSON.parse(await readFile(join(task.taskDir, "source-manifest.json"), "utf8")).gitDirPresent, false);

  const referenceFiles = await readTreeAsText(task.referenceDir);
  const retained = referenceFiles.find((file) => file.relativePath === "verification/canonical-reproducer.sql");
  assert.ok(retained);
  assert.equal(retained!.text, reproContents);
});

test("change-set.diff at E2+ does not leak the historical or reference revision SHAs", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-221-diff-leak-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec = withSyntheticRevisions(historicalPostgresChange18574TaskSpec("unused", "E2"), repo);
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  const diffContent = await readFile(join(task.taskDir, "change-set.diff"), "utf8");
  assert.ok(!diffContent.includes(spec.source.historicalRevision));
  assert.ok(!diffContent.includes(spec.source.referenceRevision));
});
