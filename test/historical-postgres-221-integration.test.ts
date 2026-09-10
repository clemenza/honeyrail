import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  gradeHistoricalPostgresSubmission,
  historicalPostgresChange18574TaskSpec,
  materializeHistoricalPostgresTask,
  resolveOracleReproduction,
  runHistoricalPostgresTrial,
  type HistoricalPostgresOracleAttribution
} from "../server/postgres/historical-task.js";
import { classifyExecutionValidity } from "../server/postgres/historical-behavioral-oracle.js";
import {
  withPostgresResearchEnvironment,
  type PostgresResearchEnvironment
} from "../server/postgres/research-environment.js";
import { resolveHistoricalPostgresTaskSpecFromEnv } from "../server/postgres/historical-postgres-task-env.js";
import { RESEARCH_CONTAINER_PATHS } from "../server/postgres/agent-container.js";
import { runCommandSafe } from "../server/utils.js";

// ---------------------------------------------------------------------------
// Integration-config classifier
// ---------------------------------------------------------------------------

/**
 * Unlike #212 (whose `HONEYRAIL_PG_212_FIX_EVIDENCE` is genuinely optional -
 * the task can auto-generate fix evidence on request), #221's own CLI
 * (`scripts/historical-postgres-221.ts`) already requires
 * `HONEYRAIL_PG_221_FIX_EVIDENCE` unconditionally, since the introducing and
 * fix commits are ~3.5 years apart and auto-generation is unusable. The
 * integration tests must not disagree with the CLI about what "configured"
 * means, so all three vars are required together for FULLY_CONFIGURED here
 * (#221 review round 2, Blocking 3).
 */
export function classifyHistoricalPostgres221IntegrationConfig(env: {
  mirror: string;
  reproducer: string;
  fixEvidence: string;
}): { state: "UNCONFIGURED" | "PARTIALLY_CONFIGURED" | "FULLY_CONFIGURED"; missing: string[] } {
  const all = [
    { key: "HONEYRAIL_PG_221_MIRROR", value: env.mirror },
    { key: "HONEYRAIL_PG_221_REPRODUCER", value: env.reproducer },
    { key: "HONEYRAIL_PG_221_FIX_EVIDENCE", value: env.fixEvidence }
  ];
  const missing = all.filter((e) => !e.value).map((e) => e.key);
  if (missing.length === 3) return { state: "UNCONFIGURED", missing };
  if (missing.length === 0) return { state: "FULLY_CONFIGURED", missing: [] };
  return { state: "PARTIALLY_CONFIGURED", missing };
}

// ---------------------------------------------------------------------------
// Unit tests for classifyHistoricalPostgres221IntegrationConfig
// ---------------------------------------------------------------------------

test("classifyHistoricalPostgres221IntegrationConfig: 0/3 set → UNCONFIGURED with all 3 missing", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({ mirror: "", reproducer: "", fixEvidence: "" });
  assert.equal(result.state, "UNCONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_221_FIX_EVIDENCE", "HONEYRAIL_PG_221_MIRROR", "HONEYRAIL_PG_221_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres221IntegrationConfig: only mirror set → PARTIALLY_CONFIGURED missing reproducer+fixEvidence", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({ mirror: "/some/path", reproducer: "", fixEvidence: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_221_FIX_EVIDENCE", "HONEYRAIL_PG_221_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres221IntegrationConfig: only reproducer set → PARTIALLY_CONFIGURED missing mirror+fixEvidence", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({ mirror: "", reproducer: "/some/repro.sql", fixEvidence: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_221_FIX_EVIDENCE", "HONEYRAIL_PG_221_MIRROR"].sort());
});

test("classifyHistoricalPostgres221IntegrationConfig: only fixEvidence set → PARTIALLY_CONFIGURED missing mirror+reproducer", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({ mirror: "", reproducer: "", fixEvidence: "/some/fix-evidence.diff" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing.sort(), ["HONEYRAIL_PG_221_MIRROR", "HONEYRAIL_PG_221_REPRODUCER"].sort());
});

test("classifyHistoricalPostgres221IntegrationConfig: mirror+reproducer set (no fixEvidence) → PARTIALLY_CONFIGURED missing fixEvidence", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({ mirror: "/some/path", reproducer: "/some/repro.sql", fixEvidence: "" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_221_FIX_EVIDENCE"]);
});

test("classifyHistoricalPostgres221IntegrationConfig: mirror+fixEvidence set (no reproducer) → PARTIALLY_CONFIGURED missing reproducer", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({ mirror: "/some/path", reproducer: "", fixEvidence: "/some/fix-evidence.diff" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_221_REPRODUCER"]);
});

test("classifyHistoricalPostgres221IntegrationConfig: reproducer+fixEvidence set (no mirror) → PARTIALLY_CONFIGURED missing mirror", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({ mirror: "", reproducer: "/some/repro.sql", fixEvidence: "/some/fix-evidence.diff" });
  assert.equal(result.state, "PARTIALLY_CONFIGURED");
  assert.deepEqual(result.missing, ["HONEYRAIL_PG_221_MIRROR"]);
});

test("classifyHistoricalPostgres221IntegrationConfig: all 3 set → FULLY_CONFIGURED with 0 missing", () => {
  const result = classifyHistoricalPostgres221IntegrationConfig({
    mirror: "/some/path",
    reproducer: "/some/repro.sql",
    fixEvidence: "/some/fix-evidence.diff"
  });
  assert.equal(result.state, "FULLY_CONFIGURED");
  assert.deepEqual(result.missing, []);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL integration test
// ---------------------------------------------------------------------------

const mirror = String(process.env.HONEYRAIL_PG_221_MIRROR || "").trim();
const knownReproducer = String(process.env.HONEYRAIL_PG_221_REPRODUCER || "").trim();
const knownFixEvidence = String(process.env.HONEYRAIL_PG_221_FIX_EVIDENCE || "").trim();

const config = classifyHistoricalPostgres221IntegrationConfig({ mirror, reproducer: knownReproducer, fixEvidence: knownFixEvidence });
const HISTORICAL_REVISION = "ee895a655ce4341546facd6f23e3e8f2931b96bf";

async function canonicalIntroducingDiff(repoPath: string, introducingCommit: string) {
  return runCommandSafe(
    "git",
    [
      "-C", resolve(repoPath),
      "-c", "color.ui=false",
      "-c", "diff.external=",
      "diff", "--no-ext-diff", "--no-color", "--no-textconv", "--diff-algorithm=myers", "--no-renames",
      `${introducingCommit}^`, introducingCommit
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 * 8 }
  );
}

test(
  "#221 known local PostgreSQL verification distinguishes the pinned introducing and fix commits",
  { skip: config.state === "UNCONFIGURED" ? "HONEYRAIL_PG_221_MIRROR, HONEYRAIL_PG_221_REPRODUCER, HONEYRAIL_PG_221_FIX_EVIDENCE are not set" : false },
  async () => {
    if (config.state === "PARTIALLY_CONFIGURED") {
      assert.fail(
        `Integration test is partially configured — some but not all required env vars are set. ` +
        `Missing: ${config.missing.join(", ")}. ` +
        `Either set all three (HONEYRAIL_PG_221_MIRROR, HONEYRAIL_PG_221_REPRODUCER, HONEYRAIL_PG_221_FIX_EVIDENCE) or none of them.`
      );
    }

    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg221-integration-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
    await writeFile(
      join(workspace, "finding.json"),
      JSON.stringify({ status: "reproduced", summary: "Known local postgres-change-002 verification", reproducer: "repro.sql" })
    );
    const task = historicalPostgresChange18574TaskSpec(resolve(mirror), "E0", resolve(knownReproducer), resolve(knownFixEvidence));
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
    // Retained private evidence must actually be hashed when supplied (#221
    // review round 2, Blocking 3) - not merely accepted and silently unused.
    assert.ok(layout.truthManifest.fixEvidenceSha256, "fixEvidenceSha256 must be present when knownFixEvidencePath is supplied");
    assert.equal(layout.truthManifest.fixEvidence, "expected-behavior/fix-evidence");
  }
);

test(
  "#221 E2 materialization binds the historical source to the complete introducing change-set",
  { skip: config.state !== "FULLY_CONFIGURED" ? "HONEYRAIL_PG_221_MIRROR, HONEYRAIL_PG_221_REPRODUCER, HONEYRAIL_PG_221_FIX_EVIDENCE are required" : false },
  async () => {
    const expectedDiff = await canonicalIntroducingDiff(mirror, HISTORICAL_REVISION);
    assert.equal(expectedDiff.ok, true, expectedDiff.stderr || expectedDiff.stdout);

    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg221-e2-materialization-"));
    const task = historicalPostgresChange18574TaskSpec(resolve(mirror), "E2", resolve(knownReproducer), resolve(knownFixEvidence));
    assert.equal(task.source.historicalRevision, HISTORICAL_REVISION);
    assert.equal(task.changeContext!.introducingCommit, HISTORICAL_REVISION);

    const layout = await materializeHistoricalPostgresTask(task, join(root, "task-bundle"));
    assert.equal(layout.truthManifest.historicalRevision, HISTORICAL_REVISION);
    const sourceManifest = JSON.parse(await readFile(join(layout.referenceDir, "source-manifest.json"), "utf8"));
    assert.equal(sourceManifest.resolvedCommit, HISTORICAL_REVISION);
    assert.equal(await readFile(join(layout.taskDir, "change-set.diff"), "utf8"), expectedDiff.stdout);
  }
);

// ---------------------------------------------------------------------------
// 10x determinism: each revision must produce identical output every run
// ---------------------------------------------------------------------------

/**
 * "Determinism" for this task means stable *semantic* behavioral-oracle
 * attribution across repeated runs, not raw stdout/stderr equality (#223
 * review round 3, Blocking 2): the historical side's second observation
 * embeds a dynamic OID (`cache lookup failed for function <OID>`), so raw
 * byte-for-byte comparison would be meaningless (or flaky, if a run ever
 * happened to reuse an OID). Reuses the same production helper the real
 * grader calls (`resolveOracleReproduction()`, `classifyExecutionValidity()`)
 * rather than a bug-specific regex parser reimplemented in the test.
 */
async function repeatedSemanticAttribution(revision: string, mirrorPath: string, reproducerPath: string, task: ReturnType<typeof historicalPostgresChange18574TaskSpec>) {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg221-determ-"));
  const outcomes: Array<{ valid: boolean; reproduced: boolean; attributedTo?: string }> = [];
  await withPostgresResearchEnvironment(
    { root, source: { repoPath: resolve(mirrorPath), ref: revision }, build: { configureArgs: ["--without-readline", "--without-zlib", "--without-icu"] } },
    async (env: PostgresResearchEnvironment) => {
      await env.start();
      for (let i = 0; i < 10; i++) {
        const execution = await env.psqlFile(resolve(reproducerPath));
        const validity = classifyExecutionValidity(execution);
        const { reproduced, attribution } = resolveOracleReproduction({ execution, revision, spec: task });
        outcomes.push({ valid: validity.valid, reproduced, attributedTo: attribution?.attributedTo });
      }
    }
  );
  return outcomes;
}

test(
  "#221 10x determinism: historical revision attributes to \"historical\" with a satisfied oracle on every run",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 600_000 },
  async () => {
    const task = historicalPostgresChange18574TaskSpec(resolve(mirror), "E0", resolve(knownReproducer), resolve(knownFixEvidence));
    const outcomes = await repeatedSemanticAttribution(HISTORICAL_REVISION, mirror, knownReproducer, task);
    assert.equal(outcomes.length, 10);
    outcomes.forEach((outcome, i) => {
      assert.equal(outcome.valid, true, `historical run ${i + 1}: execution was not valid/interpretable`);
      assert.equal(outcome.reproduced, true, `historical run ${i + 1}: historical oracle was not satisfied`);
      assert.equal(outcome.attributedTo, "historical", `historical run ${i + 1}: attributedTo was "${outcome.attributedTo}", expected "historical"`);
    });
  }
);

test(
  "#221 10x determinism: reference revision attributes to \"reference\" with a satisfied oracle on every run",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 600_000 },
  async () => {
    const task = historicalPostgresChange18574TaskSpec(resolve(mirror), "E0", resolve(knownReproducer), resolve(knownFixEvidence));
    const outcomes = await repeatedSemanticAttribution("7f875fb5bd603d8640cc7aca2c79c604aacd3890", mirror, knownReproducer, task);
    assert.equal(outcomes.length, 10);
    outcomes.forEach((outcome, i) => {
      assert.equal(outcome.valid, true, `reference run ${i + 1}: execution was not valid/interpretable`);
      assert.equal(outcome.reproduced, false, `reference run ${i + 1}: historical oracle must not be satisfied on the reference build`);
      assert.equal(outcome.attributedTo, "reference", `reference run ${i + 1}: attributedTo was "${outcome.attributedTo}", expected "reference"`);
    });
  }
);

// ---------------------------------------------------------------------------
// Infrastructure error: unresolvable revision → infrastructure_error
// ---------------------------------------------------------------------------

test(
  "#221 infrastructure error: unresolvable revision is classified as infrastructure_error",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 300_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg221-infra-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await cp(resolve(knownReproducer), join(workspace, "repro.sql"));
    await writeFile(
      join(workspace, "finding.json"),
      JSON.stringify({ status: "reproduced", summary: "infra-error test", reproducer: "repro.sql" })
    );
    const task = historicalPostgresChange18574TaskSpec(resolve(mirror), "E0", resolve(knownReproducer), resolve(knownFixEvidence));
    const badTask = { ...task, source: { ...task.source, referenceRevision: "0000000000000000000000000000000000000000" } };
    const grade = await gradeHistoricalPostgresSubmission({
      task: badTask,
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
  "#221 normal-path trial: scripted fake agent produces a graded result",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 600_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg221-trial-"));
    const artifactDir = join(root, "artifacts");

    const reproducerSql = await readFile(resolve(knownReproducer), "utf-8");
    const inlineScript = [
      "set -euo pipefail",
      'W="${HR_PG_WORK_DIR:-.}"',
      `cat > "$W/repro.sql" <<'EOSQL'`,
      reproducerSql.trimEnd(),
      "EOSQL",
      `printf '%s' '{"status":"reproduced","summary":"scripted fake agent","reproducer":"repro.sql"}' > "$W/finding.json"`
    ].join("\n");

    const task = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-change-002", {
      HONEYRAIL_PG_221_MIRROR: resolve(mirror),
      HONEYRAIL_PG_221_REPRODUCER: resolve(knownReproducer),
      HONEYRAIL_PG_221_FIX_EVIDENCE: resolve(knownFixEvidence)
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

test(
  "#221 E0-E3 public task context reaches the actual isolated agent surface",
  { skip: config.state !== "FULLY_CONFIGURED" ? "integration env vars not set" : false, timeout: 600_000 },
  async () => {
    const expectedDiff = await canonicalIntroducingDiff(mirror, HISTORICAL_REVISION);
    assert.equal(expectedDiff.ok, true, expectedDiff.stderr || expectedDiff.stdout);
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg221-agent-surface-"));
    const levels = ["E0", "E1", "E2", "E3"] as const;
    const expectedVisibility = {
      E0: { spec: false, changeSet: false, harness: false },
      E1: { spec: true, changeSet: false, harness: false },
      E2: { spec: true, changeSet: true, harness: false },
      E3: { spec: true, changeSet: true, harness: true }
    } as const;
    const observer = [
      "set -eu",
      ': "${HONEYRAIL_TASK_DIR:?public task context was not injected}"',
      'printf "task_dir=%s\\n" "$HONEYRAIL_TASK_DIR" > "$HR_PG_WORK_DIR/task-surface.txt"',
      "for entry in spec.md change-set.diff harness-profile.md; do",
      '  if test -r "$HONEYRAIL_TASK_DIR/$entry"; then echo "$entry=present"; else echo "$entry=absent"; fi',
      "done >> \"$HR_PG_WORK_DIR/task-surface.txt\"",
      'find "$HONEYRAIL_TASK_DIR" -type f -print | sort > "$HR_PG_WORK_DIR/public-task-files.txt"',
      'test ! -e "$HONEYRAIL_TASK_DIR/../reference"',
      'test ! -e "$HONEYRAIL_TASK_DIR/truth.json"',
      'if test -r "$HONEYRAIL_TASK_DIR/change-set.diff"; then cp "$HONEYRAIL_TASK_DIR/change-set.diff" "$HR_PG_WORK_DIR/observed-change-set.diff"; fi',
      `printf '%s' '{"status":"not-reproduced","summary":"public task context observed"}' > "$HR_PG_WORK_DIR/finding.json"`
    ].join("\n");

    for (const level of levels) {
      const task = await resolveHistoricalPostgresTaskSpecFromEnv("postgres-change-002", {
        HONEYRAIL_PG_221_MIRROR: resolve(mirror),
        HONEYRAIL_PG_221_REPRODUCER: resolve(knownReproducer),
        HONEYRAIL_PG_221_FIX_EVIDENCE: resolve(knownFixEvidence),
        HONEYRAIL_PG_221_SCAFFOLDING: level
      });
      const artifactDir = join(root, level);
      const result = await runHistoricalPostgresTrial({
        task,
        agent: { command: "/bin/sh", args: ["-c", observer], timeoutMs: 120_000 },
        artifactDir
      });
      assert.equal(result.status, "completed", JSON.stringify(result, null, 2));
      const observed = await readFile(join(artifactDir, "agent-workspace", "task-surface.txt"), "utf8");
      assert.match(observed, new RegExp(`task_dir=${RESEARCH_CONTAINER_PATHS.task}`));
      assert.match(observed, new RegExp(`spec\\.md=${expectedVisibility[level].spec ? "present" : "absent"}`));
      assert.match(observed, new RegExp(`change-set\\.diff=${expectedVisibility[level].changeSet ? "present" : "absent"}`));
      assert.match(observed, new RegExp(`harness-profile\\.md=${expectedVisibility[level].harness ? "present" : "absent"}`));
      const visibleFiles = await readFile(join(artifactDir, "agent-workspace", "public-task-files.txt"), "utf8");
      for (const privateMarker of [
        `${RESEARCH_CONTAINER_PATHS.task}/reference/`,
        `${RESEARCH_CONTAINER_PATHS.task}/truth.json`,
        `${RESEARCH_CONTAINER_PATHS.task}/verification/`,
        `${RESEARCH_CONTAINER_PATHS.task}/expected-behavior/`
      ]) {
        assert.equal(visibleFiles.includes(privateMarker), false, `${level} agent surface leaked ${privateMarker}`);
      }
      if (level === "E2" || level === "E3") {
        assert.equal(
          await readFile(join(artifactDir, "agent-workspace", "observed-change-set.diff"), "utf8"),
          expectedDiff.stdout,
          `${level} agent-observed change-set must equal the full introducing diff`
        );
      }
    }
  }
);
