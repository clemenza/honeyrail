import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GRADER_LEGIBLE_ARCHETYPES,
  graderLegibleArchetype
} from "../server/capability/grader-legible-archetypes.js";
import {
  GRADER_LEGIBLE_SUBMISSION_FILENAME,
  materializeGraderLegibleArchetype,
  readGraderLegibleInvocationLog,
  validateGraderLegibleSubmission
} from "../server/capability/grader-legible-fixture.js";
import { graderLegibleIntervention } from "../server/capability/grader-legible-intervention.js";
import {
  GraderLegiblePairingError,
  assertPairedTaskSurface,
  runGraderLegibleAttempt,
  runGraderLegiblePairedExperiment
} from "../server/capability/grader-legible-run.js";
import {
  SCRIPTED_GRADER_LEGIBLE_PROVIDER,
  SCRIPTED_PAIRED_DEMONSTRATION_PROVIDER,
  SCRIPTED_SELF_ASSERTING_PROVIDER
} from "../server/capability/grader-legible-scripted-agents.js";

const scratch = () => mkdtemp(join(tmpdir(), "honeyrail-cap-glo-"));

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

test("materialization exposes only public material in the agent-visible workspace", async () => {
  for (const archetype of GRADER_LEGIBLE_ARCHETYPES) {
    const layout = await materializeGraderLegibleArchetype(archetype, await scratch(), graderLegibleIntervention("candidate"));
    const visible = (
      await Promise.all(
        ["BRIEF.md", "SUBMISSION-CONTRACT.md", "INTERVENTION.md"].map((name) => readFile(join(layout.workspaceDir, name), "utf8"))
      )
    ).join("\n");

    const secrets: string[] = [];
    if (archetype.observationContract.stdout.mode === "exact-lines") secrets.push(...archetype.observationContract.stdout.lines);
    if (archetype.observationContract.stderr.mode === "contains-exact-line") secrets.push(archetype.observationContract.stderr.line);
    for (const secret of secrets) {
      assert.ok(!visible.includes(secret), `${archetype.archetypeId} workspace leaks ${JSON.stringify(secret)}`);
    }
    // The failure class names the very mistake under test; it stays operator-side.
    assert.ok(!visible.includes(archetype.failureClass), `${archetype.archetypeId} workspace leaks its failure class`);

    const manifest = JSON.parse(await readFile(layout.manifestPath, "utf8"));
    assert.equal(manifest.archetypeId, archetype.archetypeId);
    assert.equal(typeof manifest.observationContractHash, "string");
    assert.ok(!Object.prototype.hasOwnProperty.call(manifest, "observationContract"));
  }
});

test("the baseline condition materializes no intervention file", async () => {
  const archetype = graderLegibleArchetype("cap-glo-001");
  const layout = await materializeGraderLegibleArchetype(archetype, await scratch(), graderLegibleIntervention("baseline"));
  await assert.rejects(readFile(join(layout.workspaceDir, "INTERVENTION.md"), "utf8"));
});

// ---------------------------------------------------------------------------
// End-to-end grading of the reference shapes, per archetype
// ---------------------------------------------------------------------------

for (const archetype of GRADER_LEGIBLE_ARCHETYPES) {
  test(`${archetype.archetypeId}: the grader-legible shape passes`, async () => {
    const attempt = await runGraderLegibleAttempt({
      archetype,
      condition: "candidate",
      provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER,
      artifactDir: await scratch(),
      attemptId: `good:${archetype.archetypeId}`
    });
    assert.equal(attempt.status, "completed", JSON.stringify(attempt.diagnostics));
    assert.equal(attempt.grade?.result, "grader_legible", JSON.stringify(attempt.grade?.diagnostics));
    assert.equal(attempt.grade?.secondary.discriminatingExperimentPerformed, true);
    assert.equal(attempt.grade?.secondary.deterministicExternalOutput, true);
  });

  test(`${archetype.archetypeId}: the bad-but-plausible shape fails as a capability miss, not infrastructure`, async () => {
    const attempt = await runGraderLegibleAttempt({
      archetype,
      condition: "baseline",
      provider: SCRIPTED_SELF_ASSERTING_PROVIDER,
      artifactDir: await scratch(),
      attemptId: `bad:${archetype.archetypeId}`
    });
    assert.equal(attempt.status, "completed");
    assert.equal(attempt.grade?.result, "not_grader_legible", JSON.stringify(attempt.grade));
    assert.notEqual(attempt.grade?.failureStage, "infrastructure");
    assert.equal(attempt.grade?.secondary.discriminatingExperimentPerformed, true);
  });
}

test("the nondeterministic-shape archetype's bad shape is attributed to nondeterminism specifically", async () => {
  const attempt = await runGraderLegibleAttempt({
    archetype: graderLegibleArchetype("cap-glo-006"),
    condition: "baseline",
    provider: SCRIPTED_SELF_ASSERTING_PROVIDER,
    artifactDir: await scratch(),
    attemptId: "bad:006"
  });
  assert.equal(attempt.grade?.failureStage, "nondeterministic_output");
});

test("raw observations are retained outside the agent for every execution", async () => {
  const archetype = graderLegibleArchetype("cap-glo-001");
  const artifactDir = await scratch();
  const attempt = await runGraderLegibleAttempt({
    archetype,
    condition: "candidate",
    provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER,
    artifactDir,
    attemptId: "retention:001"
  });
  assert.equal(attempt.telemetry.executionsCaptured, 2);
  for (const index of [0, 1]) {
    const runDir = join(artifactDir, "runs", String(index));
    assert.equal((await readFile(join(runDir, "exit-status.txt"), "utf8")).trim(), "3");
    assert.match(await readFile(join(runDir, "stderr.txt"), "utf8"), /LEDGER-E0412/);
  }
  const invocations = await readGraderLegibleInvocationLog(join(artifactDir, "state"));
  assert.ok(invocations.includes("commit beta"));
  const persisted = JSON.parse(await readFile(join(artifactDir, "attempt.json"), "utf8"));
  assert.equal(persisted.attemptId, "retention:001");
  assert.equal(persisted.grade.result, "grader_legible");
});

// ---------------------------------------------------------------------------
// Non-capability outcomes stay separable
// ---------------------------------------------------------------------------

test("a missing submission is an invalid submission, not a capability miss", async () => {
  const attempt = await runGraderLegibleAttempt({
    archetype: graderLegibleArchetype("cap-glo-003"),
    condition: "baseline",
    provider: { kind: "scripted", label: "scripted:no-op", script: () => "" },
    artifactDir: await scratch(),
    attemptId: "empty:003"
  });
  assert.equal(attempt.status, "invalid_submission");
  assert.equal(attempt.grade, null);
});

test("a submission that exceeds its execution budget is an infrastructure outcome", async () => {
  const attempt = await runGraderLegibleAttempt({
    archetype: graderLegibleArchetype("cap-glo-003"),
    condition: "baseline",
    provider: { kind: "scripted", label: "scripted:hang", script: () => "#!/bin/sh\nsleep 30\n" },
    artifactDir: await scratch(),
    attemptId: "hang:003",
    submissionTimeoutMs: 250
  });
  assert.equal(attempt.status, "infrastructure_error");
  assert.equal(attempt.grade?.result, "invalid_execution");
  assert.equal(attempt.grade?.failureStage, "infrastructure");
});

test("an agent command that cannot start is an infrastructure outcome", async () => {
  const attempt = await runGraderLegibleAttempt({
    archetype: graderLegibleArchetype("cap-glo-003"),
    condition: "baseline",
    provider: { kind: "command", label: "command:missing", command: "honeyrail-no-such-agent-binary", timeoutMs: 5_000 },
    artifactDir: await scratch(),
    attemptId: "nostart:003"
  });
  assert.equal(attempt.status, "infrastructure_error");
  assert.equal(attempt.grade, null);
});

test("an oversized submission is an integrity error", async () => {
  const layout = await materializeGraderLegibleArchetype(
    graderLegibleArchetype("cap-glo-003"),
    await scratch(),
    graderLegibleIntervention("baseline")
  );
  await writeFile(join(layout.workspaceDir, GRADER_LEGIBLE_SUBMISSION_FILENAME), "#".repeat(17 * 1024));
  const validation = await validateGraderLegibleSubmission(layout.workspaceDir);
  assert.equal(validation.ok, false);
  assert.equal(validation.ok === false && validation.integrity, true);
});

// ---------------------------------------------------------------------------
// Paired experiment
// ---------------------------------------------------------------------------

test("a paired run keeps one task surface, grades both conditions and refuses to be read as capability evidence", async () => {
  const artifactRoot = await scratch();
  const report = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-harness-validation",
    artifactRoot,
    provider: SCRIPTED_PAIRED_DEMONSTRATION_PROVIDER
  });

  assert.equal(report.capabilityEvidenceEligible, false);
  assert.equal(report.attempts.length, GRADER_LEGIBLE_ARCHETYPES.length * 2);
  assert.equal(report.executionsPerAttempt, 2);

  const baseline = report.conditions.find((condition) => condition.condition === "baseline")!;
  const candidate = report.conditions.find((condition) => condition.condition === "candidate")!;
  assert.equal(baseline.completed, GRADER_LEGIBLE_ARCHETYPES.length);
  assert.equal(candidate.completed, GRADER_LEGIBLE_ARCHETYPES.length);
  assert.equal(baseline.graderLegible, 0);
  assert.equal(candidate.graderLegible, GRADER_LEGIBLE_ARCHETYPES.length);
  assert.equal(candidate.graderLegibleRate, 1);
  assert.deepEqual(baseline.nonCapabilityOutcomes, { invalid_submission: 0, integrity_error: 0, infrastructure_error: 0 });
  // Failure-stage attribution, not just a pass/fail count.
  assert.ok(Object.keys(baseline.failureStages).length > 0);

  const persisted = JSON.parse(await readFile(join(artifactRoot, "experiment-report.json"), "utf8"));
  assert.equal(persisted.experimentId, report.experimentId);
  assert.equal(persisted.pairedTaskSurfaceHash, report.pairedTaskSurfaceHash);
});

test("a rerun into an artifact root holding another experiment is refused", async () => {
  const artifactRoot = await scratch();
  await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-first",
    artifactRoot,
    provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER,
    archetypes: [graderLegibleArchetype("cap-glo-002")]
  });
  await assert.rejects(
    runGraderLegiblePairedExperiment({
      experimentId: "cap-glo-second",
      artifactRoot,
      provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER,
      archetypes: [graderLegibleArchetype("cap-glo-002")]
    }),
    GraderLegiblePairingError
  );
});

test("a diverging task surface fails the pairing check before any comparison is reported", async () => {
  const archetype = graderLegibleArchetype("cap-glo-002");
  const baseline = await materializeGraderLegibleArchetype(archetype, await scratch(), graderLegibleIntervention("baseline"));
  const candidate = await materializeGraderLegibleArchetype(archetype, await scratch(), graderLegibleIntervention("candidate"));
  assert.equal(
    await assertPairedTaskSurface(baseline.workspaceDir, candidate.workspaceDir),
    await assertPairedTaskSurface(candidate.workspaceDir, baseline.workspaceDir)
  );
  await writeFile(join(candidate.workspaceDir, "BRIEF.md"), "an extra hint the baseline never saw\n");
  await assert.rejects(assertPairedTaskSurface(baseline.workspaceDir, candidate.workspaceDir), GraderLegiblePairingError);
});
