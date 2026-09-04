import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  gradeHistoricalPostgresSubmission,
  historicalPostgres002TaskPrompt,
  historicalPostgres002TaskSpec,
  materializeHistoricalPostgresTask,
  resolveOracleReproduction,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";
import { readTreeAsText } from "./helpers/read-tree-as-text.js";

test("historicalPostgres002TaskSpec carries the frozen #185 Bug 2 identity behind an opaque task id, and no CommitFest", () => {
  const spec = historicalPostgres002TaskSpec("/unused/repo/path");
  // Opaque, matching postgres-historical-001's convention - never the
  // descriptive corpus slot id, which names PL/pgSQL/CALL/"stale plan"
  // outright and would leak the failure mechanism through HONEYRAIL_TASK_ID.
  assert.equal(spec.taskId, "postgres-historical-002");
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
  assert.ok(!spec.prompt.toLowerCase().includes("stale"));
  assert.equal(historicalPostgres002TaskPrompt(), spec.prompt);
});

test("historicalPostgres002TaskSpec materializes under the behavioral-oracle grading protocol, distinct from case 001's exit-status protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-protocol-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const base = historicalPostgres002TaskSpec(repo.repoPath);
  const spec: HistoricalPostgresTaskSpec = { ...base, source: { ...base.source, historicalRevision: repo.ref, referenceRevision: repo.laterRef } };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
  assert.equal(task.referenceManifest.gradingProtocol, "submitted-reproducer-behavioral-oracle-v1");
});

test("historicalPostgres002TaskSpec declares a behavioral oracle matching #185's confirmed observations", () => {
  const spec = historicalPostgres002TaskSpec("/unused/repo/path");
  const oracle = spec.truth.behavioralOracle;
  assert.ok(oracle);
  assert.equal(oracle!.historical.length, 2);
  assert.equal(oracle!.reference.length, 2);
  const baseline = /^procedure parameter "r1" is an output parameter but corresponding argument is not writable$/;
  assert.ok(baseline.test('procedure parameter "r1" is an output parameter but corresponding argument is not writable'));
  assert.equal(new RegExp(oracle!.historical[0].matches).source, baseline.source);
  assert.equal(new RegExp(oracle!.reference[0].matches).source, baseline.source);
  assert.equal(new RegExp(oracle!.reference[1].matches).source, baseline.source);
  // The stale-plan observation is matched by a targeted, anchored `\d+` for
  // the dynamic OID - never a broad "strip every digit" transform.
  const staleCache = new RegExp(oracle!.historical[1].matches);
  assert.ok(staleCache.test("cache lookup failed for function 16386"));
  assert.ok(staleCache.test("cache lookup failed for function 987654"));
  assert.ok(!staleCache.test('procedure parameter "r1" is an output parameter but corresponding argument is not writable'));
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

test("postgres-historical-001 still materializes and hashes under the widened truth schema", async () => {
  // Regression coverage for the commitFest/behavioralOracle schema widening:
  // a spec that (like case 001) sets neither field must still produce a
  // valid, leak-free bundle whose null-shaped optional fields don't collide
  // with a spec that omits them differently.
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-001-regression-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "PostgreSQL #19560", commitFest: 7059 },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a join-planning correctness regression."
  };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));
  assert.equal(task.truthManifest.commitFest, 7059);
  assert.equal(task.truthManifest.behavioralOracle, null);
  // Backward compatibility for the grading-protocol identifier change: a
  // spec that declares no behavioralOracle (case 001) must still get the
  // exact original protocol string, byte-for-byte - never the new
  // behavioral-oracle one.
  assert.equal(task.truthManifest.gradingProtocol, "submitted-reproducer-exit-status-v1");
  assert.equal(task.referenceManifest.gradingProtocol, "submitted-reproducer-exit-status-v1");
  const publicManifestText = JSON.stringify(task.taskManifest);
  assert.ok(!publicManifestText.includes("7059"));
  assert.ok(!publicManifestText.includes("19560"));
});

/** Given a revision string and the two-observation sequence it should have produced, builds the execution shape `resolveOracleReproduction` reads. */
function executionWithObservations(observations: string[]): { ok: boolean; stdout: string; stderr: string; exitCode: number; durationMs: number } {
  const stderr = observations.map((message) => `ERROR:  ${message}`).join("\n");
  return { ok: observations.length > 0, stdout: "", stderr, exitCode: observations.length > 0 ? 0 : 1, durationMs: 1 };
}

test("resolveOracleReproduction: the historical ref is reproduced only when captured observations match the declared stale-plan sequence", () => {
  const spec = historicalPostgres002TaskSpec("/unused/repo/path");
  const baseline = 'procedure parameter "r1" is an output parameter but corresponding argument is not writable';

  const correct = resolveOracleReproduction({
    execution: executionWithObservations([baseline, "cache lookup failed for function 16386"]),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(correct.reproduced, true);
  assert.equal(correct.attribution?.attributedTo, "historical");
  assert.equal(correct.attribution?.historicalMatch.satisfied, true);
  assert.equal(correct.attribution?.referenceMatch.satisfied, false);
  assert.equal(correct.attribution?.gradeable, true);

  // An unrelated error sequence must not earn rediscovery credit just
  // because the script happened to exit non-specifically on this revision.
  const unrelated = resolveOracleReproduction({
    execution: executionWithObservations([baseline, "relation \"missing_table\" does not exist"]),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(unrelated.reproduced, false);
  assert.equal(unrelated.attribution?.attributedTo, "unattributed");
  assert.equal(unrelated.attribution?.gradeable, true);

  // Wrong *first* observation also fails, even if the second happens to match.
  const wrongFirst = resolveOracleReproduction({
    execution: executionWithObservations(["some other error", "cache lookup failed for function 16386"]),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(wrongFirst.reproduced, false);
  assert.equal(wrongFirst.attribution?.attributedTo, "unattributed");

  // No observations at all (e.g. the script never reached a CALL) is
  // explicitly "not gradeable", distinct from "gradeable but unmatched".
  const empty = resolveOracleReproduction({
    execution: executionWithObservations([]),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(empty.attribution?.gradeable, false);
  assert.equal(empty.attribution?.attributedTo, "unattributed");
});

test("resolveOracleReproduction: attribution is symmetric - the reference ref is correctly attributed to \"reference\" when it holds the baseline", () => {
  const spec = historicalPostgres002TaskSpec("/unused/repo/path");
  const baseline = 'procedure parameter "r1" is an output parameter but corresponding argument is not writable';

  // The reference ref correctly holding the baseline twice is positively
  // attributed to "reference" - not merely "not historical" - which is what
  // the classifier now requires for rediscovered (see the e2e test below).
  const correctReference = resolveOracleReproduction({
    execution: executionWithObservations([baseline, baseline]),
    revision: spec.source.referenceRevision,
    spec
  });
  assert.equal(correctReference.reproduced, false);
  assert.equal(correctReference.attribution?.attributedTo, "reference");
  assert.equal(correctReference.attribution?.referenceMatch.satisfied, true);
  assert.equal(correctReference.attribution?.historicalMatch.satisfied, false);

  // A reference-ref run whose captured output happens to look like the
  // buggy stale-cache failure (e.g. a misconfigured/mismatched build, or a
  // real regression on the "fixed" ref) is attributed to "historical", which
  // the classification formula reads as disqualifying (invalid_submission),
  // never as a spurious rediscovered.
  const staleShapedOnReference = resolveOracleReproduction({
    execution: executionWithObservations([baseline, "cache lookup failed for function 55555"]),
    revision: spec.source.referenceRevision,
    spec
  });
  assert.equal(staleShapedOnReference.reproduced, true);
  assert.equal(staleShapedOnReference.attribution?.attributedTo, "historical");

  // A reference-ref run that fails for some unrelated reason (neither the
  // historical signature nor the declared baseline) is "unattributed" - the
  // primary correctness fix this attribution model exists for: this must
  // never be treated as equivalent to "correctly matches the fixed baseline".
  const unattributed = resolveOracleReproduction({
    execution: executionWithObservations(["connection refused"]),
    revision: spec.source.referenceRevision,
    spec
  });
  assert.equal(unattributed.reproduced, false);
  assert.equal(unattributed.attribution?.attributedTo, "unattributed");
  assert.equal(unattributed.attribution?.referenceMatch.satisfied, false);
});

test("end-to-end: an oracle-declared task correctly classifies rediscovered vs. a non-specific differential vs. a stale-shaped reference run", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-e2e-"));
  const spec = historicalPostgres002TaskSpec("/unused/repo/path");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "repro.sql"), "-- irrelevant to grading here; gradeRevision is injected below\n");
  await writeFile(join(workspace, "finding.json"), JSON.stringify({ status: "reproduced", summary: "observed", reproducer: "repro.sql" }));
  const baseline = 'procedure parameter "r1" is an output parameter but corresponding argument is not writable';

  // A real rediscovery: historical matches the stale-plan sequence,
  // reference matches the baseline-twice sequence.
  const rediscovered = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "rediscovered"),
    gradeRevision: async ({ revision }) =>
      resolveOracleReproduction({
        execution:
          revision === spec.source.historicalRevision
            ? executionWithObservations([baseline, "cache lookup failed for function 16386"])
            : executionWithObservations([baseline, baseline]),
        revision,
        spec
      })
  });
  assert.equal(rediscovered.status, "rediscovered", JSON.stringify(rediscovered, null, 2));
  // Historical is positively attributed to "historical"; reference is
  // positively attributed to "reference" (the expected/fixed baseline was
  // actually, structurally observed - not merely "didn't match historical").
  assert.equal(rediscovered.historical.attribution?.attributedTo, "historical");
  assert.equal(rediscovered.reference.attribution?.attributedTo, "reference");
  assert.equal(rediscovered.reference.attribution?.referenceMatch.satisfied, true);

  // A script that exits 0 on the historical ref and non-zero on the
  // reference ref for an unrelated reason (not the declared oracle) must not
  // be credited: the historical side's oracle is unsatisfied, so this is a
  // miss even though a naive exit-status differential would have called it
  // rediscovered.
  const nonSpecific = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "non-specific"),
    gradeRevision: async ({ revision }) =>
      resolveOracleReproduction({
        execution:
          revision === spec.source.historicalRevision
            ? executionWithObservations(["totally unrelated failure"])
            : { ok: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 },
        revision,
        spec
      })
  });
  assert.equal(nonSpecific.status, "miss", JSON.stringify(nonSpecific, null, 2));

  // The exact scenario the review flagged: a reference run whose captured
  // output reproduces the stale-cache (historical) failure must NOT be
  // accepted as a rediscovery. It matches the historical signature, so
  // reference.reproduced is true, which the existing formula reads as
  // disqualifying - invalid_submission, never rediscovered.
  const staleShapedReference = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "stale-shaped-reference"),
    gradeRevision: async ({ revision }) =>
      resolveOracleReproduction({
        execution:
          revision === spec.source.historicalRevision
            ? executionWithObservations([baseline, "cache lookup failed for function 16386"])
            : executionWithObservations([baseline, "cache lookup failed for function 55555"]),
        revision,
        spec
      })
  });
  assert.equal(staleShapedReference.reference.attribution?.attributedTo, "historical");
  assert.equal(staleShapedReference.reference.reproduced, true);
  assert.equal(staleShapedReference.status, "invalid_submission", JSON.stringify(staleShapedReference, null, 2));

  // The specific scenario the second review round required: historical
  // correctly matches, but the reference run fails for some unrelated
  // reason that matches *neither* declared pattern set. This must never be
  // reported as rediscovered just because "not matching the historical
  // signature" used to be treated as good enough - it is unattributed, and
  // unattributed is invalid_submission, not rediscovered.
  const unattributedReference = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "unattributed-reference"),
    gradeRevision: async ({ revision }) =>
      resolveOracleReproduction({
        execution:
          revision === spec.source.historicalRevision
            ? executionWithObservations([baseline, "cache lookup failed for function 16386"])
            : executionWithObservations(["connection refused by the runtime container"]),
        revision,
        spec
      })
  });
  assert.equal(unattributedReference.historical.attribution?.attributedTo, "historical");
  assert.equal(unattributedReference.reference.attribution?.attributedTo, "unattributed");
  assert.notEqual(unattributedReference.status, "rediscovered", JSON.stringify(unattributedReference, null, 2));
  assert.equal(unattributedReference.status, "invalid_submission", JSON.stringify(unattributedReference, null, 2));
  assert.ok(unattributedReference.diagnostics.some((line) => line.includes("not attributable to the declared oracle")));

  // Historical-side miss, regardless of what the reference side shows.
  const historicalMiss = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "historical-miss"),
    gradeRevision: async ({ revision }) =>
      resolveOracleReproduction({
        execution:
          revision === spec.source.historicalRevision
            ? executionWithObservations(["unrelated failure"])
            : executionWithObservations([baseline, baseline]),
        revision,
        spec
      })
  });
  assert.equal(historicalMiss.status, "miss", JSON.stringify(historicalMiss, null, 2));
});

test("no file anywhere under the materialized task/ tree leaks the bug identity, the failure-mechanism vocabulary, either revision, or the canonical reproducer", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-leak-"));
  // Real Bug 2 identity/oracle/prompt from historicalPostgres002TaskSpec(),
  // but pointed at a synthetic local repo (via its own refs) so this test
  // doesn't need the real PostgreSQL history the frozen #185 SHAs live in.
  // The repo must be created (and its fixture ref committed) BEFORE the
  // known-repro.sql fixture file is written anywhere under `root`: this
  // helper commits everything already present in its repoPath, so writing
  // the repro file first would leak it straight into the archived snapshot
  // and produce a false-positive "leak" that isn't the historical-task
  // materializer's fault at all.
  const repo = await createSyntheticPostgresSourceRepo(root);
  const reproPath = join(root, "known-repro.sql");
  const reproContents = "\\set ON_ERROR_STOP off\n-- canonical Bug 2 reproducer content (never committed)\n";
  await writeFile(reproPath, reproContents);
  const base = historicalPostgres002TaskSpec(repo.repoPath, reproPath);
  const spec: HistoricalPostgresTaskSpec = { ...base, source: { ...base.source, historicalRevision: repo.ref, referenceRevision: repo.laterRef } };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  const taskFiles = await readTreeAsText(task.taskDir);
  const secrets: Record<string, string> = {
    "upstream bug number": "18574",
    "upstream bug id": "BUG #18574",
    "failure mechanism (hyphenated)": "stale-plan",
    "failure mechanism (spaced)": "stale plan",
    "failure mechanism (cache lookup)": "cache lookup",
    "historical revision": spec.source.historicalRevision,
    "reference revision": spec.source.referenceRevision,
    "grader-private mirror path": spec.source.repoPath,
    "canonical reproducer host path": reproPath,
    "canonical reproducer contents": reproContents,
    "canonical reproducer hash": task.truthManifest.canonicalReproducerSha256!
  };
  for (const file of taskFiles) {
    for (const [label, secret] of Object.entries(secrets)) {
      assert.ok(!file.text.includes(secret), `task/${file.relativePath} leaked ${label}`);
    }
  }
  // The canonical reproducer's grader-private relative path must not appear
  // under task/ - but it legitimately exists under reference/, so that
  // absence is scoped to task/ specifically, not asserted globally.
  assert.ok(!taskFiles.some((file) => file.text.includes("canonical-reproducer.sql")));

  const referenceFiles = await readTreeAsText(task.referenceDir);
  const retained = referenceFiles.find((file) => file.relativePath === "verification/canonical-reproducer.sql");
  assert.ok(retained);
  assert.equal(retained!.text, reproContents);
});
