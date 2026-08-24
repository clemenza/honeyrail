import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";
import type { DshTrialRecord } from "../server/evals/dsh-report.js";

// #118: read-only web UI view onto a scripts/dsh-evals-demo.ts (#93) --out
// directory. Exercises GET /api/evals/dsh-runs* against a hand-written
// state.json + cells/ layout matching exactly what the real driver writes
// (see scripts/dsh-evals-demo.ts's StateFile/executeCell) - no live dsh
// install or Docker needed, since this is a pure filesystem read path with
// no Run/Step/Worktree involved at all.

function trial(overrides: Partial<DshTrialRecord> & Pick<DshTrialRecord, "trialId" | "artifactsDir">): DshTrialRecord {
  return {
    fixture: "m01",
    profile: "baseline",
    trial: 1,
    killed: true,
    falseAlarms: 0,
    contractOk: true,
    integrityOk: true,
    transcriptAuditHits: [],
    killRate: null,
    killedByKind: null,
    wallTimeMs: 12_000,
    ...overrides
  };
}

async function withServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-dsh-run-browser-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const store = new JsonStore(join(tempDir, "store.json"));
  const app = createApp({
    store,
    bus: new EventBus(),
    tmux: { listSessions: async () => [] } as any,
    worktrees: {} as any,
    run: (async () => ({ ok: true, stdout: "", stderr: "" })) as any,
    token: null,
    attachmentRoot: join(tempDir, "attachments"),
    sessionLogRoot: join(tempDir, "sessions")
  });
  const server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  t.after(async () => new Promise<void>((res) => server.close(() => res())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, tempDir };
}

async function writeState(outDir: string, trials: DshTrialRecord[]) {
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "state.json"),
    JSON.stringify({
      config: { image: "tinytable-exam-room:latest", smoke: true, dshVersion: "0.1.0-rc.7" },
      profiles: [{ label: "baseline", sha256: "a".repeat(64) }],
      fixtures: ["m01"],
      trials
    })
  );
}

test("GET /api/evals/dsh-runs 404s with a clear message when state.json doesn't exist yet", async (t) => {
  const { baseUrl, tempDir } = await withServer(t);
  const outDir = join(tempDir, "no-such-report");
  const res = await fetch(`${baseUrl}/api/evals/dsh-runs?outDir=${encodeURIComponent(outDir)}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /No state\.json/);
  assert.match(body.error, /dsh-evals-demo\.ts/);
});

test("GET /api/evals/dsh-runs 400s when outDir is missing", async (t) => {
  const { baseUrl } = await withServer(t);
  const res = await fetch(`${baseUrl}/api/evals/dsh-runs`);
  assert.equal(res.status, 400);
});

test("GET /api/evals/dsh-runs reads state.json and returns the same profile/fixture summaries dsh-report.ts computes for the CLI report", async (t) => {
  const { baseUrl, tempDir } = await withServer(t);
  const outDir = join(tempDir, "report");
  await writeState(outDir, [
    trial({ trialId: "m01-baseline-1", artifactsDir: join(outDir, "cells", "m01-baseline-1"), killed: true, falseAlarms: 0, contractOk: true }),
    trial({ trialId: "m01-baseline-2", artifactsDir: join(outDir, "cells", "m01-baseline-2"), trial: 2, killed: false, falseAlarms: 0, contractOk: true })
  ]);

  const res = await fetch(`${baseUrl}/api/evals/dsh-runs?outDir=${encodeURIComponent(outDir)}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.config.dshVersion, "0.1.0-rc.7");
  assert.equal(body.fixtures[0], "m01");

  assert.equal(body.profileSummaries.length, 1);
  assert.equal(body.profileSummaries[0].trials, 2);
  assert.equal(body.profileSummaries[0].passed, 1);
  assert.equal(body.profileSummaries[0].taskFailed, 1);

  assert.equal(body.fixtureCells.length, 1);
  assert.equal(body.fixtureCells[0].killRate, 0.5);

  // Every trial gets its outcome computed server-side via classifyDshOutcome -
  // the frontend must never have to reimplement that priority logic itself.
  assert.equal(body.trials.length, 2);
  assert.equal(body.trials.find((tr: any) => tr.trialId === "m01-baseline-1").outcome, "passed");
  assert.equal(body.trials.find((tr: any) => tr.trialId === "m01-baseline-2").outcome, "task_failed");

  // Confirm this never touched Store/OrchestrationService - no Run exists anywhere.
  const runsRes = await fetch(`${baseUrl}/api/runs`);
  const runs = await runsRes.json();
  assert.equal(runs.runs.length, 0);
});

test("GET /api/evals/dsh-runs/trial returns a trial's score.json and container.log, matching the on-disk layout scripts/dsh-evals-demo.ts writes", async (t) => {
  const { baseUrl, tempDir } = await withServer(t);
  const outDir = join(tempDir, "report");
  const artifactsDir = join(outDir, "cells", "m01-baseline-1");
  await writeState(outDir, [trial({ trialId: "m01-baseline-1", artifactsDir })]);

  await mkdir(join(artifactsDir, "seed-root"), { recursive: true });
  await writeFile(join(artifactsDir, "seed-root", "score.json"), JSON.stringify({ killed: true, false_alarms: 0, contract_ok: true, passed: true }));
  await writeFile(join(artifactsDir, "container.log"), "--- stdout ---\nhello\n--- stderr ---\n\n");

  const res = await fetch(`${baseUrl}/api/evals/dsh-runs/trial?outDir=${encodeURIComponent(outDir)}&trialId=m01-baseline-1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.trial.trialId, "m01-baseline-1");
  assert.equal(body.trial.outcome, "passed");
  assert.equal(body.scoreJson.killed, true);
  assert.match(body.containerLog, /hello/);
});

test("GET /api/evals/dsh-runs/trial returns null artifacts (not an error) when a trial errored before writing them", async (t) => {
  const { baseUrl, tempDir } = await withServer(t);
  const outDir = join(tempDir, "report");
  const artifactsDir = join(outDir, "cells", "m01-baseline-1");
  await writeState(outDir, [
    trial({
      trialId: "m01-baseline-1",
      artifactsDir,
      killed: null,
      falseAlarms: null,
      contractOk: null,
      error: "docker not found"
    })
  ]);

  const res = await fetch(`${baseUrl}/api/evals/dsh-runs/trial?outDir=${encodeURIComponent(outDir)}&trialId=m01-baseline-1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.trial.outcome, "driver_error");
  assert.equal(body.scoreJson, null);
  assert.equal(body.containerLog, null);
});

// Regression: a state.json written by a driver from before #107 added
// transcriptAuditHits (or before #126 replaced killMatrix with
// killRate/killedByKind) has trial records missing those fields entirely -
// classifyDshOutcome()'s unconditional `.transcriptAuditHits.length` must
// not crash the reader just because an older directory is being browsed.
// Writes the raw JSON directly (not via the trial() helper, which always
// fills every field) to reproduce the exact on-disk shape an old driver
// run left behind.
test("GET /api/evals/dsh-runs tolerates a state.json from before transcriptAuditHits/killRate existed", async (t) => {
  const { baseUrl, tempDir } = await withServer(t);
  const outDir = join(tempDir, "old-report");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "state.json"),
    JSON.stringify({
      config: { image: "tinytable-exam-room:latest", smoke: true, dshVersion: "0.1.0-rc.7" },
      profiles: [{ label: "baseline", sha256: "a".repeat(64) }],
      fixtures: ["m01"],
      trials: [
        {
          fixture: "m01",
          profile: "baseline",
          trial: 1,
          trialId: "m01-baseline-1",
          artifactsDir: join(outDir, "cells", "m01-baseline-1"),
          killed: true,
          falseAlarms: 0,
          contractOk: true,
          integrityOk: true,
          wallTimeMs: 12_000
          // no transcriptAuditHits, no killRate/killedByKind - the pre-#107/#126 shape.
        }
      ]
    })
  );

  const res = await fetch(`${baseUrl}/api/evals/dsh-runs?outDir=${encodeURIComponent(outDir)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.trials.length, 1);
  assert.equal(body.trials[0].outcome, "passed");
  assert.deepEqual(body.trials[0].transcriptAuditHits, []);
  assert.equal(body.trials[0].killRate, null);
  assert.equal(body.trials[0].killedByKind, null);
});

test("GET /api/evals/dsh-runs/trial 404s for an unknown trialId", async (t) => {
  const { baseUrl, tempDir } = await withServer(t);
  const outDir = join(tempDir, "report");
  await writeState(outDir, [trial({ trialId: "m01-baseline-1", artifactsDir: join(outDir, "cells", "m01-baseline-1") })]);

  const res = await fetch(`${baseUrl}/api/evals/dsh-runs/trial?outDir=${encodeURIComponent(outDir)}&trialId=does-not-exist`);
  assert.equal(res.status, 404);
});
