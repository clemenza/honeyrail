import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  gradeHistoricalPostgresSubmission,
  historicalPostgres003TaskPrompt,
  historicalPostgres003TaskSpec,
  materializeHistoricalPostgresTask,
  resolveOracleReproduction,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { evaluateStructuredOracleAttribution } from "../server/postgres/historical-structured-oracle.js";
import { createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";
import { readTreeAsText } from "./helpers/read-tree-as-text.js";

// ---------------------------------------------------------------------------
// Identity and structure
// ---------------------------------------------------------------------------

test("historicalPostgres003TaskSpec carries the frozen #185 Bug 3 identity behind an opaque task id, and no CommitFest", () => {
  const spec = historicalPostgres003TaskSpec("/unused/repo/path");
  assert.equal(spec.taskId, "postgres-historical-003");
  assert.equal(spec.source.historicalRevision, "c7c4ce2be363ac5cf5141e73fd7966e0bbfe401f");
  assert.equal(spec.source.referenceRevision, "10323f140fef776881923f1afc0a369f7be8e035");
  assert.equal(spec.truth.upstreamBug, "PostgreSQL BUG #18118");
  assert.equal(spec.truth.commitFest, undefined);
  assert.ok(spec.prompt.trim().length > 0);
  // The prompt is agent-visible: it must never name the upstream bug, a
  // specific chain/savepoint/subtransaction mechanism, or the raw expected tuples.
  assert.ok(!spec.prompt.includes("18118"));
  assert.ok(!spec.prompt.toLowerCase().includes("commitfest"));
  assert.ok(!spec.prompt.toLowerCase().includes("savepoint"));
  assert.ok(!spec.prompt.toLowerCase().includes("chain"));
  assert.ok(!spec.prompt.toLowerCase().includes("serializable|on|on"));
  assert.equal(historicalPostgres003TaskPrompt(), spec.prompt);
});

test("historicalPostgres003TaskSpec declares a structured oracle with the expected tuple shape", () => {
  const spec = historicalPostgres003TaskSpec("/unused/repo/path");
  const oracle = spec.truth.structuredOracle;
  assert.ok(oracle, "structuredOracle must be present");
  assert.ok(Array.isArray(oracle!.historical.rows));
  assert.ok(Array.isArray(oracle!.reference.rows));
  assert.equal(oracle!.historical.rows.length, 1);
  assert.equal(oracle!.reference.rows.length, 1);
  assert.equal(oracle!.historical.rows[0].length, 3);
  assert.equal(oracle!.reference.rows[0].length, 3);
  // Oracle sides must be mutually exclusive (historical != reference)
  assert.notDeepEqual(oracle!.historical.rows, oracle!.reference.rows);
  // No behavioralOracle on a structured-oracle task
  assert.equal(spec.truth.behavioralOracle, undefined);
});

test("historicalPostgres003TaskSpec passes a known-reproducer path through to truth for provenance hashing", () => {
  const spec = historicalPostgres003TaskSpec("/unused/repo/path", "/private/known-repro.sql");
  assert.equal(spec.truth.knownReproducerPath, "/private/known-repro.sql");
});

// ---------------------------------------------------------------------------
// Grading protocol: structured oracle
// ---------------------------------------------------------------------------

test("historicalPostgres003TaskSpec materializes under the structured-oracle grading protocol, distinct from 001/002", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-protocol-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const base = historicalPostgres003TaskSpec(repo.repoPath);
  const spec: HistoricalPostgresTaskSpec = { ...base, source: { ...base.source, historicalRevision: repo.ref, referenceRevision: repo.laterRef } };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
  assert.equal(task.referenceManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
  // The structuredOracle key is genuinely present (not merely non-null) when a
  // task declares one — the mirror image of the "absent, not null" Policy A
  // proof for case 001/002.
  assert.ok("structuredOracle" in task.truthManifest);
  assert.deepEqual(task.truthManifest.structuredOracle, spec.truth.structuredOracle);
  // behavioralOracle must be absent — not present-as-null — for a structured-oracle task
  assert.ok(!("behavioralOracle" in task.truthManifest));
});

// ---------------------------------------------------------------------------
// Hash isolation: structuredOracle presence moves bundleHash, not taskDefinitionHash
// ---------------------------------------------------------------------------

test("structuredOracle/gradingProtocol presence is covered by bundleHash but not by taskDefinitionHash", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-hash-scope-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const withoutOracle: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-hash-scope-003",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #55503" },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a correctness regression."
  };
  const withOracle: HistoricalPostgresTaskSpec = {
    ...withoutOracle,
    truth: {
      ...withoutOracle.truth,
      structuredOracle: {
        historical: { rows: [["synthetic-historical-value"]] },
        reference: { rows: [["synthetic-reference-value"]] }
      }
    }
  };
  const a = await materializeHistoricalPostgresTask(withoutOracle, join(root, "without-oracle"));
  const b = await materializeHistoricalPostgresTask(withOracle, join(root, "with-oracle"));
  assert.equal(a.truthManifest.taskDefinitionHash, b.truthManifest.taskDefinitionHash);
  assert.notEqual(a.truthManifest.bundleHash, b.truthManifest.bundleHash);
  assert.notEqual(a.referenceManifest.gradingProtocol, b.referenceManifest.gradingProtocol);
});

// ---------------------------------------------------------------------------
// Policy A: case 001 and case 002 truth bundles are byte-identical after
// adding structuredOracle support (no new unconditional keys).
// ---------------------------------------------------------------------------

test("Policy A: case 001 truth bundle is byte-for-byte identical after structuredOracle support was added", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-policy-a-001-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "PostgreSQL #19560", commitFest: 7059 },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a join-planning correctness regression."
  };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  // structuredOracle key must be genuinely absent — not present-as-null — for a
  // legacy spec that declares no oracle. Adding it unconditionally would move
  // the bundleHash for zero behavioral reason (Policy A).
  assert.ok(!("structuredOracle" in task.truthManifest));
  assert.ok(!JSON.stringify(task.truthManifest).includes("structuredOracle"));
  assert.ok(!("behavioralOracle" in task.truthManifest));
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-exit-status-v1");

  // Reconstruct the pre-#199 (pre-structuredOracle) truthShape literally and
  // confirm the current legacy-path bundle hashes identically.
  const { bundleHash: _current, ...currentWithoutBundleHash } = task.truthManifest;
  const pristineShape = {
    schemaVersion: 1 as const,
    taskId: spec.taskId,
    upstreamBug: spec.truth.upstreamBug,
    commitFest: spec.truth.commitFest,
    historicalRevision: task.truthManifest.historicalRevision,
    referenceRevision: task.truthManifest.referenceRevision,
    gradingProtocol: "submitted-reproducer-exit-status-v1" as const,
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

test("Policy A: case 002 truth bundle is byte-for-byte identical after structuredOracle support was added", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-policy-a-002-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-002",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: {
      upstreamBug: "PostgreSQL BUG #18574",
      behavioralOracle: {
        historical: [
          { label: "first CALL", matches: '^procedure parameter "r1" is an output parameter but corresponding argument is not writable$' },
          { label: "second CALL", matches: "^cache lookup failed for function \\d+$" }
        ],
        reference: [
          { label: "first CALL", matches: '^procedure parameter "r1" is an output parameter but corresponding argument is not writable$' },
          { label: "second CALL", matches: '^procedure parameter "r1" is an output parameter but corresponding argument is not writable$' }
        ]
      }
    },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a PL/pgSQL correctness regression."
  };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  // structuredOracle key must be absent for a behavioralOracle-declaring spec
  assert.ok(!("structuredOracle" in task.truthManifest));
  assert.ok(!JSON.stringify(task.truthManifest).includes("structuredOracle"));
  // behavioralOracle is present, gradingProtocol is behavioral
  assert.ok("behavioralOracle" in task.truthManifest);
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
});

// ---------------------------------------------------------------------------
// resolveOracleReproduction: structured oracle dispatch
// ---------------------------------------------------------------------------

test("resolveOracleReproduction: structured oracle — historical stdout gives reproduced: true", () => {
  const oracle = {
    historical: { rows: [["read committed", "off", "off"]] },
    reference: { rows: [["serializable", "on", "on"]] }
  };
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-resolve-003",
    source: { repoPath: "/unused", historicalRevision: "a".repeat(40), referenceRevision: "b".repeat(40) },
    truth: { upstreamBug: "Synthetic #99902", structuredOracle: oracle },
    build: { mode: "host" },
    prompt: "Test."
  };
  const execution = { ok: true, stdout: "read committed|off|off\n", stderr: "", exitCode: 0 as const, durationMs: 5 };
  const { reproduced, attribution } = resolveOracleReproduction({ execution, revision: "a".repeat(40), spec });
  assert.equal(reproduced, true);
  assert.equal(attribution?.attributedTo, "historical");
});

test("resolveOracleReproduction: structured oracle — reference stdout gives reproduced: false", () => {
  const oracle = {
    historical: { rows: [["read committed", "off", "off"]] },
    reference: { rows: [["serializable", "on", "on"]] }
  };
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-resolve-003b",
    source: { repoPath: "/unused", historicalRevision: "a".repeat(40), referenceRevision: "b".repeat(40) },
    truth: { upstreamBug: "Synthetic #99903", structuredOracle: oracle },
    build: { mode: "host" },
    prompt: "Test."
  };
  const execution = { ok: false, stdout: "serializable|on|on\n", stderr: "", exitCode: 3 as const, durationMs: 5 };
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

test("gradeHistoricalPostgresSubmission: structured oracle — full rediscovery path", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-rediscovered-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "Bug 3 reproduced", reproducer: "repro.sql" }));
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");

  const oracle = {
    historical: { rows: [["read committed", "off", "off"]] },
    reference: { rows: [["serializable", "on", "on"]] }
  };
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-structured-grade",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic #99904", structuredOracle: oracle },
    build: { mode: "host" },
    prompt: "Test."
  };
  const grade = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts"),
    gradeRevision: gradeRevisionWith((revision) =>
      revision === repo.ref
        ? { ok: true, stdout: "read committed|off|off\n", exitCode: 0 }
        : { ok: false, stdout: "serializable|on|on\n", exitCode: 3 }
    )
  });
  assert.equal(grade.status, "rediscovered", JSON.stringify(grade, null, 2));
  assert.equal(grade.historical.reproduced, true);
  assert.equal(grade.reference.reproduced, false);
  assert.equal(grade.historical.attribution?.attributedTo, "historical");
  assert.equal(grade.reference.attribution?.attributedTo, "reference");
});

test("gradeHistoricalPostgresSubmission: structured oracle — wrong historical output is miss", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-miss-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "miss test", reproducer: "repro.sql" }));
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");

  const oracle = {
    historical: { rows: [["read committed", "off", "off"]] },
    reference: { rows: [["serializable", "on", "on"]] }
  };
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-structured-miss",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic #99905", structuredOracle: oracle },
    build: { mode: "host" },
    prompt: "Test."
  };
  // Historical output is unrelated — does not match either oracle side
  const grade = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts"),
    gradeRevision: gradeRevisionWith(() => ({ ok: true, stdout: "repeatable read|off|on\n", exitCode: 0 }))
  });
  assert.equal(grade.status, "miss", JSON.stringify(grade, null, 2));
});

test("gradeHistoricalPostgresSubmission: structured oracle — infrastructure-invalid execution is infrastructure_error", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-infra-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "infra test", reproducer: "repro.sql" }));
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");

  const oracle = {
    historical: { rows: [["read committed", "off", "off"]] },
    reference: { rows: [["serializable", "on", "on"]] }
  };
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-structured-infra",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic #99906", structuredOracle: oracle },
    build: { mode: "host" },
    prompt: "Test."
  };
  // Invalid exit code on the historical revision = infrastructure_error
  const grade = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts"),
    gradeRevision: async ({ revision, spec: s }) => {
      const execution = { ok: false, stdout: "", stderr: "", exitCode: 1 as const, durationMs: 5 };
      const { reproduced, attribution } = resolveOracleReproduction({ execution, revision, spec: s });
      return { reproduced, execution, attribution };
    }
  });
  assert.equal(grade.status, "infrastructure_error", JSON.stringify(grade, null, 2));
});

// ---------------------------------------------------------------------------
// Recursive leak test — the most important correctness proof for HOLDOUT
// ---------------------------------------------------------------------------

test("no file anywhere under the materialized task/ tree leaks the bug identity, either revision, the canonical reproducer, or the expected oracle tuples", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-003-leak-"));
  // Create synthetic repo BEFORE writing the repro file (same discipline as
  // the 002 leak test: the fixture commits everything present in repoPath, so
  // writing repro first would commit it into the archived source snapshot).
  const repo = await createSyntheticPostgresSourceRepo(root);
  const reproPath = join(root, "known-repro.sql");
  const reproContents =
    "\\set ON_ERROR_STOP off\n" +
    "SET default_transaction_isolation = 'read committed';\n" +
    "SET default_transaction_read_only = off;\n" +
    "SET default_transaction_deferrable = off;\n" +
    "-- canonical Bug 3 reproducer content (never committed)\n";
  await writeFile(reproPath, reproContents);

  const base = historicalPostgres003TaskSpec(repo.repoPath, reproPath);
  const spec: HistoricalPostgresTaskSpec = { ...base, source: { ...base.source, historicalRevision: repo.ref, referenceRevision: repo.laterRef } };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  const taskFiles = await readTreeAsText(task.taskDir);
  const secrets: Record<string, string> = {
    // Upstream bug identity
    "upstream bug number": "18118",
    "upstream bug id": "BUG #18118",
    // Failure-mechanism vocabulary (never in the prompt, never in task/)
    "failure mechanism (chain)": "COMMIT AND CHAIN",
    "failure mechanism (savepoint)": "savepoint",
    // Both pinned revisions
    "historical revision": spec.source.historicalRevision,
    "reference revision": spec.source.referenceRevision,
    // Grader-private filesystem paths
    "grader-private mirror path": spec.source.repoPath,
    "canonical reproducer host path": reproPath,
    // Reproducer content and provenance hash
    "canonical reproducer contents": reproContents,
    "canonical reproducer hash": task.truthManifest.canonicalReproducerSha256!,
    // Expected oracle tuple strings — the HOLDOUT answer key. These must
    // match the actual hardcoded HISTORICAL_POSTGRES_003_STRUCTURED_ORACLE
    // values (confirmed against the real PostgreSQL mirror, not the private
    // repro script's own inaccurate "read uncommitted" comment) — a leak test
    // that checks for the wrong string would silently fail to catch a real
    // leak of the true value.
    "historical expected tuple (full)": "read committed|off|off",
    "historical tuple field 0": "read committed",
    "reference expected tuple (full)": "serializable|on|on",
    "reference tuple field 0": "serializable"
  };

  for (const file of taskFiles) {
    for (const [label, secret] of Object.entries(secrets)) {
      assert.ok(!file.text.includes(secret), `task/${file.relativePath} leaked ${label}`);
    }
  }

  // The canonical reproducer's grader-private relative path must not appear
  // under task/ — it exists under reference/, so the check is scoped to task/.
  assert.ok(!taskFiles.some((file) => file.text.includes("canonical-reproducer.sql")));

  // Verify the canonical reproducer IS retained grader-side under reference/
  const referenceFiles = await readTreeAsText(task.referenceDir);
  const retained = referenceFiles.find((file) => file.relativePath === "verification/canonical-reproducer.sql");
  assert.ok(retained);
  assert.equal(retained!.text, reproContents);
});
