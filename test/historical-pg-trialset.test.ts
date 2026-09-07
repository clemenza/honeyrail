import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HISTORICAL_PG_TRIALSET_RUNNER_VERSION,
  TrialSetExperimentIdentityMismatchError,
  TrialSetStateCorruptError,
  assertCompatibleExperimentManifest,
  assertUniqueProfileIds,
  buildExperimentManifest,
  buildHistoricalPgTrialSetReport,
  buildTrialSetCellRecord,
  computeExperimentId,
  computeProfileHash,
  defaultTaskIdSelection,
  emptyTrialSetState,
  executeTrialSetCell,
  loadTrialSetState,
  planTrialSetCells,
  resolveTrialSetTaskSelection,
  selectPendingCells,
  summarizeTrialSetProfile,
  writeTrialSetStateAtomic,
  type TrialSetCellRecord,
  type TrialSetExperimentIdentityInput,
  type TrialSetProfileSpec
} from "../server/postgres/historical-pg-trialset.js";
import type { HistoricalPostgresCorpusManifest } from "../server/postgres/historical-corpus.js";
import type { HistoricalPostgresPilotResult } from "../server/postgres/historical-postgres-preflight.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeCorpusManifest(): HistoricalPostgresCorpusManifest {
  return {
    schemaVersion: 1,
    corpusId: "test-corpus-v0",
    freezeDate: new Date().toISOString(),
    gradingEntryPoint: [],
    outcomeVocabulary: [],
    holdoutNote: "",
    environmentFingerprint: {} as HistoricalPostgresCorpusManifest["environmentFingerprint"],
    tasks: [
      { taskId: "postgres-historical-001", partition: "TRAIN" } as HistoricalPostgresCorpusManifest["tasks"][number],
      { taskId: "postgres-historical-002", partition: "FRONTIER" } as HistoricalPostgresCorpusManifest["tasks"][number],
      { taskId: "postgres-historical-003", partition: "FRONTIER" } as HistoricalPostgresCorpusManifest["tasks"][number]
    ],
    corpusHash: "a".repeat(64)
  };
}

function baseIdentity(overrides: Partial<TrialSetExperimentIdentityInput> = {}): TrialSetExperimentIdentityInput {
  return {
    corpusId: "test-corpus-v0",
    corpusHash: "a".repeat(64),
    tasks: [{ taskId: "postgres-historical-001", partition: "TRAIN" }],
    profiles: [{ profileId: "baseline", profileHash: computeProfileHash("baseline-content") }],
    trialsPerCell: 1,
    agentImage: "honeyrail-postgres-research-agent-dsh:latest",
    isolationPolicy: { restrictedEgress: true, upstreamUrl: "https://api.deepseek.com" },
    runnerVersion: HISTORICAL_PG_TRIALSET_RUNNER_VERSION,
    ...overrides
  };
}

function fakePilotResult(overrides: Partial<HistoricalPostgresPilotResult> & Pick<HistoricalPostgresPilotResult, "datasetEligible" | "officialScoredResult" | "status">): HistoricalPostgresPilotResult {
  return {
    pilotId: "pilot-1",
    profileKind: "agent",
    corpusId: "test-corpus-v0",
    corpusHash: "a".repeat(64),
    taskId: "postgres-historical-001",
    partition: "TRAIN",
    preflight: { status: "passed" },
    frozenEnvironmentFingerprint: {} as HistoricalPostgresPilotResult["frozenEnvironmentFingerprint"],
    executionBinding: { agent: { status: "verified" }, historicalGrader: { status: "not_applicable" }, referenceGrader: { status: "not_applicable" }, overall: { status: "verified" } },
    agentRunCount: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:05:00.000Z",
    diagnostics: [],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Matrix planning
// ---------------------------------------------------------------------------

test("planTrialSetCells: task x profile x trial expansion is deterministic regardless of input order", () => {
  const tasks = [
    { taskId: "postgres-historical-002", partition: "FRONTIER" as const },
    { taskId: "postgres-historical-001", partition: "TRAIN" as const }
  ];
  const profiles = [
    { profileId: "candidate", profileHash: "cc" },
    { profileId: "baseline", profileHash: "bb" }
  ];
  const cellsA = planTrialSetCells({ tasks, profiles, trialsPerCell: 2 });
  const cellsB = planTrialSetCells({ tasks: [...tasks].reverse(), profiles: [...profiles].reverse(), trialsPerCell: 2 });
  assert.deepEqual(cellsA.map((c) => c.cellId), cellsB.map((c) => c.cellId));
  assert.equal(cellsA.length, 8);
  assert.equal(cellsA[0].cellId, "postgres-historical-001__baseline__trial-1");
  assert.equal(cellsA[1].cellId, "postgres-historical-001__baseline__trial-2");
});

test("planTrialSetCells: partition is carried from the corpus task selection", () => {
  const cells = planTrialSetCells({
    tasks: [{ taskId: "postgres-historical-002", partition: "FRONTIER" }],
    profiles: [{ profileId: "baseline", profileHash: "bb" }],
    trialsPerCell: 1
  });
  assert.equal(cells[0].partition, "FRONTIER");
});

test("planTrialSetCells: rejects a non-positive-integer trialsPerCell", () => {
  assert.throws(() => planTrialSetCells({ tasks: [], profiles: [], trialsPerCell: 0 }), /positive integer/);
});

test("resolveTrialSetTaskSelection: unknown task id is rejected clearly", () => {
  assert.throws(() => resolveTrialSetTaskSelection(fakeCorpusManifest(), ["postgres-historical-999"]), /Unknown task id "postgres-historical-999"/);
});

test("resolveTrialSetTaskSelection: known task ids resolve with their corpus partition", () => {
  const resolved = resolveTrialSetTaskSelection(fakeCorpusManifest(), ["postgres-historical-002"]);
  assert.deepEqual(resolved, [{ taskId: "postgres-historical-002", partition: "FRONTIER" }]);
});

test("assertUniqueProfileIds: duplicate profile id is rejected clearly", () => {
  assert.throws(
    () => assertUniqueProfileIds([{ profileId: "baseline" }, { profileId: "baseline" }]),
    /Duplicate profile id "baseline"/
  );
});

test("defaultTaskIdSelection: --smoke defaults to TRAIN-only; non-smoke defaults to every corpus task", () => {
  const manifest = fakeCorpusManifest();
  assert.deepEqual(defaultTaskIdSelection(manifest, { smoke: true }), ["postgres-historical-001"]);
  assert.deepEqual(defaultTaskIdSelection(manifest, { smoke: false }), ["postgres-historical-001", "postgres-historical-002", "postgres-historical-003"]);
});

// ---------------------------------------------------------------------------
// Experiment identity
// ---------------------------------------------------------------------------

test("computeExperimentId: a profile content change changes the profile hash and therefore the experiment id", () => {
  const idA = computeExperimentId(baseIdentity());
  const hashB = computeProfileHash("different-content");
  const idB = computeExperimentId(baseIdentity({ profiles: [{ profileId: "baseline", profileHash: hashB }] }));
  assert.notEqual(idA, idB);
});

test("computeExperimentId: a corpus hash change changes the experiment id", () => {
  const idA = computeExperimentId(baseIdentity());
  const idB = computeExperimentId(baseIdentity({ corpusHash: "b".repeat(64) }));
  assert.notEqual(idA, idB);
});

test("computeExperimentId: trialsPerCell / agentImage / isolationPolicy changes each change the experiment id", () => {
  const idA = computeExperimentId(baseIdentity());
  assert.notEqual(idA, computeExperimentId(baseIdentity({ trialsPerCell: 2 })));
  assert.notEqual(idA, computeExperimentId(baseIdentity({ agentImage: "some-other-image:latest" })));
  assert.notEqual(idA, computeExperimentId(baseIdentity({ isolationPolicy: { restrictedEgress: false, network: "bridge" } })));
});

test("computeExperimentId: task/profile array order does not change the experiment id (order-independent identity)", () => {
  const tasksA = [
    { taskId: "postgres-historical-001", partition: "TRAIN" as const },
    { taskId: "postgres-historical-002", partition: "FRONTIER" as const }
  ];
  const idA = computeExperimentId(baseIdentity({ tasks: tasksA }));
  const idB = computeExperimentId(baseIdentity({ tasks: [...tasksA].reverse() }));
  assert.equal(idA, idB);
});

test("buildExperimentManifest: never carries a mirror path, reproducer path, or private truth field", () => {
  const profiles: TrialSetProfileSpec[] = [{ profileId: "baseline", sourcePath: "/tmp/whatever.yml", content: "baseline-content", profileHash: computeProfileHash("baseline-content") }];
  const manifest = buildExperimentManifest({ identity: baseIdentity(), repositoryCommit: "deadbeef", profiles });
  const serialized = JSON.stringify(manifest).toLowerCase();
  for (const forbidden of ["mirror", "reproducer", "private_truth", "privatetruth", "upstreambug", "commitfest"]) {
    assert.equal(serialized.includes(forbidden), false, `manifest must never mention "${forbidden}"`);
  }
  assert.equal(manifest.experimentId, computeExperimentId(baseIdentity()));
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

test("assertCompatibleExperimentManifest: identical identity resumes even when createdAt/repositoryCommit differ", () => {
  const profiles: TrialSetProfileSpec[] = [{ profileId: "baseline", sourcePath: "/a.yml", content: "baseline-content", profileHash: computeProfileHash("baseline-content") }];
  const existing = buildExperimentManifest({ identity: baseIdentity(), repositoryCommit: "commit-a", profiles, createdAt: "2026-01-01T00:00:00.000Z" });
  const current = buildExperimentManifest({ identity: baseIdentity(), repositoryCommit: "commit-b", profiles, createdAt: "2026-02-02T00:00:00.000Z" });
  assert.doesNotThrow(() => assertCompatibleExperimentManifest(existing, current));
});

test("assertCompatibleExperimentManifest: a changed identity-relevant input fails closed rather than silently resuming", () => {
  const profiles: TrialSetProfileSpec[] = [{ profileId: "baseline", sourcePath: "/a.yml", content: "baseline-content", profileHash: computeProfileHash("baseline-content") }];
  const existing = buildExperimentManifest({ identity: baseIdentity(), repositoryCommit: "commit-a", profiles });
  const current = buildExperimentManifest({ identity: baseIdentity({ trialsPerCell: 3 }), repositoryCommit: "commit-a", profiles });
  assert.throws(() => assertCompatibleExperimentManifest(existing, current), TrialSetExperimentIdentityMismatchError);
});

test("selectPendingCells: a completed cell is not re-planned as pending", () => {
  const cells = planTrialSetCells({ tasks: [{ taskId: "postgres-historical-001", partition: "TRAIN" }], profiles: [{ profileId: "baseline", profileHash: "bb" }], trialsPerCell: 2 });
  const state = emptyTrialSetState("exp-1");
  state.cells[cells[0].cellId] = buildTrialSetCellRecord({ experimentId: "exp-1", identity: cells[0], artifactDir: "/tmp/x", pilot: fakePilotResult({ datasetEligible: true, officialScoredResult: "miss", status: "completed" }) });
  const pending = selectPendingCells(cells, state);
  assert.deepEqual(pending.map((c) => c.cellId), [cells[1].cellId]);
});

test("selectPendingCells: an infrastructure_error cell already in state is not re-planned (no automatic retry)", () => {
  const cells = planTrialSetCells({ tasks: [{ taskId: "postgres-historical-001", partition: "TRAIN" }], profiles: [{ profileId: "baseline", profileHash: "bb" }], trialsPerCell: 1 });
  const state = emptyTrialSetState("exp-1");
  state.cells[cells[0].cellId] = buildTrialSetCellRecord({ experimentId: "exp-1", identity: cells[0], artifactDir: "/tmp/x", pilot: fakePilotResult({ datasetEligible: false, officialScoredResult: "N/A", status: "infrastructure_error" }) });
  assert.deepEqual(selectPendingCells(cells, state), []);
});

test("state.json round-trips through writeTrialSetStateAtomic/loadTrialSetState, and a missing file loads as null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-trialset-state-"));
  const statePath = join(dir, "state.json");
  assert.equal(await loadTrialSetState(statePath), null);
  const state = emptyTrialSetState("exp-1");
  const cells = planTrialSetCells({ tasks: [{ taskId: "postgres-historical-001", partition: "TRAIN" }], profiles: [{ profileId: "baseline", profileHash: "bb" }], trialsPerCell: 1 });
  state.cells[cells[0].cellId] = buildTrialSetCellRecord({ experimentId: "exp-1", identity: cells[0], artifactDir: "/tmp/x", pilot: fakePilotResult({ datasetEligible: true, officialScoredResult: "rediscovered", status: "completed" }) });
  await writeTrialSetStateAtomic(statePath, state);
  const reloaded = await loadTrialSetState(statePath);
  // JSON has no `undefined` - optional fields left unset on the in-memory
  // record are simply absent after a round trip, not a mismatch.
  assert.deepEqual(reloaded, JSON.parse(JSON.stringify(state)));
});

test("loadTrialSetState: a corrupted/incompatible state.json fails clearly rather than silently mixing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-trialset-state-corrupt-"));
  const statePath = join(dir, "state.json");
  await writeTrialSetStateAtomic(statePath, { schemaVersion: 1, experimentId: "exp-1", cells: {} });
  const fs = await import("node:fs/promises");
  await fs.writeFile(statePath, "{ this is not valid json");
  await assert.rejects(() => loadTrialSetState(statePath), TrialSetStateCorruptError);
});

// ---------------------------------------------------------------------------
// executeTrialSetCell wiring (injected pilot boundary - never a real docker/dsh call)
// ---------------------------------------------------------------------------

test("executeTrialSetCell: calls runHistoricalPostgresPilotTrial exactly once with profileKind 'agent' and returns a traceable record", async () => {
  let capturedInput: unknown;
  const fakeRunPilotTrial = (async (input: unknown) => {
    capturedInput = input;
    return fakePilotResult({ datasetEligible: true, officialScoredResult: "miss", status: "completed", pilotId: "pilot-xyz" });
  }) as unknown as typeof import("../server/postgres/historical-postgres-preflight.js").runHistoricalPostgresPilotTrial;

  const identity = planTrialSetCells({ tasks: [{ taskId: "postgres-historical-001", partition: "TRAIN" }], profiles: [{ profileId: "baseline", profileHash: "bb" }], trialsPerCell: 1 })[0];
  const record = await executeTrialSetCell({
    identity,
    experimentId: "exp-1",
    corpusManifest: fakeCorpusManifest(),
    taskSpec: { taskId: "postgres-historical-001" } as never,
    profile: { profileId: "baseline", sourcePath: "/a.yml", content: "profile-body", profileHash: "bb" },
    artifactDir: "/tmp/whatever",
    apiKey: "fake-key",
    agentImage: "honeyrail-postgres-research-agent-dsh:latest",
    upstreamUrl: "https://api.deepseek.com",
    agentTimeoutMs: 1000,
    sessionTimeoutMs: 2000,
    runPilotTrial: fakeRunPilotTrial
  });

  assert.equal(record.pilotId, "pilot-xyz");
  assert.equal(record.taskId, "postgres-historical-001");
  assert.equal(record.profileId, "baseline");
  assert.equal(record.artifactDir, "/tmp/whatever");
  assert.equal(record.datasetEligible, true);
  assert.equal(record.officialScoredResult, "miss");

  const input = capturedInput as { profileKind: string; agent: { command: string; args: string[]; env: Record<string, string> } };
  assert.equal(input.profileKind, "agent");
  assert.equal(input.agent.command, "sh");
  assert.equal(input.agent.env.HR_TRIALSET_PROFILE_CONTENT, "profile-body");
  assert.equal(input.agent.env.DEEPSEEK_API_KEY, "fake-key");
  assert.match(input.agent.args[1], /dsh --profile headless --patch cordis\.patch\.yml "\$HONEYRAIL_TASK_PROMPT"/);
});

// ---------------------------------------------------------------------------
// Authoritative denominator
// ---------------------------------------------------------------------------

function record(overrides: Partial<TrialSetCellRecord>): TrialSetCellRecord {
  return {
    experimentId: "exp-1",
    cellId: "cell",
    taskId: "postgres-historical-001",
    partition: "TRAIN",
    profileId: "baseline",
    profileHash: "bb",
    trialIndex: 1,
    pilotId: "pilot-1",
    profileKind: "agent",
    artifactDir: "/tmp/x",
    pilotStatus: "completed",
    datasetEligible: true,
    officialScoredResult: "rediscovered",
    executionBindingOverall: "verified",
    wallTimeMs: 1000,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    diagnostics: [],
    ...overrides
  };
}

test("summarizeTrialSetProfile: only datasetEligible=true cells enter the denominator, split by officialScoredResult", () => {
  const records: TrialSetCellRecord[] = [
    record({ cellId: "c1", datasetEligible: true, officialScoredResult: "rediscovered", pilotStatus: "completed" }),
    record({ cellId: "c2", datasetEligible: true, officialScoredResult: "miss", pilotStatus: "completed" }),
    record({ cellId: "c3", datasetEligible: false, officialScoredResult: "N/A", pilotStatus: "blocked" }),
    record({ cellId: "c4", datasetEligible: false, officialScoredResult: "N/A", pilotStatus: "infrastructure_error" }),
    record({ cellId: "c5", datasetEligible: false, officialScoredResult: "N/A", pilotStatus: "integrity_error" }),
    record({ cellId: "c6", datasetEligible: false, officialScoredResult: "N/A", pilotStatus: "unscored" }),
    record({ cellId: "c7", datasetEligible: false, officialScoredResult: "N/A", pilotStatus: "completed", gradeStatus: "invalid_submission" })
  ];
  const summary = summarizeTrialSetProfile("baseline", records);
  assert.equal(summary.eligibleTrials, 2);
  assert.equal(summary.rediscovered, 1);
  assert.equal(summary.miss, 1);
  assert.equal(summary.rediscoveryRate, 0.5);
  assert.deepEqual(summary.nonDataset, { blocked: 1, invalidSubmission: 1, infrastructure: 1, integrity: 1, unscored: 1, other: 0 });
});

test("summarizeTrialSetProfile: rediscoveryRate is null (not 0) when there are zero eligible trials", () => {
  const summary = summarizeTrialSetProfile("baseline", [record({ datasetEligible: false, officialScoredResult: "N/A", pilotStatus: "blocked" })]);
  assert.equal(summary.eligibleTrials, 0);
  assert.equal(summary.rediscoveryRate, null);
});

test("summarizeTrialSetProfile: never keys off pilotStatus/executionBindingOverall for eligible cells - only datasetEligible/officialScoredResult decide the denominator and split", () => {
  // A cell that is somehow datasetEligible=true with an unverified executionBindingOverall would be
  // a #207 contract violation, not something this report layer should second-guess or reclassify.
  const summary = summarizeTrialSetProfile("baseline", [record({ datasetEligible: true, officialScoredResult: "rediscovered", executionBindingOverall: "unverified" })]);
  assert.equal(summary.eligibleTrials, 1);
  assert.equal(summary.rediscovered, 1);
});

test("buildTrialSetCellRecord: every field needed for evidence traceability is present", () => {
  const identity = planTrialSetCells({ tasks: [{ taskId: "postgres-historical-001", partition: "TRAIN" }], profiles: [{ profileId: "baseline", profileHash: "bb" }], trialsPerCell: 1 })[0];
  const rec = buildTrialSetCellRecord({
    experimentId: "exp-1",
    identity,
    artifactDir: "/artifacts/cell-1",
    pilot: fakePilotResult({ datasetEligible: true, officialScoredResult: "rediscovered", status: "completed", pilotId: "pilot-abc", diagnostics: ["note"] })
  });
  assert.equal(rec.pilotId, "pilot-abc");
  assert.equal(rec.artifactDir, "/artifacts/cell-1");
  assert.equal(rec.taskId, "postgres-historical-001");
  assert.equal(rec.profileId, "baseline");
  assert.equal(rec.trialIndex, 1);
  assert.deepEqual(rec.diagnostics, ["note"]);
});

test("buildHistoricalPgTrialSetReport: every cell row carries pilotId and artifactDir, and the denominator note names the authoritative fields", () => {
  const profiles: TrialSetProfileSpec[] = [{ profileId: "baseline", sourcePath: "/a.yml", content: "x", profileHash: "bb" }];
  const manifest = buildExperimentManifest({ identity: baseIdentity(), repositoryCommit: "deadbeef", profiles });
  const records = [record({ cellId: "c1", pilotId: "pilot-1", artifactDir: "/artifacts/c1" })];
  const report = buildHistoricalPgTrialSetReport({ manifest, records });
  assert.match(report, /datasetEligible/);
  assert.match(report, /officialScoredResult/);
  assert.match(report, /pilot-1/);
  assert.match(report, /\/artifacts\/c1/);
});
