import assert from "node:assert/strict";
import test from "node:test";
import {
  GRADER_LEGIBLE_ARCHETYPES,
  GRADER_LEGIBLE_FAILURE_CLASSES,
  graderLegibleArchetype,
  graderLegibleArchetypeHash,
  graderLegibleArchetypeSetHash
} from "../server/capability/grader-legible-archetypes.js";
import { channelLines, gradeGraderLegibleSubmission } from "../server/capability/grader-legible-grader.js";
import {
  GRADER_LEGIBLE_BASELINE_INTERVENTION,
  GRADER_LEGIBLE_CANDIDATE_INTERVENTION,
  GraderLegibleInterventionIntegrityError,
  assertFrozenGraderLegibleIntervention,
  exportFrozenGraderLegibleIntervention,
  graderLegibleIntervention
} from "../server/capability/grader-legible-intervention.js";

// ---------------------------------------------------------------------------
// TRAIN archetype set
// ---------------------------------------------------------------------------

test("archetype set covers each of the six declared output-shape failure classes exactly once", () => {
  const classes = GRADER_LEGIBLE_ARCHETYPES.map((archetype) => archetype.failureClass);
  assert.deepEqual([...classes].sort(), [...GRADER_LEGIBLE_FAILURE_CLASSES].sort());
  assert.equal(new Set(classes).size, GRADER_LEGIBLE_FAILURE_CLASSES.length);
});

test("archetype ids and fixture commands are unique", () => {
  const ids = GRADER_LEGIBLE_ARCHETYPES.map((archetype) => archetype.archetypeId);
  const commands = GRADER_LEGIBLE_ARCHETYPES.map((archetype) => archetype.fixtureCommand);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(commands).size, commands.length);
});

test("every archetype ships a bad-but-plausible and a grader-legible reference shape", () => {
  for (const archetype of GRADER_LEGIBLE_ARCHETYPES) {
    assert.ok(archetype.referenceCandidates.bad.trim().length > 0, `${archetype.archetypeId} bad shape`);
    assert.ok(archetype.referenceCandidates.good.trim().length > 0, `${archetype.archetypeId} good shape`);
    assert.notEqual(archetype.referenceCandidates.bad, archetype.referenceCandidates.good);
  }
});

test("every archetype requires cross-run determinism and constrains at least one channel or the exit status", () => {
  for (const archetype of GRADER_LEGIBLE_ARCHETYPES) {
    const contract = archetype.observationContract;
    assert.equal(contract.deterministicAcrossRuns, true, archetype.archetypeId);
    const constrainsChannel = contract.stdout.mode !== "ignored" || contract.stderr.mode !== "ignored";
    assert.ok(constrainsChannel || typeof contract.exitStatus === "number", archetype.archetypeId);
  }
});

test("agent-visible strings do not leak the expected observation", () => {
  for (const archetype of GRADER_LEGIBLE_ARCHETYPES) {
    const visible = `${archetype.publicBrief}\n${archetype.publicSubmissionContract}`;
    const secrets: string[] = [];
    if (archetype.observationContract.stdout.mode === "exact-lines") secrets.push(...archetype.observationContract.stdout.lines);
    if (archetype.observationContract.stderr.mode === "contains-exact-line") secrets.push(archetype.observationContract.stderr.line);
    for (const secret of secrets) {
      assert.ok(!visible.includes(secret), `${archetype.archetypeId} leaks ${JSON.stringify(secret)} to the agent`);
    }
  }
});

test("archetype hashing is stable and sensitive to the observation contract", () => {
  const archetype = graderLegibleArchetype("cap-glo-002");
  assert.equal(graderLegibleArchetypeHash(archetype), graderLegibleArchetypeHash(archetype));
  const mutated = { ...archetype, observationContract: { ...archetype.observationContract, exitStatus: 9 } };
  assert.notEqual(graderLegibleArchetypeHash(mutated), graderLegibleArchetypeHash(archetype));
});

test("archetype hashing ignores reference candidate shapes", () => {
  const archetype = graderLegibleArchetype("cap-glo-002");
  const withExtraBadShape = {
    ...archetype,
    referenceCandidates: { ...archetype.referenceCandidates, bad: "#!/bin/sh\necho something else\n" }
  };
  assert.equal(graderLegibleArchetypeHash(withExtraBadShape), graderLegibleArchetypeHash(archetype));
});

test("archetype set hash changes when the set changes", () => {
  const full = graderLegibleArchetypeSetHash();
  assert.equal(full, graderLegibleArchetypeSetHash());
  assert.notEqual(graderLegibleArchetypeSetHash(GRADER_LEGIBLE_ARCHETYPES.slice(0, 5)), full);
});

test("graderLegibleArchetype throws on an unknown id", () => {
  assert.throws(() => graderLegibleArchetype("nope"), /Unknown grader-legible archetype/);
});

// ---------------------------------------------------------------------------
// channelLines
// ---------------------------------------------------------------------------

test("channelLines drops exactly one trailing newline and preserves interior blanks", () => {
  assert.deepEqual(channelLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(channelLines(""), []);
  assert.deepEqual(channelLines("a\n\nb\n"), ["a", "", "b"]);
  assert.deepEqual(channelLines("a\n\n"), ["a", ""]);
});

// ---------------------------------------------------------------------------
// Grader
// ---------------------------------------------------------------------------

const ARCHETYPE_2 = graderLegibleArchetype("cap-glo-002");
const ARCHETYPE_1 = graderLegibleArchetype("cap-glo-001");

function grade(input: {
  archetype?: typeof ARCHETYPE_2;
  runs: { stdout: string; stderr: string; exitStatus: number | null }[];
  invocationLog?: string[];
  valid?: boolean;
}) {
  return gradeGraderLegibleSubmission({
    archetype: input.archetype ?? ARCHETYPE_2,
    validity: input.valid === false ? { valid: false, reason: "synthetic" } : { valid: true },
    runs: input.runs,
    invocationLog: input.invocationLog ?? ["read adjusted"],
    submissionBytes: 32
  });
}

test("grader accepts the minimal raw observable", () => {
  const result = grade({ runs: [{ stdout: "1007\n", stderr: "", exitStatus: 0 }, { stdout: "1007\n", stderr: "", exitStatus: 0 }] });
  assert.equal(result.result, "grader_legible");
  assert.equal(result.failureStage, null);
  assert.equal(result.secondary.discriminatingExperimentPerformed, true);
});

test("grader rejects a self-asserted verdict in place of the raw value", () => {
  const output = { stdout: "DRIFT DETECTED: adjusted gauge disagrees with base gauge\n", stderr: "", exitStatus: 0 };
  const result = grade({ runs: [output, output] });
  assert.equal(result.result, "not_grader_legible");
  assert.equal(result.failureStage, "stdout_shape_mismatch");
});

test("grader rejects the right value buried in extra diagnostic output", () => {
  const output = { stdout: "=== reproducer ===\n1007\n=== end ===\n", stderr: "", exitStatus: 0 };
  const result = grade({ runs: [output, output] });
  assert.equal(result.result, "not_grader_legible");
  assert.equal(result.failureStage, "stdout_shape_mismatch");
});

test("an invalid execution is infrastructure, never a capability miss", () => {
  const result = grade({ valid: false, runs: [] });
  assert.equal(result.result, "invalid_execution");
  assert.equal(result.failureStage, "infrastructure");
});

test("a valid execution with no captured runs fails closed as infrastructure", () => {
  const result = grade({ runs: [] });
  assert.equal(result.result, "invalid_execution");
  assert.equal(result.failureStage, "infrastructure");
});

test("a submission that never ran the discriminating experiment is attributed upstream of output shape", () => {
  const result = grade({
    archetype: ARCHETYPE_1,
    runs: [
      { stdout: "", stderr: "LEDGER-E0412: commit rejected: stage \"beta\" was superseded\n", exitStatus: 3 },
      { stdout: "", stderr: "LEDGER-E0412: commit rejected: stage \"beta\" was superseded\n", exitStatus: 3 }
    ],
    invocationLog: ["stage alpha"]
  });
  assert.equal(result.failureStage, "no_discriminating_experiment");
  assert.equal(result.secondary.discriminatingExperimentPerformed, false);
  // The encoding-stage diagnostics are still computed and retained.
  assert.equal(result.secondary.exitStatusMatched, true);
  assert.equal(result.secondary.stderrSignalPreserved, true);
});

test("nondeterministic external output is attributed before channel mismatches", () => {
  const result = grade({
    runs: [
      { stdout: "1007\n", stderr: "", exitStatus: 0 },
      { stdout: "1008\n", stderr: "", exitStatus: 0 }
    ]
  });
  assert.equal(result.failureStage, "nondeterministic_output");
  assert.equal(result.secondary.deterministicExternalOutput, false);
});

test("a swallowed raw error is attributed to the missing stderr signal", () => {
  const output = { stdout: "", stderr: "", exitStatus: 3 };
  const result = grade({ archetype: ARCHETYPE_1, runs: [output, output], invocationLog: ["commit beta"] });
  assert.equal(result.result, "not_grader_legible");
  assert.equal(result.failureStage, "stderr_signal_missing");
  assert.equal(result.secondary.stderrSignalPreserved, false);
});

test("a translated raw error does not satisfy contains-exact-line", () => {
  const output = { stdout: "", stderr: "error: the commit was rejected\n", exitStatus: 3 };
  const result = grade({ archetype: ARCHETYPE_1, runs: [output, output], invocationLog: ["commit beta"] });
  assert.equal(result.failureStage, "stderr_signal_missing");
});

test("a wrong exit status is attributed before stdout shape", () => {
  const output = { stdout: "1007\n", stderr: "", exitStatus: 1 };
  const result = grade({ runs: [output, output] });
  assert.equal(result.failureStage, "exit_status_mismatch");
});

test("grader diagnostics never echo the expected value back", () => {
  const output = { stdout: "PASS\n", stderr: "", exitStatus: 0 };
  const result = grade({ runs: [output, output] });
  assert.ok(result.diagnostics.length > 0);
  assert.ok(!result.diagnostics.join("\n").includes("1007"));
});

// ---------------------------------------------------------------------------
// Intervention freeze
// ---------------------------------------------------------------------------

test("baseline is the empty intervention and candidate is not", () => {
  assert.equal(graderLegibleIntervention("baseline").body, "");
  assert.equal(graderLegibleIntervention("baseline").interventionId, GRADER_LEGIBLE_BASELINE_INTERVENTION.interventionId);
  assert.ok(graderLegibleIntervention("candidate").body.length > 0);
  assert.notEqual(GRADER_LEGIBLE_CANDIDATE_INTERVENTION.interventionHash, GRADER_LEGIBLE_BASELINE_INTERVENTION.interventionHash);
});

test("the candidate intervention encodes no case-specific or fixture-specific material", () => {
  const body = GRADER_LEGIBLE_CANDIDATE_INTERVENTION.body.toLowerCase();
  const forbidden = [
    "postgres",
    "psql",
    "savepoint",
    "plpgsql",
    "raise notice",
    "sqlstate",
    "16867",
    "18574",
    "18118",
    "family-003",
    "family-004",
    ...GRADER_LEGIBLE_ARCHETYPES.map((archetype) => archetype.fixtureCommand)
  ];
  for (const term of forbidden) {
    assert.ok(!body.includes(term), `intervention body mentions ${JSON.stringify(term)}`);
  }
});

test("a frozen intervention round-trips and refuses a modified body", () => {
  const frozen = exportFrozenGraderLegibleIntervention();
  assert.doesNotThrow(() => assertFrozenGraderLegibleIntervention(frozen));
  assert.throws(
    () => assertFrozenGraderLegibleIntervention({ ...frozen, body: `${frozen.body}\n8. One more principle.\n` }),
    GraderLegibleInterventionIntegrityError
  );
});
