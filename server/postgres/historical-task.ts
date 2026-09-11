import { createHash } from "node:crypto";
import { cp, lstat, mkdir, opendir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { nowIso, runCommandSafe } from "../utils.js";
import {
  createAgentEnvRoot,
  materializePostgresSource,
  withPostgresResearchEnvironment,
  defaultBuildMode,
  resolveBuildEnv,
  BUILD_PROFILE_VERSION,
  DEFAULT_CONFIGURE_ARGS,
  DEFAULT_INITDB_ARGS,
  type PostgresBuildManifest,
  type PostgresBuildSpec,
  type PostgresQueryResult,
  type PostgresResearchEnvironment,
  type PostgresResearchSpec
} from "./research-environment.js";
import { DEFAULT_BUILDER_IMAGE, resolveBuilderImageIdentity, probeBuildContainerToolchain } from "./build-container.js";
import { DEFAULT_RUNTIME_IMAGE, resolveRuntimeImageIdentity } from "./runtime-container.js";
import type { RunCommand } from "./runtime.js";
import {
  runAgentInPostgresResearchEnvironment,
  type PostgresResearchAgentSpec,
  type PostgresResearchSessionOptions,
  type PostgresResearchSessionResult
} from "./research-session.js";
import { foldSessionStatsReport, readBoundedDshSessionTelemetry, type DshRawEvent } from "../evals/dsh-session-stats.js";
import { buildTranscriptLines } from "../evals/dsh-transcript.js";
import { deriveTrajectoryEvents } from "../evals/dsh-trajectory-bridge.js";
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
 * A `gradingProtocol` string names which *family* of oracle graded a task
 * (exit-status / behavioral / structured), but the classification logic
 * inside that family - `gradeHistoricalPostgresSubmission()`'s 4-step
 * classifier, `resolveOracleReproduction()`, `classifyExecutionValidity()`'s
 * exit-code allow-list, `evaluateOracleAttribution()`/
 * `evaluateStructuredOracleAttribution()` - can itself change scoring
 * semantics for an *existing* task without changing that protocol string at
 * all (#201 PR #206 review, Blocking 2). Bump this integer whenever such a
 * change is made, so `truthShape.graderBundleVersion` below - and therefore
 * `bundleHash`/`truthBundleHash`/the corpus hash that aggregates it - moves
 * even though `gradingProtocol` itself is unchanged. A simple explicit
 * version counter, not source-code introspection, per that review's
 * preference for "a simple explicit versioned grader contract... over
 * fragile runtime source-code introspection."
 */
export const HISTORICAL_POSTGRES_GRADER_BUNDLE_VERSION = 1;

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
  /**
   * Optional change-oriented context for `HistoricalChangeTask v0` (#212).
   * When present, enables E0-E3 scaffolding levels that progressively expose
   * a contemporaneous SPEC, the full introducing change-set diff, and a
   * generic test-engineering HarnessProfile to the agent. All existing tasks
   * (001/002/003) omit this entirely — Policy A: the serialized key itself
   * is absent, so no legacy hash moves.
   *
   * The materializer handles this generically: "if changeContext is present,
   * materialize the artifacts the scaffoldingLevel selects" — never
   * "if taskId == postgres-change-001".
   */
  changeContext?: HistoricalPostgresChangeContext;
};

/**
 * Change-oriented context for a `HistoricalChangeTask v0` (#212). Supplies
 * the content that `materializeHistoricalPostgresTask()` writes into agent-
 * visible files when the task's `scaffoldingLevel` selects them:
 *
 * - `E0`: none of these artifacts are materialized (blind baseline)
 * - `E1`: `spec` → `task/spec.md`
 * - `E2`: `spec` + introducing diff → `task/spec.md` + `task/change-set.diff`
 * - `E3`: all of the above + `harnessProfile` → `task/harness-profile.md`
 *
 * The introducing diff is generated deterministically at materialization
 * time from `introducingCommit` and the local mirror in `source.repoPath`.
 */
export type HistoricalPostgresChangeContext = {
  /** Contemporaneous specification content (written as `task/spec.md` at E1+). */
  spec: string;
  /**
   * The introducing commit whose full `git diff <parent>..<commit>` becomes
   * `task/change-set.diff` at E2+. Must be a pinned 40-character hex SHA
   * resolvable in `source.repoPath`.
   */
  introducingCommit: string;
  /**
   * Generic test-engineering methodology profile (written as
   * `task/harness-profile.md` at E3). Must not contain bug-specific
   * terminology — it should be reusable across unrelated tasks.
   */
  harnessProfile?: string;
  /**
   * When true, `materializeHistoricalPostgresTask()` skips its default check
   * that `source.historicalRevision` and `changeContext.introducingCommit`
   * resolve to the same commit (#212's original guarantee: the agent's
   * source tree and the diff it is shown always come from one change).
   *
   * This exists for a within-family sibling-defect replication study (#233)
   * whose frozen source/oracle (`historicalPostgres003TaskSpec()`, #199/#201)
   * deliberately postdates the introducing commit it exposes as E2/E3
   * context — re-materializing the task around the introduction commit would
   * change the already-validated task and weaken attribution, so the shown
   * diff and the scored source snapshot are intentionally allowed to differ.
   *
   * Default `false`/absent preserves the original #212 guarantee byte-for-
   * byte for every existing `HistoricalChangeTask` (`postgres-change-001`/
   * `-002`). Only set this deliberately, per task, with the reason recorded
   * at the call site — it is not a general escape hatch.
   */
  allowHistoricalSourceDivergence?: boolean;
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
  artifacts: {
    sourceManifest: string;
    prompt: string;
    workspace: string;
    /**
     * Present only when the task declares `changeContext` and `scaffoldingLevel`
     * selects E1+. Omitted (not null) for legacy tasks — Policy A.
     */
    spec?: string;
    /**
     * Present only when the task declares `changeContext` and `scaffoldingLevel`
     * selects E2+. Omitted (not null) for legacy tasks — Policy A.
     */
    changeSet?: string;
    /**
     * Present only when the task declares `changeContext` with a
     * `harnessProfile` and `scaffoldingLevel` selects E3. Omitted (not null)
     * for legacy tasks — Policy A.
     */
    harnessProfile?: string;
  };
  hashes: {
    sourceTree: string;
    prompt: string;
    taskDefinition: string;
    truthBundle: string;
    /**
     * Hash of the initial agent-visible `task/workspace/` scaffolding (e.g.
     * the generated README) at materialization time - never post-agent
     * output. Closes the gap where the agent-visible workspace contract
     * could change without moving any other hash (#201 PR #206 review,
     * Blocking 2). Already folded into `taskDefinition` too; exposed here
     * directly so the corpus layer can surface it per-task without
     * recomputing it.
     */
    agentWorkspace: string;
    /**
     * Hash of the declarative build/runtime contract this task is scored
     * under - see `resolveHistoricalPostgresBuildContract()`. Already folded
     * into `taskDefinition` too; exposed here directly for the same reason
     * as `agentWorkspace` above.
     */
    buildContract: string;
  };
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
  /** See HISTORICAL_POSTGRES_GRADER_BUNDLE_VERSION - always present, unlike the Policy-A-conditional oracle/fix-evidence fields below. */
  graderBundleVersion: number;
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
  /**
   * The build/runtime identity this grader revision's own research
   * environment actually resolved - same shape (and same extraction helper,
   * `extractHistoricalPostgresTrialExecutionEnvironment()`) as
   * `HistoricalPostgresTrial.executionEnvironment` for the agent's own
   * session. The final `rediscovered`/`miss`/`invalid_submission` result
   * comes from *this* revision's own execution, not the agent's - so a
   * caller proving "the official score used the frozen environment" must
   * check this too, not only the agent session (#180 P0 2 / #207 review
   * round 2, P0 Blocking 1).
   */
  executionEnvironment?: HistoricalPostgresTrialExecutionEnvironment;
};

/**
 * Which branch of `gradeHistoricalPostgresSubmission()` actually produced
 * `status` - an explicit marker (#207 review round 3, Blocking 1) rather than
 * inferring it from diagnostics text or from whether `historical`/`reference`
 * happen to carry an `execution`/`executionEnvironment`:
 *
 * - `"invalid"`: the submission itself failed validation before either
 *   revision was ever considered (missing/malformed `finding.json`, an
 *   escaping/oversized reproducer, ...). Neither grader revision ran.
 * - `"not_reproduced"`: a validated submission explicitly reported
 *   `"not-reproduced"` - a real, legitimate capability miss. Neither grader
 *   revision runs for this path *by design* (see the diagnostic message this
 *   branch already writes), so there is nothing there to verify or distrust.
 * - `"reproducer"`: a validated `"reproduced"` submission was actually
 *   graded against both the historical and reference revisions.
 *
 * This is what lets a caller (the #180 pilot's execution-binding check, in
 * particular) distinguish "an execution that was required but never ran" -
 * a real evidentiary gap - from "an execution this grading path never
 * needed in the first place" - see `HistoricalPostgresRevisionObservation.executionEnvironment`.
 */
export type HistoricalPostgresGradingPath = "invalid" | "not_reproduced" | "reproducer";

export type HistoricalPostgresGrade = {
  taskId: string;
  status: HistoricalPostgresGradeStatus;
  gradingPath: HistoricalPostgresGradingPath;
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

/**
 * The build/runtime identity actually used by this trial's real execution -
 * as opposed to `HistoricalPostgresEnvironmentFingerprint`, which is what a
 * *separate* preflight resolution observed beforehand. Two independent
 * resolutions of a mutable image tag can disagree if the tag was repointed in
 * between (#180 P0 2); a caller that needs to prove "the execution really
 * used the environment preflight verified" compares this against that
 * fingerprint after the fact. Only the fields that are actually re-resolved
 * per execution (never a static declarative default) are included -
 * `initdbArgs` is a fixed constant and cannot drift, so it is deliberately
 * not part of this type.
 */
export type HistoricalPostgresTrialExecutionEnvironment = {
  buildMode: string;
  buildProfileVersion: string;
  configureArgs: string[];
  buildEnv: Record<string, string>;
  builderImage: { reference: string; id: string } | null;
  runtimeImage: { reference: string; id: string } | null;
  compiler: { command: string; version: string; target: string };
};

/**
 * Extracts `HistoricalPostgresTrialExecutionEnvironment` from a real
 * `PostgresBuildManifest`/`runtimeManifest()` pair - the one shape shared by
 * both the agent's own session (`PostgresResearchSessionResult.build`/
 * `.runtime`) and each grader revision's independent research environment
 * (`defaultGradeRevision()`'s `env.buildManifest`/`env.runtimeManifest()`),
 * so both call sites derive execution-binding evidence identically rather
 * than duplicating the extraction (#207 review round 2, P0 Blocking 1).
 */
function extractHistoricalPostgresTrialExecutionEnvironment(
  build: PostgresBuildManifest,
  runtime: ReturnType<PostgresResearchEnvironment["runtimeManifest"]>
): HistoricalPostgresTrialExecutionEnvironment {
  return {
    buildMode: build.buildMode,
    buildProfileVersion: build.profileVersion,
    configureArgs: [...build.configureArgs],
    buildEnv: { ...build.buildEnv },
    builderImage: build.builderImage ? { reference: build.builderImage.reference, id: build.builderImage.id } : null,
    runtimeImage: runtime.runtime.image ? { reference: runtime.runtime.image.reference, id: runtime.runtime.image.id } : null,
    compiler: { command: build.compiler.command, version: build.compiler.version, target: build.compiler.target }
  };
}

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
  /** Present whenever a session was actually obtained (i.e. not on a materialization/setup throw before one existed). */
  executionEnvironment?: HistoricalPostgresTrialExecutionEnvironment;
  artifacts: string[];
  diagnostics: string[];
};

export type GradeRevisionInput = {
  revision: string;
  reproducerPath: string;
  artifactDir: string;
  spec: HistoricalPostgresTaskSpec;
};

export type GradeRevision = (input: GradeRevisionInput) => Promise<HistoricalPostgresRevisionObservation>;

class HistoricalPostgresIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalPostgresIntegrityError";
  }
}

/**
 * Exported (not just locally used) so `historical-corpus.ts` computes the
 * corpus-level manifest hash with the exact same canonicalize+sha256
 * algorithm as every per-task truth/task-definition hash in this file,
 * rather than a second copy that could silently drift from this one.
 */
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function canonicalize(value: unknown): unknown {
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

export const stableJson = (value: unknown) => JSON.stringify(canonicalize(value), null, 2);

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

/**
 * The declarative build/runtime contract a task is scored under - not an
 * observed, machine-specific fact (a locally built image's content-addressed
 * id, a compiler version actually detected on some runner), which would make
 * a frozen corpus hash non-reproducible across operators/machines, but the
 * same declared knobs `withPostgresResearchEnvironment()` already resolves
 * `PostgresBuildSpec` overrides against - reused directly from
 * `research-environment.ts`/`build-container.ts`/`runtime-container.ts`
 * rather than duplicated. `gradeHistoricalPostgresSubmission()` passes
 * `task.build` unchanged to both revisions' `defaultGradeRevision()`, so one
 * contract covers both. Closes the gap where `buildProfile: "container"`
 * alone could not detect a changed configure argument, builder/runtime image
 * reference, or build-environment override (#201 PR #206 review, Blocking
 * 2). `HistoricalPostgresTaskSpec` has no per-task runtime-image override
 * today, so the runtime image is always the resolved default; if one is ever
 * added, it belongs here too.
 *
 * Deliberately stays synchronous and Docker-free, so materialization (and
 * every offline/synthetic test that calls it) never needs a daemon: `mode`
 * is resolved through the exact same `defaultBuildMode()`
 * `buildPostgres()` itself calls (#201 PR #206 second review, Blocking 1,
 * Problem C - the two resolution paths must not disagree, and now cannot,
 * since both call the same function), and `env` is the exact same
 * `resolveBuildEnv()` pass-through `buildPostgres()` hashes into its own
 * build cache key (Problem B - an ambient `CFLAGS`/`pgac_cv_*` override that
 * would change the actual binaries now changes this too). What this
 * function cannot cover without Docker - the builder/runtime image's
 * resolved content-addressed id and the compiler actually observed inside
 * the build container (Problem A) - is `resolveHistoricalPostgresEnvironmentFingerprint()`
 * below, a separate operator/grader-side step collected once during the
 * real freeze rather than on every materialization.
 */
function resolveHistoricalPostgresBuildContract(build?: PostgresBuildSpec): {
  mode: string;
  buildProfileVersion: string;
  builderImage: string;
  configureArgs: string[];
  initdbArgs: string[];
  runtimeImage: string;
  env: Record<string, string>;
} {
  return {
    mode: build?.mode ?? defaultBuildMode(),
    buildProfileVersion: BUILD_PROFILE_VERSION,
    builderImage: build?.builderImage ?? DEFAULT_BUILDER_IMAGE,
    configureArgs: [...(build?.configureArgs ?? DEFAULT_CONFIGURE_ARGS)],
    initdbArgs: [...DEFAULT_INITDB_ARGS],
    runtimeImage: DEFAULT_RUNTIME_IMAGE,
    env: resolveBuildEnv(process.env, build?.env ?? {})
  };
}

export type HistoricalPostgresEnvironmentFingerprint = {
  buildMode: string;
  buildProfileVersion: string;
  configureArgs: string[];
  initdbArgs: string[];
  /** Effective BUILD_ENV_VARS/BUILD_ENV_PREFIXES pass-through - see resolveBuildEnv(). */
  buildEnv: Record<string, string>;
  /** Resolved, content-addressed - never just the mutable tag. See resolveBuilderImageIdentity(). */
  builderImage: { reference: string; id: string };
  /** Resolved, content-addressed - never just the mutable tag. See resolveRuntimeImageIdentity(). */
  runtimeImage: { reference: string; id: string };
  /** Observed inside the build container - see probeBuildContainerToolchain(). */
  compiler: { command: string; version: string; target: string };
};

/**
 * The grader/operator-side resolved execution-environment fingerprint (#201
 * PR #206 second review, Blocking 1): everything `resolveHistoricalPostgresBuildContract()`
 * cannot know without a docker daemon. Collected once during the real Corpus
 * v0 freeze (`scripts/historical-postgres-201-freeze.ts`), never during
 * ordinary task materialization - `materializeHistoricalPostgresTask()` must
 * stay usable against a synthetic fixture repo with no docker daemon at all
 * (every offline test in this codebase depends on that), so this is a
 * separate, explicitly-invoked step rather than something folded into it.
 *
 * Reuses the identical resolvers the real build/runtime path already uses
 * - `resolveBuilderImageIdentity()`/`resolveRuntimeImageIdentity()`
 * (content-addressed image ids, never a mutable tag alone - Problem A) and
 * `probeBuildContainerToolchain()` (the compiler actually observed inside
 * the build container) - rather than a second, weaker identity model.
 * `runCommand` and `ambientEnv` are both injectable so this is unit-testable
 * with a fake docker responder and a fake environment object, with no daemon
 * and no mutation of global `process.env`.
 */
export async function resolveHistoricalPostgresEnvironmentFingerprint(input: {
  build?: PostgresBuildSpec;
  runtimeImage?: string;
  runCommand?: RunCommand;
  ambientEnv?: NodeJS.ProcessEnv;
}): Promise<HistoricalPostgresEnvironmentFingerprint> {
  const runCommand = input.runCommand ?? runCommandSafe;
  const ambientEnv = input.ambientEnv ?? process.env;
  const buildMode = input.build?.mode ?? defaultBuildMode(ambientEnv);
  const configureArgs = [...(input.build?.configureArgs ?? DEFAULT_CONFIGURE_ARGS)];
  const initdbArgs = [...DEFAULT_INITDB_ARGS];
  const buildEnv = resolveBuildEnv(ambientEnv, input.build?.env ?? {});
  const builderImageRef = input.build?.builderImage ?? DEFAULT_BUILDER_IMAGE;
  const runtimeImageRef = input.runtimeImage ?? DEFAULT_RUNTIME_IMAGE;
  const builderImage = await resolveBuilderImageIdentity(builderImageRef, runCommand);
  const runtimeImage = await resolveRuntimeImageIdentity(runtimeImageRef, runCommand);
  // Probe the already-resolved content-addressed id, never the mutable
  // tag again: resolving an id and then re-resolving the tag for the probe
  // would leave a TOCTOU window where the tag could be repointed in between,
  // producing an impossible mixed fingerprint (builderImage.id from A,
  // compiler identity from B) - same closure as buildPostgres() itself
  // (#207 review round 2, P0 Blocking 2).
  const toolchain = await probeBuildContainerToolchain({ image: builderImage.id, runCommand, buildEnv });
  return {
    buildMode,
    buildProfileVersion: BUILD_PROFILE_VERSION,
    configureArgs,
    initdbArgs,
    buildEnv,
    builderImage: { reference: builderImage.reference, id: builderImage.id },
    runtimeImage: { reference: runtimeImage.reference, id: runtimeImage.id },
    compiler: toolchain.compiler
  };
}

/** Stable hash of a resolved environment fingerprint - same canonicalize+sha256 algorithm as every other hash in this module. */
export function hashHistoricalPostgresEnvironmentFingerprint(fingerprint: HistoricalPostgresEnvironmentFingerprint): string {
  return sha256(stableJson(fingerprint));
}

function exactRevision(value: string, field: string) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${field} must be a pinned 40-character commit SHA`);
  return value.toLowerCase();
}

async function resolveHistoricalPostgresCommit(repoPath: string, revision: string, field: string): Promise<string> {
  const result = await runCommandSafe(
    "git",
    ["-C", repoPath, "rev-parse", "--verify", `${revision}^{commit}`],
    { timeout: 60_000, maxBuffer: 1024 * 1024 }
  );
  if (!result.ok) {
    throw new Error(
      `Could not resolve ${field} ${revision} in ${repoPath}: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return exactRevision(result.stdout.trim(), `${field} resolved commit`);
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
  // Change-context validation (#212). Only validates when present — legacy
  // tasks that omit changeContext skip this entirely, keeping their behaviour
  // byte-identical.
  if (spec.changeContext !== undefined) {
    if (!String(spec.changeContext.spec || "").trim()) {
      throw new Error("changeContext.spec is required when changeContext is present");
    }
    exactRevision(spec.changeContext.introducingCommit, "changeContext.introducingCommit");
    if (!(["E0", "E1", "E2", "E3"] as const).includes(spec.scaffoldingLevel as "E0" | "E1" | "E2" | "E3")) {
      throw new Error("changeContext requires scaffoldingLevel to be exactly E0, E1, E2, or E3");
    }
    if (spec.scaffoldingLevel === "E3" && !String(spec.changeContext.harnessProfile || "").trim()) {
      throw new Error("changeContext.harnessProfile is required when scaffoldingLevel is E3");
    }
    if (spec.changeContext.harnessProfile !== undefined && !String(spec.changeContext.harnessProfile || "").trim()) {
      throw new Error("changeContext.harnessProfile must be non-empty when present");
    }
  }
  const historicalRevision = exactRevision(spec.source.historicalRevision, "source.historicalRevision");
  const referenceRevision = exactRevision(spec.source.referenceRevision, "source.referenceRevision");
  if (historicalRevision === referenceRevision) throw new Error("historical and reference revisions must differ");
  return { ...spec, source: { ...spec.source, historicalRevision, referenceRevision } };
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Bounded top-N lists in the persisted inventory (#209) - large enough to be useful, small enough to never itself become an unbounded-evidence problem. */
export const HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP = 50;

/**
 * The core evidence contract a scored Historical PostgreSQL capability
 * sample requires (PR #210 review round 3, Blocking 1). An otherwise
 * scored-eligible, `agent.ok === true`, within-limit trial must not proceed
 * to grading - and therefore can never become an official `rediscovered`/
 * `miss` dataset sample - unless every one of these persisted successfully.
 * Tracked directly from each artifact's own persistence attempt, never
 * inferred later by scanning the artifact directory.
 */
export const HISTORICAL_POSTGRES_REQUIRED_CORE_EVIDENCE = ["agent-result.json", "agent-stdout.txt", "agent-stderr.txt", "workspace-inventory.json"] as const;

/**
 * Historical PG's own DSH raw-telemetry sanity policy (PR #210 review round
 * 5, Blocking 3b; bounded-discovery/decoded/event limits added round 6,
 * Blocking 1) - harness safety, never a substitute for
 * `MAX_HISTORICAL_POSTGRES_WORKSPACE_{FILES,BYTES}`, which polices
 * agent-authored task output, not agent-tamperable diagnostic telemetry.
 * `$DSH_HOME` is writable by a process running inside the agent container,
 * so nothing else bounds its growth. Chosen comfortably above every real
 * TRAIN001 run observed so far (observed real runs range from several
 * thousand to tens of thousands of raw events - e.g. 43,156 on one round-6
 * candidate cell - across single-digit megabytes of raw/decoded telemetry,
 * a handful of directory entries under `sessions/`) rather than tuned to
 * any one run - large
 * enough that ordinary DSH telemetry never approaches any of these
 * boundaries, small enough to still catch a runaway or adversarially large
 * `$DSH_HOME` before it can force a large allocation.
 *
 * `MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_ENTRIES` bounds the cheapest
 * resource first: every directory entry visited while walking `sessions/`
 * (matching or not), so a tree of purely non-matching junk files stops
 * during discovery rather than after fully enumerating it.
 * `MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_FILES`/`_BYTES` bound the matching
 * `.jsonl`/`.jsonl.zstd` files themselves and their on-disk (compressed, for
 * `.zstd`) bytes. `MAX_HISTORICAL_POSTGRES_DSH_DECODED_BYTES` is a
 * deliberately separate bound on *decoded* bytes - a small compressed file
 * can still expand into a much larger plaintext buffer, so the on-disk
 * bound alone cannot protect against that. `MAX_HISTORICAL_POSTGRES_DSH_EVENTS`
 * bounds the total recovered raw events, independent of decoded bytes
 * (many tiny events could otherwise stay under the byte bound while still
 * producing a pathologically large in-memory array).
 */
export const MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_ENTRIES = 5_000;
export const MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_FILES = 500;
export const MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_BYTES = 200 * 1024 * 1024;
export const MAX_HISTORICAL_POSTGRES_DSH_DECODED_BYTES = 256 * 1024 * 1024;
export const MAX_HISTORICAL_POSTGRES_DSH_EVENTS = 200_000;

/** The `DshSessionTelemetryLimits` this module passes to `readBoundedDshSessionTelemetry()` for every trial - one definition, reused rather than reconstructed at each call site. */
const HISTORICAL_POSTGRES_DSH_TELEMETRY_LIMITS = {
  maxEntries: MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_ENTRIES,
  maxFiles: MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_FILES,
  maxBytes: MAX_HISTORICAL_POSTGRES_DSH_TELEMETRY_BYTES,
  maxDecodedBytes: MAX_HISTORICAL_POSTGRES_DSH_DECODED_BYTES,
  maxEvents: MAX_HISTORICAL_POSTGRES_DSH_EVENTS
};

type CappedFileEntry = { path: string; bytes: number };
type CappedTopLevelEntry = { path: string; fileCount: number; totalBytes: number };

/**
 * Inserts `candidate` into `topN` (bounded to `cap`, ordered by `isBetter`)
 * if it belongs there, evicting the current worst-ranked entry when already
 * at capacity. `topN` never grows past `cap` - the PR #210 review fix for an
 * earlier implementation that accumulated every entry into an unbounded
 * array before sorting once at the end (unbounded memory/CPU for exactly the
 * untrusted, potentially huge workspaces this code exists to handle). Used
 * for both `largestFiles` and `topLevelEntries` - one small generic helper
 * rather than two near-duplicate ones.
 */
function offerCapped<T>(topN: T[], candidate: T, cap: number, isBetter: (a: T, b: T) => boolean): void {
  if (topN.length < cap) {
    const insertAt = topN.findIndex((entry) => isBetter(candidate, entry));
    topN.splice(insertAt === -1 ? topN.length : insertAt, 0, candidate);
    return;
  }
  const worst = topN[topN.length - 1];
  if (!isBetter(candidate, worst)) return;
  const insertAt = topN.findIndex((entry) => isBetter(candidate, entry));
  topN.splice(insertAt, 0, candidate);
  topN.pop();
}

/** Descending bytes, ties broken by ascending path - deterministic regardless of filesystem readdir order. */
const fileRanksBefore = (a: CappedFileEntry, b: CappedFileEntry): boolean => a.bytes > b.bytes || (a.bytes === b.bytes && a.path < b.path);
/** Same rule, keyed on a subtree's aggregate bytes instead of one file's. */
const topLevelRanksBefore = (a: CappedTopLevelEntry, b: CappedTopLevelEntry): boolean => a.totalBytes > b.totalBytes || (a.totalBytes === b.totalBytes && a.path < b.path);

export type HistoricalPostgresWorkspaceMeasurement = {
  totalFiles: number;
  totalBytes: number;
  /** Sorted descending by totalBytes (ties broken by ascending path), bounded to HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP entries throughout the walk. */
  topLevelEntries: CappedTopLevelEntry[];
  /** Sorted descending by bytes (ties broken by ascending path), bounded to HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP entries throughout the walk - never a full file list. */
  largestFiles: CappedFileEntry[];
};

/**
 * The single walk both the workspace-size policy check and the persisted
 * `workspace-inventory.json` evidence (#209) are derived from, so the two
 * can never disagree about what the workspace actually contained. Always
 * completes the full walk rather than early-exiting once a limit is crossed
 * (unlike the policy check this replaces) - the point of this function is an
 * accurate total, not a fast abort. `totalFiles`/`totalBytes` are exact
 * regardless of workspace size; only the *lists* (`largestFiles`,
 * `topLevelEntries`) are bounded.
 *
 * Bounded-memory with respect to file count (PR #210 review round 3,
 * Blocking 2): uses `opendir()`'s async iterator rather than
 * `readdir(..., {withFileTypes:true})`, which materializes an entire
 * directory's entries into one array before returning - a real concern once
 * a single directory can hold tens of thousands of agent-authored files, as
 * a real TRAIN001 run already did. Each top-level entry's own subtree is
 * fully aggregated (`walkSubtree`) before being offered to the bounded
 * `topLevelEntries` top-N and discarded - at most one subtree aggregate plus
 * the two bounded top-N lists are ever held at once, never a map keyed by
 * every top-level name.
 *
 * Same non-following-of-symlinks discipline as the check it replaces:
 * `lstat`, never `stat`, on each file - a reproducer symlink is validated
 * only when actually selected as the submission, never dereferenced while
 * merely measuring agent-owned output.
 */
export async function measureHistoricalPostgresWorkspace(root: string): Promise<HistoricalPostgresWorkspaceMeasurement> {
  let totalFiles = 0;
  let totalBytes = 0;
  const topLevelEntries: CappedTopLevelEntry[] = [];
  const largestFiles: CappedFileEntry[] = [];

  const recordFile = (entryPath: string, bytes: number): void => {
    totalFiles += 1;
    totalBytes += bytes;
    offerCapped(largestFiles, { path: relative(root, entryPath), bytes }, HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP, fileRanksBefore);
  };

  /**
   * `for await...of` on an `fs.Dir` already closes the handle once iteration
   * completes normally; closing it again throws `ERR_DIR_CLOSED`. On an
   * early exit (an exception thrown from inside the loop body, e.g. `lstat`
   * failing mid-walk) the handle is not guaranteed closed, so `finally`
   * still needs to try - this just tolerates the already-closed case rather
   * than assuming one or the other.
   */
  async function closeDirQuietly(dir: { close: () => Promise<void> }): Promise<void> {
    try {
      await dir.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ERR_DIR_CLOSED") throw error;
    }
  }

  /** Fully aggregates one subtree's own fileCount/totalBytes - the only per-subtree state ever held at once. */
  async function walkSubtree(path: string): Promise<{ fileCount: number; totalBytes: number }> {
    let fileCount = 0;
    let bytes = 0;
    const dir = await opendir(path);
    try {
      for await (const entry of dir) {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) {
          const sub = await walkSubtree(entryPath);
          fileCount += sub.fileCount;
          bytes += sub.totalBytes;
          continue;
        }
        const details = await lstat(entryPath);
        fileCount += 1;
        bytes += details.size;
        recordFile(entryPath, details.size);
      }
    } finally {
      await closeDirQuietly(dir);
    }
    return { fileCount, totalBytes: bytes };
  }

  const rootDir = await opendir(root);
  try {
    for await (const entry of rootDir) {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        const subtree = await walkSubtree(entryPath);
        offerCapped(topLevelEntries, { path: entry.name, ...subtree }, HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP, topLevelRanksBefore);
      } else {
        const details = await lstat(entryPath);
        recordFile(entryPath, details.size);
        offerCapped(topLevelEntries, { path: entry.name, fileCount: 1, totalBytes: details.size }, HISTORICAL_POSTGRES_WORKSPACE_INVENTORY_CAP, topLevelRanksBefore);
      }
    }
  } finally {
    await closeDirQuietly(rootDir);
  }

  return { totalFiles, totalBytes, topLevelEntries, largestFiles };
}

/** True exactly when a workspace measurement violates the (unchanged) 2048-file / 16MiB policy - the one authoritative decision this module makes, independent of whether any evidence artifact can be persisted. */
export function isHistoricalPostgresWorkspaceOverLimit(measurement: HistoricalPostgresWorkspaceMeasurement): boolean {
  return measurement.totalFiles > MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES || measurement.totalBytes > MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES;
}

function workspaceLimitExceededMessage(measurement: HistoricalPostgresWorkspaceMeasurement): string {
  return `agent workspace exceeds limits (${measurement.totalFiles} files, ${measurement.totalBytes} bytes; maximum ${MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES} files and ${MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES} bytes)`;
}

/**
 * The smallest reusable redaction boundary for "known injected sensitive
 * values" (PR #210 review, Blocking 3) - not a generic secret scanner.
 * `input.agent.env` (the caller-supplied environment for the agent process -
 * e.g. a model API key) is, by construction, exactly the set of values this
 * module was ever explicitly handed as sensitive; nothing else this module
 * sees is treated as a secret. A short-value floor avoids redacting common,
 * non-sensitive flags (`"none"`, `"1"`, ...) that happen to appear in
 * `agent.env` too - real credentials are comfortably longer.
 */
const HISTORICAL_POSTGRES_SECRET_REDACTION_MIN_LENGTH = 12;

function collectKnownSecretValues(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.values(env).filter((value) => value.length >= HISTORICAL_POSTGRES_SECRET_REDACTION_MIN_LENGTH);
}

/** Replaces every occurrence of a known secret value with a fixed marker - never logs or persists the value itself in the process of doing so. */
function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

/**
 * Same redaction boundary, applied recursively to an arbitrary JSON-shaped
 * value (#209/#210 round 4) - DSH's own raw session events and derived
 * trajectory events are nested objects (tool arguments, assistant messages,
 * tool results), not flat strings, so a known secret could otherwise survive
 * inside any string leaf of that structure.
 */
function redactSecretsDeep<T>(value: T, secrets: readonly string[]): T {
  if (!secrets.length) return value;
  if (typeof value === "string") return redactKnownSecrets(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactSecretsDeep(item, secrets)) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecretsDeep(item, secrets)])) as unknown as T;
  }
  return value;
}

export type HistoricalPostgresWorkspaceInventory = {
  schemaVersion: 1;
  totalFiles: number;
  totalBytes: number;
  limits: { maxFiles: number; maxBytes: number };
  exceeded: { files: boolean; bytes: boolean };
  topLevelEntries: HistoricalPostgresWorkspaceMeasurement["topLevelEntries"];
  largestFiles: HistoricalPostgresWorkspaceMeasurement["largestFiles"];
};

/**
 * A bounded evidence projection - counts only, plus paths - never the full
 * oversized workspace itself. Paths are agent-controlled input, so
 * `secrets` (see collectKnownSecretValues()) is applied to every persisted
 * path: a filename is not inherently safe just because it is "only a path".
 */
export function buildHistoricalPostgresWorkspaceInventory(measurement: HistoricalPostgresWorkspaceMeasurement, secrets: readonly string[] = []): HistoricalPostgresWorkspaceInventory {
  const redactPath = <T extends { path: string }>(entry: T): T => (secrets.length ? { ...entry, path: redactKnownSecrets(entry.path, secrets) } : entry);
  return {
    schemaVersion: 1,
    totalFiles: measurement.totalFiles,
    totalBytes: measurement.totalBytes,
    limits: { maxFiles: MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES, maxBytes: MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES },
    exceeded: { files: measurement.totalFiles > MAX_HISTORICAL_POSTGRES_WORKSPACE_FILES, bytes: measurement.totalBytes > MAX_HISTORICAL_POSTGRES_WORKSPACE_BYTES },
    topLevelEntries: measurement.topLevelEntries.map(redactPath),
    largestFiles: measurement.largestFiles.map(redactPath)
  };
}

export type HistoricalPostgresSafeAgentExecutionSummary = {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutSource?: "agent" | "session";
  confirmedStopped?: boolean;
  terminationError?: string;
  startedAt: string;
  durationMs: number;
};

function sanitizeAgentExecutionSummary(agent: PostgresResearchSessionResult["agent"], secrets: readonly string[]): HistoricalPostgresSafeAgentExecutionSummary {
  return {
    ok: agent.ok,
    exitCode: agent.exitCode,
    signal: agent.signal,
    timedOut: agent.timedOut,
    timeoutSource: agent.timeoutSource,
    confirmedStopped: agent.confirmedStopped,
    terminationError: agent.terminationError ? redactKnownSecrets(agent.terminationError, secrets) : agent.terminationError,
    startedAt: agent.startedAt,
    durationMs: agent.durationMs
  };
}

export type HistoricalPostgresSafeIsolationSummary = {
  mode: string;
  isolated: boolean;
  scoredEligible: boolean;
  networkMode?: string;
  restrictedEgressVerified?: boolean;
  /** The resolved, immutable agent image identity - never the mutable tag alone (same discipline as #198's TrialSet identity). */
  imageIdentity?: { reference: string; id: string };
  /**
   * #197 evidence (PR #210 review round 3, Blocking 3): which gateway
   * enforced the restricted-egress boundary, not just that a boolean claims
   * one did. `restrictedEgressVerified: true` alone cannot answer "which
   * gateway bytes actually relayed model traffic" - this can. Never the raw
   * `egressGateway` record, which additionally carries `containerName` (no
   * evidentiary value beyond what `internalNetworkName` already gives) and
   * an internal `imageIdentitySchemaVersion` counter this projection
   * deliberately omits rather than growing to track.
   */
  egressGateway?: {
    internalNetworkName: string;
    upstreamHost: string;
    internalVerified: boolean;
    imageIdentity: { reference: string; id: string };
  };
};

function sanitizeIsolationSummary(isolation: PostgresResearchSessionResult["isolation"]): HistoricalPostgresSafeIsolationSummary {
  const record = isolation as {
    mode: string;
    isolated: boolean;
    scoredEligible: boolean;
    networkMode?: string;
    restrictedEgressVerified?: boolean;
    imageIdentity?: { reference: string; id: string };
    egressGateway?: { internalNetworkName: string; upstreamHost: string; internalVerified: boolean; imageIdentity: { reference: string; id: string } };
  };
  return {
    mode: record.mode,
    isolated: record.isolated,
    scoredEligible: record.scoredEligible,
    networkMode: record.networkMode,
    restrictedEgressVerified: record.restrictedEgressVerified,
    imageIdentity: record.imageIdentity ? { reference: record.imageIdentity.reference, id: record.imageIdentity.id } : undefined,
    egressGateway: record.egressGateway
      ? {
          internalNetworkName: record.egressGateway.internalNetworkName,
          upstreamHost: record.egressGateway.upstreamHost,
          internalVerified: record.egressGateway.internalVerified,
          imageIdentity: { reference: record.egressGateway.imageIdentity.reference, id: record.egressGateway.imageIdentity.id }
        }
      : undefined
  };
}

export type HistoricalPostgresSafeSessionEvidence = {
  schemaVersion: 1;
  agent: HistoricalPostgresSafeAgentExecutionSummary;
  isolation: HistoricalPostgresSafeIsolationSummary;
  /** Already-public build/runtime metadata only - see HistoricalPostgresTrialExecutionEnvironment's own docstring. Never grader-private truth, never a host path. */
  executionEnvironment: HistoricalPostgresTrialExecutionEnvironment;
};

/**
 * The one explicit, versioned, whitelisted projection of a real agent
 * session this module ever persists to `agent-result.json` (#209/PR #210
 * review, Blocking 2) - never the raw `PostgresResearchSessionResult`, which
 * carries `agentEnvironment` (exactly what was exported into the agent
 * process - e.g. a model API key), `source`/`build`/`runtime` (host paths
 * and internal detail beyond what HistoricalPostgresTrialExecutionEnvironment
 * already whitelists), and `stdout`/`stderr` (already persisted separately,
 * so duplicating them here would be redundant, not just risky).
 *
 * Retains enough to explain *under what environment* the agent ran
 * (isolation/confinement mode, network/restricted-egress verification,
 * resolved agent image identity, build/runtime/compiler identity) alongside
 * the agent's own execution outcome - the two things #209's investigation
 * actually needed and the old raw-session dump accidentally buried a secret
 * inside of.
 */
function buildSafeSessionEvidence(session: PostgresResearchSessionResult, executionEnvironment: HistoricalPostgresTrialExecutionEnvironment, secrets: readonly string[]): HistoricalPostgresSafeSessionEvidence {
  return {
    schemaVersion: 1,
    agent: sanitizeAgentExecutionSummary(session.agent, secrets),
    isolation: sanitizeIsolationSummary(session.isolation),
    executionEnvironment
  };
}

/** Materializes a clean scored task tree and a separate grader-only reference tree. */
export async function materializeHistoricalPostgresTask(spec: HistoricalPostgresTaskSpec, root: string): Promise<HistoricalPostgresTaskLayout> {
  let input = checkedTaskSpec(spec);
  if (input.changeContext) {
    // A change-oriented task must expose the exact change that produced the
    // source tree the agent investigates. Checking resolved object IDs, not
    // merely the pinned input strings, rejects aliases and unrelated commits
    // without introducing a broader revision-relation model.
    const [historicalRevision, introducingCommit] = await Promise.all([
      resolveHistoricalPostgresCommit(input.source.repoPath, input.source.historicalRevision, "source.historicalRevision"),
      resolveHistoricalPostgresCommit(input.source.repoPath, input.changeContext.introducingCommit, "changeContext.introducingCommit")
    ]);
    if (historicalRevision !== introducingCommit && !input.changeContext.allowHistoricalSourceDivergence) {
      throw new Error(
        `HistoricalChangeTask source.historicalRevision (${historicalRevision}) must resolve to the same commit as changeContext.introducingCommit (${introducingCommit}). Set changeContext.allowHistoricalSourceDivergence to intentionally show a different commit's diff than the scored source snapshot.`
      );
    }
    input = {
      ...input,
      source: { ...input.source, historicalRevision },
      changeContext: { ...input.changeContext, introducingCommit }
    };
  }
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
  // Hashed here, immediately after the only file materialization ever writes
  // into workspaceDir and before anything else touches it - never post-agent
  // output, which lives in a wholly separate directory (see
  // runHistoricalPostgresTrial()'s own `session.workspaceDir`).
  const agentWorkspaceHash = await hashDirectoryContents(workspaceDir);
  const buildContract = resolveHistoricalPostgresBuildContract(input.build);
  const buildContractHash = sha256(stableJson(buildContract));

  // Change-context artifact materialization (#212). Progressively exposes
  // contemporaneous SPEC, the full introducing change-set diff, and a generic
  // test-engineering HarnessProfile based on scaffoldingLevel:
  //   E0 (or no changeContext): nothing
  //   E1: spec.md
  //   E2: spec.md + change-set.diff
  //   E3: spec.md + change-set.diff + harness-profile.md
  // The artifact hashes (when generated) are folded into taskDefinition via
  // the Policy A spread pattern, so legacy tasks that omit changeContext
  // produce byte-identical taskDefinition hashes.
  const scaffolding = input.scaffoldingLevel ?? "minimal";
  const scaffoldingRank = scaffolding === "E3" ? 3 : scaffolding === "E2" ? 2 : scaffolding === "E1" ? 1 : 0;
  let changeContextHashes: { spec: string; changeSet?: string; harnessProfile?: string } | undefined;
  let changeContextArtifacts: { spec?: string; changeSet?: string; harnessProfile?: string } | undefined;
  if (input.changeContext && scaffoldingRank >= 1) {
    const specPath = join(taskDir, "spec.md");
    await writeFile(specPath, `${input.changeContext.spec.trim()}\n`);
    const specHash = sha256(await readFile(specPath));
    changeContextHashes = { spec: specHash };
    changeContextArtifacts = { spec: "spec.md" };

    if (scaffoldingRank >= 2) {
      // Generate the full introducing diff deterministically from the local
      // mirror. The introducing commit's parent is <commit>^ (first parent).
      const diffResult = await runCommandSafe(
        "git",
        [
          "-C", input.source.repoPath,
          "-c", "color.ui=false",
          "-c", "diff.external=",
          "diff", "--no-ext-diff", "--no-color", "--no-textconv", "--diff-algorithm=myers", "--no-renames",
          `${input.changeContext.introducingCommit}^`, input.changeContext.introducingCommit
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 * 8 }
      );
      if (!diffResult.ok) {
        throw new Error(
          `Could not generate change-set.diff: git diff ${input.changeContext.introducingCommit}^ ${input.changeContext.introducingCommit} in ${input.source.repoPath} failed: ${(diffResult.stderr || diffResult.stdout).trim()}`
        );
      }
      const changeSetPath = join(taskDir, "change-set.diff");
      const changeSetContents = Buffer.from(diffResult.stdout, "utf8");
      await writeFile(changeSetPath, changeSetContents);
      changeContextHashes.changeSet = sha256(changeSetContents);
      changeContextArtifacts.changeSet = "change-set.diff";
    }

    if (scaffoldingRank >= 3 && input.changeContext.harnessProfile) {
      const harnessProfilePath = join(taskDir, "harness-profile.md");
      await writeFile(harnessProfilePath, `${input.changeContext.harnessProfile.trim()}\n`);
      changeContextHashes.harnessProfile = sha256(await readFile(harnessProfilePath));
      changeContextArtifacts.harnessProfile = "harness-profile.md";
    }
  }

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
    buildProfile: input.build?.mode ?? defaultBuildMode(),
    // Both added #201 PR #206 review, Blocking 2: neither the agent-visible
    // workspace scaffolding nor the declarative build/runtime contract used
    // to be covered by any hash, so either could change while every existing
    // hash (including this one) stayed the same. Deliberately *not*
    // `gradingProtocol`/oracle content - that stays truthShape/bundleHash's
    // job, unchanged, per the documented taskDefinitionHash/bundleHash
    // boundary below.
    agentWorkspaceHash,
    buildContractHash,
    // Policy A: changeContext hashes are only present when the task actually
    // declares changeContext and scaffoldingLevel selected at least E1. Legacy
    // tasks (001/002/003) omit the key entirely, so their serialized
    // taskDefinition — and therefore taskDefinitionHash — is byte-identical
    // to what it was before #212.
    ...(changeContextHashes ? { changeContext: changeContextHashes } : {})
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
    // Always present (unlike behavioralOracle/structuredOracle/fixEvidence
    // below, which are Policy-A-conditional): every task, including a legacy
    // exit-status one, is graded by *some* version of the classifier logic,
    // so this always participates in bundleHash - closing the gap where a
    // grader-semantics change (e.g. to gradeHistoricalPostgresSubmission's
    // classification steps) would not move any hash at all as long as
    // gradingProtocol itself stayed the same (#201 PR #206 review, Blocking
    // 2). See HISTORICAL_POSTGRES_GRADER_BUNDLE_VERSION.
    graderBundleVersion: HISTORICAL_POSTGRES_GRADER_BUNDLE_VERSION,
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
    buildProfile: input.build?.mode ?? defaultBuildMode(),
    artifacts: {
      sourceManifest: "source-manifest.json",
      prompt: "prompt.md",
      workspace: "workspace",
      // Policy A: change-context artifact references are only present when
      // the materializer actually wrote those files. Legacy tasks produce
      // byte-identical manifests.
      ...(changeContextArtifacts?.spec ? { spec: changeContextArtifacts.spec } : {}),
      ...(changeContextArtifacts?.changeSet ? { changeSet: changeContextArtifacts.changeSet } : {}),
      ...(changeContextArtifacts?.harnessProfile ? { harnessProfile: changeContextArtifacts.harnessProfile } : {})
    },
    hashes: {
      sourceTree: source.sourceHash,
      prompt: taskDefinition.promptHash,
      taskDefinition: taskDefinitionHash,
      truthBundle: truthManifest.bundleHash,
      agentWorkspace: agentWorkspaceHash,
      buildContract: buildContractHash
    }
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
    observation = {
      reproduced,
      execution,
      attribution,
      sourceManifest: env.sourceManifest,
      buildManifest: env.buildManifest,
      runtimeManifest: env.runtimeManifest(),
      executionEnvironment: extractHistoricalPostgresTrialExecutionEnvironment(env.buildManifest, env.runtimeManifest())
    };
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
      gradingPath: "invalid",
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
      gradingPath: "not_reproduced",
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
    const result: HistoricalPostgresGrade = { taskId: task.taskId, status, gradingPath: "reproducer", historical, reference, artifacts, diagnostics, gradedAt: nowIso() };
    await writeJson(join(input.artifactDir, "grade.json"), result);
    return result;
  } catch (error) {
    const result: HistoricalPostgresGrade = {
      taskId: task.taskId,
      status: "infrastructure_error",
      gradingPath: "reproducer",
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
  /**
   * Explicit, caller-known expectation that this trial's agent is DSH and
   * will therefore engage `@deepseek-ai/dsh-session-persistence-jsonl`
   * (PR #210 review round 5, Blocking 1) - never inferred here from
   * `agent.command`, filesystem contents, `$DSH_HOME` existence after
   * execution, or any profile id/name. The caller that actually chose the
   * agent (the TrialSet real-agent path, `executeTrialSetCell()`) sets this
   * explicitly; the deterministic `smoke_stub` path does not. Absent means
   * "no DSH trajectory is owed" - a missing/empty `$DSH_HOME` is then
   * legitimately `not_applicable`, exactly the pre-round-5 behavior. Present
   * (`"dsh"`) means a non-empty, successfully persisted transcript is
   * required core evidence for an otherwise scored-eligible, `agent.ok`,
   * within-limit trial - see the required-evidence gate below.
   */
  trajectoryExpectation?: "dsh";
  /** Injectable for tests (e.g. a fixture with `isolation.scoredEligible: false`); defaults to the real session runner. */
  runSession?: typeof runAgentInPostgresResearchEnvironment;
  /** Injectable for tests (e.g. controlling each grader revision's reported `executionEnvironment`); defaults to the real per-revision research environment. */
  gradeRevision?: GradeRevision;
}): Promise<HistoricalPostgresTrial> {
  const task = checkedTaskSpec(input.task);
  const artifacts: string[] = [];
  const runSession = input.runSession ?? runAgentInPostgresResearchEnvironment;
  const dshTrajectoryExpected = input.trajectoryExpectation === "dsh";
  // Created only when a DSH trajectory is actually expected (PR #210 review
  // round 5, Blocking 2 "only mount it when expected") - a non-DSH agent
  // gets no extra writable mount at all. Lives outside input.artifactDir on
  // purpose: raw DSH session events are written by a process running
  // *inside* the agent container (arbitrary shell access - agent-tamperable
  // diagnostic telemetry, never immutable grader-owned evidence) and can
  // carry tool arguments/output or credential values an agent happened to
  // echo, which the derived agent-transcript.ndjson/agent-trajectory.jsonl
  // artifacts deliberately redact. Publishing the raw source into the same
  // tree those sanitized artifacts live in would let anyone who copies/
  // shares/archives the trial artifact directory recover exactly the values
  // the redaction exists to remove. `createAgentEnvRoot()` is the same
  // private per-trial temp root `historical-agent-`/`historical-grade-`
  // already use - unique per trial, starts empty, removed in this
  // function's `finally` below regardless of which return path is taken.
  let dshHomeDir: string | undefined;
  let result: HistoricalPostgresTrial;
  try {
    result = await (async (): Promise<HistoricalPostgresTrial> => {
    await mkdir(input.artifactDir, { recursive: true });
    const taskLayout = await materializeHistoricalPostgresTask(task, join(input.artifactDir, "task-bundle"));
    artifacts.push(taskLayout.taskDir, taskLayout.referenceDir);
    if (dshTrajectoryExpected) dshHomeDir = await createAgentEnvRoot("historical-dsh-home-");
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
      {
        ...input.session,
        // `taskLayout.taskDir` contains only the public task projection. The
        // sibling reference directory holds truth, fix evidence, and the
        // canonical reproducer and is never handed to the research session.
        ...(task.changeContext ? { publicTaskDir: taskLayout.taskDir } : {}),
        isolation: { ...(input.session?.isolation ?? {}), ...(dshHomeDir ? { dshHomeDir } : {}) }
      }
    );
    const scoredEligible = session.isolation.scoredEligible;
    // What this specific execution actually resolved - see
    // HistoricalPostgresTrialExecutionEnvironment. Computed once, right after
    // `session` exists, so both return paths below carry it.
    const executionEnvironment = extractHistoricalPostgresTrialExecutionEnvironment(session.build, session.runtime);
    const returnedWorkspace = join(input.artifactDir, "agent-workspace");
    const evidenceWarnings: string[] = [];
    // The exact values this trial was ever explicitly handed as sensitive -
    // see collectKnownSecretValues()'s own docstring. Computed once, reused
    // by every redaction site below.
    const knownSecrets = collectKnownSecretValues(input.agent.env);

    // #209 (PR #210 review, Blocking 1): the workspace-size policy verdict
    // is the one authoritative decision here, computed purely from the
    // measurement and never affected by whether any evidence artifact below
    // can actually be persisted. Evidence persistence is a separate,
    // best-effort concern: a failed write is recorded as an evidence
    // warning, never allowed to fall through to the outer catch and get
    // silently reclassified as "infrastructure_error". A failure to obtain
    // the measurement itself is a genuine, unmasked infrastructure failure
    // and is deliberately left to propagate to that outer catch - without a
    // measurement there is no authoritative verdict to protect at all.
    const workspaceMeasurement = await measureHistoricalPostgresWorkspace(session.workspaceDir);
    const workspaceOverLimit = isHistoricalPostgresWorkspaceOverLimit(workspaceMeasurement);

    // The core evidence contract a scored capability sample requires (PR
    // #210 review round 3, Blocking 1) - tracked directly from the
    // persistence step below, never inferred later by scanning the
    // artifact directory.
    const persistedEvidenceLabels = new Set<string>();
    const persistEvidence = async (label: string, write: () => Promise<void>): Promise<void> => {
      try {
        await write();
        artifacts.push(join(input.artifactDir, label));
        persistedEvidenceLabels.add(label);
      } catch (error) {
        evidenceWarnings.push(`evidence_warning: could not persist ${label}: ${(error as Error).message}`);
      }
    };
    // #209: persist cheap, bounded, sanitized agent evidence *before* the
    // workspace-size check can abort the trial. Previously every piece of
    // agent evidence (including stdout/stderr) was written only after this
    // check passed, so a workspace-over-limit integrity_error retained
    // nothing at all about what the agent actually did - see #209's own
    // investigation. None of this changes the check's policy (limits are
    // unchanged) or its outcome (still integrity_error, still
    // datasetEligible: false) - only what evidence survives it, and how
    // resiliently.
    await persistEvidence("agent-result.json", () =>
      writeJson(join(input.artifactDir, "agent-result.json"), buildSafeSessionEvidence(session, executionEnvironment, knownSecrets))
    );
    await persistEvidence("agent-stdout.txt", () => writeFile(join(input.artifactDir, "agent-stdout.txt"), redactKnownSecrets(session.agent.stdout ?? "", knownSecrets)));
    await persistEvidence("agent-stderr.txt", () => writeFile(join(input.artifactDir, "agent-stderr.txt"), redactKnownSecrets(session.agent.stderr ?? "", knownSecrets)));
    await persistEvidence("workspace-inventory.json", () =>
      writeJson(join(input.artifactDir, "workspace-inventory.json"), buildHistoricalPostgresWorkspaceInventory(workspaceMeasurement, knownSecrets))
    );

    // PR #210 review round 5, Blocking 3 (evidence-boundary isolation) /
    // round 6, Blocking 1-2 (bounded ingestion, required-vs-best-effort
    // separation): the required transcript path and the derived best-effort
    // paths are two *separate* try/catch blocks, both inside the overall
    // trajectory evidence boundary - a failure in either must never
    // propagate to the function's outer catch and silently overwrite an
    // already-known authoritative trial attribution (an over-limit
    // workspace's integrity_error, a timed-out agent's blocked) with
    // infrastructure_error, and a failure in the derived, best-effort paths
    // (session-stats, trajectory derivation) must never retroactively
    // invalidate an already-successfully-persisted required transcript
    // (round 6, Blocking 2) - `trajectoryUsable` is only ever set inside the
    // transcript try block below, nowhere else.
    let trajectoryUsable = false;
    if (dshHomeDir) {
      // `readBoundedDshSessionTelemetry()` performs its own bounded
      // discovery/read/decode (round 6, Blocking 1: a streaming
      // `opendir()` walk, never `readdir(..., {recursive:true})`; symlinks
      // rejected via `lstat().isFile()`; on-disk, decoded, and event-count
      // bounds all enforced before any unbounded downstream structure is
      // built) and throws `DshSessionTelemetryLimitExceededError` when any
      // bound is exceeded - a harness/evidence-retention failure, handled
      // identically to a genuine corruption error (corrupt JSONL, a
      // malformed Zstandard frame) by the single catch below. Returning
      // null means the mount was never populated at all, even though a DSH
      // trajectory was expected - itself an evidence gap the
      // required-evidence gate below must catch (trajectoryUsable stays
      // false), not "not_applicable" (that outcome now belongs only to a
      // trial with no trajectoryExpectation at all).
      let rawSessions: Array<{ file: string; events: DshRawEvent[] }> | null = null;
      try {
        rawSessions = await readBoundedDshSessionTelemetry(dshHomeDir, HISTORICAL_POSTGRES_DSH_TELEMETRY_LIMITS);
        if (rawSessions !== null) {
          const transcriptLines = redactSecretsDeep(buildTranscriptLines(rawSessions), knownSecrets);
          await persistEvidence("agent-transcript.ndjson", () =>
            writeFile(join(input.artifactDir, "agent-transcript.ndjson"), transcriptLines.length ? `${transcriptLines.map((line) => JSON.stringify(line)).join("\n")}\n` : "")
          );
          trajectoryUsable = transcriptLines.length > 0 && persistedEvidenceLabels.has("agent-transcript.ndjson");
        }
      } catch (error) {
        // Never leak the private host temp path into persisted/public
        // evidence (round 6, Blocking 3's same discipline, applied here
        // too): a bounded-discovery/decode error can legitimately embed
        // the filesystem path it was operating on.
        evidenceWarnings.push(`evidence_warning: DSH trajectory evidence extraction failed: ${redactKnownSecrets((error as Error).message, [dshHomeDir])}`);
      }

      // Derived/best-effort (regenerable from the transcript above) - never
      // part of the required core evidence contract, same reasoning as
      // agent-postgres.log: a failure here is a diagnostic, not a
      // classification change, and - round 6, Blocking 2 - must never touch
      // `trajectoryUsable`, which is already finalized above. Folded
      // directly from the already-bounded `rawSessions` this function just
      // obtained, rather than re-reading/re-decoding the same files a
      // second time via a second, independent call.
      if (rawSessions !== null) {
        try {
          const sessionStatsReport = foldSessionStatsReport(rawSessions);
          await persistEvidence("agent-session-stats.json", () => writeJson(join(input.artifactDir, "agent-session-stats.json"), sessionStatsReport.aggregate));
        } catch (error) {
          evidenceWarnings.push(`evidence_warning: DSH session-stats derivation failed: ${redactKnownSecrets((error as Error).message, [dshHomeDir])}`);
        }
        try {
          const trajectoryEvents = redactSecretsDeep(
            rawSessions.flatMap(({ events }) => deriveTrajectoryEvents(events)),
            knownSecrets
          );
          await persistEvidence("agent-trajectory.jsonl", () =>
            writeFile(join(input.artifactDir, "agent-trajectory.jsonl"), trajectoryEvents.length ? `${trajectoryEvents.map((event) => JSON.stringify(event)).join("\n")}\n` : "")
          );
        } catch (error) {
          evidenceWarnings.push(`evidence_warning: DSH trajectory derivation failed: ${redactKnownSecrets((error as Error).message, [dshHomeDir])}`);
        }
      }
    }

    if (workspaceOverLimit) {
      return {
        taskId: task.taskId,
        status: "integrity_error",
        scoredEligible: false,
        agent: session.agent,
        executionEnvironment,
        artifacts,
        diagnostics: [`Historical PostgreSQL trial integrity failed: ${workspaceLimitExceededMessage(workspaceMeasurement)}`, ...evidenceWarnings]
      };
    }
    await cp(session.workspaceDir, returnedWorkspace, { recursive: true, dereference: false });
    artifacts.push(returnedWorkspace);
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
        executionEnvironment,
        artifacts,
        diagnostics: [
          session.agent.timedOut ? "Agent timed out before submission." : "Agent exited without a successful completed run.",
          ...evidenceWarnings
        ]
      };
    }
    // PR #210 review round 3, Blocking 1: an official scored capability
    // sample must never enter the Historical PostgreSQL dataset unless its
    // required core evidence contract was successfully persisted. This
    // check only applies to a trial that could otherwise become one -
    // `scoredEligible === false` already routes to "unscored" below with no
    // official score regardless, and must keep that distinct attribution
    // rather than being folded into an infrastructure failure it isn't.
    // Grading is skipped entirely rather than run and then discarded, per
    // the review's "do not grade a submission with an already-known-
    // incomplete evidence contract" requirement.
    // PR #210 review round 5, Blocking 1/1b: whether a DSH trajectory is
    // required at all comes only from the caller-supplied
    // `trajectoryExpectation` (dshTrajectoryExpected) - never from whether
    // evidence happened to survive. A trial that expected DSH but ended up
    // with no usable transcript (mount never populated, zero recovered
    // events, or a parse/persist failure caught by the evidence boundary
    // above) is an infrastructure failure for an otherwise scored-eligible
    // run, exactly like a missing core-evidence file - it just isn't folded
    // into `HISTORICAL_POSTGRES_REQUIRED_CORE_EVIDENCE` itself, since that
    // constant's membership must stay identical for every trial regardless
    // of trajectory expectation.
    const missingCoreEvidence = HISTORICAL_POSTGRES_REQUIRED_CORE_EVIDENCE.filter((label) => !persistedEvidenceLabels.has(label));
    const dshTrajectoryMissing = dshTrajectoryExpected && !trajectoryUsable;
    if (scoredEligible && (missingCoreEvidence.length > 0 || dshTrajectoryMissing)) {
      return {
        taskId: task.taskId,
        status: "infrastructure_error",
        scoredEligible,
        workspaceDir: returnedWorkspace,
        agent: session.agent,
        executionEnvironment,
        artifacts,
        diagnostics: [
          `Historical PostgreSQL trial infrastructure failed: required core evidence incomplete before grading` +
            (missingCoreEvidence.length > 0 ? ` (missing: ${missingCoreEvidence.join(", ")})` : "") +
            (dshTrajectoryMissing ? " (expected DSH trajectory/session evidence is missing or unusable: agent-transcript.ndjson)" : "") +
            ".",
          ...evidenceWarnings
        ]
      };
    }
    // A diagnostic grade is still useful evidence even when the run is not
    // scored-eligible, but it must never be reported as a completed score:
    // see HistoricalPostgresTrialStatus - "unscored" exists precisely so a
    // consumer cannot mistake a bridge-network smoke run for a scored miss
    // or rediscovery.
    const grade = await gradeHistoricalPostgresSubmission({
      task,
      workspaceDir: returnedWorkspace,
      artifactDir: join(input.artifactDir, "grader"),
      gradeRevision: input.gradeRevision
    });
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
      executionEnvironment,
      artifacts,
      diagnostics: [...unscoredNotice, ...grade.diagnostics, ...evidenceWarnings]
    };
    })();
  } catch (error) {
    result = {
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
  // PR #210 review round 6, Blocking 3: the private raw DSH telemetry root
  // is never a normal public/shareable trial artifact and is always removed
  // - but a removal *failure* must be observable, not silently swallowed:
  // the raw source can carry tool arguments/output, echoed environment
  // values, or a credential before redaction, so a caller needs to know
  // when it was possibly retained on disk. This never reclassifies the
  // trial's own status (integrity_error/blocked/completed/
  // infrastructure_error all stay exactly what they already were) - it only
  // appends a diagnostic, and never leaks the private host path itself.
  if (dshHomeDir) {
    try {
      await rm(dshHomeDir, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unknown_error";
      result.diagnostics.push(`evidence_warning: failed to remove private raw DSH telemetry root (${code}) - raw, unredacted DSH telemetry may still be retained on disk.`);
    }
  }
  return result;
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
 * BUG #18574's behavioral oracle - the exact confirmed observations from
 * #185's manual validation against real PostgreSQL 14.13 (buggy) and 14.14
 * (fixed) builds. Shared verbatim between the blind-discovery task
 * (`historicalPostgres002TaskSpec()`, below) and the change-oriented task
 * (`historicalPostgresChange18574TaskSpec()`, #221) - same underlying bug,
 * same truth, never duplicated or redeclared. Generic, declarative oracle
 * (see historical-behavioral-oracle.ts): requires the submitted reproducer's
 * own captured stderr to contain these two ERROR observations, in order,
 * before the historical ref counts as reproduced or the reference ref counts
 * as the baseline. This is what keeps an unrelated revision-discriminating
 * script from earning `rediscovered` credit for a different bug entirely.
 */
export function historicalPostgresBug18574BehavioralOracle(): HistoricalPostgresBehavioralOracle {
  return {
    historical: [
      { label: "first CALL", matches: HISTORICAL_POSTGRES_002_BASELINE_ERROR },
      { label: "second CALL", matches: "^cache lookup failed for function \\d+$" }
    ],
    reference: [
      { label: "first CALL", matches: HISTORICAL_POSTGRES_002_BASELINE_ERROR },
      { label: "second CALL", matches: HISTORICAL_POSTGRES_002_BASELINE_ERROR }
    ]
  };
}

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
      behavioralOracle: historicalPostgresBug18574BehavioralOracle()
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
 * @param scaffoldingLevel Defaults to `"minimal"` — the original #199/#201
 *   blind-discovery materialization, byte-identical to this function's
 *   behavior before #233. Pass `"E0"`/`"E1"`/`"E2"`/`"E3"` together with
 *   `changeContext` (e.g. `historicalPostgres003ChangeContext()`) to run
 *   #233's within-family sibling-replication E0-E3 ladder on this same
 *   frozen source/oracle instead.
 * @param changeContext Optional; see `scaffoldingLevel`. Omitted by every
 *   existing caller (Corpus v0 scoring, #200/#201 freeze) — Policy A: the
 *   serialized key stays absent, so no legacy hash moves.
 */
export function historicalPostgres003TaskSpec(
  repoPath: string,
  privateTruth: HistoricalPostgresCase003PrivateTruth,
  knownReproducerPath?: string,
  scaffoldingLevel: "minimal" | "E0" | "E1" | "E2" | "E3" = "minimal",
  changeContext?: HistoricalPostgresChangeContext
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
    scaffoldingLevel,
    budget: {},
    prompt: historicalPostgres003TaskPrompt(),
    ...(changeContext ? { changeContext } : {})
  };
}

/**
 * The original transaction-chaining feature commit, shared ancestor of both
 * Study 1's BUG #16867 and Task 003's BUG #18118 (#233's "sibling defect in
 * the broader transaction-chaining feature family" framing). Public — named
 * directly in #233's own issue text, unlike Task 003's own historical/
 * reference revisions and upstream bug identity, which stay operator-private
 * (`loadHistoricalPostgres003PrivateTruth()`).
 */
export const HISTORICAL_POSTGRES_TRANSACTION_CHAINING_INTRODUCING_COMMIT = "280a408b48d5ee42969f981bceb9e9426c3a344c";

/**
 * `changeContext` for #233's Task 003 within-family sibling-replication
 * E0-E3 experiment. Reuses Study 1's SPEC and HarnessProfile byte-for-byte
 * (`historicalPostgresChange16867Spec()`/`historicalPostgresChange16867HarnessProfile()`
 * called directly, never copied) per #233's explicit preference for maximal
 * comparability, and sets `allowHistoricalSourceDivergence: true` because
 * Task 003's frozen #199/#201 historical/reference revisions are deliberately
 * later in history than `280a408b` (#233's "Source/snapshot rule": do not
 * re-materialize Task 003 around the introduction commit).
 */
export function historicalPostgres003ChangeContext(): HistoricalPostgresChangeContext {
  return {
    spec: historicalPostgresChange16867Spec(),
    introducingCommit: HISTORICAL_POSTGRES_TRANSACTION_CHAINING_INTRODUCING_COMMIT,
    harnessProfile: historicalPostgresChange16867HarnessProfile(),
    allowHistoricalSourceDivergence: true
  };
}

// ---------------------------------------------------------------------------
// Case: postgres-change-001 (#212) — HistoricalChangeTask v0 vertical slice
// ---------------------------------------------------------------------------

/**
 * Operator-supplied private truth for the #16867 change-oriented task (#212).
 * Passed at runtime via `loadHistoricalPostgresChange16867PrivateTruth()` —
 * never committed to this repository. The script
 * `scripts/historical-postgres-212.ts` reads this from a local JSON file
 * pointed to by `HONEYRAIL_PG_212_PRIVATE_TRUTH`. Synthetic values are used
 * in unit tests.
 */
export type HistoricalPostgresChange16867PrivateTruth = {
  upstreamBug: string;
  historicalRevision: string;
  referenceRevision: string;
  introducingCommit: string;
  structuredOracle: HistoricalPostgresStructuredOracle;
};

/**
 * Loads and validates operator-supplied private truth for the #16867 task
 * from a local JSON file. Same loud-failure discipline as
 * `loadHistoricalPostgres003PrivateTruth()`.
 */
export async function loadHistoricalPostgresChange16867PrivateTruth(filePath: string): Promise<HistoricalPostgresChange16867PrivateTruth> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`loadHistoricalPostgresChange16867PrivateTruth: could not read or parse ${filePath}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`loadHistoricalPostgresChange16867PrivateTruth: ${filePath} must contain a JSON object`);
  }
  const value = raw as Record<string, unknown>;
  const upstreamBug = typeof value.upstreamBug === "string" ? value.upstreamBug.trim() : "";
  if (!upstreamBug) throw new Error(`loadHistoricalPostgresChange16867PrivateTruth: ${filePath} missing or empty "upstreamBug"`);
  const historicalRevision = exactRevision(
    typeof value.historicalRevision === "string" ? value.historicalRevision.trim() : "",
    `loadHistoricalPostgresChange16867PrivateTruth: ${filePath} "historicalRevision"`
  );
  const referenceRevision = exactRevision(
    typeof value.referenceRevision === "string" ? value.referenceRevision.trim() : "",
    `loadHistoricalPostgresChange16867PrivateTruth: ${filePath} "referenceRevision"`
  );
  const introducingCommit = exactRevision(
    typeof value.introducingCommit === "string" ? value.introducingCommit.trim() : "",
    `loadHistoricalPostgresChange16867PrivateTruth: ${filePath} "introducingCommit"`
  );
  const oracle = value.structuredOracle;
  if (!oracle || typeof oracle !== "object" || Array.isArray(oracle)) {
    throw new Error(`loadHistoricalPostgresChange16867PrivateTruth: ${filePath} missing or invalid "structuredOracle"`);
  }
  const oracleObj = oracle as Record<string, unknown>;
  for (const side of ["historical", "reference"] as const) {
    const sideVal = oracleObj[side];
    if (!sideVal || typeof sideVal !== "object" || Array.isArray(sideVal)) {
      throw new Error(`loadHistoricalPostgresChange16867PrivateTruth: ${filePath} structuredOracle.${side} must be an object`);
    }
    const sideValObj = sideVal as Record<string, unknown>;
    if ("ordered" in sideValObj && typeof sideValObj.ordered !== "boolean") {
      throw new Error(
        `loadHistoricalPostgresChange16867PrivateTruth: ${filePath} structuredOracle.${side}.ordered must be a boolean when present; got ${typeof sideValObj.ordered}`
      );
    }
    assertValidExpectedRows(sideValObj.rows);
    assertNoDelimiterInExpectedRows(sideValObj.rows, "|");
  }
  if (structuredExpectationsOverlap(oracleObj.historical as HistoricalPostgresStructuredExpectation, oracleObj.reference as HistoricalPostgresStructuredExpectation)) {
    throw new Error(
      `loadHistoricalPostgresChange16867PrivateTruth: ${filePath} structuredOracle.historical and .reference expectations overlap and cannot be attributed unambiguously`
    );
  }
  return { upstreamBug, historicalRevision, referenceRevision, introducingCommit, structuredOracle: value.structuredOracle as HistoricalPostgresStructuredOracle };
}

/**
 * Contemporaneous SPEC for the #16867 change-oriented task. Written as
 * `task/spec.md` at scaffolding level E1+.
 *
 * CONTENT POLICY: this text must contain only information available at or
 * before the introducing commit's timestamp (2019-03-24, PostgreSQL 12-era).
 * Prohibited hindsight markers that must NOT appear here or in any future
 * revision: SAVEPOINT, "unreleased savepoint", subtransaction,
 * TBLOCK_SUBCOMMIT, "nested transaction state", "missing switch branch",
 * "enumerate every blockState", "BUG #16867", or any future-fix wording.
 */
export function historicalPostgresChange16867Spec(): string {
  return `# Transaction Chaining — Contemporaneous Specification

## Feature Summary

PostgreSQL (development tip at the time of this commit) adds support for
**transaction chaining** via the SQL-standard syntax:

\`\`\`sql
COMMIT AND CHAIN;
ROLLBACK AND CHAIN;
\`\`\`

When a transaction ends with \`AND CHAIN\`, the server immediately starts a
new transaction with the same effective transaction characteristics as the
transaction that just finished — specifically transaction isolation,
read-only/read-write, and deferrable.

## Expected Invariant

After \`COMMIT AND CHAIN\` (or \`ROLLBACK AND CHAIN\`), the newly started
transaction must retain those effective transaction characteristics.
`;
}

/**
 * Generic test-engineering HarnessProfile for database correctness tasks.
 * Written as `task/harness-profile.md` at scaffolding level E3. Deliberately
 * domain-generic — reusable across unrelated tasks. Must not contain
 * bug-specific terminology.
 */
export function historicalPostgresChange16867HarnessProfile(): string {
  return `# HarnessProfile: Database Correctness Test Engineering

## Methodology

1. **Identify the invariant**: what observable property must hold?
2. **Enumerate boundary conditions**: which SQL statement combinations
   exercise the invariant under different code paths?
3. **Write self-asserting reproducers**: encode the suspected regression so
   the script exits successfully (status 0) only when the suspected
   correctness violation is observed. On an implementation where the
   invariant holds, the same script must exit non-zero.
4. **Verify determinism**: run each reproducer at least twice to confirm
   the result is stable (not timing-dependent).
5. **Minimize**: strip the reproducer to the smallest sequence of
   statements that still triggers the violation.

## Reproducer Structure

A reproducer is a \`.sql\` file executed via \`psql\`. It must:

- Set up the prerequisite database or session state required by the hypothesis.
- Execute the sequence of statements under test.
- Capture externally observable behavior that discriminates the hypothesis.
- Exit with status 0 only when the suspected correctness violation is
  observed; use a deliberate failure mechanism (e.g. a division-by-zero or
  an explicit \`\\q 1\`) when the invariant holds.
`;
}

/**
 * Public task prompt for the #16867 change-oriented task (#212). Same
 * discipline as all other task prompts: describes the *category* of behaviour
 * to investigate without naming the specific failure mechanism. The prompt is
 * the same at all scaffolding levels — only the supplementary artifacts
 * (spec.md, change-set.diff, harness-profile.md) vary.
 */
export function historicalPostgresChange16867TaskPrompt(): string {
  return `# PostgreSQL correctness-testing assignment

Investigate transaction state, session-level transaction characteristics, and transaction-control behavior. Form hypotheses, design focused SQL tests, inspect relevant source and documentation, execute experiments, and report any reproducible functional correctness defect.

If you observe a reproducible behavioral correctness problem, write \`finding.json\` with \`status: "reproduced"\`, a concise summary, and the name of a runnable SQL reproducer. The reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion. If no reproducible issue is found, write \`finding.json\` with \`status: "not-reproduced"\` and a concise summary.\n`;
}

/**
 * Builds the `HistoricalPostgresTaskSpec` for the #16867 change-oriented task.
 *
 * @param repoPath Local PostgreSQL mirror path.
 * @param privateTruth Operator-supplied private truth (loaded at runtime).
 * @param scaffoldingLevel E0/E1/E2/E3 — controls which change-context
 *   artifacts are materialized. Defaults to "E0" (blind baseline).
 * @param knownReproducerPath Optional canonical verification reproducer.
 */
export function historicalPostgresChange16867TaskSpec(
  repoPath: string,
  privateTruth: HistoricalPostgresChange16867PrivateTruth,
  scaffoldingLevel: "E0" | "E1" | "E2" | "E3" = "E0",
  knownReproducerPath?: string,
  knownFixEvidencePath?: string
): HistoricalPostgresTaskSpec {
  return {
    taskId: "postgres-change-001",
    source: {
      repoPath,
      historicalRevision: privateTruth.historicalRevision,
      referenceRevision: privateTruth.referenceRevision
    },
    truth: {
      upstreamBug: privateTruth.upstreamBug,
      knownReproducerPath,
      knownFixEvidencePath,
      structuredOracle: privateTruth.structuredOracle
    },
    scaffoldingLevel,
    budget: {},
    prompt: historicalPostgresChange16867TaskPrompt(),
    changeContext: {
      spec: historicalPostgresChange16867Spec(),
      introducingCommit: privateTruth.introducingCommit,
      harnessProfile: historicalPostgresChange16867HarnessProfile()
    }
  };
}

// ---------------------------------------------------------------------------
// postgres-change-002 (#221): BUG #18574 unrelated-family transfer validation
// ---------------------------------------------------------------------------

/**
 * #211's experimentally-confirmed first-bad-commit validation for BUG #18574
 * (`parent(ee895a655) -> expected behavior`, `ee895a655 -> BUG #18574
 * behavior`). Also `source.historicalRevision` for the change-oriented task,
 * since `checkedTaskSpec()` requires `historicalRevision` to resolve to the
 * same commit as `changeContext.introducingCommit`. Not the #200
 * blind-discovery task's own `historicalRevision` (`7696b2ea...`), which is
 * a much later REL_14_STABLE release snapshot unsuitable as a focused
 * two-revision comparator for a change-oriented task.
 */
export const HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT = "ee895a655ce4341546facd6f23e3e8f2931b96bf";

/**
 * The commit that actually fixed BUG #18574 upstream, on `master` (the same
 * lineage as the introducing commit above). Its own commit message confirms
 * both the bug and the coding it patches: "Fix edge case in plpgsql's
 * make_callstmt_target()... Per bug #18574 from Song Hongyu. Back-patch to
 * v14 where this coding was introduced." This *is* the same commit as the
 * #200 blind-discovery task's own `referenceRevision` - reused as-is, not a
 * new pin.
 */
export const HISTORICAL_POSTGRES_18574_FIX_COMMIT = "7f875fb5bd603d8640cc7aca2c79c604aacd3890";

/**
 * Contemporaneous SPEC for the #18574 change-oriented task. Written as
 * `task/spec.md` at scaffolding level E1+.
 *
 * CONTENT POLICY (same discipline as `historicalPostgresChange16867Spec()`):
 * this text must contain only information available at or before the
 * introducing commit's timestamp (2021-01-25). Prohibited hindsight markers
 * that must NOT appear here or in any future revision: "stale", "drop"/
 * "recreate" of the called procedure, "cache lookup failed", any OID
 * wording, "BUG #18574", or any future-fix wording.
 *
 * POSITIVE PROVENANCE MAPPING (#221 review round 2, Blocking 2 - a negative
 * leakage test only proves prohibited words are absent, not that every
 * substantive statement is actually grounded; this maps each one to its
 * contemporaneous source so that can be checked directly):
 *
 * - "Feature Summary" paragraph 1 (re-planning cost, `ResourceOwner`
 *   requirement for a saved plan) -> introducing commit message ("forced us
 *   to re-plan CALL and DO statements each time through... because use of a
 *   saved plan requires having a ResourceOwner to hold a reference count on
 *   the plan, and we had no suitable resowner at hand").
 * - "Feature Summary" paragraph 2 (dedicated `ResourceOwner` for non-atomic
 *   procedures/DO blocks containing CALL/DO) -> introducing commit message
 *   ("when running a non-atomic procedure or DO block that contains any
 *   CALL or DO commands, plpgsql creates a ResourceOwner that will be used
 *   to pin the plans of the CALL/DO commands... we can just save CALL/DO
 *   plans normally, whether or not they are used across transaction
 *   boundaries").
 * - "Feature Summary" paragraph 3 (CALL statement target determined once,
 *   expected to remain associated with the statement while its plan is
 *   reused) -> introducing diff, `src/pl/plpgsql/src/pl_exec.c`
 *   `exec_stmt_call()`/`make_callstmt_target()` hunk: the post-commit code
 *   only calls `make_callstmt_target()` inside `if (expr->plan == NULL)`,
 *   i.e. exactly once per statement for as long as its plan is cached - an
 *   observable fact of the diff itself, not narrative added around it.
 * - "Expected Invariant" -> the general correctness expectation for *any*
 *   plan-caching optimization (an optimization must not change externally
 *   observable behavior versus not caching) applied to the specific
 *   observable this diff introduces (CALL statement target resolution tied
 *   to plan reuse) - same category of grounding as
 *   `historicalPostgresChange16867Spec()`'s invariant, which restates
 *   `AND CHAIN`'s documented semantics rather than quoting the commit
 *   verbatim. An earlier draft additionally referenced "current search
 *   path" here; removed (#221 review round 2) because no contemporaneous
 *   source for that specific qualifier was found in the introducing
 *   commit's message or diff - conservative wording only.
 */
export function historicalPostgresChange18574Spec(): string {
  return `# Repeated CALL/DO Plan Caching — Contemporaneous Specification

## Feature Summary

PostgreSQL (development tip at the time of this commit) improves the
performance of repeated \`CALL\`/\`DO\` statements executed within a
non-atomic PL/pgSQL procedure or \`DO\` block. Previously, each execution of
a \`CALL\`/\`DO\` statement in a non-atomic context re-planned the statement
from scratch, because using a saved (cached) plan requires a
\`ResourceOwner\` to hold a reference count on the plan, and no such
resource owner was available across transaction boundaries in that context.

When a non-atomic procedure or \`DO\` block contains any \`CALL\`/\`DO\`
commands, PL/pgSQL now creates a dedicated \`ResourceOwner\` that survives
for the duration of the enclosing procedure/block's execution, and uses it
to pin the plans of those \`CALL\`/\`DO\` commands. This lets a
\`CALL\`/\`DO\` statement's plan be saved and reused normally across
repeated invocations and across transaction boundaries, instead of being
rebuilt on every execution.

As part of this change, the target of a \`CALL\` statement — the called
procedure's identity and output-argument row shape, resolved from the
statement's plan — is determined once and is expected to remain associated
with that statement for as long as the statement's plan is reused.

## Expected Invariant

Caching a statement's plan for reuse must not change the statement's
externally observable behavior compared to planning it fresh on every
execution. In particular, for a given \`CALL\` statement executed
repeatedly within a session, the procedure identity resolved for each
execution must correctly reflect what that statement's plan currently
points to — regardless of whether the plan was just built or is being
reused from a previous execution.
`;
}

/**
 * Public task prompt for the #18574 change-oriented task (#221). Same
 * discipline as all other task prompts: describes the *category* of
 * behaviour to investigate without naming the specific failure mechanism.
 * The prompt is the same at all scaffolding levels — only the supplementary
 * artifacts (spec.md, change-set.diff, harness-profile.md) vary.
 */
export function historicalPostgresChange18574TaskPrompt(): string {
  return `# PostgreSQL correctness-testing assignment

Investigate PL/pgSQL procedure execution, including repeated \`CALL\`/\`DO\` statement behavior across multiple invocations within a session, DDL/object lifecycle interactions with an active session, plan/cache invalidation, and session-lifetime correctness. Form hypotheses, design focused SQL tests, inspect relevant source and documentation, execute experiments, and report any reproducible functional correctness defect.

If you observe a reproducible behavioral correctness problem, write \`finding.json\` with \`status: "reproduced"\`, a concise summary, and the name of a runnable SQL reproducer. The reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion. If no reproducible issue is found, write \`finding.json\` with \`status: "not-reproduced"\` and a concise summary.\n`;
}

/**
 * Builds the `HistoricalPostgresTaskSpec` for the #18574 change-oriented
 * task. Reuses BUG #18574's existing behavioral-oracle contract
 * (`historicalPostgresBug18574BehavioralOracle()`, shared with
 * `historicalPostgres002TaskSpec()` above, unchanged) and the exact same
 * generic Test-Engineer HarnessProfile frozen for `postgres-change-001`
 * (`historicalPostgresChange16867HarnessProfile()` - called directly, never
 * copied, so E3 content is provably byte-identical across both tasks).
 *
 * Unlike `postgres-change-001`, no operator-supplied private-truth file is
 * needed: the introducing/fix commits and the behavioral oracle are already
 * public (#200/#211/#185), so nothing here is a fresh secret. Only the
 * canonical verification reproducer and fix evidence stay operator-private,
 * exactly as case 002's own script (`scripts/historical-postgres-200.ts`)
 * already treats them.
 *
 * @param repoPath Local PostgreSQL mirror path.
 * @param scaffoldingLevel E0/E1/E2/E3 — controls which change-context
 *   artifacts are materialized. Defaults to "E0" (blind baseline).
 * @param knownReproducerPath Optional canonical verification reproducer.
 * @param knownFixEvidencePath Recommended: the introducing and fix commits
 *   are ~3.5 years apart on `master`, so auto-generating fix evidence via
 *   `git diff historicalRevision referenceRevision` would produce years of
 *   unrelated changes, not focused fix evidence. Supply the fix commit's own
 *   diff (`git show` of `HISTORICAL_POSTGRES_18574_FIX_COMMIT`) instead.
 */
export function historicalPostgresChange18574TaskSpec(
  repoPath: string,
  scaffoldingLevel: "E0" | "E1" | "E2" | "E3" = "E0",
  knownReproducerPath?: string,
  knownFixEvidencePath?: string
): HistoricalPostgresTaskSpec {
  return {
    taskId: "postgres-change-002",
    source: {
      repoPath,
      historicalRevision: HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT,
      referenceRevision: HISTORICAL_POSTGRES_18574_FIX_COMMIT
    },
    truth: {
      upstreamBug: "PostgreSQL BUG #18574",
      knownReproducerPath,
      knownFixEvidencePath,
      behavioralOracle: historicalPostgresBug18574BehavioralOracle()
    },
    scaffoldingLevel,
    budget: {},
    prompt: historicalPostgresChange18574TaskPrompt(),
    changeContext: {
      spec: historicalPostgresChange18574Spec(),
      introducingCommit: HISTORICAL_POSTGRES_18574_INTRODUCING_COMMIT,
      harnessProfile: historicalPostgresChange16867HarnessProfile()
    }
  };
}
