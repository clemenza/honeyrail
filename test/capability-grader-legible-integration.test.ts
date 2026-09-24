import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import {
  GRADER_LEGIBLE_CANDIDATE_INTERVENTION,
  graderLegibleIntervention,
  graderLegibleInterventionHash
} from "../server/capability/grader-legible-intervention.js";
import {
  GraderLegibleIsolationError,
  graderLegibleImageAvailable,
  graderLegibleImageEntrypoint
} from "../server/capability/grader-legible-container.js";
import { dockerAvailable } from "../server/postgres/agent-container.js";
import type { RunCommand } from "../server/postgres/runtime.js";
import {
  GraderLegiblePairingError,
  assertArtifactRootUnused,
  assertPairedTaskSurface,
  runGraderLegibleAttempt,
  runGraderLegiblePairedExperiment,
  type GraderLegibleCandidateProvider
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

// ---------------------------------------------------------------------------
// Isolation (Docker-gated)
//
// These two tests are the only evidence that the isolation claim is true
// rather than merely configured. Everything else in this file asserts on
// structures the harness itself produced; only a probe from inside the
// container can distinguish "we passed the right -v flags" from "the harness's
// private material is actually unreachable". They are skipped - never pulled -
// when the daemon or the stub image is absent, matching this repo's
// no-implicit-pull rule. See docker/capability-grader-legible-agent-stub/.
// ---------------------------------------------------------------------------

const STUB_AGENT_IMAGE = "honeyrail-cap-glo-agent-stub:latest";

/** Returns a skip reason, or `null` when the containerized path can actually run. */
async function isolationSkipReason(): Promise<string | null> {
  if (!(await dockerAvailable())) return "docker daemon is unavailable; skipping the containerized isolation path";
  if (!(await graderLegibleImageAvailable(STUB_AGENT_IMAGE))) {
    return `${STUB_AGENT_IMAGE} is not present locally; build it with \`docker build -t ${STUB_AGENT_IMAGE} docker/capability-grader-legible-agent-stub\` (this repo never pulls)`;
  }
  return null;
}

/**
 * The stub image's entrypoint is `stub-agent <fixture> [args...]`, and the
 * invocation is spelled out here rather than taken from
 * `referenceCandidates.good`: that field is the grader's own reference
 * solution, and a stub that read it would "solve" the task without the
 * container surface working at all. This is cap-glo-002's public
 * discriminating invocation, the one its brief asks an agent to find.
 */
const CAP_GLO_002_INVOCATION = ["read", "adjusted"] as const;

/** The value the fixture only prints for the discriminating invocation. Grader-private; never in the container. */
const CAP_GLO_002_PRIVATE_VALUE = "1007";

function stubAgentProvider(fixtureCommand: string, args: readonly string[]): GraderLegibleCandidateProvider {
  return {
    kind: "command",
    label: "command:stub-agent (isolation probe)",
    command: fixtureCommand,
    args: [...args],
    timeoutMs: 120_000,
    isolation: { image: STUB_AGENT_IMAGE, network: "none" }
  };
}

test("an agent confined to the container can still solve the task", async (t) => {
  const reason = await isolationSkipReason();
  if (reason) return t.skip(reason);

  const archetype = graderLegibleArchetype("cap-glo-002");
  const attempt = await runGraderLegibleAttempt({
    archetype,
    condition: "candidate",
    provider: stubAgentProvider(archetype.fixtureCommand, CAP_GLO_002_INVOCATION),
    artifactDir: await scratch(),
    attemptId: "cap-glo-isolation:candidate:cap-glo-002",
    archetypeSet: [archetype]
  });

  // Sufficiency, not just confinement: the fixture is not in the container at
  // all, so this passes only if the facade actually carried the invocation to
  // the host and the real output back. If the mounted surface were too thin
  // every capability miss under isolation would be uninterpretable.
  assert.equal(attempt.status, "completed", attempt.diagnostics.join(" | "));
  assert.equal(attempt.grade?.result, "grader_legible", attempt.diagnostics.join(" | "));
  // The positive half of both launch signals: a container that did start and an
  // agent that did launch say so from inside, so the flags distinguish outcomes
  // rather than being uniformly false and vacuously safe.
  assert.equal(attempt.telemetry.isolationEstablished, true);
  assert.equal(attempt.telemetry.agentExecutionEstablished, true);
});

test("a container that never starts is an isolation failure, not an invalid submission", async (t) => {
  const reason = await isolationSkipReason();
  if (reason) return t.skip(reason);

  const archetype = graderLegibleArchetype("cap-glo-002");
  const artifactRoot = await scratch();
  // A valid, locally-present image on a network that does not exist. `docker
  // run` then fails while *creating* the container, before any agent process
  // exists - and leaves behind exactly what "the agent ran and submitted
  // nothing" leaves behind. Before the marker, the report scored this as
  // `agent_invalid_submission` and still called itself capability evidence.
  const report = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-isolation-not-established",
    artifactRoot,
    archetypes: [archetype],
    submissionTimeoutMs: 5_000,
    provider: {
      kind: "command",
      label: "command:stub-agent (unreachable network)",
      command: archetype.fixtureCommand,
      args: [...CAP_GLO_002_INVOCATION],
      timeoutMs: 60_000,
      isolation: { image: STUB_AGENT_IMAGE, network: "honeyrail-cap-glo-network-that-does-not-exist" },
      realAgentIdentity: {
        model: "test-model-1",
        agentName: "test-agent",
        agentVersion: "0.0.0-test",
        commandIdentity: "agent-bin",
        repositoryCommit: "0000000000000000000000000000000000000000"
      }
    }
  });

  assert.ok(report.attempts.length > 0, "the run should have produced attempts");
  for (const attempt of report.attempts) {
    const context = attempt.diagnostics.join(" | ");
    assert.equal(attempt.telemetry.isolationEstablished, false, context);
    // No container, so no agent either. Asserted so the two flags cannot both
    // collapse into one signal that happens to be set by whichever ran first.
    assert.notEqual(attempt.telemetry.agentExecutionEstablished, true, context);
    // The attribution that matters: blaming the agent for a failure of the
    // harness's own infrastructure is how a broken run becomes a capability
    // number.
    assert.equal(attempt.primaryCause, "isolation_or_integrity", context);
    assert.equal(attempt.status, "infrastructure_error", context);
  }

  // No agent ran, so nothing can have been submitted. A `reproducer.sh` here
  // would mean the workspace was written by something other than the agent.
  for (const attempt of report.attempts) {
    const entries = await readdir(join(attempt.artifactDir, "workspace"));
    assert.ok(!entries.includes("reproducer.sh"), `a submission appeared without any agent: ${entries.join(", ")}`);
  }

  // Driven through the paired experiment, not a bare attempt: the eligibility
  // gate is a property of the report, and it is the thing that previously let
  // a run with zero established containers present itself as evidence.
  assert.equal(report.capabilityEvidenceEligible, false);
});

// ---------------------------------------------------------------------------
// Entrypoint inspection fails closed (no Docker: the reader is injected)
// ---------------------------------------------------------------------------

test("reading an image entrypoint distinguishes 'declares none' from 'could not find out'", async () => {
  const inspect = (record: unknown): RunCommand => async () => ({
    ok: true,
    stdout: `${JSON.stringify([record])}\n`,
    stderr: "",
    code: 0
  });

  // A genuinely absent entrypoint is `[]`, and stays `[]`: the wrapper then
  // execs `provider.command` directly, which is correct for such an image.
  assert.deepEqual(await graderLegibleImageEntrypoint("img", inspect({ Config: { Entrypoint: null } })), []);
  assert.deepEqual(await graderLegibleImageEntrypoint("img", inspect({ Config: {} })), []);
  assert.deepEqual(
    await graderLegibleImageEntrypoint("img", inspect({ Config: { Entrypoint: ["/bin/agent", "--serve"] } })),
    ["/bin/agent", "--serve"]
  );

  // Everything below used to also return `[]`, which silently dropped the
  // image's declared entrypoint and ran `provider.command` as its own program -
  // a different agent than the operator configured, reported as the configured
  // one. Each must now be loud.
  const failures: RunCommand[] = [
    async () => ({ ok: false, stdout: "", stderr: "Error: No such image: img\n", code: 1 }),
    async () => ({ ok: true, stdout: "not json at all\n", stderr: "", code: 0 }),
    async () => ({ ok: true, stdout: "[]\n", stderr: "", code: 0 }),
    inspect({ Config: { Entrypoint: "/bin/agent --serve" } }),
    inspect({ Config: { Entrypoint: ["/bin/agent", 7] } })
  ];
  for (const runCommand of failures) {
    await assert.rejects(graderLegibleImageEntrypoint("img", runCommand), GraderLegibleIsolationError);
  }
});

/**
 * The launch-attribution tests below need an image that declares *no*
 * entrypoint, because the wrapper checks the program it is actually about to
 * exec - which, for an image with an ENTRYPOINT, is the entrypoint, and
 * `provider.command` is only an argument to it. Against the stub agent a bogus
 * `command` therefore still launches the stub. This second tag from the same
 * Dockerfile makes `provider.command` the exec target itself.
 */
const NO_ENTRYPOINT_STUB_IMAGE = "honeyrail-cap-glo-no-entrypoint-stub:latest";

async function noEntrypointSkipReason(): Promise<string | null> {
  if (!(await dockerAvailable())) return "docker daemon is unavailable; skipping the containerized isolation path";
  if (!(await graderLegibleImageAvailable(NO_ENTRYPOINT_STUB_IMAGE))) {
    return (
      `${NO_ENTRYPOINT_STUB_IMAGE} is not present locally; build it with ` +
      `\`docker build --target no-entrypoint -t ${NO_ENTRYPOINT_STUB_IMAGE} docker/capability-grader-legible-agent-stub\` ` +
      "(this repo never pulls)"
    );
  }
  return null;
}

function launchProvider(command: string, args: readonly string[], label: string, timeoutMs: number): GraderLegibleCandidateProvider {
  return {
    kind: "command",
    label,
    command,
    args: [...args],
    timeoutMs,
    isolation: { image: NO_ENTRYPOINT_STUB_IMAGE, network: "none" },
    realAgentIdentity: {
      model: "test-model-1",
      agentName: "test-agent",
      agentVersion: "0.0.0-test",
      commandIdentity: "agent-bin",
      repositoryCommit: "0000000000000000000000000000000000000000"
    }
  };
}

test("an agent executable that never launches is an infrastructure failure, not an invalid submission", async (t) => {
  const reason = await noEntrypointSkipReason();
  if (reason) return t.skip(reason);

  // The container starts fine - valid image, valid network - and then the
  // configured command does not exist inside it. `exec` fails *after* the
  // container-started marker, so the shell exits 127 with no timeout and no
  // spawn error the host can see: before the second marker this was
  // indistinguishable from an agent that ran and submitted nothing, and the
  // report still called it capability evidence.
  const report = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-agent-never-launched",
    artifactRoot: await scratch(),
    archetypes: [graderLegibleArchetype("cap-glo-002")],
    submissionTimeoutMs: 5_000,
    provider: launchProvider(
      "honeyrail-agent-that-does-not-exist",
      [],
      "command:missing-executable (launch probe)",
      60_000
    )
  });

  assert.ok(report.attempts.length > 0, "the run should have produced attempts");
  for (const attempt of report.attempts) {
    const context = attempt.diagnostics.join(" | ");
    // The distinguishing pair: the container did start, the agent did not.
    assert.equal(attempt.telemetry.isolationEstablished, true, context);
    assert.equal(attempt.telemetry.agentExecutionEstablished, false, context);
    assert.equal(attempt.status, "infrastructure_error", context);
    assert.equal(attempt.primaryCause, "infrastructure", context);

    // No agent process existed, so nothing can have been submitted.
    const entries = await readdir(join(attempt.artifactDir, "workspace"));
    assert.ok(!entries.includes("reproducer.sh"), `a submission appeared without any agent: ${entries.join(", ")}`);
  }

  // Driven through the paired experiment, because the eligibility gate is a
  // property of the report and that is what previously mislabelled this run.
  assert.equal(report.capabilityEvidenceEligible, false);
});

test("an agent that launches and submits nothing is still the agent's own outcome", async (t) => {
  const reason = await noEntrypointSkipReason();
  if (reason) return t.skip(reason);

  // The control for the test above: `/bin/true` exists, so it launches, runs and
  // exits 0 without writing a submission. Both markers are set, so the new check
  // must not fire - otherwise it would relabel every real capability miss as
  // infrastructure and empty the denominator.
  const attempt = await runGraderLegibleAttempt({
    archetype: graderLegibleArchetype("cap-glo-002"),
    condition: "candidate",
    provider: launchProvider("/bin/true", [], "command:/bin/true (launch control)", 60_000),
    artifactDir: await scratch(),
    attemptId: "cap-glo-launched-no-submission:candidate:cap-glo-002",
    archetypeSet: [graderLegibleArchetype("cap-glo-002")]
  });

  const context = attempt.diagnostics.join(" | ");
  assert.equal(attempt.telemetry.isolationEstablished, true, context);
  assert.equal(attempt.telemetry.agentExecutionEstablished, true, context);
  assert.equal(attempt.status, "invalid_submission", context);
  assert.equal(attempt.primaryCause, "agent_invalid_submission", context);
});

test("an isolated agent that exceeds its budget is a resource limit, not a launch failure", async (t) => {
  const reason = await noEntrypointSkipReason();
  if (reason) return t.skip(reason);

  // An agent that launched and then hung has both markers set, so the timeout
  // attribution has to survive the new check: this stays the agent's spent
  // budget rather than becoming an infrastructure failure.
  const attempt = await runGraderLegibleAttempt({
    archetype: graderLegibleArchetype("cap-glo-002"),
    condition: "candidate",
    provider: launchProvider("/bin/sleep", ["120"], "command:/bin/sleep (timeout probe)", 5_000),
    artifactDir: await scratch(),
    attemptId: "cap-glo-isolated-timeout:candidate:cap-glo-002",
    archetypeSet: [graderLegibleArchetype("cap-glo-002")]
  });

  const context = attempt.diagnostics.join(" | ");
  assert.equal(attempt.telemetry.isolationEstablished, true, context);
  assert.equal(attempt.telemetry.agentExecutionEstablished, true, context);
  assert.equal(attempt.telemetry.agentTimedOut, true, context);
  assert.equal(attempt.primaryCause, "agent_resource_limit", context);
  assert.equal(attempt.status, "infrastructure_error", context);
});

test("the container exposes the facade and nothing of the fixture, the manifest or the grader-owned state", async (t) => {
  const reason = await isolationSkipReason();
  if (reason) return t.skip(reason);

  const archetype = graderLegibleArchetype("cap-glo-002");
  const artifactDir = await scratch();
  const attempt = await runGraderLegibleAttempt({
    archetype,
    condition: "candidate",
    provider: stubAgentProvider(archetype.fixtureCommand, CAP_GLO_002_INVOCATION),
    artifactDir,
    attemptId: "cap-glo-isolation:candidate:cap-glo-002",
    archetypeSet: [archetype]
  });

  const workspace = join(artifactDir, "workspace");
  const probes = JSON.parse(await readFile(join(workspace, "probe-results.json"), "utf8")) as Record<string, unknown>;
  // Graded grader-legible, so the agent-visible surface really worked: every
  // "absent" below reads as "unreachable", not as "the container was broken
  // and nothing worked".
  assert.equal(attempt.grade?.result, "grader_legible", attempt.diagnostics.join(" | "));
  assert.equal(attempt.status, "completed", attempt.diagnostics.join(" | "));

  // The agent's PATH entry is readable - and is the generic facade client.
  // Round 2 mounted the real fixture here read-only, so `cat "$(command -v
  // meter)"` printed the discriminating branch and ended the task.
  assert.equal(probes.pathEntry, "/workspace/bin/meter");
  assert.equal(probes.pathEntryReadable, "readable");
  const pathEntrySource = await readFile(join(workspace, "path-entry-source.txt"), "utf8");
  assert.ok(pathEntrySource.includes("facade"), "the PATH entry should be the facade client");
  assert.ok(
    !pathEntrySource.includes(CAP_GLO_002_PRIVATE_VALUE),
    `the PATH entry leaks the private discriminating value: ${pathEntrySource}`
  );
  assert.ok(!pathEntrySource.includes("HONEYRAIL_FIXTURE_STATE"), "the PATH entry leaks the fixture's own protocol");
  for (const archetypeArg of CAP_GLO_002_INVOCATION) {
    assert.ok(!pathEntrySource.includes(`${archetypeArg})`), "the PATH entry leaks the fixture's branch structure");
  }

  // The channel carries request/response files, the harness's two launch markers
  // and never fixture source. The markers are the harness's own: the wrapper
  // touches one before looking for the agent and one immediately before
  // exec'ing it, which is how the host learns a container really ran and that
  // the agent really launched, so the agent necessarily sees both here.
  const facadeListing = await readFile(join(workspace, "facade-listing.txt"), "utf8");
  for (const entry of facadeListing.split("\n").filter((line) => line.trim() && line.trim() !== "." && line.trim() !== "..")) {
    assert.match(
      entry.trim(),
      /(\.(request|response)\.(json|tmp)|^container-started\.marker|^agent-exec\.marker)$/,
      `unexpected entry in the facade channel: ${entry}`
    );
  }
  assert.ok(!facadeListing.includes(CAP_GLO_002_PRIVATE_VALUE));

  // The harness's private material, by every spelling an agent could try.
  assert.equal(probes.fixtureSource, "absent");
  assert.equal(probes.fixtureSourceAbsolute, "absent");
  assert.equal(probes.archetypeManifest, "absent");
  assert.equal(probes.archetypeManifestAbsolute, "absent");
  assert.equal(probes.graderStateLog, "absent");
  assert.equal(probes.graderStateDir, "absent");
  assert.equal(probes.graderRunsDir, "absent");
});

// ---------------------------------------------------------------------------
// Evidence retention: a used artifact root is refused before any mutation
// ---------------------------------------------------------------------------

test("a run into an occupied artifact root is refused before the provider or materialization is reached", async () => {
  const artifactRoot = await scratch();
  const staleWorkspace = join(artifactRoot, "candidate", "cap-glo-002", "workspace");
  await mkdir(staleWorkspace, { recursive: true });
  const stalePath = join(staleWorkspace, GRADER_LEGIBLE_SUBMISSION_FILENAME);
  await writeFile(stalePath, "#!/bin/sh\n# retained evidence from an earlier run\n");
  const before = await readFile(stalePath);

  let providerCalls = 0;
  const archetype = graderLegibleArchetype("cap-glo-002");
  await assert.rejects(
    runGraderLegiblePairedExperiment({
      experimentId: "cap-glo-occupied-root",
      artifactRoot,
      archetypes: [archetype],
      provider: {
        kind: "scripted",
        label: "scripted:should-never-run",
        script: (candidate) => {
          providerCalls += 1;
          return candidate.referenceCandidates.good;
        }
      }
    }),
    GraderLegiblePairingError
  );

  // The point of failing closed is that nothing was touched, so the check has
  // to be that the bytes survived - not merely that an error was thrown.
  assert.equal(providerCalls, 0);
  assert.deepEqual(await readFile(stalePath), before);
});

test("a refused run creates no new attempt directory under the occupied root", async () => {
  const artifactRoot = await scratch();
  await mkdir(join(artifactRoot, "candidate", "cap-glo-002", "workspace"), { recursive: true });
  await writeFile(join(artifactRoot, "candidate", "cap-glo-002", "workspace", GRADER_LEGIBLE_SUBMISSION_FILENAME), "stale\n");

  await assert.rejects(
    runGraderLegiblePairedExperiment({
      experimentId: "cap-glo-occupied-root",
      artifactRoot,
      archetypes: [graderLegibleArchetype("cap-glo-002")],
      provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER
    }),
    GraderLegiblePairingError
  );

  // Materialization runs per attempt, so a `baseline/` here would mean the
  // refusal happened after the first attempt had already written to disk.
  assert.deepEqual((await readdir(artifactRoot)).sort(), ["candidate"]);
  assert.deepEqual((await readdir(join(artifactRoot, "candidate"))).sort(), ["cap-glo-002"]);
});

/** Every retained file under `root`, as path -> sha256. The unit of evidence is the byte, not the directory listing. */
async function fingerprintTree(root: string, prefix = ""): Promise<Map<string, string>> {
  const fingerprints = new Map<string, string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [path, hash] of await fingerprintTree(join(root, entry.name), relative)) fingerprints.set(path, hash);
    } else {
      fingerprints.set(relative, createHash("sha256").update(await readFile(join(root, entry.name))).digest("hex"));
    }
  }
  return fingerprints;
}

test("re-running the same experiment into its own artifact root is refused, and its evidence survives byte-for-byte", async () => {
  const artifactRoot = await scratch();
  const archetype = graderLegibleArchetype("cap-glo-002");
  await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-no-rerun",
    artifactRoot,
    archetypes: [archetype],
    provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER
  });
  const before = await fingerprintTree(artifactRoot);
  assert.ok(before.size > 0);

  // Same experiment id, same task subset - the case the removed "matching root"
  // exception used to accept. It deleted and re-created every attempt
  // directory, so a rerun that died halfway left the root holding a mixture of
  // two runs with a report describing neither.
  let providerCalls = 0;
  await assert.rejects(
    runGraderLegiblePairedExperiment({
      experimentId: "cap-glo-no-rerun",
      artifactRoot,
      archetypes: [archetype],
      provider: {
        kind: "scripted",
        label: "scripted:should-never-run",
        script: (candidate) => {
          providerCalls += 1;
          return candidate.referenceCandidates.good;
        }
      }
    }),
    GraderLegiblePairingError
  );

  assert.equal(providerCalls, 0, "the refusal must precede the first provider invocation");
  assert.deepEqual([...(await fingerprintTree(artifactRoot))].sort(), [...before].sort());
});

test("the artifact-root preflight refuses any non-empty root, whatever it holds", async () => {
  const artifactRoot = await scratch();
  await assertArtifactRootUnused(artifactRoot);
  // Not an attempt directory, not a report - the rule is "unused", so there is
  // no shape of pre-existing content that reads as safe to write over.
  await writeFile(join(artifactRoot, "unrelated-note.txt"), "someone else's file\n");
  await assert.rejects(assertArtifactRootUnused(artifactRoot), GraderLegiblePairingError);
});

test("a legitimate retry uses a fresh root and leaves its predecessor's evidence untouched", async () => {
  const firstRoot = await scratch();
  const archetype = graderLegibleArchetype("cap-glo-002");
  const first = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-retry-001",
    artifactRoot: firstRoot,
    archetypes: [archetype],
    provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER
  });
  const before = await fingerprintTree(firstRoot);

  const second = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-retry-002",
    artifactRoot: await scratch(),
    archetypes: [archetype],
    provider: SCRIPTED_GRADER_LEGIBLE_PROVIDER
  });

  // The retry is a complete, comparable run in its own right - refusing reruns
  // costs a directory, not the ability to run the experiment again.
  assert.equal(second.pairedTaskSurfaceHash, first.pairedTaskSurfaceHash);
  assert.equal(second.archetypeSetHash, first.archetypeSetHash);
  assert.deepEqual(
    second.conditions.map((condition) => condition.graderLegible),
    first.conditions.map((condition) => condition.graderLegible)
  );
  assert.deepEqual([...(await fingerprintTree(firstRoot))].sort(), [...before].sort());
});

// ---------------------------------------------------------------------------
// Attribution and rate arithmetic
// ---------------------------------------------------------------------------

test("an agent that exhausts its budget is attributed to a resource limit, not to an invalid submission", async () => {
  const attempt = await runGraderLegibleAttempt({
    archetype: graderLegibleArchetype("cap-glo-002"),
    condition: "candidate",
    provider: {
      kind: "command",
      label: "command:sleep (budget exhaustion)",
      command: "/bin/sh",
      args: ["-c", "sleep 30"],
      timeoutMs: 400
    },
    artifactDir: await scratch(),
    attemptId: "cap-glo-timeout:candidate:cap-glo-002",
    archetypeSet: [graderLegibleArchetype("cap-glo-002")]
  });

  // Status alone cannot carry this: a timed-out agent and an agent that simply
  // wrote nothing both end with no submission on disk.
  assert.equal(attempt.primaryCause, "agent_resource_limit");
  assert.equal(attempt.telemetry.agentTimedOut, true);
  assert.equal(attempt.grade, null);
});

test("end-to-end budget success and conditional rediscovery are computed over different denominators", async () => {
  const archetypes = [graderLegibleArchetype("cap-glo-001"), graderLegibleArchetype("cap-glo-002")];
  const report = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-rate-arithmetic",
    artifactRoot: await scratch(),
    archetypes,
    provider: {
      kind: "scripted",
      label: "scripted:one-submission-missing",
      // An empty submission never reaches the grader, so it lands in A but not
      // in E - exactly the attempt D/E would silently discard.
      script: (archetype, condition) => (archetype.archetypeId === "cap-glo-001" ? "" : archetype.referenceCandidates.good)
    }
  });

  for (const condition of report.conditions) {
    assert.equal(condition.attempts, 2, condition.condition);
    assert.equal(condition.completed, 1, condition.condition);
    assert.equal(condition.graderLegible, 1, condition.condition);
    assert.equal(condition.graderLegibleRate, 1, `D/E for ${condition.condition}`);
    assert.equal(condition.endToEndBudgetSuccessRate, 0.5, `D/A for ${condition.condition}`);
    assert.equal(
      Object.values(condition.causeCounts).reduce((sum, count) => sum + count, 0),
      condition.attempts,
      `cause counts must sum to A for ${condition.condition}`
    );
    assert.equal(condition.causeCounts.completed_success, 1, condition.condition);
    assert.equal(condition.causeCounts.agent_invalid_submission, 1, condition.condition);
  }
});

// ---------------------------------------------------------------------------
// Capability eligibility and identity
// ---------------------------------------------------------------------------

test("a command provider without isolation or a declared identity is not capability evidence", async () => {
  const report = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-bare-command",
    artifactRoot: await scratch(),
    archetypes: [graderLegibleArchetype("cap-glo-002")],
    provider: { kind: "command", label: "command:/usr/bin/true", command: "/usr/bin/true", timeoutMs: 10_000 }
  });

  // "It was a real process" was never the bar: an unisolated, unattributed
  // command tells you nothing about which agent produced the number.
  assert.equal(report.capabilityEvidenceEligible, false);
  assert.equal(report.realAgentIdentity, null);
});

test("a run that claims isolation is refused before any attempt when the image is absent", async () => {
  const artifactRoot = await scratch();
  await assert.rejects(
    runGraderLegiblePairedExperiment({
      experimentId: "cap-glo-missing-image",
      artifactRoot,
      archetypes: [graderLegibleArchetype("cap-glo-002")],
      provider: {
        kind: "command",
        label: "command:absent-image",
        command: "/usr/bin/true",
        timeoutMs: 5_000,
        isolation: { image: "honeyrail-cap-glo-does-not-exist:never-built", network: "none" }
      }
    }),
    // Any error will do for the caller; what matters is that it arrives before
    // the run can produce a report that claims isolation it never had.
    (error: unknown) => error instanceof Error
  );
  // Nothing was materialized, so no attempt ran: the image check is a preflight
  // and not a per-attempt failure that a report could average away.
  assert.deepEqual(await readdir(artifactRoot), []);
});

test("a declared, isolated command provider is eligible and its retained identity carries no secrets", async (t) => {
  const reason = await isolationSkipReason();
  if (reason) return t.skip(reason);

  const secretMarker = "cap-glo-test-secret-a7f3e1d9";
  const report = await runGraderLegiblePairedExperiment({
    experimentId: "cap-glo-declared-identity",
    artifactRoot: await scratch(),
    archetypes: [graderLegibleArchetype("cap-glo-002")],
    submissionTimeoutMs: 5_000,
    provider: {
      kind: "command",
      label: "command:declared",
      command: "/usr/bin/true",
      env: { HONEYRAIL_TEST_API_KEY: secretMarker },
      timeoutMs: 5_000,
      isolation: { image: STUB_AGENT_IMAGE, network: "none" },
      realAgentIdentity: {
        model: "test-model-1",
        agentName: "test-agent",
        agentVersion: "0.0.0-test",
        // Absolute, with a directory name that must not survive into evidence.
        commandIdentity: "/home/operator/private-tooling/agent-bin",
        repositoryCommit: "0000000000000000000000000000000000000000"
      }
    }
  });

  assert.equal(report.capabilityEvidenceEligible, true);
  // The image id is resolved, not declared: a tag is mutable, so a retained
  // report that named only the tag would stop identifying the agent the moment
  // the operator rebuilt it.
  assert.match(String(report.realAgentIdentity?.resolvedImageId), /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(report.realAgentIdentity, {
    imageReference: STUB_AGENT_IMAGE,
    resolvedImageId: report.realAgentIdentity?.resolvedImageId,
    network: "none",
    provider: "command",
    model: "test-model-1",
    agentName: "test-agent",
    agentVersion: "0.0.0-test",
    isolationPolicy: "docker",
    // Basename only: the operator's directory layout is not part of who the
    // agent was, and retained evidence is shared more widely than the host is.
    commandIdentity: "agent-bin",
    repositoryCommit: "0000000000000000000000000000000000000000",
    enforcedBudgets: { agentTimeoutMs: 5_000, submissionTimeoutMs: 5_000 }
  });
  // The provider environment is the obvious place for a credential, so the
  // report must never have copied it anywhere - not into identity, not into a
  // diagnostic, not into a telemetry echo.
  assert.equal(JSON.stringify(report).includes(secretMarker), false);
});

// ---------------------------------------------------------------------------
// Paired surface and frozen intervention regressions
// ---------------------------------------------------------------------------

test("the paired task-surface comparison sees divergence inside nested subdirectories", async () => {
  const archetype = graderLegibleArchetype("cap-glo-003");
  const baseline = await materializeGraderLegibleArchetype(archetype, await scratch(), graderLegibleIntervention("baseline"), [archetype]);
  const candidate = await materializeGraderLegibleArchetype(archetype, await scratch(), graderLegibleIntervention("candidate"), [archetype]);

  // Identical nested content: still paired. A hash that only walked the top
  // level would also pass here, which is why the divergent case below matters.
  for (const layout of [baseline, candidate]) {
    await mkdir(join(layout.workspaceDir, "notes", "deep"), { recursive: true });
    await writeFile(join(layout.workspaceDir, "notes", "deep", "context.md"), "shared\n");
  }
  await assertPairedTaskSurface(baseline.workspaceDir, candidate.workspaceDir);

  await writeFile(join(candidate.workspaceDir, "notes", "deep", "context.md"), "candidate-only hint\n");
  await assert.rejects(
    assertPairedTaskSurface(baseline.workspaceDir, candidate.workspaceDir),
    GraderLegiblePairingError
  );
});

test("the candidate intervention still matches its recorded hash and the frozen corpus artifact", async () => {
  const live = graderLegibleIntervention("candidate");
  assert.equal(live.interventionId, GRADER_LEGIBLE_CANDIDATE_INTERVENTION.interventionId);
  assert.equal(live.interventionHash, graderLegibleInterventionHash(live.interventionId, live.body));

  // The frozen artifact is what an unseen-family run would receive, so a body
  // edit that forgot to re-freeze must fail here rather than silently produce
  // "validated the frozen intervention" for a different text.
  const frozen = JSON.parse(
    await readFile(new URL("../corpus/capability-grader-legible-intervention-v1.json", import.meta.url), "utf8")
  ) as { intervention: { interventionId: string; interventionHash: string; body: string } };
  assert.equal(frozen.intervention.interventionId, live.interventionId);
  assert.equal(frozen.intervention.interventionHash, live.interventionHash);
  assert.equal(frozen.intervention.body, live.body);
});
