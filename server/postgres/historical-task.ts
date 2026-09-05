import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { nowIso, runCommandSafe } from "../utils.js";
import {
  createAgentEnvRoot,
  materializePostgresSource,
  withPostgresResearchEnvironment,
  type PostgresBuildSpec,
  type PostgresQueryResult,
  type PostgresResearchEnvironment,
  type PostgresResearchSpec
} from "./research-environment.js";
import {
  runAgentInPostgresResearchEnvironment,
  type PostgresResearchAgentSpec,
  type PostgresResearchSessionOptions,
  type PostgresResearchSessionResult
} from "./research-session.js";
import {
  classifyExecutionValidity,
  evaluateOracleAttribution,
  extractPsqlErrorMessages,
  type HistoricalPostgresBehavioralOracle,
  type HistoricalPostgresObservationPattern,
  type HistoricalPostgresOracleAttribution
} from "./historical-behavioral-oracle.js";
import {
  assertNoDelimiterInExpectedRows,
  assertValidExpectedRows,
  evaluateStructuredOracleAttribution,
  structuredExpectationsOverlap,
  type HistoricalPostgresStructuredExpectation,
  type HistoricalPostgresStructuredOracle,
  type HistoricalPostgresStructuredOracleAttribution,
  type HistoricalPostgresStructuredOracleResult
} from "./historical-structured-oracle.js";

export type {
  HistoricalPostgresBehavioralOracle,
  HistoricalPostgresExecutionValidity,
  HistoricalPostgresObservationPattern,
  HistoricalPostgresOracleAttribution,
  HistoricalPostgresOracleObservationInput,
  HistoricalPostgresOracleResult,
  HistoricalPostgresPsqlMessage
} from "./historical-behavioral-oracle.js";

export type {
  HistoricalPostgresStructuredExpectation,
  HistoricalPostgresStructuredOracle,
  HistoricalPostgresStructuredOracleAttribution,
  HistoricalPostgresStructuredOracleResult
} from "./historical-structured-oracle.js";

/**
 * Which grading semantics a task instance uses. `submitted-reproducer-exit-status-v1`
 * (case 001, and any spec that declares no `truth.behavioralOracle`) grades
 * purely on the submitted reproducer's own exit-status differential across
 * the two revisions. `submitted-reproducer-behavioral-oracle-v1` (case 002,
 * and any future spec that declares a `behavioralOracle`) additionally
 * requires the reproducer's own captured output to structurally match a
 * declared, revision-specific observation sequence - see
 * `historical-behavioral-oracle.ts` and `resolveOracleReproduction()` below.
 * These are materially different grading semantics, so they get materially
 * different protocol identifiers rather than sharing one string that would
 * otherwise silently mean two different things depending on the task; the
 * identifier is part of the hashed truth bundle (`truthShape.gradingProtocol`
 * below), so which protocol graded a given task instance is itself
 * provenance-covered.
 */
export const HISTORICAL_POSTGRES_EXIT_STATUS_PROTOCOL = "submitted-reproducer-exit-status-v1" as const;
export const HISTORICAL_POSTGRES_BEHAVIORAL_ORACLE_PROTOCOL = "submitted-reproducer-behavioral-oracle-v1" as const;
export const HISTORICAL_POSTGRES_STRUCTURED_ORACLE_PROTOCOL = "submitted-reproducer-structured-oracle-v1" as const;
export type HistoricalPostgresGradingProtocol =
  | typeof HISTORICAL_POSTGRES_EXIT_STATUS_PROTOCOL
  | typeof HISTORICAL_POSTGRES_BEHAVIORAL_ORACLE_PROTOCOL
  | typeof HISTORICAL_POSTGRES_STRUCTURED_ORACLE_PROTOCOL;

/**
 * The deliberately small v0 contract for one historical PostgreSQL task.
 *
 * This is task/grader glue, not a second PostgreSQL runtime: both the agent
 * and the two-revision grader use research-environment.ts unchanged.
 */
export const HISTORICAL_POSTGRES_TASK_SCHEMA_VERSION = 1;
/** Bound untrusted agent output before it is copied or parsed by the grader. */
export const MAX_HISTORICAL_POSTGRES_REPRO_BYTES = 256 * 1024;
export const MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES = 16 * 1024 * 1024;
export const MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES = 2048;

/**
 * `taskId` and everything under `source` reach the agent (directly, or as the
 * `historicalRevision` used to materialize its source snapshot). `truth`
 * never does: it exists only so `materializeHistoricalPostgresTask()` can
 * write it into the grader-private `reference/truth.json` bundle. Keeping the
 * bug identity in the spec (rather than hard-coded per call site) is what
 * lets the same generic materializer serve any historical case without a
 * bug-specific branch.
 */
export type HistoricalPostgresTaskSpec = {
  taskId: string;
  source: { repoPath: string; historicalRevision: string; referenceRevision: string };
  truth: {
    upstreamBug: string;
    /**
     * Positive integer when the upstream bug was submitted through a
     * PostgreSQL CommitFest entry (e.g. case 001). Omitted for cases sourced
     * from elsewhere - e.g. a plain pgsql-bugs report (case 002) - which has
     * no CommitFest identity at all. Written into the truth bundle as `null`
     * when absent; never fabricated.
     */
    commitFest?: number;
    /**
     * Host path (private, never committed) to a known-good reproducer used
     * only to prove this task instance is well-posed before any agent runs.
     * When set, its SHA-256 is recorded in the truth bundle for provenance;
     * the file itself is never read by `gradeHistoricalPostgresSubmission()`,
     * which only ever executes the agent-submitted reproducer. Conflating the
     * two would let a canonical verification aid quietly become part of
     * agent grading.
     */
    knownReproducerPath?: string;
    /**
     * Host path (private, never committed) to grader-private fix/reference
     * evidence for this task instance - e.g. notes on the upstream fix, a
     * diff, or release-note excerpts. Purely optional provenance: never read
     * by the grader during scoring, exists only so a task instance's truth
     * bundle can carry more than bare hashes when an operator supplies it.
     * Copied byte-identical into reference/expected-behavior/fix-evidence
     * (fixed name, regardless of the source file's own name/extension) and
     * hashed into the truth bundle - never written anywhere under task/.
     *
     * Overrides auto-generation: when omitted and `behavioralOracle` (below)
     * is declared, `materializeHistoricalPostgresTask()` generates real
     * fix-evidence itself - a `git diff` between `historicalRevision` and
     * `referenceRevision` in `repoPath`, which the local mirror this task
     * type already requires makes available for free (#200 fourth review
     * round, Blocking 4). Supply this only when narrative content a raw diff
     * can't capture is worth adding.
     */
    knownFixEvidencePath?: string;
    /**
     * Optional declarative, task-generic behavioral oracle: ordered
     * observation patterns the submitted reproducer's own captured psql
     * stderr must match, per revision. When present, it - not the script's
     * own exit status - drives `HistoricalPostgresRevisionObservation.reproduced`
     * (see `defaultGradeRevision()`), so a submission can no longer earn
     * `rediscovered` credit merely by encoding *some* revision-discriminating
     * exit code; its captured output must actually match the declared
     * upstream regression's observations, in order. Absent for tasks (e.g.
     * case 001, and any synthetic/unit-test spec) that don't declare one,
     * which keeps `reproduced` exactly the legacy `execution.ok` semantics
     * for them - zero behavior change.
     */
    behavioralOracle?: HistoricalPostgresBehavioralOracle;
    /**
     * Optional declarative, task-generic structured-output oracle: exact
     * tuples the submitted reproducer's own captured psql stdout (tuples-only,
     * unaligned, already guaranteed by `psqlArgs()` in runtime.ts) must
     * return, per revision. When present, it - not the script's own exit
     * status - drives `HistoricalPostgresRevisionObservation.reproduced`, same
     * as `behavioralOracle`. Mutually exclusive with `behavioralOracle` by
     * task-authoring convention (at most one drives grading per task). Absent
     * for tasks that don't declare one - zero behavior change.
     * See `historical-structured-oracle.ts`.
     */
    structuredOracle?: HistoricalPostgresStructuredOracle;
  };
  build?: PostgresBuildSpec;
  scaffoldingLevel?: string;
  budget?: Record<string, number>;
  prompt: string;
};

export type HistoricalPostgresTaskLayout = {
  root: string;
  taskDir: string;
  sourceDir: string;
  workspaceDir: string;
  referenceDir: string;
  taskManifestPath: string;
  referenceManifestPath: string;
  truthManifestPath: string;
  taskManifest: HistoricalPostgresTaskManifest;
  referenceManifest: HistoricalPostgresReferenceManifest;
  truthManifest: HistoricalPostgresTruthManifest;
};

/**
 * Agent-visible replacement for the full `PostgresSourceManifest` that
 * `materializePostgresSource()` returns. The full manifest carries
 * `repoPath`, `ref`, `resolvedCommit` and `sourceDir` - the historical
 * revision itself and a local grader-only filesystem path - so it is never
 * written into `task/`. This sanitized shape is: only what an agent could
 * legitimately want to confirm about the tree it was actually given.
 */
export type HistoricalPostgresPublicSourceManifest = {
  schemaVersion: 1;
  sourceHash: string;
  gitDirPresent: boolean;
};

/**
 * Everything an agent (or anything mounted into its container) can see.
 * Deliberately excludes both pinned revisions, the bug identity, and any
 * reproducer hash - only opaque hashes and execution-shaping settings.
 */
export type HistoricalPostgresTaskManifest = {
  schemaVersion: 1;
  taskId: string;
  database: "postgresql";
  taskType: "historical-correctness-regression";
  scaffoldingLevel: string;
  budget: Record<string, number>;
  buildProfile: string;
  artifacts: { sourceManifest: string; prompt: string; workspace: string };
  hashes: { sourceTree: string; prompt: string; taskDefinition: string; truthBundle: string };
};

/**
 * Grader-private, protocol-level metadata. No revisions and no bug identity
 * live here on purpose - only enough to say "here is how this was graded" and
 * to point at the truth bundle whose hash actually covers that identity.
 */
export type HistoricalPostgresReferenceManifest = {
  schemaVersion: 1;
  taskId: string;
  gradingProtocol: HistoricalPostgresGradingProtocol;
  taskDefinitionHash: string;
  truthBundleHash: string;
};

/**
 * Grader-private truth. This is the one place the original bug identity and
 * both pinned revisions are recorded in plaintext; it is written under
 * `reference/`, which is never mounted into an agent's container.
 * `bundleHash` covers every field below it (including the two revisions, the
 * bug identity, and both material hashes), so the bundle's own hash is real
 * provenance rather than a hash of unrelated shape metadata.
 */
export type HistoricalPostgresTruthManifest = {
  schemaVersion: 1;
  taskId: string;
  upstreamBug: string;
  /** `null` when the upstream bug has no CommitFest identity - see HistoricalPostgresTaskSpec.truth.commitFest. */
  commitFest: number | null;
  historicalRevision: string;
  referenceRevision: string;
  gradingProtocol: HistoricalPostgresGradingProtocol;
  /** Grader-private relative path to the retained canonical verification reproducer; never used as an agent grading fallback. */
  canonicalReproducer: string | null;
  /** SHA-256 of the canonical verification reproducer, when one was supplied; never the agent's. */
  canonicalReproducerSha256: string | null;
  /**
   * Grader-private relative path to fix/reference evidence, present when
   * either an operator explicitly supplied `truth.knownFixEvidencePath` or
   * (for any task that declares `truth.behavioralOracle`) it was
   * auto-generated as a real `git diff` between the two pinned revisions -
   * see `materializeHistoricalPostgresTask()`'s Blocking-4 fix-evidence
   * generation and HistoricalPostgresTaskSpec.truth.knownFixEvidencePath.
   * The key itself - like `behavioralOracle` below - is omitted (not
   * present-as-`null`) when neither applies, so a legacy exit-status task's
   * (case 001's) serialized truth bundle - and therefore its hash - is
   * byte-identical to what it was before this field existed (#200 fourth
   * review round, "Blocking 3" - a corrected version of the third round's
   * "unconditional null is fine here, it's brand new" reasoning, which was
   * wrong: brand-new-to-this-PR does not mean safe-to-add-unconditionally).
   */
  fixEvidence?: string;
  /** SHA-256 of the fix/reference evidence file. Present exactly when `fixEvidence` is. */
  fixEvidenceSha256?: string;
  /**
   * Present only when the task declares `truth.behavioralOracle` - the key
   * itself is omitted (not present-as-`null`) when absent, so a legacy
   * exit-status task's (case 001's) serialized truth bundle - and therefore
   * its hash - is byte-identical to what it was before this field existed.
   * See HistoricalPostgresTaskSpec.truth.behavioralOracle.
   */
  behavioralOracle?: HistoricalPostgresBehavioralOracle;
  /**
   * Present only when the task declares `truth.structuredOracle` - the key
   * itself is omitted (not present-as-`null`) when absent, so case 001's and
   * case 002's serialized truth bundles - and therefore their hashes - are
   * byte-identical to what they were before this field existed (Policy A).
   * See HistoricalPostgresTaskSpec.truth.structuredOracle.
   */
  structuredOracle?: HistoricalPostgresStructuredOracle;
  /** SHA-256 over the sorted relative-path+content of reference/expected-behavior and reference/verification. */
  expectedBehaviorSha256: string;
  taskDefinitionHash: string;
  bundleHash: string;
};

export type HistoricalPostgresSubmission =
  | { status: "not-reproduced"; summary: string }
  | { status: "reproduced"; summary: string; reproducer: string };

export type HistoricalPostgresGradeStatus =
  | "rediscovered"
  | "miss"
  | "invalid_submission"
  | "blocked"
  | "infrastructure_error"
  | "integrity_error";

export type HistoricalPostgresRevisionObservation = {
  /**
   * When the task declares `truth.behavioralOracle`, this is
   * `attribution.attributedTo === "historical"` - informational/back-compat
   * only, since `gradeHistoricalPostgresSubmission()` no longer classifies
   * from this boolean for oracle-declared tasks (it consumes `attribution`
   * directly - see below). Falls back to `execution.ok` when no oracle is
   * declared (legacy exit-status differential, e.g. case 001) - there
   * `reproduced` is still what drives classification, unchanged.
   */
  reproduced: boolean;
  execution?: Pick<PostgresQueryResult, "ok" | "stdout" | "stderr" | "exitCode" | "durationMs">;
  /**
   * Present only when the task declares `truth.behavioralOracle` or
   * `truth.structuredOracle`. Separates four distinct concepts the classifier
   * consumes structurally, not just as diagnostic prose: `validity` (was
   * execution even interpretable - a client/transport/runtime failure is
   * `{valid: false}` regardless of what, if anything, was captured),
   * `historicalMatch.satisfied` (matches the known regression's own
   * signature), `referenceMatch.satisfied` (matches the declared
   * expected/fixed behavior), and `attributedTo` (which one, if either,
   * unambiguously - `"unattributed"` when invalid or when neither matches,
   * which is what stops an unrelated/unexpected reference-side failure from
   * ever silently counting as "the bug is absent"). The union type reflects
   * the two oracle families; the 4-step classifier consumes the shared
   * structural fields duck-typed, so no oracle-specific branching is needed
   * in `gradeHistoricalPostgresSubmission()`.
   */
  attribution?: HistoricalPostgresOracleAttribution | HistoricalPostgresStructuredOracleAttribution;
  sourceManifest?: Record<string, unknown>;
  buildManifest?: Record<string, unknown>;
  runtimeManifest?: Record<string, unknown>;
};

export type HistoricalPostgresGrade = {
  taskId: string;
  status: HistoricalPostgresGradeStatus;
  historical: HistoricalPostgresRevisionObservation;
  reference: HistoricalPostgresRevisionObservation;
  artifacts: string[];
  diagnostics: string[];
  gradedAt: string;
};

/**
 * `"unscored"` is the outcome for an otherwise-normal run whose isolation was
 * not scored-eligible (e.g. `network: "bridge"` for a real agent that needs
 * model-API access): the grader may still run as a diagnostic, but the trial
 * itself must never be reported as `"completed"` with a scored `miss` or
 * `rediscovered` - see `scoredEligible` below, which is what a consumer must
 * check before treating `grade` as an official score rather than a
 * diagnostic.
 */
export type HistoricalPostgresTrialStatus = "completed" | "unscored" | "blocked" | "infrastructure_error" | "integrity_error";

export type HistoricalPostgresTrial = {
  taskId: string;
  status: HistoricalPostgresTrialStatus;
  /**
   * Mirrors `session.isolation.scoredEligible`. `false` means the run's
   * isolation (most commonly a non-`"none"` agent network) was not the
   * scored configuration; any `grade` present is diagnostic only, and
   * `status` will never be `"completed"` in that case - see `"unscored"`.
   */
  scoredEligible: boolean;
  workspaceDir?: string;
  agent: Record<string, unknown>;
  /** Official score only when `scoredEligible` is true and `status` is `"completed"`; diagnostic otherwise. */
  grade?: HistoricalPostgresGrade;
  artifacts: string[];
  diagnostics: string[];
};

type GradeRevisionInput = {
  revision: string;
  reproducerPath: string;
  artifactDir: string;
  spec: HistoricalPostgresTaskSpec;
};

type GradeRevision = (input: GradeRevisionInput) => Promise<HistoricalPostgresRevisionObservation>;

class HistoricalPostgresIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalPostgresIntegrityError";
  }
}

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
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

const stableJson = (value: unknown) => JSON.stringify(canonicalize(value), null, 2);

/** Deterministic content hash of a directory: sorted relative-path:sha256 pairs, joined and re-hashed. */
async function hashDirectoryContents(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of [...items].sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(dir, item.name);
      const relPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await visit(entryPath, relPath);
        continue;
      }
      entries.push(`${relPath}:${sha256(await readFile(entryPath))}`);
    }
  }
  await visit(root, "");
  return sha256(entries.join("\n"));
}

function exactRevision(value: string, field: string) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${field} must be a pinned 40-character commit SHA`);
  return value.toLowerCase();
}

function checkedTaskSpec(spec: HistoricalPostgresTaskSpec): HistoricalPostgresTaskSpec {
  if (!/^[a-z0-9][a-z0-9-]{2,}$/i.test(spec.taskId)) throw new Error("taskId must be a stable, opaque slug");
  if (!String(spec.source.repoPath || "").trim()) throw new Error("source.repoPath is required");
  if (!String(spec.prompt || "").trim()) throw new Error("prompt is required");
  if (!String(spec.truth?.upstreamBug || "").trim()) throw new Error("truth.upstreamBug is required");
  if (spec.truth?.commitFest !== undefined && (!Number.isInteger(spec.truth.commitFest) || spec.truth.commitFest <= 0)) {
    throw new Error("truth.commitFest must be a positive integer when present");
  }
  if (spec.truth?.behavioralOracle !== undefined) {
    for (const side of ["historical", "reference"] as const) {
      const patterns = spec.truth.behavioralOracle[side];
      if (!Array.isArray(patterns) || patterns.length === 0) {
        throw new Error(`truth.behavioralOracle.${side} must be a non-empty array of observation patterns`);
      }
      patterns.forEach((pattern, index) => {
        try {
          void new RegExp(pattern.matches);
        } catch (error) {
          throw new Error(`truth.behavioralOracle.${side}[${index}].matches is not a valid regular expression: ${(error as Error).message}`);
        }
      });
    }
  }
  if (spec.truth?.structuredOracle !== undefined) {
    for (const side of ["historical", "reference"] as const) {
      const expectation = spec.truth.structuredOracle[side];
      if (!expectation || !Array.isArray(expectation.rows) || expectation.rows.length === 0) {
        throw new Error(`truth.structuredOracle.${side}.rows must be a non-empty array`);
      }
      expectation.rows.forEach((row, index) => {
        if (!Array.isArray(row) || row.length === 0) {
          throw new Error(`truth.structuredOracle.${side}.rows[${index}] must be a non-empty array of strings`);
        }
      });
    }
    if (structuredExpectationsOverlap(spec.truth.structuredOracle.historical, spec.truth.structuredOracle.reference)) {
      throw new Error(
        "truth.structuredOracle historical/reference expectations overlap and cannot be attributed unambiguously"
      );
    }
  }
  if (spec.truth?.behavioralOracle !== undefined && spec.truth?.structuredOracle !== undefined) {
    throw new Error("A task spec may declare at most one oracle: truth.behavioralOracle and truth.structuredOracle are mutually exclusive");
  }
  const historicalRevision = exactRevision(spec.source.historicalRevision, "source.historicalRevision");
  const referenceRevision = exactRevision(spec.source.referenceRevision, "source.referenceRevision");
  if (historicalRevision === referenceRevision) throw new Error("historical and reference revisions must differ");
  return { ...spec, source: { ...spec.source, historicalRevision, referenceRevision } };
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertWorkspaceWithinLimits(root: string) {
  let bytes = 0;
  let files = 0;
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      // Symlinks are copied as links and validated only when selected as the
      // reproducer; never follow one while measuring agent-owned output.
      const details = await lstat(entryPath);
      files += 1;
      bytes += details.size;
      if (files > MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES || bytes > MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES) {
        throw new HistoricalPostgresIntegrityError(
          `agent workspace exceeds limits (${files} files, ${bytes} bytes; maximum ${MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES} files and ${MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES} bytes)`
        );
      }
    }
  }
  await visit(root);
}

/** Materializes a clean scored task tree and a separate grader-only reference tree. */
export async function materializeHistoricalPostgresTask(spec: HistoricalPostgresTaskSpec, root: string): Promise<HistoricalPostgresTaskLayout> {
  const input = checkedTaskSpec(spec);
  const taskDir = join(root, "task");
  const sourceDir = join(taskDir, "source");
  const workspaceDir = join(taskDir, "workspace");
  const referenceDir = join(root, "reference");
  const expectedBehaviorDir = join(referenceDir, "expected-behavior");
  const verificationDir = join(referenceDir, "verification");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(expectedBehaviorDir, { recursive: true });
  await mkdir(verificationDir, { recursive: true });

  const source = await materializePostgresSource({ repoPath: input.source.repoPath, ref: input.source.historicalRevision }, sourceDir);
  const promptPath = join(taskDir, "prompt.md");
  await writeFile(promptPath, `${input.prompt.trim()}\n`);
  await writeFile(
    join(workspaceDir, "README.md"),
    "Write finding.json and the runnable SQL reproducer here. HoneyRail grades the same reproducer on the supplied historical build and a grader-owned corrected build.\n"
  );
  await writeFile(
    join(verificationDir, "reproducer-contract.md"),
    "A creditable repro.sql exits successfully only when the observed behavior violates the assertion encoded by the " +
      "reproducer; a run on the corrected build must exit non-zero under the same assertion. The grader executes " +
      "exactly the file the agent names in finding.json - never any canonical verification reproducer, which (if one " +
      "exists for this case) is used only to prove the task itself is well-posed before an agent ever sees it.\n"
  );

  // The canonical reproducer, when supplied, is physically retained here
  // (never the original host path) so a later ground-truth revalidation
  // does not depend on the host-side fixture still existing. It must be
  // copied - and its hash computed - before expectedBehaviorSha256 hashes
  // reference/verification, and long before truth.json (which embeds
  // bundleHash) is written, or the bundle hash would be non-deterministic
  // or self-referential.
  const canonicalReproducerRelativePath = "verification/canonical-reproducer.sql";
  let canonicalReproducer: string | null = null;
  let canonicalReproducerSha256: string | null = null;
  if (input.truth.knownReproducerPath) {
    const canonicalReproducerContents = await readFile(input.truth.knownReproducerPath);
    await writeFile(join(verificationDir, "canonical-reproducer.sql"), canonicalReproducerContents);
    canonicalReproducer = canonicalReproducerRelativePath;
    canonicalReproducerSha256 = sha256(canonicalReproducerContents);
  }
  // Grader-private fix/reference evidence (#200 third review round, 5.B;
  // auto-generation added fourth review round, Blocking 4). Same discipline
  // as the canonical reproducer above - copied/written under a fixed name
  // (never a source file's own name), hashed, and covered by
  // expectedBehaviorSha256/bundleHash. Purely optional provenance; never read
  // by the grader during scoring and never written under task/.
  //
  // `knownFixEvidencePath`, when supplied, is an explicit operator override
  // (narrative content a raw diff can't capture). Otherwise, for any task
  // that declares `behavioralOracle`, real evidence is auto-generated from
  // the local mirror this task type already requires - a `git diff` between
  // the two pinned revisions - so a real historical task never has to rely
  // on a manually maintained extra private file. A legacy exit-status task
  // (no oracle declared, e.g. case 001) attempts neither path and keeps
  // `fixEvidence`/`fixEvidenceSha256` absent from the truth bundle entirely
  // (Policy A - see below).
  //
  // Generation failure is loud, not silent: an oracle-declaring task's
  // `referenceRevision` must actually be diffable against `historicalRevision`
  // in `repoPath`, or this throws - "missing evidence when the task requires
  // it fails loudly, rather than silently satisfying acceptance" (#200
  // fourth review round). An *empty* diff (two distinct commits with
  // byte-identical trees - vanishingly unlikely for a real historical bug,
  // but not itself a failure) is not an error; only `git diff` itself
  // failing (e.g. an unresolvable ref) is.
  let fixEvidence: string | undefined;
  let fixEvidenceSha256: string | undefined;
  if (input.truth.knownFixEvidencePath) {
    const fixEvidenceContents = await readFile(input.truth.knownFixEvidencePath);
    await writeFile(join(expectedBehaviorDir, "fix-evidence"), fixEvidenceContents);
    fixEvidence = "expected-behavior/fix-evidence";
    fixEvidenceSha256 = sha256(fixEvidenceContents);
  } else if (input.truth.behavioralOracle || input.truth.structuredOracle) {
    const diff = await runCommandSafe(
      "git",
      ["-C", input.source.repoPath, "diff", input.source.historicalRevision, input.source.referenceRevision],
      { timeout: 60_000, maxBuffer: 1024 * 1024 * 8 }
    );
    if (!diff.ok) {
      throw new Error(
        `Could not generate grader-private fix/reference evidence: git diff ${input.source.historicalRevision} ${input.source.referenceRevision} in ${input.source.repoPath} failed: ${(diff.stderr || diff.stdout).trim()}`
      );
    }
    const fixEvidenceContents = Buffer.from(diff.stdout, "utf8");
    await writeFile(join(expectedBehaviorDir, "fix-evidence.diff"), fixEvidenceContents);
    fixEvidence = "expected-behavior/fix-evidence.diff";
    fixEvidenceSha256 = sha256(fixEvidenceContents);
  }
  const expectedBehaviorSha256 = await hashDirectoryContents(referenceDir);

  // Which grading semantics this task instance uses - see
  // HistoricalPostgresGradingProtocol. Derived from whether the task
  // declares a behavioral oracle, so case 001 (no oracle) keeps its exact
  // existing protocol string untouched while case 002 (and any future
  // oracle-declaring task) gets an honestly distinct one. This is why no
  // separate hashing code is needed for it: it's just another field already
  // flowing into truthShape/taskDefinition below, covered by the existing
  // generic bundleHash/taskDefinitionHash machinery.
  const gradingProtocol: HistoricalPostgresGradingProtocol = input.truth.structuredOracle
    ? HISTORICAL_POSTGRES_STRUCTURED_ORACLE_PROTOCOL
    : input.truth.behavioralOracle
      ? HISTORICAL_POSTGRES_BEHAVIORAL_ORACLE_PROTOCOL
      : HISTORICAL_POSTGRES_EXIT_STATUS_PROTOCOL;

  const taskDefinition = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    sourceRevision: input.source.historicalRevision,
    referenceRevision: input.source.referenceRevision,
    sourceTree: source.sourceHash,
    promptHash: sha256(await readFile(promptPath)),
    scaffoldingLevel: input.scaffoldingLevel ?? "minimal",
    budget: input.budget ?? {},
    buildProfile: input.build?.mode ?? "container"
  };
  const taskDefinitionHash = sha256(stableJson(taskDefinition));

  const truthShape = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    upstreamBug: input.truth.upstreamBug,
    commitFest: input.truth.commitFest ?? null,
    historicalRevision: input.source.historicalRevision,
    referenceRevision: input.source.referenceRevision,
    gradingProtocol,
    canonicalReproducer,
    canonicalReproducerSha256,
    // Key presence itself is conditional (not just its value) so a legacy
    // spec that declares no oracle and no fix evidence - case 001, and any
    // synthetic/unit-test spec that doesn't opt into either - serializes
    // with exactly the same key set it always has, byte for byte, rather
    // than gaining new "behavioralOracle":null / "fixEvidence":null entries
    // that would move bundleHash for zero behavioral reason (#200 third
    // review round, "Important 4" / Policy A - corrected in the fourth round
    // to actually cover fixEvidence/fixEvidenceSha256 too, which an earlier
    // round had added unconditionally on the mistaken reasoning that
    // "brand new to this PR" meant "safe to add unconditionally").
    ...(fixEvidence ? { fixEvidence, fixEvidenceSha256 } : {}),
    ...(input.truth.behavioralOracle ? { behavioralOracle: input.truth.behavioralOracle } : {}),
    ...(input.truth.structuredOracle ? { structuredOracle: input.truth.structuredOracle } : {}),
    expectedBehaviorSha256,
    taskDefinitionHash
  };
  const truthManifest: HistoricalPostgresTruthManifest = { ...truthShape, bundleHash: sha256(stableJson(truthShape)) };

  const referenceManifest: HistoricalPostgresReferenceManifest = {
    schemaVersion: 1,
    taskId: input.taskId,
    gradingProtocol,
    taskDefinitionHash,
    truthBundleHash: truthManifest.bundleHash
  };

  const taskManifest: HistoricalPostgresTaskManifest = {
    schemaVersion: 1,
    taskId: input.taskId,
    database: "postgresql",
    taskType: "historical-correctness-regression",
    scaffoldingLevel: input.scaffoldingLevel ?? "minimal",
    budget: input.budget ?? {},
    buildProfile: input.build?.mode ?? "container",
    artifacts: { sourceManifest: "source-manifest.json", prompt: "prompt.md", workspace: "workspace" },
    hashes: { sourceTree: source.sourceHash, prompt: taskDefinition.promptHash, taskDefinition: taskDefinitionHash, truthBundle: truthManifest.bundleHash }
  };

  const taskManifestPath = join(taskDir, "task-manifest.json");
  const referenceManifestPath = join(referenceDir, "reference-manifest.json");
  const truthManifestPath = join(referenceDir, "truth.json");
  // The full PostgresSourceManifest (repoPath, ref, resolvedCommit, sourceDir)
  // is grader-private provenance - it names the historical revision and a
  // local mirror path outright. Only a sanitized shape reaches task/.
  const publicSourceManifest: HistoricalPostgresPublicSourceManifest = {
    schemaVersion: 1,
    sourceHash: source.sourceHash,
    gitDirPresent: source.gitDirPresent
  };
  await writeJson(join(taskDir, "source-manifest.json"), publicSourceManifest);
  await writeJson(join(referenceDir, "source-manifest.json"), source);
  await writeJson(taskManifestPath, taskManifest);
  await writeJson(referenceManifestPath, referenceManifest);
  await writeJson(truthManifestPath, truthManifest);
  return {
    root,
    taskDir,
    sourceDir,
    workspaceDir,
    referenceDir,
    taskManifestPath,
    referenceManifestPath,
    truthManifestPath,
    taskManifest,
    referenceManifest,
    truthManifest
  };
}

type SubmissionValidation =
  | { ok: true; status: "not-reproduced"; submission: Extract<HistoricalPostgresSubmission, { status: "not-reproduced" }> }
  | { ok: true; status: "reproduced"; submission: Extract<HistoricalPostgresSubmission, { status: "reproduced" }>; reproducerPath: string }
  | { ok: false; diagnostic: string; integrity?: boolean };

/**
 * `not-reproduced` requires only a non-empty summary; `reproduced` also
 * requires a valid, in-workspace reproducer. A `not-reproduced` submission's
 * `reproducer` field (if present at all) is never read here or by the grader
 * - a miss must never be upgraded to `rediscovered` just because a stray
 * value happens to distinguish the two revisions.
 */
export async function validateHistoricalPostgresSubmission(workspaceDir: string): Promise<SubmissionValidation> {
  const findingPath = join(workspaceDir, "finding.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(findingPath, "utf8"));
  } catch (error) {
    return { ok: false, diagnostic: `finding.json is missing or invalid JSON: ${(error as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, diagnostic: "finding.json must be an object" };
  const value = parsed as Record<string, unknown>;
  const status = value.status;
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (status !== "reproduced" && status !== "not-reproduced") {
    return { ok: false, diagnostic: 'finding.json requires status to be "reproduced" or "not-reproduced"' };
  }
  if (!summary) return { ok: false, diagnostic: "finding.json requires a non-empty summary" };
  if (status === "not-reproduced") {
    return { ok: true, status, submission: { status, summary } };
  }

  const reproducer = typeof value.reproducer === "string" ? value.reproducer.trim() : "";
  if (!reproducer) return { ok: false, diagnostic: 'finding.json requires reproducer when status is "reproduced"' };
  if (basename(reproducer) !== reproducer || reproducer === "." || reproducer === "..") {
    return { ok: false, integrity: true, diagnostic: "reproducer must name a file directly inside the workspace" };
  }
  const reproducerPath = resolve(workspaceDir, reproducer);
  try {
    const [workspaceReal, reproReal, details] = await Promise.all([realpath(workspaceDir), realpath(reproducerPath), stat(reproducerPath)]);
    if (relative(workspaceReal, reproReal).startsWith("..") || details.isDirectory()) {
      return { ok: false, integrity: true, diagnostic: "reproducer resolves outside the workspace or is not a file" };
    }
    if (details.size > MAX_HISTORICAL_POSTGRES_REPRO_BYTES) {
      return { ok: false, integrity: true, diagnostic: `reproducer exceeds ${MAX_HISTORICAL_POSTGRES_REPRO_BYTES} byte limit` };
    }
  } catch (error) {
    return { ok: false, diagnostic: `reproducer is missing or unreadable: ${(error as Error).message}` };
  }
  return { ok: true, status, submission: { status, summary, reproducer }, reproducerPath };
}

/**
 * Given one revision's captured execution and the task's optional
 * `truth.behavioralOracle`, decides `reproduced` and (when an oracle is
 * declared) the structural `attribution` evidence behind it. Pure and
 * side-effect free - no PostgreSQL/Docker/filesystem I/O - specifically so
 * this decision is directly unit-testable without a real cluster; see
 * `resolveOracleReproduction` tests in `test/historical-postgres-002-task.test.ts`
 * and `evaluateOracleAttribution` tests in `test/historical-behavioral-oracle.test.ts`.
 *
 * Absent an oracle, `reproduced` is exactly the legacy `execution.ok`
 * differential (case 001, and any synthetic/unit-test spec): zero behavior
 * change, and `gradeHistoricalPostgresSubmission()` classifies from it
 * unchanged. When an oracle is declared, this tests the captured
 * observations against *both* halves of the oracle (via
 * `evaluateOracleAttribution()`) - not just the historical half - which is
 * what lets `attributedTo` distinguish "matches the known regression",
 * "matches the declared expected/fixed behavior", and "matched neither"
 * (`"unattributed"`): a run that fails for some unrelated reason on the
 * reference revision no longer collapses into the same "not reproduced" bit
 * as a run that correctly confirmed the fix. `reproduced` is retained only
 * as an informational summary (`attributedTo === "historical"`); the
 * classifier below consumes `attribution` directly.
 */
export function resolveOracleReproduction(input: {
  execution: Pick<PostgresQueryResult, "ok" | "stdout" | "stderr" | "exitCode" | "durationMs">;
  revision: string;
  spec: HistoricalPostgresTaskSpec;
}): { reproduced: boolean; attribution?: HistoricalPostgresOracleAttribution | HistoricalPostgresStructuredOracleAttribution } {
  const structuredOracle = input.spec.truth.structuredOracle;
  if (structuredOracle) {
    const validity = classifyExecutionValidity(input.execution);
    // Structured oracle reads stdout (tuples-only query output, already
    // captured by psqlFile() in runtime-container.ts via psqlArgs() -X -t -A),
    // not stderr. A client/transport/runtime failure passes empty stdout to
    // evaluateStructuredOracleAttribution, which gates attribution on validity.
    const attribution = evaluateStructuredOracleAttribution(input.execution.stdout, structuredOracle, validity);
    return { reproduced: attribution.attributedTo === "historical", attribution };
  }
  const behavioralOracle = input.spec.truth.behavioralOracle;
  if (!behavioralOracle) return { reproduced: input.execution.ok };
  const validity = classifyExecutionValidity(input.execution);
  // A client/transport/runtime failure never gets to claim it "matched"
  // anything - observations from an execution we can't even trust are
  // discarded before evaluation, not merely likely to fail to match.
  // Structured (not just message text) so a pattern that opts into
  // `sqlstate` checking (#200 fourth review round, Blocking 2) can actually
  // see it.
  const observations = validity.valid ? extractPsqlErrorMessages(input.execution.stderr) : [];
  const attribution = evaluateOracleAttribution(observations, behavioralOracle, validity);
  return { reproduced: attribution.attributedTo === "historical", attribution };
}

async function defaultGradeRevision(input: GradeRevisionInput): Promise<HistoricalPostgresRevisionObservation> {
  const root = await createAgentEnvRoot("historical-grade-");
  const envSpec: PostgresResearchSpec = {
    root,
    privateDir: join(input.artifactDir, "private"),
    source: { repoPath: input.spec.source.repoPath, ref: input.revision },
    build: input.spec.build,
    label: `historical-grader:${input.spec.taskId}`
  };
  let observation: HistoricalPostgresRevisionObservation | undefined;
  let environment: PostgresResearchEnvironment | undefined;
  await withPostgresResearchEnvironment(envSpec, async (env) => {
    environment = env;
    await env.start();
    const execution = await env.psqlFile(input.reproducerPath);
    await mkdir(input.artifactDir, { recursive: true });
    await writeJson(join(input.artifactDir, "source-manifest.json"), env.sourceManifest);
    await writeJson(join(input.artifactDir, "build-manifest.json"), env.buildManifest);
    await writeJson(join(input.artifactDir, "runtime-manifest.live.json"), env.runtimeManifest());
    await writeJson(join(input.artifactDir, "grader-execution.json"), execution);
    await cp(env.logPath, join(input.artifactDir, "postgres.log"));
    const { reproduced, attribution } = resolveOracleReproduction({ execution, revision: input.revision, spec: input.spec });
    if (attribution) await writeJson(join(input.artifactDir, "attribution-result.json"), attribution);
    observation = { reproduced, execution, attribution, sourceManifest: env.sourceManifest, buildManifest: env.buildManifest, runtimeManifest: env.runtimeManifest() };
  });
  const finalRuntimeManifest = environment!.runtimeManifest();
  await writeJson(join(input.artifactDir, "runtime-manifest.json"), finalRuntimeManifest);
  observation!.runtimeManifest = finalRuntimeManifest;
  return observation!;
}

/**
 * Deterministically grades an agent-owned SQL script. A successful script is
 * the contract's assertion that the regression is observable; success on the
 * corrected revision therefore invalidates rediscovery credit.
 *
 * `not-reproduced` never runs the two-revision reproducer grader at all -
 * that is what keeps a legitimate miss from being silently upgraded to
 * `rediscovered` by a `reproducer` field the submission did not rely on.
 */
export async function gradeHistoricalPostgresSubmission(input: {
  task: HistoricalPostgresTaskSpec;
  workspaceDir: string;
  artifactDir: string;
  gradeRevision?: GradeRevision;
}): Promise<HistoricalPostgresGrade> {
  const task = checkedTaskSpec(input.task);
  const artifacts: string[] = [];
  await mkdir(input.artifactDir, { recursive: true });
  const validated = await validateHistoricalPostgresSubmission(input.workspaceDir);
  if (!validated.ok) {
    const result: HistoricalPostgresGrade = {
      taskId: task.taskId,
      status: validated.integrity ? "integrity_error" : "invalid_submission",
      historical: { reproduced: false },
      reference: { reproduced: false },
      artifacts,
      diagnostics: [validated.diagnostic],
      gradedAt: nowIso()
    };
    await writeJson(join(input.artifactDir, "grade.json"), result);
    return result;
  }
  if (validated.status === "not-reproduced") {
    const result: HistoricalPostgresGrade = {
      taskId: task.taskId,
      status: "miss",
      historical: { reproduced: false },
      reference: { reproduced: false },
      artifacts,
      diagnostics: ["Submission reported not-reproduced; the two-revision reproducer grader did not run."],
      gradedAt: nowIso()
    };
    await writeJson(join(input.artifactDir, "grade.json"), result);
    return result;
  }

  const gradeRevision = input.gradeRevision ?? defaultGradeRevision;
  try {
    const historicalDir = join(input.artifactDir, "historical");
    const referenceDir = join(input.artifactDir, "reference");
    const [historical, reference] = await Promise.all([
      gradeRevision({ revision: task.source.historicalRevision, reproducerPath: validated.reproducerPath, artifactDir: historicalDir, spec: task }),
      gradeRevision({ revision: task.source.referenceRevision, reproducerPath: validated.reproducerPath, artifactDir: referenceDir, spec: task })
    ]);
    artifacts.push(historicalDir, referenceDir);
    // Oracle-declared tasks (case 002+) classify from structural
    // `attribution`, not the `reproduced` boolean, in four parts (#200
    // third review round):
    //   1. either side's execution being uninterpretable (client/transport/
    //      runtime failure - see classifyExecutionValidity()) is always
    //      `infrastructure_error`, checked first, before anything below ever
    //      gets a chance to call it a miss/invalid submission;
    //   2. `rediscovered` requires the reference run to *positively* match
    //      the declared expected (fixed) baseline, not merely "not match the
    //      historical signature" - an unattributed reference-side outcome
    //      (`attributedTo === "unattributed"`) is `invalid_submission`, the
    //      same bucket as "reference still shows the historical signature";
    //   3. the public contract (see historicalPostgres002TaskPrompt()) still
    //      requires the *submitted reproducer itself* to self-assert - exit
    //      0 only on the historical ref, non-zero only on the reference ref,
    //      exactly case 001's convention. The behavioral oracle is an
    //      *additional* requirement on top of that contract, never a
    //      replacement for it: a submission whose captured text matches the
    //      declared signatures but whose own exit status doesn't follow the
    //      public contract must not be credited either.
    // A task without a declared oracle (case 001, and any synthetic/unit-test
    // spec) takes the untouched legacy branch - byte-for-byte the same as
    // before this classification-model change.
    const oracleDriven = Boolean(task.truth.behavioralOracle) || Boolean(task.truth.structuredOracle);
    const infrastructureInvalid =
      oracleDriven && (historical.attribution?.validity.valid === false || reference.attribution?.validity.valid === false);
    const selfAssertionConsistent = Boolean(historical.execution?.ok) && reference.execution?.ok === false;
    const status: HistoricalPostgresGradeStatus = oracleDriven
      ? infrastructureInvalid
        ? "infrastructure_error"
        : historical.attribution?.attributedTo !== "historical"
          ? "miss"
          : reference.attribution?.attributedTo !== "reference"
            ? "invalid_submission"
            : !selfAssertionConsistent
              ? "invalid_submission"
              : "rediscovered"
      : !historical.reproduced
        ? "miss"
        : reference.reproduced
          ? "invalid_submission"
          : "rediscovered";
    const diagnostics: string[] = [];
    if (oracleDriven) {
      if (status === "infrastructure_error") {
        if (historical.attribution?.validity.valid === false) {
          diagnostics.push(`Historical revision execution was not valid/interpretable: ${historical.attribution.validity.reason}`);
        }
        if (reference.attribution?.validity.valid === false) {
          diagnostics.push(`Reference revision execution was not valid/interpretable: ${reference.attribution.validity.reason}`);
        }
      } else if (status === "miss") {
        diagnostics.push(...(historical.attribution?.historicalMatch.diagnostics ?? []));
      } else if (status === "invalid_submission") {
        if (reference.attribution?.attributedTo !== "reference") {
          diagnostics.push(
            reference.attribution?.attributedTo === "historical"
              ? "The submitted reproducer's captured behavior on the reference revision still matches the historical regression signature - not target-specific."
              : "The reference revision's captured behavior matched neither the historical signature nor the declared expected reference behavior - this differential is not attributable to the declared oracle."
          );
        } else if (!selfAssertionConsistent) {
          diagnostics.push(
            "The submitted reproducer's own exit status does not follow the required self-asserting contract (must exit 0 only on the historical revision, non-zero only on the reference revision), even though its captured behavior matched the declared oracle."
          );
        }
      }
    } else if (status === "invalid_submission") {
      diagnostics.push("The submitted reproducer also succeeded on the corrected reference revision, so it is not target-specific.");
    }
    const result = { taskId: task.taskId, status, historical, reference, artifacts, diagnostics, gradedAt: nowIso() };
    await writeJson(join(input.artifactDir, "grade.json"), result);
    return result;
  } catch (error) {
    const result: HistoricalPostgresGrade = {
      taskId: task.taskId,
      status: "infrastructure_error",
      historical: { reproduced: false },
      reference: { reproduced: false },
      artifacts,
      diagnostics: [`Grader infrastructure failed: ${(error as Error).message}`],
      gradedAt: nowIso()
    };
    await writeJson(join(input.artifactDir, "grade.json"), result);
    return result;
  }
}

/**
 * The #184 real-agent composition. It intentionally delegates lifecycle,
 * isolation, source materialization, build and runtime setup to the existing
 * session implementation, then grades the files returned from its writable
 * workspace. A valid miss is therefore a completed trial, while setup errors
 * cannot be confused with a score.
 */
export async function runHistoricalPostgresTrial(input: {
  task: HistoricalPostgresTaskSpec;
  agent: PostgresResearchAgentSpec;
  artifactDir: string;
  session?: PostgresResearchSessionOptions;
  /** Injectable for tests (e.g. a fixture with `isolation.scoredEligible: false`); defaults to the real session runner. */
  runSession?: typeof runAgentInPostgresResearchEnvironment;
}): Promise<HistoricalPostgresTrial> {
  const task = checkedTaskSpec(input.task);
  const artifacts: string[] = [];
  const runSession = input.runSession ?? runAgentInPostgresResearchEnvironment;
  try {
    await mkdir(input.artifactDir, { recursive: true });
    const taskLayout = await materializeHistoricalPostgresTask(task, join(input.artifactDir, "task-bundle"));
    artifacts.push(taskLayout.taskDir, taskLayout.referenceDir);
    const session: PostgresResearchSessionResult = await runSession(
      {
        root: await createAgentEnvRoot("historical-agent-"),
        privateDir: join(input.artifactDir, "agent-private"),
        source: { repoPath: task.source.repoPath, ref: task.source.historicalRevision },
        build: task.build,
        label: `historical-agent:${task.taskId}`
      },
      {
        ...input.agent,
        // The session's dynamic workspace is the only writable directory an
        // isolated agent sees. Keep the public prompt alongside the dynamic
        // PostgreSQL coordinates, never by mounting the task/reference root.
        // task.taskId is the opaque agent-visible id - never the truth bundle's
        // upstreamBug/commitFest/referenceRevision, which stay grader-private.
        env: { ...(input.agent.env ?? {}), HONEYRAIL_TASK_ID: task.taskId, HONEYRAIL_TASK_PROMPT: task.prompt }
      },
      input.session
    );
    const scoredEligible = session.isolation.scoredEligible;
    const returnedWorkspace = join(input.artifactDir, "agent-workspace");
    await assertWorkspaceWithinLimits(session.workspaceDir);
    await cp(session.workspaceDir, returnedWorkspace, { recursive: true, dereference: false });
    artifacts.push(returnedWorkspace);
    await writeJson(join(input.artifactDir, "agent-result.json"), session);
    await writeFile(join(input.artifactDir, "agent-stdout.txt"), session.agent.stdout ?? "");
    await writeFile(join(input.artifactDir, "agent-stderr.txt"), session.agent.stderr ?? "");
    const evidenceWarnings: string[] = [];
    // The PostgreSQL server log from the agent's own live investigation
    // session - distinct from (and in addition to) any per-revision grading
    // log the two-revision grader below writes under grader/{historical,reference}.
    // A copy failure must be visible, not swallowed: this is required #184 evidence.
    if (session.runtime?.logPath) {
      try {
        await cp(session.runtime.logPath, join(input.artifactDir, "agent-postgres.log"));
      } catch (error) {
        evidenceWarnings.push(`evidence_warning: could not retain the agent's own PostgreSQL log: ${(error as Error).message}`);
      }
    } else {
      evidenceWarnings.push("evidence_warning: session reported no runtime.logPath for the agent's own PostgreSQL log.");
    }
    // Grader-private convenience copies at the artifact root; the agent never
    // saw this artifactDir, only its bind-mounted workspace above.
    await writeJson(join(input.artifactDir, "task-manifest.json"), taskLayout.taskManifest);
    await writeJson(join(input.artifactDir, "reference-manifest.json"), taskLayout.referenceManifest);
    await writeJson(join(input.artifactDir, "reference-truth.json"), taskLayout.truthManifest);
    if (!session.agent.ok) {
      return {
        taskId: task.taskId,
        status: "blocked",
        scoredEligible,
        workspaceDir: returnedWorkspace,
        agent: session.agent,
        artifacts,
        diagnostics: [
          session.agent.timedOut ? "Agent timed out before submission." : "Agent exited without a successful completed run.",
          ...evidenceWarnings
        ]
      };
    }
    // A diagnostic grade is still useful evidence even when the run is not
    // scored-eligible, but it must never be reported as a completed score:
    // see HistoricalPostgresTrialStatus - "unscored" exists precisely so a
    // consumer cannot mistake a bridge-network smoke run for a scored miss
    // or rediscovery.
    const grade = await gradeHistoricalPostgresSubmission({ task, workspaceDir: returnedWorkspace, artifactDir: join(input.artifactDir, "grader") });
    artifacts.push(join(input.artifactDir, "grader"));
    const status: HistoricalPostgresTrialStatus =
      grade.status === "integrity_error"
        ? "integrity_error"
        : grade.status === "infrastructure_error"
          ? "infrastructure_error"
          : scoredEligible
            ? "completed"
            : "unscored";
    const unscoredNotice = !scoredEligible && status === "unscored" ? [`Not a scored trial: ${session.isolation.warning ?? "isolation was not scored-eligible."}`] : [];
    return {
      taskId: task.taskId,
      status,
      scoredEligible,
      workspaceDir: returnedWorkspace,
      agent: session.agent,
      grade,
      artifacts,
      diagnostics: [...unscoredNotice, ...grade.diagnostics, ...evidenceWarnings]
    };
  } catch (error) {
    return {
      taskId: task.taskId,
      status: error instanceof HistoricalPostgresIntegrityError ? "integrity_error" : "infrastructure_error",
      scoredEligible: false,
      agent: {},
      artifacts,
      diagnostics: [
        error instanceof HistoricalPostgresIntegrityError
          ? `Historical PostgreSQL trial integrity failed: ${error.message}`
          : `Historical PostgreSQL trial infrastructure failed: ${(error as Error).message}`
      ]
    };
  }
}

/**
 * Public task copy for the selected #184 case. It intentionally omits the
 * answer/reproducer, and - unlike the historical `commitfest7059*` names -
 * the returned taskId and prompt never mention the CommitFest entry or the
 * upstream report; those live only in `truth`, which the caller must not
 * hand to an agent.
 */
export function historicalPostgres001TaskPrompt() {
  return `# PostgreSQL correctness-testing assignment

Investigate the supplied PostgreSQL source and a locally running PostgreSQL instance for a correctness issue in join planning. Design focused SQL tests, inspect relevant source and documentation, and save any useful test scripts in the writable workspace.

If you observe a reproducible behavioral correctness problem, write \`finding.json\` with \`status: "reproduced"\`, a concise summary, and the name of a runnable SQL reproducer. The reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion. If no reproducible issue is found, write \`finding.json\` with \`status: "not-reproduced"\` and a concise summary.\n`;
}

/**
 * @param knownReproducerPath Optional private path (e.g. from
 *   `HONEYRAIL_PG_184_REPRODUCER`) to a canonical verification reproducer.
 *   Used only to compute a provenance hash for the truth bundle; never read
 *   by the grader.
 */
export function historicalPostgres001TaskSpec(repoPath: string, knownReproducerPath?: string): HistoricalPostgresTaskSpec {
  return {
    taskId: "postgres-historical-001",
    source: {
      repoPath,
      historicalRevision: "07fdee7c8a8b415fb3a2991e7aea34f08975d445",
      referenceRevision: "2ebf25e7d70a8fce31ace78d723fa9271ab8af72"
    },
    truth: { upstreamBug: "PostgreSQL #19560", commitFest: 7059, knownReproducerPath },
    scaffoldingLevel: "minimal",
    budget: {},
    prompt: historicalPostgres001TaskPrompt()
  };
}

/**
 * Public task copy for the #200 case (#185's Bug 2 slot). Same discipline as
 * historicalPostgres001TaskPrompt(): the prompt never names the upstream bug
 * report, the CommitFest (there isn't one for this case - see
 * HistoricalPostgresTaskSpec.truth.commitFest), or the DDL/cache-invalidation
 * mechanism specifically enough to point an agent at it; those live only in
 * `truth`.
 */
export function historicalPostgres002TaskPrompt() {
  return `# PostgreSQL correctness-testing assignment

Investigate the supplied PostgreSQL source and a locally running PostgreSQL instance for a correctness issue involving PL/pgSQL procedures and schema changes. Design focused SQL tests - including sessions that alter procedures or their dependencies mid-session - inspect relevant source and documentation, and save any useful test scripts in the writable workspace.

If you observe a reproducible behavioral correctness problem, write \`finding.json\` with \`status: "reproduced"\`, a concise summary, and the name of a runnable SQL reproducer. The reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion. If no reproducible issue is found, write \`finding.json\` with \`status: "not-reproduced"\` and a concise summary.\n`;
}

/**
 * The exact confirmed observations from #185's manual validation against
 * real PostgreSQL 14.13 (buggy) and 14.14 (fixed) builds. `\d+` for the
 * stale-plan OID is a targeted, anchored pattern - never a broad
 * "strip every digit" transform - so a meaningful numeric difference
 * elsewhere in a message could never be silently erased.
 */
const HISTORICAL_POSTGRES_002_BASELINE_ERROR = '^procedure parameter "r1" is an output parameter but corresponding argument is not writable$';

/**
 * @param knownReproducerPath Optional private path (e.g. from
 *   `HONEYRAIL_PG_200_REPRODUCER`) to a canonical verification reproducer.
 *   Used only to compute a provenance hash for the truth bundle; never read
 *   by the grader. Intentionally not committed to this repository - see
 *   docs/historical-postgres-task-v0.md. `scripts/historical-postgres-200.ts`
 *   - unlike case 001's script - requires this for its real trial entrypoint,
 *   since a real Bug 2 run without canonical truth provenance is not
 *   acceptable for this task; the parameter itself stays optional here so
 *   synthetic/unit-test specs can omit it.
 */
export function historicalPostgres002TaskSpec(repoPath: string, knownReproducerPath?: string): HistoricalPostgresTaskSpec {
  return {
    // Opaque, matching `postgres-historical-001`'s convention. The
    // descriptive corpus slot id `pg-hist-plpgsql-call-stale-plan-002`
    // (#185) names PL/pgSQL, CALL and "stale plan" outright and must never
    // be agent-visible (it would leak the failure mechanism through the
    // task manifest / HONEYRAIL_TASK_ID) - it stays a code/doc reference
    // only, for administrative traceability back to #185.
    taskId: "postgres-historical-002",
    source: {
      repoPath,
      historicalRevision: "7696b2ea52416cc2f4046a359d3b6f760e4c013d",
      referenceRevision: "7f875fb5bd603d8640cc7aca2c79c604aacd3890"
    },
    truth: {
      upstreamBug: "PostgreSQL BUG #18574",
      // No CommitFest entry exists for this bug - it was reported directly
      // to pgsql-bugs, not submitted through a CommitFest - so commitFest is
      // omitted rather than fabricated. See HistoricalPostgresTaskSpec.truth.
      knownReproducerPath,
      // Generic, declarative oracle (see historical-behavioral-oracle.ts):
      // requires the submitted reproducer's own captured stderr to contain
      // these two ERROR observations, in order, before the historical ref
      // counts as reproduced or the reference ref counts as the baseline.
      // This is what keeps an unrelated revision-discriminating script from
      // earning `rediscovered` credit for a different bug entirely.
      behavioralOracle: {
        historical: [
          { label: "first CALL", matches: HISTORICAL_POSTGRES_002_BASELINE_ERROR },
          { label: "second CALL", matches: "^cache lookup failed for function \\d+$" }
        ],
        reference: [
          { label: "first CALL", matches: HISTORICAL_POSTGRES_002_BASELINE_ERROR },
          { label: "second CALL", matches: HISTORICAL_POSTGRES_002_BASELINE_ERROR }
        ]
      }
    },
    scaffoldingLevel: "minimal",
    budget: {},
    prompt: historicalPostgres002TaskPrompt()
  };
}

/**
 * Operator-supplied private truth for case 003 (issue #199). Passed at
 * runtime via `loadHistoricalPostgres003PrivateTruth()` — never committed to
 * this repository. The script `scripts/historical-postgres-199.ts` reads this
 * from a local JSON file pointed to by `HONEYRAIL_PG_199_PRIVATE_TRUTH`.
 * Synthetic values are used in unit tests.
 */
export type HistoricalPostgresCase003PrivateTruth = {
  upstreamBug: string;
  historicalRevision: string;
  referenceRevision: string;
  structuredOracle: HistoricalPostgresStructuredOracle;
};

/**
 * Loads and validates operator-supplied private truth for case 003 from a
 * local JSON file. Throws loudly (not falling back to any default) if the
 * file is missing, unreadable, malformed, or missing required fields — same
 * "task-authoring bug must be loud" discipline as `assertValidExpectedRows()`
 * in `historical-structured-oracle.ts`.
 *
 * The file's contents flow only into the returned
 * `HistoricalPostgresCase003PrivateTruth` object (and from there into
 * `truth.*` in `historicalPostgres003TaskSpec()`). Nothing is ever written
 * under `task/` from this data directly.
 */
export async function loadHistoricalPostgres003PrivateTruth(filePath: string): Promise<HistoricalPostgresCase003PrivateTruth> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`loadHistoricalPostgres003PrivateTruth: could not read or parse ${filePath}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`loadHistoricalPostgres003PrivateTruth: ${filePath} must contain a JSON object`);
  }
  const value = raw as Record<string, unknown>;
  const upstreamBug = typeof value.upstreamBug === "string" ? value.upstreamBug.trim() : "";
  if (!upstreamBug) throw new Error(`loadHistoricalPostgres003PrivateTruth: ${filePath} missing or empty "upstreamBug"`);
  // Validate revision format: must be a pinned 40-character hex SHA. Reuses the
  // private exactRevision() helper already used by checkedTaskSpec() — same
  // module, no need to export it.
  const historicalRevision = exactRevision(
    typeof value.historicalRevision === "string" ? value.historicalRevision.trim() : "",
    `loadHistoricalPostgres003PrivateTruth: ${filePath} "historicalRevision"`
  );
  const referenceRevision = exactRevision(
    typeof value.referenceRevision === "string" ? value.referenceRevision.trim() : "",
    `loadHistoricalPostgres003PrivateTruth: ${filePath} "referenceRevision"`
  );
  const oracle = value.structuredOracle;
  if (!oracle || typeof oracle !== "object" || Array.isArray(oracle)) {
    throw new Error(`loadHistoricalPostgres003PrivateTruth: ${filePath} missing or invalid "structuredOracle"`);
  }
  const oracleObj = oracle as Record<string, unknown>;
  for (const side of ["historical", "reference"] as const) {
    const sideVal = oracleObj[side];
    if (!sideVal || typeof sideVal !== "object" || Array.isArray(sideVal)) {
      throw new Error(`loadHistoricalPostgres003PrivateTruth: ${filePath} structuredOracle.${side} must be an object`);
    }
    const sideValObj = sideVal as Record<string, unknown>;
    // Validate `ordered` type when present — task-authoring bug must be loud.
    if ("ordered" in sideValObj && typeof sideValObj.ordered !== "boolean") {
      throw new Error(
        `loadHistoricalPostgres003PrivateTruth: ${filePath} structuredOracle.${side}.ordered must be a boolean when present; got ${typeof sideValObj.ordered}`
      );
    }
    // Reuse the exported oracle row validators from historical-structured-oracle.ts
    // so this loader and evaluateStructuredOracle() enforce the same rules without
    // duplication. Both throw loudly on malformed private truth — a task-authoring
    // bug must fail at load time, not later when the grader happens to run.
    assertValidExpectedRows(sideValObj.rows);
    assertNoDelimiterInExpectedRows(sideValObj.rows, "|");
  }
  // An oracle that can't structurally distinguish the two revisions is a
  // task-authoring bug and must fail loudly at load time rather than only
  // surfacing later as "always unattributed." Use the same semantic-overlap
  // check that checkedTaskSpec() enforces generically — one definition of
  // "overlap", not two subtly different implementations.
  if (structuredExpectationsOverlap(oracleObj.historical as HistoricalPostgresStructuredExpectation, oracleObj.reference as HistoricalPostgresStructuredExpectation)) {
    throw new Error(
      `loadHistoricalPostgres003PrivateTruth: ${filePath} structuredOracle.historical and .reference expectations overlap and cannot be attributed unambiguously — the oracle cannot distinguish the two revisions`
    );
  }
  return { upstreamBug, historicalRevision, referenceRevision, structuredOracle: value.structuredOracle as HistoricalPostgresStructuredOracle };
}


/**
 * Public task prompt for the #199 case (#185's Bug 3 slot). Same
 * discipline as historicalPostgres001TaskPrompt() / historicalPostgres002TaskPrompt():
 * the prompt describes the *category* (transaction state, session
 * characteristics) without naming the specific failure mechanism (`COMMIT AND
 * CHAIN`, subtransaction, savepoint interaction) in a way that would directly
 * point an agent at the root cause. Those live only in `truth`.
 */
export function historicalPostgres003TaskPrompt() {
  return `# PostgreSQL correctness-testing assignment

Investigate the supplied PostgreSQL source and a locally running PostgreSQL instance for a correctness issue involving transaction state and session-level transaction characteristics. Design focused SQL tests - including sessions that use explicit transaction characteristics and transaction control statements - inspect relevant source and documentation, and save any useful test scripts in the writable workspace.

If you observe a reproducible behavioral correctness problem, write \`finding.json\` with \`status: "reproduced"\`, a concise summary, and the name of a runnable SQL reproducer. The reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion. If no reproducible issue is found, write \`finding.json\` with \`status: "not-reproduced"\` and a concise summary.\n`;
}

/**
 * @param privateTruth Operator-supplied private truth (upstream bug identity,
 *   both pinned revisions, and the structured oracle). Never hardcoded in this
 *   file — load it at runtime via `loadHistoricalPostgres003PrivateTruth()`.
 *   Synthetic values are fine for unit tests.
 * @param knownReproducerPath Optional private path (e.g. from
 *   `HONEYRAIL_PG_199_REPRODUCER`) to a canonical verification reproducer.
 *   Used only to compute a provenance hash for the truth bundle; never read
 *   by the grader. Intentionally not committed to this repository.
 *   `scripts/historical-postgres-199.ts` requires this for its real trial
 *   entrypoint; the parameter stays optional here so synthetic/unit-test
 *   specs can omit it.
 */
export function historicalPostgres003TaskSpec(
  repoPath: string,
  privateTruth: HistoricalPostgresCase003PrivateTruth,
  knownReproducerPath?: string
): HistoricalPostgresTaskSpec {
  return {
    // Opaque, matching `postgres-historical-001`/`-002` convention. The
    // descriptive corpus slot id `pg-hist-xact-chain-savepoint-003` (#185)
    // names the transaction-chain/savepoint mechanism outright and must never
    // be agent-visible - it stays a code/doc reference only, for
    // administrative traceability back to #185.
    taskId: "postgres-historical-003",
    source: {
      repoPath,
      historicalRevision: privateTruth.historicalRevision,
      referenceRevision: privateTruth.referenceRevision
    },
    truth: {
      upstreamBug: privateTruth.upstreamBug,
      // No CommitFest entry exists for this bug - reported directly to
      // pgsql-bugs, same as case 002. See HistoricalPostgresTaskSpec.truth.
      knownReproducerPath,
      // Generic, declarative structured-output oracle (see
      // historical-structured-oracle.ts): requires the submitted reproducer's
      // own captured stdout (tuples-only, already guaranteed by psqlArgs())
      // to return the exact tuples declared here, per revision. This is what
      // keeps an unrelated revision-discriminating script from earning
      // `rediscovered` credit for a different bug or mechanism entirely.
      structuredOracle: privateTruth.structuredOracle
    },
    scaffoldingLevel: "minimal",
    budget: {},
    prompt: historicalPostgres003TaskPrompt()
  };
}
