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
  type PostgresResearchSessionOptions
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

export type HistoricalPostgresTaskSpec = {
  taskId: string;
  source: { repoPath: string; historicalRevision: string; referenceRevision: string };
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
  taskManifest: HistoricalPostgresTaskManifest;
  referenceManifest: HistoricalPostgresReferenceManifest;
};

export type HistoricalPostgresTaskManifest = {
  schemaVersion: 1;
  taskId: string;
  database: "postgresql";
  taskType: "historical-correctness-regression";
  sourceRevision: string;
  referenceRevision: string;
  scaffoldingLevel: string;
  budget: Record<string, number>;
  buildProfile: string;
  artifacts: { sourceManifest: string; prompt: string; workspace: string };
  hashes: { sourceTree: string; prompt: string; taskDefinition: string; referenceBundle: string };
};

export type HistoricalPostgresReferenceManifest = {
  schemaVersion: 1;
  taskId: string;
  referenceRevision: string;
  taskDefinitionHash: string;
  gradingProtocol: "submitted-reproducer-exit-status-v1";
  bundleHash: string;
};

export type HistoricalPostgresSubmission = {
  status: "reproduced" | "not-reproduced";
  summary: string;
  reproducer: string;
};

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

export type HistoricalPostgresTrial = {
  taskId: string;
  status: "completed" | "blocked" | "infrastructure_error" | "integrity_error";
  workspaceDir?: string;
  agent: Record<string, unknown>;
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

function exactRevision(value: string, field: string) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`${field} must be a pinned 40-character commit SHA`);
  return value.toLowerCase();
}

function checkedTaskSpec(spec: HistoricalPostgresTaskSpec): HistoricalPostgresTaskSpec {
  if (!/^[a-z0-9][a-z0-9-]{2,}$/i.test(spec.taskId)) throw new Error("taskId must be a stable slug");
  if (!String(spec.source.repoPath || "").trim()) throw new Error("source.repoPath is required");
  if (!String(spec.prompt || "").trim()) throw new Error("prompt is required");
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
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(referenceDir, "expected-behavior"), { recursive: true });
  await mkdir(join(referenceDir, "verification"), { recursive: true });

  const source = await materializePostgresSource({ repoPath: input.source.repoPath, ref: input.source.historicalRevision }, sourceDir);
  const promptPath = join(taskDir, "prompt.md");
  await writeFile(promptPath, `${input.prompt.trim()}\n`);
  await writeFile(
    join(workspaceDir, "README.md"),
    "Write finding.json and the runnable SQL reproducer here. HoneyRail grades the same reproducer on the supplied historical build and a grader-owned corrected build.\n"
  );
  await writeFile(
    join(referenceDir, "verification", "reproducer-contract.md"),
    "A creditable repro.sql exits successfully only when the observed behavior violates the assertion encoded by the reproducer. The same script is run on both pinned revisions.\n"
  );

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
  const referenceShape = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    referenceRevision: input.source.referenceRevision,
    taskDefinitionHash,
    gradingProtocol: "submitted-reproducer-exit-status-v1" as const
  };
  const referenceManifest: HistoricalPostgresReferenceManifest = { ...referenceShape, bundleHash: sha256(stableJson(referenceShape)) };
  const taskManifest: HistoricalPostgresTaskManifest = {
    schemaVersion: 1,
    taskId: input.taskId,
    database: "postgresql",
    taskType: "historical-correctness-regression",
    sourceRevision: input.source.historicalRevision,
    referenceRevision: input.source.referenceRevision,
    scaffoldingLevel: input.scaffoldingLevel ?? "minimal",
    budget: input.budget ?? {},
    buildProfile: input.build?.mode ?? "container",
    artifacts: { sourceManifest: "source-manifest.json", prompt: "prompt.md", workspace: "workspace" },
    hashes: { sourceTree: source.sourceHash, prompt: taskDefinition.promptHash, taskDefinition: taskDefinitionHash, referenceBundle: referenceManifest.bundleHash }
  };
  const taskManifestPath = join(taskDir, "task-manifest.json");
  const referenceManifestPath = join(referenceDir, "reference-manifest.json");
  await writeJson(join(taskDir, "source-manifest.json"), source);
  await writeJson(taskManifestPath, taskManifest);
  await writeJson(referenceManifestPath, referenceManifest);
  return { root, taskDir, sourceDir, workspaceDir, referenceDir, taskManifestPath, referenceManifestPath, taskManifest, referenceManifest };
}

export async function validateHistoricalPostgresSubmission(workspaceDir: string): Promise<
  { ok: true; submission: HistoricalPostgresSubmission; reproducerPath: string } | { ok: false; diagnostic: string; integrity?: boolean }
> {
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
  const reproducer = typeof value.reproducer === "string" ? value.reproducer.trim() : "";
  if ((status !== "reproduced" && status !== "not-reproduced") || !summary || !reproducer) {
    return { ok: false, diagnostic: "finding.json requires status, summary, and reproducer" };
  }
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
  return { ok: true, submission: { status, summary, reproducer }, reproducerPath };
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
  const invalid = await validateHistoricalPostgresSubmission(input.workspaceDir);
  if (!invalid.ok) {
    const result: HistoricalPostgresGrade = {
      taskId: task.taskId,
      status: invalid.integrity ? "integrity_error" : "invalid_submission",
      historical: { reproduced: false },
      reference: { reproduced: false },
      artifacts,
      diagnostics: [invalid.diagnostic],
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
      gradeRevision({ revision: task.source.historicalRevision, reproducerPath: invalid.reproducerPath, artifactDir: historicalDir, spec: task }),
      gradeRevision({ revision: task.source.referenceRevision, reproducerPath: invalid.reproducerPath, artifactDir: referenceDir, spec: task })
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
}): Promise<HistoricalPostgresTrial> {
  const task = checkedTaskSpec(input.task);
  const artifacts: string[] = [];
  try {
    await mkdir(input.artifactDir, { recursive: true });
    const taskLayout = await materializeHistoricalPostgresTask(task, join(input.artifactDir, "task-bundle"));
    artifacts.push(taskLayout.taskDir, taskLayout.referenceDir);
    const session = await runAgentInPostgresResearchEnvironment(
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
        env: { ...(input.agent.env ?? {}), HONEYRAIL_TASK_ID: task.taskId, HONEYRAIL_TASK_PROMPT: task.prompt }
      },
      input.session
    );
    const returnedWorkspace = join(input.artifactDir, "agent-workspace");
    await assertWorkspaceWithinLimits(session.workspaceDir);
    await cp(session.workspaceDir, returnedWorkspace, { recursive: true, dereference: false });
    artifacts.push(returnedWorkspace);
    await writeJson(join(input.artifactDir, "agent-result.json"), session);
    await writeJson(join(input.artifactDir, "task-manifest.json"), taskLayout.taskManifest);
    await writeJson(join(input.artifactDir, "reference-manifest.json"), taskLayout.referenceManifest);
    if (!session.agent.ok) {
      return {
        taskId: task.taskId,
        status: "blocked",
        workspaceDir: returnedWorkspace,
        agent: session.agent,
        artifacts,
        diagnostics: [session.agent.timedOut ? "Agent timed out before submission." : "Agent exited without a successful completed run."]
      };
    }
    const grade = await gradeHistoricalPostgresSubmission({ task, workspaceDir: returnedWorkspace, artifactDir: join(input.artifactDir, "grader") });
    artifacts.push(join(input.artifactDir, "grader"));
    return {
      taskId: task.taskId,
      status: grade.status === "integrity_error" ? "integrity_error" : grade.status === "infrastructure_error" ? "infrastructure_error" : "completed",
      workspaceDir: returnedWorkspace,
      agent: session.agent,
      grade,
      artifacts,
      diagnostics: grade.diagnostics
    };
  } catch (error) {
    return {
      taskId: task.taskId,
      status: error instanceof HistoricalPostgresIntegrityError ? "integrity_error" : "infrastructure_error",
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

/** Public task copy for the selected #184 case; it intentionally omits the answer/reproducer. */
export function commitfest7059TaskPrompt() {
  return `# PostgreSQL correctness-testing assignment

Investigate the supplied PostgreSQL source and a locally running PostgreSQL instance for a correctness issue in join planning. Design focused SQL tests, inspect relevant source and documentation, and save any useful test scripts in the writable workspace.

If you observe a reproducible behavioral correctness problem, write \`finding.json\` with \`status: "reproduced"\`, a concise summary, and the name of a runnable SQL reproducer. The reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion. If no reproducible issue is found, write \`finding.json\` with \`status: "not-reproduced"\` and a concise summary.\n`;
}

export function commitfest7059TaskSpec(repoPath: string): HistoricalPostgresTaskSpec {
  return {
    taskId: "postgres-historical-cf-7059",
    source: {
      repoPath,
      historicalRevision: "07fdee7c8a8b415fb3a2991e7aea34f08975d445",
      referenceRevision: "2ebf25e7d70a8fce31ace78d723fa9271ab8af72"
    },
    scaffoldingLevel: "minimal",
    budget: {},
    prompt: commitfest7059TaskPrompt()
  };
}
