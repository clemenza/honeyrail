import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { nowIso } from "../utils.js";
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
    commitFest: number;
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
  gradingProtocol: "submitted-reproducer-exit-status-v1";
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
  commitFest: number;
  historicalRevision: string;
  referenceRevision: string;
  gradingProtocol: "submitted-reproducer-exit-status-v1";
  /** SHA-256 of the canonical verification reproducer, when one was supplied; never the agent's. */
  canonicalReproducerSha256: string | null;
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
  reproduced: boolean;
  execution?: Pick<PostgresQueryResult, "ok" | "stdout" | "stderr" | "exitCode" | "durationMs">;
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
  if (!Number.isInteger(spec.truth?.commitFest) || spec.truth.commitFest <= 0) {
    throw new Error("truth.commitFest must be a positive integer");
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

  const canonicalReproducerSha256 = input.truth.knownReproducerPath
    ? sha256(await readFile(input.truth.knownReproducerPath))
    : null;
  const expectedBehaviorSha256 = await hashDirectoryContents(referenceDir);

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
    commitFest: input.truth.commitFest,
    historicalRevision: input.source.historicalRevision,
    referenceRevision: input.source.referenceRevision,
    gradingProtocol: "submitted-reproducer-exit-status-v1" as const,
    canonicalReproducerSha256,
    expectedBehaviorSha256,
    taskDefinitionHash
  };
  const truthManifest: HistoricalPostgresTruthManifest = { ...truthShape, bundleHash: sha256(stableJson(truthShape)) };

  const referenceManifest: HistoricalPostgresReferenceManifest = {
    schemaVersion: 1,
    taskId: input.taskId,
    gradingProtocol: "submitted-reproducer-exit-status-v1",
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
    observation = { reproduced: execution.ok, execution, sourceManifest: env.sourceManifest, buildManifest: env.buildManifest, runtimeManifest: env.runtimeManifest() };
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
    const status: HistoricalPostgresGradeStatus = !historical.reproduced
      ? "miss"
      : reference.reproduced
        ? "invalid_submission"
        : "rediscovered";
    const diagnostics =
      status === "invalid_submission"
        ? ["The submitted reproducer also succeeded on the corrected reference revision, so it is not target-specific."]
        : [];
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
