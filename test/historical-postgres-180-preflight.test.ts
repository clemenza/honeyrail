import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_HASH,
  HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_ID,
  runHistoricalPostgresPilotTrial,
  verifyHistoricalPostgresFrozenTrialInput
} from "../server/postgres/historical-postgres-preflight.js";
import {
  buildHistoricalPostgresCorpusManifest,
  buildHistoricalPostgresCorpusTaskEntry,
  type HistoricalPostgresCorpusManifest,
  type HistoricalPostgresCorpusTaskEntry
} from "../server/postgres/historical-corpus.js";
import {
  historicalPostgres001TaskSpec,
  materializeHistoricalPostgresTask,
  resolveHistoricalPostgresEnvironmentFingerprint,
  sha256,
  type GradeRevision,
  type HistoricalPostgresEnvironmentFingerprint,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import type { PostgresResearchSessionResult } from "../server/postgres/research-session.js";
import type { RunCommand } from "../server/postgres/runtime.js";
import { createAdditionalSyntheticCommit, createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

/**
 * Same fake docker responder technique as `test/historical-postgres-corpus.test.ts`
 * (`resolveHistoricalPostgresEnvironmentFingerprint()`'s own test suite) - no
 * real docker daemon required for any test in this file.
 */
function fakeDockerEnvironmentRunCommand(options: { builderId: string; runtimeId: string }): RunCommand {
  return (async (command: string, args: string[] = []) => {
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
      const image = String(args[2] ?? "");
      const id = image.includes("runtime") ? options.runtimeId : options.builderId;
      const inspected = [{ Id: id, RepoDigests: [], Os: "linux", Architecture: "amd64" }];
      return { ok: true, stdout: `${JSON.stringify(inspected)}\n`, stderr: "", code: 0 };
    }
    if (command === "docker" && args[0] === "run") {
      const script = String(args[args.length - 1] ?? "");
      const delimiterMatch = /echo '([^']+)'/.exec(script);
      const delimiter = delimiterMatch?.[1] ?? "@@FIELD@@";
      const stdout = ["cc (GCC) 12.2.0", delimiter, "x86_64-linux-gnu", delimiter, "GNU Make 4.3"].join("\n");
      return { ok: true, stdout, stderr: "", code: 0 };
    }
    throw new Error(`fakeDockerEnvironmentRunCommand: unexpected command "${command} ${args.join(" ")}"`);
  }) as unknown as RunCommand;
}

const FAKE_RUN_COMMAND = fakeDockerEnvironmentRunCommand({ builderId: `sha256:${"1".repeat(64)}`, runtimeId: `sha256:${"2".repeat(64)}` });

/**
 * Minimal fixture standing in for `runAgentInPostgresResearchEnvironment()` -
 * identical technique to `test/historical-postgres-task.test.ts`'s own
 * `fakeSessionResult()` - so `runHistoricalPostgresPilotTrial()`'s downstream
 * call into `runHistoricalPostgresTrial()` can be exercised without Docker.
 *
 * `environmentFingerprint` populates `build`/`runtime` with a shape realistic
 * enough for `runHistoricalPostgresTrial()`'s own
 * `HistoricalPostgresTrialExecutionEnvironment` extraction to read - by
 * default the *same* fingerprint the fixture's preflight verified (so the
 * execution-binding check is "verified"); pass a deliberately different one
 * to simulate a real execution that resolved a different environment than
 * preflight did (#180 P0 2).
 */
function fakeSessionResult(overrides: {
  scoredEligible: boolean;
  agentOk: boolean;
  workspaceDir: string;
  environmentFingerprint: HistoricalPostgresEnvironmentFingerprint;
}): PostgresResearchSessionResult {
  const ef = overrides.environmentFingerprint;
  return {
    agent: {
      command: "fake-agent",
      args: [],
      cwd: overrides.workspaceDir,
      ok: overrides.agentOk,
      exitCode: overrides.agentOk ? 0 : 1,
      signal: null,
      timedOut: false,
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
    build: {
      buildMode: ef.buildMode,
      profileVersion: ef.buildProfileVersion,
      configureArgs: [...ef.configureArgs],
      buildEnv: { ...ef.buildEnv },
      builderImage: ef.builderImage,
      compiler: ef.compiler
    },
    runtime: {
      runtime: { image: ef.runtimeImage }
    }
  } as unknown as PostgresResearchSessionResult;
}

/**
 * A full, valid, self-consistent synthetic Corpus v0-shaped manifest (all
 * three real task ids - `buildHistoricalPostgresCorpusManifest()` refuses
 * anything less, see `EXPECTED_CORPUS_TASK_IDS` in historical-corpus.ts).
 * Never the real committed corpus: this is entirely offline, no docker
 * daemon and no real PostgreSQL mirror, same discipline as
 * `test/historical-postgres-corpus.test.ts`'s own `corpusFixture()`.
 */
async function threeTaskFixture(runCommand: RunCommand) {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg180-preflight-"));
  // A genuinely separate root from `root` (which the rest of this fixture and
  // its callers use only as grader-side materialize/artifact scratch space) -
  // mirrors real topology (a private source mirror living entirely outside
  // the grader's own evidence tree) so the leak-regression test's sentinel
  // check is meaningful rather than a path-nesting coincidence.
  const privateMirrorRoot = await mkdtemp(join(tmpdir(), "honeyrail-pg180-private-mirror-"));
  const repo = await createSyntheticPostgresSourceRepo(privateMirrorRoot);
  const fixedForCase002 = await createAdditionalSyntheticCommit(repo.repoPath, "case-002-fixed");
  const fixedForCase003 = await createAdditionalSyntheticCommit(repo.repoPath, "case-003-fixed");

  const spec001: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #10001", commitFest: 1001 },
    prompt: "Investigate case 001."
  };
  const spec002: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-002",
    source: { repoPath: repo.repoPath, historicalRevision: repo.laterRef, referenceRevision: fixedForCase002 },
    truth: {
      upstreamBug: "Synthetic upstream #10002",
      behavioralOracle: {
        historical: [{ label: "first", matches: "^synthetic historical error$" }],
        reference: [{ label: "first", matches: "^synthetic reference error$" }]
      }
    },
    prompt: "Investigate case 002."
  };
  const spec003: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-003",
    source: { repoPath: repo.repoPath, historicalRevision: fixedForCase002, referenceRevision: fixedForCase003 },
    truth: {
      upstreamBug: "Synthetic upstream #10003",
      structuredOracle: { historical: { rows: [["historical-row"]] }, reference: { rows: [["reference-row"]] } }
    },
    prompt: "Investigate case 003."
  };

  const entries: HistoricalPostgresCorpusTaskEntry[] = [];
  for (const spec of [spec001, spec002, spec003]) {
    const layout = await materializeHistoricalPostgresTask(spec, join(root, `frozen-${spec.taskId}`));
    entries.push(buildHistoricalPostgresCorpusTaskEntry(layout, ["#180"]));
  }
  const environmentFingerprint = await resolveHistoricalPostgresEnvironmentFingerprint({ runCommand, ambientEnv: {} });
  const manifest = buildHistoricalPostgresCorpusManifest({
    corpusId: "test-corpus-v0",
    freezeDate: new Date().toISOString(),
    environmentFingerprint,
    tasks: entries
  });
  const entry001 = entries.find((entry) => entry.taskId === "postgres-historical-001")!;
  return { root, repo, spec001, spec002, spec003, entries, entry001, environmentFingerprint, manifest, runCommand };
}

async function materializeRootFor(root: string, label: string) {
  const path = join(root, `materialize-${label}-${Math.random().toString(36).slice(2)}`);
  await mkdir(path, { recursive: true });
  return path;
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test("verifyHistoricalPostgresFrozenTrialInput passes when manifest, environment and task entry all match", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const result = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    materializeRoot: await materializeRootFor(fx.root, "success"),
    runCommand: fx.runCommand
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.taskEntry.taskId, "postgres-historical-001");
    assert.deepEqual(result.taskEntry, result.frozenTaskEntry);
  }
});

// ---------------------------------------------------------------------------
// Manifest self-integrity (tamper without updating corpusHash)
// ---------------------------------------------------------------------------

test("a manifest field changed without updating corpusHash fails as manifestIntegrity, agent never starts", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const tampered: HistoricalPostgresCorpusManifest = { ...fx.manifest, freezeDate: "2000-01-01T00:00:00.000Z" };

  const result = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: tampered,
    expectedCorpusId: tampered.corpusId,
    expectedCorpusHash: tampered.corpusHash,
    taskSpec: fx.spec001,
    materializeRoot: await materializeRootFor(fx.root, "tamper"),
    runCommand: fx.runCommand
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failedDimension, "manifestIntegrity");

  let agentRunCount = 0;
  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: tampered,
    expectedCorpusId: tampered.corpusId,
    expectedCorpusHash: tampered.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir: await materializeRootFor(fx.root, "tamper-pilot"),
    runCommand: fx.runCommand,
    runSession: async () => {
      agentRunCount += 1;
      throw new Error("agent must never be invoked after a failed preflight");
    }
  });
  assert.equal(pilot.agentRunCount, 0);
  assert.equal(agentRunCount, 0);
  assert.equal(pilot.trial, undefined);
});

// ---------------------------------------------------------------------------
// Pinned corpusId / corpusHash rejection - never silently accept a different corpus
// ---------------------------------------------------------------------------

test("a valid manifest under an unexpected corpusId fails as corpusId", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const result = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: fx.manifest,
    expectedCorpusId: HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_ID,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    materializeRoot: await materializeRootFor(fx.root, "corpus-id"),
    runCommand: fx.runCommand
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failedDimension, "corpusId");
});

test("a valid manifest under an unexpected corpusHash fails as corpusHash", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const result = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_HASH,
    taskSpec: fx.spec001,
    materializeRoot: await materializeRootFor(fx.root, "corpus-hash"),
    runCommand: fx.runCommand
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failedDimension, "corpusHash");
});

test("default expected corpusId/corpusHash are pinned to the real committed Corpus v0 values", async () => {
  const committed = JSON.parse(
    await readFile(resolve("corpus/historical-postgres-corpus-v0.json"), "utf8")
  ) as HistoricalPostgresCorpusManifest;
  assert.equal(HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_ID, committed.corpusId);
  assert.equal(HISTORICAL_POSTGRES_PILOT_EXPECTED_CORPUS_HASH, committed.corpusHash);
});

// ---------------------------------------------------------------------------
// Environment fingerprint mismatch
// ---------------------------------------------------------------------------

test("environment mismatch: same builder reference, different resolved image id fails as environmentFingerprint", async () => {
  const frozenRunCommand = fakeDockerEnvironmentRunCommand({ builderId: `sha256:${"1".repeat(64)}`, runtimeId: `sha256:${"2".repeat(64)}` });
  const fx = await threeTaskFixture(frozenRunCommand);
  const rebuiltRunCommand = fakeDockerEnvironmentRunCommand({ builderId: `sha256:${"9".repeat(64)}`, runtimeId: `sha256:${"2".repeat(64)}` });

  const result = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    materializeRoot: await materializeRootFor(fx.root, "env-image"),
    runCommand: rebuiltRunCommand
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failedDimension, "environmentFingerprint");
    assert.ok(result.diagnostics.some((line) => line.includes("builderImage.id")));
  }
});

test("environment mismatch: different CFLAGS fails as environmentFingerprint", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const result = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    materializeRoot: await materializeRootFor(fx.root, "env-cflags"),
    runCommand: fx.runCommand,
    ambientEnv: { CFLAGS: "-O2" }
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failedDimension, "environmentFingerprint");
    assert.ok(result.diagnostics.some((line) => line.includes("buildEnv.CFLAGS")));
  }
});

// ---------------------------------------------------------------------------
// Effective build mode (#180 P0 item 4): host mode must never pass as an
// unnoticed default, and must never reach a started agent as a scored run.
// ---------------------------------------------------------------------------

test("effective build mode: taskManifest.buildProfile follows HONEYRAIL_PG_BUILD_MODE, not a hardcoded default", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-pg180-buildmode-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #10001", commitFest: 1001 },
    prompt: "Investigate case 001."
  };
  const original = process.env.HONEYRAIL_PG_BUILD_MODE;
  process.env.HONEYRAIL_PG_BUILD_MODE = "host";
  try {
    const layout = await materializeHistoricalPostgresTask(spec, join(root, "host-mode-task"));
    assert.equal(layout.taskManifest.buildProfile, "host");
  } finally {
    if (original === undefined) delete process.env.HONEYRAIL_PG_BUILD_MODE;
    else process.env.HONEYRAIL_PG_BUILD_MODE = original;
  }
});

test("effective build mode: HONEYRAIL_PG_BUILD_MODE=host is rejected before the agent starts (environmentFingerprint mismatch, not silently unscored)", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND); // frozen under container mode, ambientEnv {}
  const result = await verifyHistoricalPostgresFrozenTrialInput({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    materializeRoot: await materializeRootFor(fx.root, "host-mode-preflight"),
    runCommand: fx.runCommand,
    ambientEnv: { HONEYRAIL_PG_BUILD_MODE: "host" }
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.failedDimension, "environmentFingerprint");
    assert.ok(result.diagnostics.some((line) => line.includes("buildMode")));
  }

  let agentRunCount = 0;
  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir: await materializeRootFor(fx.root, "host-mode-pilot"),
    runCommand: fx.runCommand,
    ambientEnv: { HONEYRAIL_PG_BUILD_MODE: "host" },
    runSession: async () => {
      agentRunCount += 1;
      throw new Error("agent must never be invoked when the effective build mode disagrees with the frozen environment");
    }
  });
  assert.equal(pilot.agentRunCount, 0);
  assert.equal(agentRunCount, 0);
});

// ---------------------------------------------------------------------------
// Task-entry mismatch: each of the six contract dimensions #180 lists,
// isolated one at a time via direct field tampering on the frozen entry -
// same technique test/historical-postgres-corpus.test.ts already uses for
// its own taskManifest/referenceManifest cross-checks - so the *actual*
// materialized entry (from the real, untouched spec) disagrees with the
// *frozen* one on exactly that dimension.
// ---------------------------------------------------------------------------

const TASK_ENTRY_TAMPER_CASES: Array<{ label: string; field: keyof HistoricalPostgresCorpusTaskEntry; value: unknown }> = [
  { label: "prompt", field: "promptHash", value: sha256("tamper-prompt") },
  { label: "workspace scaffolding", field: "agentWorkspaceHash", value: sha256("tamper-workspace") },
  { label: "build contract", field: "buildContractHash", value: sha256("tamper-build-contract") },
  { label: "truth/grader bundle", field: "truthBundleHash", value: sha256("tamper-truth-bundle") },
  { label: "source snapshot", field: "sourceSnapshotHash", value: "f".repeat(40) },
  { label: "budget", field: "budget", value: { turns: 7 } }
];

for (const tamperCase of TASK_ENTRY_TAMPER_CASES) {
  test(`task mismatch (${tamperCase.label}): frozen corpus entry disagrees with the real materialized task, fails as taskEntry`, async () => {
    const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
    const tamperedEntry001: HistoricalPostgresCorpusTaskEntry = { ...fx.entry001, [tamperCase.field]: tamperCase.value };
    const tamperedManifest = buildHistoricalPostgresCorpusManifest({
      corpusId: fx.manifest.corpusId,
      freezeDate: fx.manifest.freezeDate,
      environmentFingerprint: fx.environmentFingerprint,
      tasks: [tamperedEntry001, ...fx.entries.filter((entry) => entry.taskId !== "postgres-historical-001")]
    });

    const result = await verifyHistoricalPostgresFrozenTrialInput({
      corpusManifest: tamperedManifest,
      expectedCorpusId: tamperedManifest.corpusId,
      expectedCorpusHash: tamperedManifest.corpusHash,
      taskSpec: fx.spec001,
      materializeRoot: await materializeRootFor(fx.root, `taskentry-${tamperCase.field}`),
      runCommand: fx.runCommand
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failedDimension, "taskEntry");
      assert.ok(result.diagnostics.some((line) => line.includes(`taskEntry.${tamperCase.field}`)), JSON.stringify(result.diagnostics));
    }

    let agentRunCount = 0;
    const pilot = await runHistoricalPostgresPilotTrial({
      corpusManifest: tamperedManifest,
      expectedCorpusId: tamperedManifest.corpusId,
      expectedCorpusHash: tamperedManifest.corpusHash,
      taskSpec: fx.spec001,
      agent: { command: "unused" },
      artifactDir: await materializeRootFor(fx.root, `taskentry-pilot-${tamperCase.field}`),
      runCommand: fx.runCommand,
      runSession: async () => {
        agentRunCount += 1;
        throw new Error("agent must never be invoked after a failed taskEntry preflight");
      }
    });
    assert.equal(pilot.agentRunCount, 0);
    assert.equal(agentRunCount, 0);
    assert.equal(pilot.trial, undefined);
  });
}

// ---------------------------------------------------------------------------
// No false miss: a passing preflight is what actually lets the agent run,
// exactly once - proves the assertions above aren't vacuously true.
// ---------------------------------------------------------------------------

test("no false miss: a passing preflight lets runHistoricalPostgresPilotTrial invoke the agent exactly once", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "positive-control");
  const workspace = join(artifactDir, "agent-workspace-fixture");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "Stub agent, positive control." }));

  let agentRunCount = 0;
  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => {
      agentRunCount += 1;
      return fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint });
    }
  });
  assert.equal(agentRunCount, 1);
  assert.equal(pilot.agentRunCount, 1);
  assert.equal(pilot.preflight.status, "passed");
  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.trial?.grade?.status, "miss");
  assert.equal(pilot.trial?.grade?.gradingPath, "not_reproduced");
  // A not-reproduced submission never invokes the two-revision grader at all
  // (gradeHistoricalPostgresSubmission's own early-return - see
  // historical-task.test.ts) *by design* - this grading path never required
  // either grader revision to run, so they are "not_applicable", not
  // "unverified" (#207 review round 3, Blocking 1 - a legitimate real-agent
  // not-reproduced miss must remain in the #180 rediscovery-failure
  // denominator, not be silently excluded merely because executions that
  // were never required happen to be absent).
  assert.equal(pilot.executionBinding.agent.status, "verified");
  assert.equal(pilot.executionBinding.historicalGrader.status, "not_applicable");
  assert.equal(pilot.executionBinding.referenceGrader.status, "not_applicable");
  assert.equal(pilot.executionBinding.overall.status, "verified");
  assert.equal(pilot.status, "completed");
  assert.equal(pilot.datasetEligible, true);
  assert.equal(pilot.officialScoredResult, "miss");
});

// ---------------------------------------------------------------------------
// P0 Blocking 1 (PR #207 review round 2): the official rediscovered/miss/
// invalid_submission result is produced by gradeHistoricalPostgresSubmission()'s
// own two grader executions, not only the agent's investigation session -
// all three must be individually bound to the frozen/preflight-verified
// environment before a result can be official. Fail-closed: "unverified" is
// never treated as equivalent to "verified". A "reproduced" submission (with
// a fake gradeRevision injected exactly like historical-task.test.ts already
// does directly against gradeHistoricalPostgresSubmission) is what actually
// exercises both grader revisions, entirely offline.
// ---------------------------------------------------------------------------

async function reproducedWorkspace(root: string, label: string): Promise<string> {
  const workspace = join(root, `agent-workspace-${label}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "repro.sql"), "SELECT 1;\n");
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: `Fake reproduced finding (${label}).`, reproducer: "repro.sql" }));
  return workspace;
}

/** A fake `GradeRevision` reporting a controlled `executionEnvironment` per revision, and a self-asserting exit-status differential (historical reproduces, reference does not) so case 001's exit-status protocol classifies it "rediscovered". */
/**
 * Defaults to the "rediscovered" shape (historical reproduces, reference
 * does not, matching case 001's self-asserting exit-status protocol) -
 * override `historicalReproduced`/`referenceReproduced` for a "miss"
 * (both `false`) or an "invalid_submission" (both `true`, not target-specific).
 */
function fakeGradeRevision(input: {
  historicalRevision: string;
  historicalReproduced?: boolean;
  referenceReproduced?: boolean;
  historicalExecutionEnvironment: HistoricalPostgresEnvironmentFingerprint | undefined;
  referenceExecutionEnvironment: HistoricalPostgresEnvironmentFingerprint | undefined;
}): GradeRevision {
  return async ({ revision }) => {
    const isHistorical = revision === input.historicalRevision;
    const reproduced = isHistorical ? (input.historicalReproduced ?? true) : (input.referenceReproduced ?? false);
    const ef = isHistorical ? input.historicalExecutionEnvironment : input.referenceExecutionEnvironment;
    return {
      reproduced,
      execution: { ok: reproduced, stdout: "", stderr: "", exitCode: reproduced ? 0 : 1, durationMs: 1 },
      executionEnvironment: ef
        ? { buildMode: ef.buildMode, buildProfileVersion: ef.buildProfileVersion, configureArgs: [...ef.configureArgs], buildEnv: { ...ef.buildEnv }, builderImage: ef.builderImage, runtimeImage: ef.runtimeImage, compiler: ef.compiler }
        : undefined
    };
  };
}

test("execution binding, all verified: agent + historical grader + reference grader all match the frozen environment => dataset-eligible official score", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "binding-all-verified");
  const workspace = await reproducedWorkspace(artifactDir, "all-verified");

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint }),
    gradeRevision: fakeGradeRevision({
      historicalRevision: fx.spec001.source.historicalRevision,
      historicalExecutionEnvironment: fx.environmentFingerprint,
      referenceExecutionEnvironment: fx.environmentFingerprint
    })
  });

  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.trial?.grade?.status, "rediscovered");
  assert.equal(pilot.executionBinding.agent.status, "verified");
  assert.equal(pilot.executionBinding.historicalGrader.status, "verified");
  assert.equal(pilot.executionBinding.referenceGrader.status, "verified");
  assert.equal(pilot.executionBinding.overall.status, "verified");
  assert.equal(pilot.status, "completed");
  assert.equal(pilot.datasetEligible, true);
  assert.equal(pilot.officialScoredResult, "rediscovered");
});

test("execution binding, reproducer-path miss remains eligible: agent + historical grader + reference grader all match => dataset-eligible miss", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "binding-reproducer-miss");
  const workspace = await reproducedWorkspace(artifactDir, "reproducer-miss");

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint }),
    // Neither revision reproduces (a submitted-but-wrong reproducer) - a
    // genuine miss via the reproducer grading path, not the not-reproduced
    // shortcut, so both grader revisions really ran.
    gradeRevision: fakeGradeRevision({
      historicalRevision: fx.spec001.source.historicalRevision,
      historicalReproduced: false,
      referenceReproduced: false,
      historicalExecutionEnvironment: fx.environmentFingerprint,
      referenceExecutionEnvironment: fx.environmentFingerprint
    })
  });

  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.trial?.grade?.status, "miss");
  assert.equal(pilot.trial?.grade?.gradingPath, "reproducer");
  assert.equal(pilot.executionBinding.agent.status, "verified");
  assert.equal(pilot.executionBinding.historicalGrader.status, "verified");
  assert.equal(pilot.executionBinding.referenceGrader.status, "verified");
  assert.equal(pilot.executionBinding.overall.status, "verified");
  assert.equal(pilot.status, "completed");
  assert.equal(pilot.datasetEligible, true);
  assert.equal(pilot.officialScoredResult, "miss");
});

test("execution binding: invalid_submission is never dataset-eligible even when every required binding is verified", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "binding-invalid-submission");
  const workspace = await reproducedWorkspace(artifactDir, "invalid-submission");

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint }),
    // Both revisions reproduce - not target-specific - so gradeHistoricalPostgresSubmission()
    // classifies this "invalid_submission", #180's explicitly-excluded outcome.
    gradeRevision: fakeGradeRevision({
      historicalRevision: fx.spec001.source.historicalRevision,
      historicalReproduced: true,
      referenceReproduced: true,
      historicalExecutionEnvironment: fx.environmentFingerprint,
      referenceExecutionEnvironment: fx.environmentFingerprint
    })
  });

  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.trial?.grade?.status, "invalid_submission");
  assert.equal(pilot.executionBinding.agent.status, "verified");
  assert.equal(pilot.executionBinding.historicalGrader.status, "verified");
  assert.equal(pilot.executionBinding.referenceGrader.status, "verified");
  assert.equal(pilot.executionBinding.overall.status, "verified");
  // Every required binding is verified, yet this must still never be
  // dataset-eligible: invalid_submission is not a capability outcome (#207
  // review round 3, Blocking 2). status stays "completed" - this is not an
  // integrity/environment problem, just a non-capability grade.
  assert.equal(pilot.status, "completed");
  assert.equal(pilot.datasetEligible, false);
  assert.equal(pilot.officialScoredResult, "N/A");
});

test("execution binding, historical grader mismatch: agent=A, historical grader=B, reference grader=A => integrity_error, no official score", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "binding-historical-mismatch");
  const workspace = await reproducedWorkspace(artifactDir, "historical-mismatch");
  const divergentEnvironment: HistoricalPostgresEnvironmentFingerprint = {
    ...fx.environmentFingerprint,
    builderImage: { reference: fx.environmentFingerprint.builderImage.reference, id: `sha256:${"9".repeat(64)}` }
  };

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint }),
    gradeRevision: fakeGradeRevision({
      historicalRevision: fx.spec001.source.historicalRevision,
      historicalExecutionEnvironment: divergentEnvironment,
      referenceExecutionEnvironment: fx.environmentFingerprint
    })
  });

  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.executionBinding.agent.status, "verified");
  assert.equal(pilot.executionBinding.historicalGrader.status, "mismatched");
  assert.equal(pilot.executionBinding.referenceGrader.status, "verified");
  assert.equal(pilot.executionBinding.overall.status, "mismatched");
  assert.equal(pilot.status, "integrity_error");
  assert.equal(pilot.datasetEligible, false);
  assert.equal(pilot.officialScoredResult, "N/A");
});

test("execution binding, reference grader mismatch: agent=A, historical grader=A, reference grader=B => integrity_error, no official score", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "binding-reference-mismatch");
  const workspace = await reproducedWorkspace(artifactDir, "reference-mismatch");
  const divergentEnvironment: HistoricalPostgresEnvironmentFingerprint = {
    ...fx.environmentFingerprint,
    builderImage: { reference: fx.environmentFingerprint.builderImage.reference, id: `sha256:${"9".repeat(64)}` }
  };

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint }),
    gradeRevision: fakeGradeRevision({
      historicalRevision: fx.spec001.source.historicalRevision,
      historicalExecutionEnvironment: fx.environmentFingerprint,
      referenceExecutionEnvironment: divergentEnvironment
    })
  });

  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.executionBinding.agent.status, "verified");
  assert.equal(pilot.executionBinding.historicalGrader.status, "verified");
  assert.equal(pilot.executionBinding.referenceGrader.status, "mismatched");
  assert.equal(pilot.executionBinding.overall.status, "mismatched");
  assert.equal(pilot.status, "integrity_error");
  assert.equal(pilot.datasetEligible, false);
  assert.equal(pilot.officialScoredResult, "N/A");
});

test("execution binding, unverified fails closed: a completed trial with one unavailable execution identity is never dataset-eligible", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "binding-unverified");
  const workspace = await reproducedWorkspace(artifactDir, "unverified");

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint }),
    // The reference grader's own execution identity is unavailable (e.g. an
    // older grader build that didn't record one) - not proven mismatched,
    // just missing evidence. This must never fall through into an official
    // score merely because nothing was "explicitly mismatched".
    gradeRevision: fakeGradeRevision({
      historicalRevision: fx.spec001.source.historicalRevision,
      historicalExecutionEnvironment: fx.environmentFingerprint,
      referenceExecutionEnvironment: undefined
    })
  });

  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.executionBinding.agent.status, "verified");
  assert.equal(pilot.executionBinding.historicalGrader.status, "verified");
  assert.equal(pilot.executionBinding.referenceGrader.status, "unverified");
  assert.equal(pilot.executionBinding.overall.status, "unverified");
  // Unverified is not a proven violation, so status stays "completed" - but
  // it must never be dataset-eligible or produce an official score.
  assert.equal(pilot.status, "completed");
  assert.equal(pilot.datasetEligible, false);
  assert.equal(pilot.officialScoredResult, "N/A");
});

// ---------------------------------------------------------------------------
// P0 1 (PR #207 review): preflight-result.json / pilot-result.json must never
// leak grader-private truth - proven with distinctive synthetic sentinels
// (this fixture's own private upstreamBug string, both pinned revision SHAs,
// and the private synthetic mirror path).
// ---------------------------------------------------------------------------

test("leak regression: persisted preflight/pilot evidence never contains private truth sentinels", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "leak-check");
  const workspace = join(artifactDir, "agent-workspace-fixture");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "Leak-check stub agent." }));

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint })
  });

  const preflightText = await readFile(join(artifactDir, pilot.pilotId, "preflight-result.json"), "utf8");
  const pilotText = await readFile(join(artifactDir, pilot.pilotId, "pilot-result.json"), "utf8");

  const sentinels = [
    fx.spec001.truth.upstreamBug,
    fx.spec001.source.historicalRevision,
    fx.spec001.source.referenceRevision,
    fx.repo.repoPath
  ];
  for (const sentinel of sentinels) {
    assert.ok(!preflightText.includes(sentinel), `preflight-result.json leaked sentinel: ${sentinel}`);
    assert.ok(!pilotText.includes(sentinel), `pilot-result.json leaked sentinel: ${sentinel}`);
  }
});

// ---------------------------------------------------------------------------
// P0 2 (PR #207 review): the pilot must prove the actual scored execution
// used the same immutable environment identity preflight verified - tested
// through the wrapper boundary (a real preflight resolution, then an
// injected session whose reported execution environment genuinely diverges),
// never by hand-editing a final hash.
// ---------------------------------------------------------------------------

test("execution binding: an execution-time environment that differs from what preflight verified is integrity_error with no official scored result", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "binding-mismatch");
  const workspace = join(artifactDir, "agent-workspace-fixture");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "Binding-mismatch stub agent." }));

  // Preflight sees image A (fx.environmentFingerprint.builderImage.id, via
  // FAKE_RUN_COMMAND); the injected session reports that the real execution
  // resolved a different id under the same reference - image B.
  const executionTimeEnvironment: HistoricalPostgresEnvironmentFingerprint = {
    ...fx.environmentFingerprint,
    builderImage: { reference: fx.environmentFingerprint.builderImage.reference, id: `sha256:${"9".repeat(64)}` }
  };

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: executionTimeEnvironment })
  });

  assert.equal(pilot.preflight.status, "passed");
  assert.equal(pilot.agentRunCount, 1);
  assert.equal(pilot.executionBinding.agent.status, "mismatched");
  if (pilot.executionBinding.agent.status === "mismatched") {
    assert.ok(pilot.executionBinding.agent.diagnostics.some((line) => line.includes("builderImage.id")), JSON.stringify(pilot.executionBinding.agent.diagnostics));
  }
  assert.equal(pilot.executionBinding.overall.status, "mismatched");
  assert.equal(pilot.status, "integrity_error");
  assert.equal(pilot.datasetEligible, false);
  assert.equal(pilot.officialScoredResult, "N/A");

  const writtenEvidence = JSON.parse(await readFile(join(artifactDir, pilot.pilotId, "pilot-result.json"), "utf8"));
  assert.equal(writtenEvidence.status, "integrity_error");
  assert.equal(writtenEvidence.datasetEligible, false);
});

// ---------------------------------------------------------------------------
// P0 3 (PR #207 review): a deterministic smoke-stub profile is legitimate
// harness evidence but must never enter the capability dataset, even when
// the underlying research run genuinely completed/scoredEligible/graded.
// ---------------------------------------------------------------------------

test("profileKind=smoke_stub: completed + scoredEligible=true + grade=miss is never dataset-eligible", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const artifactDir = await materializeRootFor(fx.root, "stub-profile");
  const workspace = join(artifactDir, "agent-workspace-fixture");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "not-reproduced", summary: "Stub smoke agent." }));

  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    profileKind: "smoke_stub",
    runCommand: fx.runCommand,
    runSession: async () => fakeSessionResult({ scoredEligible: true, agentOk: true, workspaceDir: workspace, environmentFingerprint: fx.environmentFingerprint })
  });

  assert.equal(pilot.trial?.status, "completed");
  assert.equal(pilot.trial?.scoredEligible, true);
  assert.equal(pilot.trial?.grade?.status, "miss");
  assert.equal(pilot.profileKind, "smoke_stub");
  assert.equal(pilot.status, "completed");
  assert.equal(pilot.datasetEligible, false);
  assert.equal(pilot.officialScoredResult, "N/A");
});

// ---------------------------------------------------------------------------
// P1 4 (PR #207 review): an infrastructure failure *during* preflight
// (docker unavailable, image-inspect/probe failure) must normalize to a
// stable pilot-level status with evidence written, never an uncaught throw.
// ---------------------------------------------------------------------------

test("infrastructure failure during preflight normalizes to infrastructure_error and still writes pilot-result.json; agent never starts", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  const brokenRunCommand: RunCommand = (async () => {
    throw new Error("docker daemon unavailable (simulated)");
  }) as unknown as RunCommand;
  const artifactDir = await materializeRootFor(fx.root, "infra-failure");

  let agentRunCount = 0;
  const pilot = await runHistoricalPostgresPilotTrial({
    corpusManifest: fx.manifest,
    expectedCorpusId: fx.manifest.corpusId,
    expectedCorpusHash: fx.manifest.corpusHash,
    taskSpec: fx.spec001,
    agent: { command: "unused" },
    artifactDir,
    runCommand: brokenRunCommand,
    runSession: async () => {
      agentRunCount += 1;
      throw new Error("agent must never be invoked when preflight itself could not complete");
    }
  });

  assert.equal(pilot.preflight.status, "error");
  assert.equal(pilot.status, "infrastructure_error");
  assert.equal(pilot.agentRunCount, 0);
  assert.equal(agentRunCount, 0);
  assert.equal(pilot.datasetEligible, false);
  assert.equal(pilot.officialScoredResult, "N/A");

  const writtenEvidence = JSON.parse(await readFile(join(artifactDir, pilot.pilotId, "pilot-result.json"), "utf8"));
  assert.equal(writtenEvidence.status, "infrastructure_error");
});

// ---------------------------------------------------------------------------
// P1 5 (PR #207 review): pilotId is resolved before the artifact root is
// created, and two attempts against the same parent artifactDir must never
// overwrite each other's evidence.
// ---------------------------------------------------------------------------

test("two default pilot attempts against the same parent artifactDir retain distinct evidence", async () => {
  const fx = await threeTaskFixture(FAKE_RUN_COMMAND);
  // A fast, offline, preflight-failing manifest (freezeDate tampered without
  // updating corpusHash) keeps both attempts quick and agent-free.
  const tamperedManifest: HistoricalPostgresCorpusManifest = { ...fx.manifest, freezeDate: "2000-01-01T00:00:00.000Z" };
  const parentArtifactDir = await materializeRootFor(fx.root, "distinct-evidence-parent");

  const runOnce = () =>
    runHistoricalPostgresPilotTrial({
      corpusManifest: tamperedManifest,
      expectedCorpusId: tamperedManifest.corpusId,
      expectedCorpusHash: tamperedManifest.corpusHash,
      taskSpec: fx.spec001,
      agent: { command: "unused" },
      artifactDir: parentArtifactDir,
      runCommand: fx.runCommand
    });

  const [first, second] = await Promise.all([runOnce(), runOnce()]);
  assert.notEqual(first.pilotId, second.pilotId);

  const firstEvidence = JSON.parse(await readFile(join(parentArtifactDir, first.pilotId, "pilot-result.json"), "utf8"));
  const secondEvidence = JSON.parse(await readFile(join(parentArtifactDir, second.pilotId, "pilot-result.json"), "utf8"));
  assert.equal(firstEvidence.pilotId, first.pilotId);
  assert.equal(secondEvidence.pilotId, second.pilotId);
  assert.notEqual(firstEvidence.pilotId, secondEvidence.pilotId);
});

// ---------------------------------------------------------------------------
// Corpus-hash stability regression (needs the real local mirror): the
// buildProfile fix (Fix #1) is behavior-preserving for the committed v0
// hashes.
// ---------------------------------------------------------------------------

const mirror184 = String(process.env.HONEYRAIL_PG_184_MIRROR || "").trim();

test(
  "case 001 re-materializes to the exact hashes committed in Corpus v0 (buildProfile fix does not move the frozen hash)",
  { skip: !mirror184 },
  async () => {
    const spec = historicalPostgres001TaskSpec(resolve(mirror184));
    const root = await mkdtemp(join(tmpdir(), "honeyrail-pg180-corpus-stability-"));
    const layout = await materializeHistoricalPostgresTask(spec, join(root, "case-001"));
    const committed = JSON.parse(
      await readFile(resolve("corpus/historical-postgres-corpus-v0.json"), "utf8")
    ) as HistoricalPostgresCorpusManifest;
    const frozenEntry = committed.tasks.find((task) => task.taskId === "postgres-historical-001")!;
    assert.equal(layout.taskManifest.buildProfile, "container");
    assert.equal(layout.taskManifest.hashes.taskDefinition, frozenEntry.taskDefinitionHash);
    assert.equal(layout.taskManifest.hashes.sourceTree, frozenEntry.sourceSnapshotHash);
    assert.equal(layout.taskManifest.hashes.prompt, frozenEntry.promptHash);
    assert.equal(layout.taskManifest.hashes.agentWorkspace, frozenEntry.agentWorkspaceHash);
    assert.equal(layout.taskManifest.hashes.buildContract, frozenEntry.buildContractHash);
  }
);
