import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { createAdditionalSyntheticCommit, createSyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";
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
  // The behavioralOracle key is genuinely present (not just non-null) when a
  // task declares one - the mirror image of the "absent, not null" proof for
  // case 001 below.
  assert.ok("behavioralOracle" in task.truthManifest);
  assert.deepEqual(task.truthManifest.behavioralOracle, spec.truth.behavioralOracle);
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
  // This file uses node:assert/strict, where `equal` is `strictEqual`, so a
  // spec that declares no oracle must not merely have `behavioralOracle`
  // equal `null` - the key must be genuinely *absent*, not present-as-null.
  // This is the actual Policy A fix (#200 third review
  // round, "Important 4") - a legacy spec's serialized truth bundle must
  // gain no new key at all, or its bundleHash would move relative to the
  // pre-existing schema for zero behavioral reason.
  assert.ok(!("behavioralOracle" in task.truthManifest));
  assert.ok(!JSON.stringify(task.truthManifest).includes("behavioralOracle"));
  // Same Policy-A treatment for fix-evidence (#200 fourth review round,
  // Blocking 3): a legacy spec declares no oracle, so fix-evidence
  // auto-generation never runs, and (having supplied no knownFixEvidencePath
  // either) gets neither key at all - not present-as-null.
  assert.ok(!("fixEvidence" in task.truthManifest));
  assert.ok(!("fixEvidenceSha256" in task.truthManifest));
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

test("gradingProtocol/behavioralOracle presence is covered by bundleHash but not by taskDefinitionHash", async () => {
  // Structural proof of the documented hash-scope boundary: two otherwise-
  // identical specs that differ only in truth.behavioralOracle presence
  // must produce the *same* taskDefinitionHash (which never includes
  // gradingProtocol/behavioralOracle) but a *different* bundleHash (which
  // does, via truthShape).
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-hash-scope-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const withoutOracle: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-hash-scope",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #55501" },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a correctness regression."
  };
  const withOracle: HistoricalPostgresTaskSpec = {
    ...withoutOracle,
    truth: {
      ...withoutOracle.truth,
      behavioralOracle: {
        historical: [{ label: "only", matches: "^synthetic historical error$" }],
        reference: [{ label: "only", matches: "^synthetic reference error$" }]
      }
    }
  };
  const a = await materializeHistoricalPostgresTask(withoutOracle, join(root, "without-oracle"));
  const b = await materializeHistoricalPostgresTask(withOracle, join(root, "with-oracle"));
  assert.equal(a.truthManifest.taskDefinitionHash, b.truthManifest.taskDefinitionHash);
  assert.notEqual(a.truthManifest.bundleHash, b.truthManifest.bundleHash);
  assert.notEqual(a.referenceManifest.gradingProtocol, b.referenceManifest.gradingProtocol);
});

test("knownFixEvidencePath is optional grader-private provenance: present when supplied, hashed, and never under task/", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-fix-evidence-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const fixEvidencePath = join(root, "fix-notes.md");
  const fixEvidenceContents = "Upstream fix: SPI_plan_get_cached_plan() replaces the stale SPI_plan_get_plan_sources() lookup.\n";
  await writeFile(fixEvidencePath, fixEvidenceContents);
  const baseSpec: HistoricalPostgresTaskSpec = {
    taskId: "synthetic-fix-evidence",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "Synthetic upstream #55502" },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a correctness regression."
  };
  // baseSpec declares no behavioralOracle and no knownFixEvidencePath, so
  // this is the legacy path: neither key is generated, and (#200 fourth
  // review round, Blocking 3) neither key is even *present* - not
  // present-as-null - matching behavioralOracle's own Policy-A treatment.
  const withoutEvidence = await materializeHistoricalPostgresTask(baseSpec, join(root, "without-evidence"));
  assert.ok(!("fixEvidence" in withoutEvidence.truthManifest));
  assert.ok(!("fixEvidenceSha256" in withoutEvidence.truthManifest));
  assert.ok(!JSON.stringify(withoutEvidence.truthManifest).includes("fixEvidence"));

  const withEvidence = await materializeHistoricalPostgresTask(
    { ...baseSpec, truth: { ...baseSpec.truth, knownFixEvidencePath: fixEvidencePath } },
    join(root, "with-evidence")
  );
  assert.equal(withEvidence.truthManifest.fixEvidence, "expected-behavior/fix-evidence");
  assert.ok(withEvidence.truthManifest.fixEvidenceSha256);
  const retained = await readFile(join(withEvidence.referenceDir, "expected-behavior", "fix-evidence"), "utf8");
  assert.equal(retained, fixEvidenceContents);

  // Changes provenance hashes relative to an otherwise-identical spec without it.
  assert.notEqual(withEvidence.truthManifest.bundleHash, withoutEvidence.truthManifest.bundleHash);
  assert.notEqual(withEvidence.truthManifest.expectedBehaviorSha256, withoutEvidence.truthManifest.expectedBehaviorSha256);

  // Never appears anywhere under task/ - neither the content nor the host path.
  const taskFiles = await readTreeAsText(withEvidence.taskDir);
  for (const file of taskFiles) {
    assert.ok(!file.text.includes(fixEvidenceContents.trim()), `task/${file.relativePath} leaked fix-evidence contents`);
    assert.ok(!file.text.includes(fixEvidencePath), `task/${file.relativePath} leaked fix-evidence host path`);
  }
});

test("Policy A: a legacy truth bundle (no behavioralOracle, no fix evidence) is byte-for-byte identical to the pristine pre-#200 schema", async () => {
  // #200 fourth review round, Blocking 3 - a real golden-compatibility
  // proof, not just "one field happens to be absent": reconstructs the
  // pristine pre-#200 (commit 7815901) truthShape literally, using this
  // run's own resolved values, and proves the current legacy-path output
  // has exactly that key set and those values, and therefore hashes
  // identically under the same canonicalize+sha256 algorithm the code
  // itself uses. This must fail if any new key is ever accidentally added
  // to a legacy bundle in the future.
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-golden-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const spec: HistoricalPostgresTaskSpec = {
    taskId: "postgres-historical-001",
    source: { repoPath: repo.repoPath, historicalRevision: repo.ref, referenceRevision: repo.laterRef },
    truth: { upstreamBug: "PostgreSQL #19560", commitFest: 7059 },
    build: { mode: "host" },
    prompt: "Test the supplied PostgreSQL source for a join-planning correctness regression."
  };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  const { bundleHash: _currentBundleHash, ...currentWithoutBundleHash } = task.truthManifest;
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

  // Exact key set: nothing added (behavioralOracle, fixEvidence,
  // fixEvidenceSha256 all correctly absent), nothing missing.
  assert.deepEqual(Object.keys(currentWithoutBundleHash).sort(), Object.keys(pristineShape).sort());
  assert.deepEqual(currentWithoutBundleHash, pristineShape);

  // And hashing the pristine shape with the exact same canonicalize+sha256
  // algorithm the code itself uses reproduces the *actual* bundleHash the
  // current code wrote - not merely "the shapes look equal".
  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)])
      );
    }
    return value;
  }
  const pristineHash = createHash("sha256").update(JSON.stringify(canonicalize(pristineShape), null, 2)).digest("hex");
  assert.equal(pristineHash, task.truthManifest.bundleHash);

  // Locked down explicitly, since Blocking 4 adds new logic near this area:
  // taskDefinitionHash for this legacy input is unaffected by any of it.
  assert.equal(task.taskManifest.hashes.taskDefinition, task.truthManifest.taskDefinitionHash);
});

test("Blocking 4: an oracle-declaring task auto-generates real grader-private fix evidence from the local mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-fixevidence-gen-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const base = historicalPostgres002TaskSpec(repo.repoPath);
  const spec: HistoricalPostgresTaskSpec = { ...base, source: { ...base.source, historicalRevision: repo.ref, referenceRevision: repo.laterRef } };
  const task = await materializeHistoricalPostgresTask(spec, join(root, "case"));

  assert.equal(task.truthManifest.fixEvidence, "expected-behavior/fix-evidence.diff");
  assert.ok(task.truthManifest.fixEvidenceSha256);
  const diffContents = await readFile(join(task.referenceDir, "expected-behavior", "fix-evidence.diff"), "utf8");
  // createSyntheticPostgresSourceRepo's later commit adds FUTURE_FIX.txt -
  // real diff content between the two pinned revisions, not a placeholder.
  assert.ok(diffContents.includes("FUTURE_FIX.txt"));
  assert.ok(diffContents.includes("history after the researched ref"));

  // Moves provenance hashes relative to an equivalent spec whose two
  // revisions produce a *different* diff.
  const differentReferenceRevision = await createAdditionalSyntheticCommit(repo.repoPath, "fix-evidence-hash-movement");
  const otherSpec: HistoricalPostgresTaskSpec = { ...spec, source: { ...spec.source, referenceRevision: differentReferenceRevision } };
  const otherTask = await materializeHistoricalPostgresTask(otherSpec, join(root, "case-different-diff"));
  assert.notEqual(otherTask.truthManifest.fixEvidenceSha256, task.truthManifest.fixEvidenceSha256);
  assert.notEqual(otherTask.truthManifest.bundleHash, task.truthManifest.bundleHash);
  assert.notEqual(otherTask.truthManifest.expectedBehaviorSha256, task.truthManifest.expectedBehaviorSha256);

  // Never appears anywhere under task/ - the auto-generated diff content
  // (which necessarily includes "future" repo content past the historical
  // ref) must stay entirely grader-private.
  const taskFiles = await readTreeAsText(task.taskDir);
  for (const file of taskFiles) {
    assert.ok(!file.text.includes("FUTURE_FIX.txt"), `task/${file.relativePath} leaked fix-evidence diff content`);
    assert.ok(!file.text.includes("fix-evidence.diff"), `task/${file.relativePath} leaked the fix-evidence relative path`);
  }
});

test("Blocking 4: an oracle-declaring task whose referenceRevision cannot be diffed fails materialization loudly, rather than silently omitting fix evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "honeyrail-historical-002-fixevidence-fail-"));
  const repo = await createSyntheticPostgresSourceRepo(root);
  const base = historicalPostgres002TaskSpec(repo.repoPath);
  // A syntactically valid 40-hex SHA that does not exist as an object in
  // this repo - `git diff` against it must fail, and materialization must
  // fail loudly with it, not silently produce fixEvidence: undefined.
  const unresolvableRevision = "000000000000000000000000000000000000dead";
  const spec: HistoricalPostgresTaskSpec = { ...base, source: { ...base.source, historicalRevision: repo.ref, referenceRevision: unresolvableRevision } };
  await assert.rejects(materializeHistoricalPostgresTask(spec, join(root, "case")), /Could not generate grader-private fix\/reference evidence/);
});

/**
 * Given the ordered observation sequence a revision's captured stderr should
 * contain, builds the execution shape `resolveOracleReproduction` reads.
 * `ok`/`exitCode` default to a simple "any observations -> ok" heuristic
 * (irrelevant to the `resolveOracleReproduction`-level tests below, which
 * assert on `.attribution`, not `.reproduced`'s legacy exit-status meaning),
 * but can be overridden explicitly - required for exercising the public
 * self-asserting-reproducer contract at the `gradeHistoricalPostgresSubmission`
 * level: real self-assertion is "ok: true (exit 0) only on the historical
 * ref, ok: false (non-zero) only on the reference ref", independent of how
 * many observations were captured.
 *
 * The default (non-zero) `exitCode` when `ok` is false is `3` - psql's own
 * documented "a SQL/script-level error occurred under ON_ERROR_STOP" status
 * (#200 fourth review round, Blocking 1's exit-code-based validity contract:
 * `1`/`2` are *client/connection*-level failures, never a legitimate
 * self-assertion signal, and would now be misclassified as
 * `infrastructure_error` - only `0`/`3` are SQL-content-driven outcomes).
 */
function executionWithObservations(
  observations: string[],
  options: { ok?: boolean; exitCode?: number | string } = {}
): { ok: boolean; stdout: string; stderr: string; exitCode: number | string; durationMs: number } {
  const stderr = observations.map((message) => `ERROR:  ${message}`).join("\n");
  const ok = options.ok ?? observations.length > 0;
  return { ok, stdout: "", stderr, exitCode: options.exitCode ?? (ok ? 0 : 3), durationMs: 1 };
}

/** An execution shape representing a client/transport/runtime failure - never a SQL-level ERROR record. */
function executionWithInfrastructureFailure(reason: "connect" | "timeout" | "container"): { ok: boolean; stdout: string; stderr: string; exitCode: number | string; durationMs: number } {
  if (reason === "timeout") return { ok: false, stdout: "", stderr: "\ntimed out after 120000ms", exitCode: "ETIMEDOUT", durationMs: 1 };
  if (reason === "container") {
    return { ok: false, stdout: "", stderr: "docker: Error response from daemon: No such container: honeyrail-pg-runtime-abc123.", exitCode: 1, durationMs: 1 };
  }
  return {
    ok: false,
    stdout: "",
    stderr: 'psql: error: connection to server on socket "/tmp/.s.PGSQL.5432" failed: No such file or directory\n\tcould not connect to server',
    exitCode: 2,
    durationMs: 1
  };
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
  assert.equal(correct.attribution?.validity.valid, true);

  // An unrelated error sequence must not earn rediscovery credit just
  // because the script happened to exit non-specifically on this revision.
  const unrelated = resolveOracleReproduction({
    execution: executionWithObservations([baseline, "relation \"missing_table\" does not exist"]),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(unrelated.reproduced, false);
  assert.equal(unrelated.attribution?.attributedTo, "unattributed");
  assert.equal(unrelated.attribution?.validity.valid, true);

  // Wrong *first* observation also fails, even if the second happens to match.
  const wrongFirst = resolveOracleReproduction({
    execution: executionWithObservations(["some other error", "cache lookup failed for function 16386"]),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(wrongFirst.reproduced, false);
  assert.equal(wrongFirst.attribution?.attributedTo, "unattributed");

  // No observations at all on an otherwise-valid execution (e.g. the script
  // never reached a CALL) is a valid, but unmatched/unattributed, execution -
  // not an infrastructure failure.
  const empty = resolveOracleReproduction({
    execution: executionWithObservations([]),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(empty.attribution?.validity.valid, true);
  assert.equal(empty.attribution?.attributedTo, "unattributed");

  // A genuine client/transport/runtime failure is a *different* kind of
  // unattributed: `validity.valid` is false, never conflated with "the
  // script ran fine but didn't match anything" (#200 third review round,
  // Blocking 1).
  const infra = resolveOracleReproduction({
    execution: executionWithInfrastructureFailure("timeout"),
    revision: spec.source.historicalRevision,
    spec
  });
  assert.equal(infra.attribution?.validity.valid, false);
  assert.equal(infra.attribution?.attributedTo, "unattributed");
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

  // `resolveOracleReproduction()` returns only `{reproduced, attribution}` -
  // in production, `defaultGradeRevision()` separately attaches the raw
  // `execution` it captured onto the same observation object. This helper
  // mirrors that composition so the injected `gradeRevision` fixtures below
  // exercise `gradeHistoricalPostgresSubmission()`'s `execution?.ok`-based
  // self-assertion check the same way a real grading run would.
  const gradeRevisionWith =
    (
      selectExecution: (
        revision: string
      ) => ReturnType<typeof executionWithObservations> | ReturnType<typeof executionWithInfrastructureFailure>
    ) =>
    async ({ revision }: { revision: string }) => {
      const execution = selectExecution(revision);
      return { execution, ...resolveOracleReproduction({ execution, revision, spec }) };
    };

  // A real rediscovery: historical matches the stale-plan sequence *and*
  // self-asserts (exit 0); reference matches the baseline-twice sequence
  // *and* self-asserts (non-zero) - both the behavioral oracle and the
  // public self-asserting-reproducer contract are satisfied.
  const rediscovered = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "rediscovered"),
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithObservations([baseline, "cache lookup failed for function 16386"], { ok: true })
        : executionWithObservations([baseline, baseline], { ok: false })
    )
  });
  assert.equal(rediscovered.status, "rediscovered", JSON.stringify(rediscovered, null, 2));
  // Historical is positively attributed to "historical"; reference is
  // positively attributed to "reference" (the expected/fixed baseline was
  // actually, structurally observed - not merely "didn't match historical").
  assert.equal(rediscovered.historical.attribution?.attributedTo, "historical");
  assert.equal(rediscovered.reference.attribution?.attributedTo, "reference");
  assert.equal(rediscovered.reference.attribution?.referenceMatch.satisfied, true);

  // #200 third review round, Blocking 3: captured text on both sides
  // correctly matches the declared oracle - this would otherwise be
  // `rediscovered` - but the reproducer's own exit status violates the
  // public self-asserting contract (exits non-zero on the historical ref,
  // where it should exit 0). Must not be credited.
  const contractViolation = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "contract-violation"),
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithObservations([baseline, "cache lookup failed for function 16386"], { ok: false })
        : executionWithObservations([baseline, baseline], { ok: false })
    )
  });
  assert.equal(contractViolation.historical.attribution?.attributedTo, "historical");
  assert.equal(contractViolation.reference.attribution?.attributedTo, "reference");
  assert.notEqual(contractViolation.status, "rediscovered", JSON.stringify(contractViolation, null, 2));
  assert.equal(contractViolation.status, "invalid_submission", JSON.stringify(contractViolation, null, 2));
  assert.ok(contractViolation.diagnostics.some((line) => line.includes("self-asserting contract")));

  // Historical-side client/transport/runtime failure must become
  // infrastructure_error, never miss.
  const historicalInfra = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "historical-infra"),
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithInfrastructureFailure("container")
        : executionWithObservations([baseline, baseline], { ok: false })
    )
  });
  assert.equal(historicalInfra.status, "infrastructure_error", JSON.stringify(historicalInfra, null, 2));
  assert.notEqual(historicalInfra.status, "miss");

  // Reference-side client/transport/runtime failure, with historical
  // correctly matching, must also become infrastructure_error - never
  // invalid_submission and never rediscovered.
  const referenceInfra = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "reference-infra"),
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithObservations([baseline, "cache lookup failed for function 16386"], { ok: true })
        : executionWithInfrastructureFailure("timeout")
    )
  });
  assert.equal(referenceInfra.status, "infrastructure_error", JSON.stringify(referenceInfra, null, 2));
  assert.notEqual(referenceInfra.status, "invalid_submission");
  assert.notEqual(referenceInfra.status, "rediscovered");

  // A script that exits 0 on the historical ref and non-zero on the
  // reference ref for an unrelated reason (not the declared oracle) must not
  // be credited: the historical side's oracle is unsatisfied, so this is a
  // miss even though a naive exit-status differential would have called it
  // rediscovered.
  const nonSpecific = await gradeHistoricalPostgresSubmission({
    task: spec,
    workspaceDir: workspace,
    artifactDir: join(root, "non-specific"),
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithObservations(["totally unrelated failure"], { ok: true })
        : executionWithObservations([], { ok: true })
    )
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
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithObservations([baseline, "cache lookup failed for function 16386"], { ok: true })
        : executionWithObservations([baseline, "cache lookup failed for function 55555"], { ok: true })
    )
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
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithObservations([baseline, "cache lookup failed for function 16386"], { ok: true })
        : executionWithObservations(["connection refused by the runtime container"], { ok: false })
    )
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
    gradeRevision: gradeRevisionWith((revision) =>
      revision === spec.source.historicalRevision
        ? executionWithObservations(["unrelated failure"], { ok: true })
        : executionWithObservations([baseline, baseline], { ok: false })
    )
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
