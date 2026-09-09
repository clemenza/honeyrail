import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  historicalPostgresChange16867TaskSpec,
  loadHistoricalPostgresChange16867PrivateTruth,
  gradeHistoricalPostgresSubmission,
  materializeHistoricalPostgresTask,
  runHistoricalPostgresTrial,
  type HistoricalPostgresStructuredOracleAttribution
} from "../server/postgres/historical-task.js";
import {
  withPostgresResearchEnvironment,
  type PostgresResearchEnvironment
} from "../server/postgres/research-environment.js";
import { resolveHistoricalPostgresTaskSpecFromEnv } from "../server/postgres/historical-postgres-task-env.js";
import { runCommandSafe } from "../server/utils.js";

// ---------------------------------------------------------------------------
// Integration-config classifier
// ---------------------------------------------------------------------------

export function classifyHistoricalPostgres212IntegrationConfig(env: {
  mirror: string;
  reproducer: string;
  privateTruthPath: string;
}): { state: "UNCONFIGURED" | "PARTIALLY_CONFIGURED" | "FULLY_CONFIGURED"; missing: string[] } {
  const all = [
    { key: "HONEYRAIL_PG_212_MIRROR", value: env.mirror },
    { key: "HONEYRAIL_PG_212_REPRODUCER", value: env.reproducer },
    { key: "HONEYRAIL_PG_212_PRIVATE_TRUTH", value: env.privateTruthPath }
  ];
  const missing = all.filter((e) => !e.value).map((e) => e.key);
  if (missing.length === 3) return { state: "UNCONFIGURED", missing };
  if (missing.length === 0) return { state: "FULLY_CONFIGURED", missing: [] };
  return { state: "PARTIALLY_CONFIGURED", missing };
}

// ---------------------------------------------------------------------------
// Unit tests for classifyHistoricalPostgres212IntegrationConfig
// ---------------------------------------------------------------------------

test("classifyHistoricalPostgres212IntegrationConfig: 0/3 set → UNCONFIGURED with all 3 missing", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({ mirror: "", reproducer: "", privateTruthPath: "" });
  assert.equal(result.state, "UNCONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_212_MIRROR", "HONEYRAIL_PG_212_PRIVATE_TRUTH", "HONEYRAIL_PG_212_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres212IntegrationConfig: only mirror set → PARTIALLY_CONFIGURED missing reproducer+privateTruth", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({ mirror: "/some/path", reproducer: "", privateTruthPath: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_212_PRIVATE_TRUTH", "HONEYRAIL_PG_212_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres212IntegrationConfig: only reproducer set → PARTIALLY_CONFIGURED missing mirror+privateTruth", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({ mirror: "", reproducer: "/some/repro.sql", privateTruthPath: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_212_MIRROR", "HONEYRAIL_PG_212_PRIVATE_TRUTH"].sort());
});

test("classifyHistoricalPostgres212IntegrationConfig: only privateTruth set → PARTIALLY_CONFIGURED missing mirror+reproducer", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({ mirror: "", reproducer: "", privateTruthPath: "/some/truth.json" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_212_MIRROR", "HONEYRAIL_PG_212_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres212IntegrationConfig: mirror+reproducer set (no privateTruth) → PARTIALLY_CONFIGURED missing privateTruth", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({ mirror: "/some/path", reproducer: "/some/repro.sql", privateTruthPath: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_212_PRIVATE_TRUTH"]);
});

test("classifyHistoricalPostgres212IntegrationConfig: mirror+privateTruth set (no reproducer) → PARTIALLY_CONFIGURED missing reproducer", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({ mirror: "/some/path", reproducer: "", privateTruthPath: "/some/truth.json" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_212_REPRODUCER"]);
});

test("classifyHistoricalPostgres212IntegrationConfig: reproducer+privateTruth set (no mirror) → PARTIALLY_CONFIGURED missing mirror", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({ mirror: "", reproducer: "/some/repro.sql", privateTruthPath: "/some/truth.json" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_212_MIRROR"]);
});

test("classifyHistoricalPostgres212IntegrationConfig: all 3 set → FULLY_CONFIGURED with 0 missing", () => {
  const result = classifyHistoricalPostgres212IntegrationConfig({
    mirror: "/some/path",
    reproducer: "/some/repro.sql",
    privateTruthPath: "/some/truth.json"
  });
  assert.equal(result.state, "FULLY_CONFIGURED");
  assert.deepEqual(result.missing, []);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL integration test
// ---------------------------------------------------------------------------

const mirror = String(process.env.HONEYRAIL_PG_212_MIRROR || "").trim();
const knownReproducer = String(process.env.HONEYRAIL_PG_212_REPRODUCER || "").trim();
const privateTruthPath = String(process.env.HONEYRAIL_PG_212_PRIVATE_TRUTH || "").trim();
const knownFixEvidence = String(process.env.HONEYRAIL_PG_212_FIX_EVIDENCE || "").trim();

const config = classifyHistoricalPostgres212IntegrationConfig({ mirror, reproducer: knownReproducer, privateTruthPath });

test(
  "#212 known local PostgreSQL verification distinguishes the pinned historical and corrected revisions",
  { skip: config.state === "UNCONFIGURED" ? "HONEYRAIL_PG_212_MIRROR, HONEYRAIL_PG_212_REPRODUCER, HONEYRAIL_PG_212_PRIVATE_TRUTH are not set" : false },
  async () => {
  if (config.state === "PARTIALLY_CONFIGURED") {
    assert.fail(
      `Integration test is partially configured — some but not all required env vars are set. ` +
      `Missing: ${config.missing.join(", ")}. ` +
      `Either set all three (HONEYRAIL_PG_212_MIRROR, HONEYRAIL_PG_212_REPRODUCER, HONEYRAIL_PG_212_PRIVATE_TRUTH) ` +
      `or none of them.`
    );
  }

  const privateTruth = await loadHistoricalPostgresChange16867PrivateTruth(privateTruthPath);
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg212-integration-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
  await writeFile(
    join(workspace, "finding.json"),
    JSON.stringify({ status: "reproduced", summary: "Known local change-task verification", reproducer: "repro.sql" })
  );
  const task = historicalPostgresChange16867TaskSpec(resolve(mirror), privateTruth, "E0", resolve(knownReproducer), knownFixEvidence ? resolve(knownFixEvidence) : undefined);
  const grade = await gradeHistoricalPostgresSubmission({
    task,
    workspaceDir: workspace,
    artifactDir: join(root, "artifacts")
  });
  assert.equal(grade.status, "rediscovered", JSON.stringify(grade, null, 2));
  assert.equal(grade.historical.reproduced, true);
  assert.equal(grade.reference.reproduced, false);

  const historicalAttribution = grade.historical.attribution as HistoricalPostgresStructuredOracleAttribution | undefined;
  const referenceAttribution = grade.reference.attribution as HistoricalPostgresStructuredOracleAttribution | undefined;

  assert.equal(historicalAttribution?.attributedTo, "historical");
  assert.equal(historicalAttribution?.historicalMatch.satisfied, true);
  assert.equal(historicalAttribution?.historicalMatch.rows.length, 1);
  assert.equal(referenceAttribution?.attributedTo, "reference");
  assert.equal(referenceAttribution?.referenceMatch.satisfied, true);

  // The materialized task tree must not leak the bug identity or fixed ref.
  const layout = await materializeHistoricalPostgresTask(task, join(root, "task-bundle"));
  const publicManifest = JSON.stringify(layout.taskManifest);
  assert.ok(!publicManifest.includes(privateTruth.upstreamBug));
  assert.ok(!publicManifest.includes(privateTruth.referenceRevision));
  assert.ok(!("referenceRevision" in layout.taskManifest));
  assert.equal(layout.taskManifest.taskId, "postgres-change-001");
  assert.equal(layout.truthManifest.upstreamBug, privateTruth.upstreamBug);
  assert.ok(layout.truthManifest.commitFest == null);
  assert.equal(layout.truthManifest.referenceRevision, task.source.referenceRevision);
  assert.ok(layout.truthManifest.canonicalReproducerSha256);
  assert.equal(layout.truthManifest.canonicalReproducer, "verification/canonical-reproducer.sql");
  assert.ok(layout.truthManifest.structuredOracle);
  assert.equal(layout.truthManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
  assert.equal(layout.referenceManifest.gradingProtocol, "submitted-reproducer-structured-oracle-v1");
});

test(
  "#212 E2 materialization binds the historical source to the complete introducing change-set",
  { skip: config.state !== "FULLY_CONFIGURED" || !knownFixEvidence ? "integration env vars plus HONEYRAIL_PG_212_FIX_EVIDENCE are required" : false },
  async () => {
    const privateTruth = await loadHistoricalPostgresChange16867PrivateTruth(privateTruthPath);
    const historicalRevision = "280a408b48d5ee42969f981bceb9e9426c3a344c";
    assert.equal(privateTruth.historicalRevision, historicalRevision);
    assert.equal(privateTruth.introducingCommit, historicalRevision);
    const expectedDiff = await runCommandSafe(
      "git",
      ["-C", resolve(mirror), "diff", `${historicalRevision}^`, historicalRevision],
      { timeout: 60_000, maxBuffer: 1024 * 1024 * 8 }
    );
    assert.equal(expectedDiff.ok, true, expectedDiff.stderr || expectedDiff.stdout);

    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg212-e2-materialization-"));
    const task = historicalPostgresChange16867TaskSpec(
      resolve(mirror), privateTruth, "E2", resolve(knownReproducer), resolve(knownFixEvidence)
    );
    const layout = await materializeHistoricalPostgresTask(task, join(root, "task-bundle"));
    assert.equal(layout.truthManifest.historicalRevision, historicalRevision);
    const sourceManifest = JSON.parse(await readFile(join(layout.referenceDir, "source-manifest.json"), "utf8"));
    assert.equal(sourceManifest.resolvedCommit, historicalRevision);
    assert.equal(await readFile(join(layout.taskDir, "change-set.diff"), "utf8"), expectedDiff.stdout);
  }
);

// ---------------------------------------------------------------------------
// 10x determinism: each revision must produce identical output every run
// ---------------------------------------------------------------------------

const privateTruthForDeterminism = privateTruthPath
  ? loadHistoricalPostgresChange16867PrivateTruth(privateTruthPath).catch(() => null)
  : Promise.resolve(null);

test(
  "#212 10x determinism: historical revision produces identical output on every run",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 600_000 },
  async () => {
    const truth = await privateTruthForDeterminism;
    assert.ok(truth, "private truth must load");
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg212-determ-hist-"));
    const results: string[] = [];
    await withPostgresResearchEnvironment(
      { root, source: { repoPath: resolve(mirror), ref: truth.historicalRevision }, build: { configureArgs: ["--without-readline", "--without-zlib", "--without-icu"] } },
      async (env: PostgresResearchEnvironment) => {
        await env.start();
        for (let i = 0; i < 10; i++) {
          const r = await env.psqlFile(resolve(knownReproducer));
          results.push(r.stdout);
        }
      }
    );
    assert.equal(results.length, 10);
    for (let i = 1; i < 10; i++) {
      assert.equal(results[i], results[0], `historical run ${i + 1} differs from run 1`);
    }
    assert.equal(results[0]!.trim(), "read committed");
  }
);

test(
  "#212 10x determinism: reference revision produces identical output on every run",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 600_000 },
  async () => {
    const truth = await privateTruthForDeterminism;
    assert.ok(truth, "private truth must load");
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg212-determ-ref-"));
    const results: string[] = [];
    await withPostgresResearchEnvironment(
      { root, source: { repoPath: resolve(mirror), ref: truth.referenceRevision }, build: { configureArgs: ["--without-readline", "--without-zlib", "--without-icu"] } },
      async (env: PostgresResearchEnvironment) => {
        await env.start();
        for (let i = 0; i < 10; i++) {
          const r = await env.psqlFile(resolve(knownReproducer));
          results.push(r.stdout);
        }
      }
    );
    assert.equal(results.length, 10);
    for (let i = 1; i < 10; i++) {
      assert.equal(results[i], results[0], `reference run ${i + 1} differs from run 1`);
    }
    assert.equal(results[0]!.trim(), "repeatable read");
  }
);

// ---------------------------------------------------------------------------
// Infrastructure error: unresolvable revision → infrastructure_error
// ---------------------------------------------------------------------------

test(
  "#212 infrastructure error: unresolvable revision is classified as infrastructure_error",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 300_000 },
  async () => {
    const truth = await privateTruthForDeterminism;
    assert.ok(truth, "private truth must load");
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg212-infra-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
    await writeFile(
      join(workspace, "finding.json"),
      JSON.stringify({ status: "reproduced", summary: "infra-error test", reproducer: "repro.sql" })
    );
    const badTruth = {
      ...truth,
      referenceRevision: "0000000000000000000000000000000000000000"
    };
    const task = historicalPostgresChange16867TaskSpec(
      resolve(mirror), badTruth, "E0",
      resolve(knownReproducer),
      knownFixEvidence ? resolve(knownFixEvidence) : undefined
    );
    const grade = await gradeHistoricalPostgresSubmission({
      task,
      workspaceDir: workspace,
      artifactDir: join(root, "artifacts")
    });
    assert.equal(grade.status, "infrastructure_error", JSON.stringify(grade, null, 2));
  }
);

// ---------------------------------------------------------------------------
// Normal-path trial through runHistoricalPostgresTrial()
// ---------------------------------------------------------------------------

test(
  "#212 normal-path trial: scripted fake agent produces a graded result",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 600_000 },
  async () => {
    const truth = await privateTruthForDeterminism;
    assert.ok(truth, "private truth must load");
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg212-trial-"));
    const artifactDir = join(root, "artifacts");

    const reproducerSql = await readFile(resolve(knownReproducer), "utf-8");
    const inlineScript = [
      'set -euo pipefail',
      'W="${HR_PG_WORK_DIR:-.}"',
      `cat > "$W/repro.sql" <<\'EOSQL\'`,
      reproducerSql.trimEnd(),
      'EOSQL',
      `printf '%s' '{"status":"reproduced","summary":"scripted fake agent","reproducer":"repro.sql"}' > "$W/finding.json"`,
    ].join("\n");

    const task = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-change-001", {
      HONEYRAIL_PG_212_MIRROR: resolve(mirror),
      HONEYRAIL_PG_212_REPRODUCER: resolve(knownReproducer),
      HONEYRAIL_PG_212_PRIVATE_TRUTH: resolve(privateTruthPath),
      ...(knownFixEvidence ? { HONEYRAIL_PG_212_FIX_EVIDENCE: resolve(knownFixEvidence) } : {})
    });
    const result = await runHistoricalPostgresTrial({
      task,
      agent: { command: "/bin/bash", args: ["-c", inlineScript], timeoutMs: 120_000 },
      artifactDir
    });
    assert.equal(result.status, "completed", JSON.stringify(result, null, 2));
    assert.ok(result.grade, "trial must produce a grade");
    assert.equal(result.grade!.status, "rediscovered");
  }
);
