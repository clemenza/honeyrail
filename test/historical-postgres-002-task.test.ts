import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  historicalPostgres002TaskPrompt,
  historicalPostgres002TaskSpec,
  materializeHistoricalPostgresTask,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

test("historicalPostgres002TaskSpec carries the frozen #185 Bug 2 identity and no CommitFest", () => {
  const spec = historicalPostgres002TaskSpec("/unused/repo/path");
  assert.equal(spec.taskId, "pg-hist-plpgsql-call-stale-plan-002");
  assert.equal(spec.source.historicalRevision, "7696b2ea52416cc2f4046a359d3b6f760e4c013d");
  assert.equal(spec.source.referenceRevision, "7f875fb5bd603d8640cc7aca2c79c604aacd3890");
  assert.equal(spec.truth.upstreamBug, "PostgreSQL BUG #18574");
  assert.equal(spec.truth.commitFest, undefined);
  assert.ok(spec.prompt.trim().length > 0);
  // The prompt is agent-visible: it must never name the upstream bug, a
  // message-id, or the specific stale-plan/cache-invalidation mechanism.
  assert.ok(!spec.prompt.includes("18574"));
  assert.ok(!spec.prompt.toLowerCase().includes("cache lookup"));
  assert.ok(!spec.prompt.toLowerCase().includes("commitfest"));
  assert.equal(historicalPostgres002TaskPrompt(), spec.prompt);
});

test("historicalPostgres002TaskSpec passes a known-reproducer path through to truth for provenance hashing", () => {
  const spec = historicalPostgres002TaskSpec("/unused/repo/path", "/private/known-repro.sql");
  assert.equal(spec.truth.knownReproducerPath, "/private/known-repro.sql");
});

test("a task with no CommitFest materializes a valid truth bundle with commitFest: null, and the bundle hash still moves", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const baseSpec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-no-commitfest",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #77777" },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a PL/pgSQL correctness regression."
  };

  const task = await materializeHistoricalPostgresTask(baseSpec, join(root, "case"));
  assert.equal(task.truthManifest.commitFest, null);
  assert.ok(task.truthManifest.bundleHash);

  const publicManifestText = JSON.stringify(task.taskManifest);
  assert.ok(!("commitFest" in JSON.parse(publicManifestText)));
  assert.ok(!publicManifestText.includes("77777"));

  const truthManifestText = await readFile(task.truthManifestPath, "utf8");
  assert.match(truthManifestText, /"commitFest": null/);

  // The bundle hash still moves on a change to another truth field, proving
  // commitFest's absence didn't collapse the hash to a constant.
  const changed = await materializeHistoricalPostgresTask(
    { ...baseSpec, truth: { ...baseSpec.truth, upstreamBug: "a different synthetic upstream bug" } },
    join(root, "case-changed")
  );
  assert.notEqual(changed.truthManifest.bundleHash, task.truthManifest.bundleHash);

  // And a task that *does* set commitFest hashes differently from one that
  // doesn't, given otherwise-identical fields - commitFest itself is part of
  // what the hash covers, not dropped as "just an optional field".
  const withCommitFest = await materializeHistoricalPostgresTask(
    { ...baseSpec, truth: { ...baseSpec.truth, commitFest: 4242 } },
    join(root, "case-with-commitfest")
  );
  assert.equal(withCommitFest.truthManifest.commitFest, 4242);
  assert.notEqual(withCommitFest.truthManifest.bundleHash, task.truthManifest.bundleHash);
});

test("truth.commitFest must be a positive integer when present, but may be omitted entirely", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-invalid-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const baseSpec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-bad-commitfest",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #77778", commitFest: 0 },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a PL/pgSQL correctness regression."
  };
  await assert.rejects(
    materializeHistoricalPostgresTask(baseSpec, join(root, "case")),
    /truth.commitFest must be a positive integer/
  );
});
