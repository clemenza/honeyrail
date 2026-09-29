/**
 * Contemporaneous Engineering Context v1 (issue #228) - methodology contract
 * only. See docs/contemporaneous-context-v1.md for the full taxonomy,
 * future-truth boundary, anti-hindsight selection rule, and contamination
 * examples this schema enforces structurally.
 *
 * This module is deliberately standalone: it is not imported by
 * historical-task.ts, historical-corpus.ts, or any materialization path, so
 * no existing taskDefinitionHash/bundleHash/corpusHash is affected by its
 * presence. It defines only the per-artifact provenance record a future
 * ContextEnvelope (#231) is expected to build on - it does not materialize
 * one itself, select a family (#230), or implement C4 temporal retrieval.
 */

export const CONTEMPORANEOUS_CONTEXT_SCHEMA_VERSION = 1;

/**
 * C0-C4 from docs/contemporaneous-context-v1.md. C4 (Temporal Retrieval) is
 * named here so a future artifact can declare it, even though no retrieval
 * mechanism is implemented by this issue.
 */
export const CONTEMPORANEOUS_CONTEXT_CLASSES = ["C0", "C1", "C2", "C3", "C4"] as const;
export type ContemporaneousContextClass = (typeof CONTEMPORANEOUS_CONTEXT_CLASSES)[number];

const CONTEXT_CLASS_SET: ReadonlySet<string> = new Set(CONTEMPORANEOUS_CONTEXT_CLASSES);

/** SHA-256 hex digest shape - same pattern used throughout historical-task.ts/historical-corpus.ts. */
const SHA256_HEX = /^[0-9a-f]{64}$/i;

export class ContemporaneousContextIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContemporaneousContextIntegrityError";
  }
}

/**
 * Required provenance for one exposed artifact - "Required provenance
 * contract" in docs/contemporaneous-context-v1.md. `publicLocator` is
 * nullable: a genuinely unavailable public URL/message-id/commit is recorded
 * as `null`, never fabricated. `inclusionRule` must name the specific
 * deterministic, predeclared rule that selected this artifact (the
 * anti-hindsight rule) - not a free-form justification.
 */
export type ContemporaneousArtifactProvenance = {
  schemaVersion: 1;
  artifactId: string;
  contextClass: ContemporaneousContextClass;
  sourceIdentifier: string;
  publicLocator: string | null;
  artifactTimestamp: string;
  taskCutoff: string;
  contentSha256: string;
  inclusionRule: string;
  collectionProcedure: string;
  derived: boolean;
};

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ContemporaneousContextIntegrityError(`${label} must be a non-empty string, got: ${JSON.stringify(value)}`);
  }
}

function parseTimestamp(value: unknown, label: string): number {
  requireNonEmptyString(value, label);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new ContemporaneousContextIntegrityError(`${label} must be a parseable ISO 8601 timestamp, got: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Structural validation of a single artifact's provenance record. Throws
 * ContemporaneousContextIntegrityError - never returns a boolean - so a
 * malformed or contract-violating record can never be silently treated as
 * valid. Enforces, in order:
 *
 * 1. schemaVersion is exactly the frozen v1 value.
 * 2. contextClass is one of C0-C4 - an unknown class fails closed.
 * 3. artifactId/sourceIdentifier/inclusionRule/collectionProcedure are all
 *    non-empty strings. collectionProcedure is required unconditionally -
 *    `derived` does not relax this: a derived artifact must still name its
 *    own mechanical derivation procedure (the "derived-context identity
 *    requirement" from docs/contemporaneous-context-v1.md).
 * 4. contentSha256 matches the SHA-256 hex shape used throughout this
 *    codebase.
 * 5. the core rule: artifactTimestamp <= taskCutoff. This checks only the
 *    timestamp conjunct of the core rule - the second conjunct
 *    ("selection does not depend on future-defect knowledge") is not
 *    machine-checkable from a single record and is enforced by the
 *    inclusion-rule discipline (predeclared, deterministic rules) described
 *    in the doc, not by this function.
 */
export function validateContemporaneousArtifactProvenance(provenance: ContemporaneousArtifactProvenance): void {
  if (provenance.schemaVersion !== CONTEMPORANEOUS_CONTEXT_SCHEMA_VERSION) {
    throw new ContemporaneousContextIntegrityError(
      `schemaVersion must be ${CONTEMPORANEOUS_CONTEXT_SCHEMA_VERSION}, got ${String(provenance.schemaVersion)}`
    );
  }
  if (!CONTEXT_CLASS_SET.has(provenance.contextClass)) {
    throw new ContemporaneousContextIntegrityError(
      `contextClass must be one of ${CONTEMPORANEOUS_CONTEXT_CLASSES.join(", ")}, got: ${JSON.stringify(provenance.contextClass)}`
    );
  }
  requireNonEmptyString(provenance.artifactId, "artifactId");
  requireNonEmptyString(provenance.sourceIdentifier, "sourceIdentifier");
  requireNonEmptyString(provenance.inclusionRule, "inclusionRule");
  requireNonEmptyString(provenance.collectionProcedure, "collectionProcedure");
  if (provenance.publicLocator !== null) {
    requireNonEmptyString(provenance.publicLocator, "publicLocator");
  }
  if (typeof provenance.derived !== "boolean") {
    throw new ContemporaneousContextIntegrityError(`derived must be a boolean, got: ${JSON.stringify(provenance.derived)}`);
  }
  if (typeof provenance.contentSha256 !== "string" || !SHA256_HEX.test(provenance.contentSha256)) {
    throw new ContemporaneousContextIntegrityError(`contentSha256 must be a 64-character SHA-256 hex digest, got: ${String(provenance.contentSha256)}`);
  }
  const artifactTimestamp = parseTimestamp(provenance.artifactTimestamp, "artifactTimestamp");
  const taskCutoff = parseTimestamp(provenance.taskCutoff, "taskCutoff");
  if (artifactTimestamp > taskCutoff) {
    throw new ContemporaneousContextIntegrityError(
      `artifactTimestamp (${provenance.artifactTimestamp}) must be <= taskCutoff (${provenance.taskCutoff}) - the core rule's time-consistency conjunct`
    );
  }
}
