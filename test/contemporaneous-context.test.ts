import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  CONTEMPORANEOUS_CONTEXT_SCHEMA_VERSION,
  ContemporaneousContextIntegrityError,
  validateContemporaneousArtifactProvenance,
  type ContemporaneousArtifactProvenance
} from "../server/postgres/contemporaneous-context.js";

const CONTENT_SHA256 = createHash("sha256").update("fixture-content").digest("hex");

function validProvenance(overrides: Partial<ContemporaneousArtifactProvenance> = {}): ContemporaneousArtifactProvenance {
  return {
    schemaVersion: CONTEMPORANEOUS_CONTEXT_SCHEMA_VERSION,
    artifactId: "c1-introducing-diff",
    contextClass: "C1",
    sourceIdentifier: "postgresql/postgresql git mirror",
    publicLocator: "https://git.postgresql.org/gitweb/?p=postgresql.git;a=commit;h=280a408b48d5ee42969f981bceb9e9426c3a344c",
    artifactTimestamp: "2019-03-24T00:00:00.000Z",
    taskCutoff: "2019-03-24T00:00:00.000Z",
    contentSha256: CONTENT_SHA256,
    inclusionRule: "full git diff <parent>..<introducing-commit>, generated deterministically from the local mirror",
    collectionProcedure: "git diff, no manual editing",
    derived: false,
    ...overrides
  };
}

test("valid provenance passes", () => {
  assert.doesNotThrow(() => validateContemporaneousArtifactProvenance(validProvenance()));
});

test("valid provenance with null publicLocator passes", () => {
  assert.doesNotThrow(() => validateContemporaneousArtifactProvenance(validProvenance({ publicLocator: null })));
});

test("wrong schemaVersion throws", () => {
  assert.throws(
    () => validateContemporaneousArtifactProvenance(validProvenance({ schemaVersion: 2 as unknown as 1 })),
    ContemporaneousContextIntegrityError
  );
});

test("unknown contextClass throws", () => {
  assert.throws(
    () => validateContemporaneousArtifactProvenance(validProvenance({ contextClass: "C5" as unknown as "C1" })),
    ContemporaneousContextIntegrityError
  );
});

test("late artifactTimestamp (after taskCutoff) throws", () => {
  assert.throws(
    () =>
      validateContemporaneousArtifactProvenance(
        validProvenance({ artifactTimestamp: "2019-03-25T00:00:00.000Z", taskCutoff: "2019-03-24T00:00:00.000Z" })
      ),
    (error: unknown) => error instanceof ContemporaneousContextIntegrityError && /core rule/.test((error as Error).message)
  );
});

test("artifactTimestamp equal to taskCutoff is allowed (boundary is inclusive)", () => {
  assert.doesNotThrow(() =>
    validateContemporaneousArtifactProvenance(validProvenance({ artifactTimestamp: "2019-03-24T00:00:00.000Z", taskCutoff: "2019-03-24T00:00:00.000Z" }))
  );
});

test("unparseable artifactTimestamp throws", () => {
  assert.throws(
    () => validateContemporaneousArtifactProvenance(validProvenance({ artifactTimestamp: "not-a-date" })),
    ContemporaneousContextIntegrityError
  );
});

test("missing inclusionRule throws", () => {
  assert.throws(() => validateContemporaneousArtifactProvenance(validProvenance({ inclusionRule: "" })), ContemporaneousContextIntegrityError);
});

test("missing sourceIdentifier throws", () => {
  assert.throws(() => validateContemporaneousArtifactProvenance(validProvenance({ sourceIdentifier: "  " })), ContemporaneousContextIntegrityError);
});

test("missing artifactId throws", () => {
  assert.throws(() => validateContemporaneousArtifactProvenance(validProvenance({ artifactId: "" })), ContemporaneousContextIntegrityError);
});

test("malformed contentSha256 throws", () => {
  assert.throws(() => validateContemporaneousArtifactProvenance(validProvenance({ contentSha256: "not-a-hash" })), ContemporaneousContextIntegrityError);
});

test("derived-context identity requirement: derived=true still requires a non-empty collectionProcedure", () => {
  assert.throws(
    () => validateContemporaneousArtifactProvenance(validProvenance({ derived: true, collectionProcedure: "" })),
    ContemporaneousContextIntegrityError
  );
  assert.doesNotThrow(() =>
    validateContemporaneousArtifactProvenance(
      validProvenance({ derived: true, collectionProcedure: "mechanical: call-graph extraction v1, no human editing" })
    )
  );
});

test("collectionProcedure is required unconditionally: derived=false with an empty procedure also throws", () => {
  assert.throws(
    () => validateContemporaneousArtifactProvenance(validProvenance({ derived: false, collectionProcedure: "" })),
    ContemporaneousContextIntegrityError
  );
});

test("non-boolean derived throws", () => {
  assert.throws(
    () => validateContemporaneousArtifactProvenance(validProvenance({ derived: "false" as unknown as boolean })),
    ContemporaneousContextIntegrityError
  );
});

test("all C0-C4 context classes are individually accepted", () => {
  for (const contextClass of ["C0", "C1", "C2", "C3", "C4"] as const) {
    assert.doesNotThrow(() => validateContemporaneousArtifactProvenance(validProvenance({ contextClass })));
  }
});
