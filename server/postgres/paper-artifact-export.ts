import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const PAPER_ARTIFACT_EXPORT_VERSION = "paper-artifact-export-v1";

const SCAFFOLDING_LEVELS = ["E0", "E1", "E2", "E3"] as const;
type ScaffoldingLevel = (typeof SCAFFOLDING_LEVELS)[number];

type AttemptSpec = {
  attemptId: string;
  condition: ScaffoldingLevel;
  sourceDirectory: string;
  predecessor: string | null;
  expectedDisposition: "completed" | "infrastructure_error";
  expectedOfficialResult: "miss" | null;
};

type ExperimentSpec = {
  shortId: "exp216" | "exp222" | "exp233";
  experimentId: string;
  taskId: string;
  sourceCommit: string;
  /**
   * `"public"`: `historicalRevision`/`referenceRevision` below are the real
   * pinned commits (exp216/exp222 - change-tasks whose introducing/fix
   * commits were already public before the task existed), validated by
   * literal equality against the source experiment's own manifest, and
   * republished as-is in every exported artifact.
   *
   * `"private"`: this study's revisions are operator-private per an existing
   * Corpus v0 blind-discovery task's own disclosure policy (#199/#201/#211 -
   * Task 003/exp233). `historicalRevision`/`referenceRevision` below MUST be
   * omitted (never hardcode the real value here - this file is committed to
   * the public `clemenza/honeyrail` repository). Validation falls back to
   * structural checks only (well-formed, distinct 40-hex-char SHAs), and
   * every exported artifact that would otherwise carry the real value
   * (`experiment-manifest.json`'s `postgresRevisions`, `provenance.json`'s
   * `historicalRevision`/`referenceRevision`) is redacted instead.
   */
  revisionDisclosure: "public" | "private";
  historicalRevision?: string;
  referenceRevision?: string;
  canonicalIssue: string;
  canonicalReport: string;
  defaultSource: string;
  expectedAgentImageId: string;
  attempts: readonly AttemptSpec[];
  ignoredFormalPrefixDirectories: readonly string[];
};

const SHARED_AGENT_IMAGE_ID = "sha256:26b7bc8ca5f45f3b043132743309d11baa755576872fb16e999c925fe4342ee9";

const EXPERIMENT_SPECS: Record<string, ExperimentSpec> = {
  "exp216-e0e3-dsh-2026-09-09": {
    shortId: "exp216",
    experimentId: "exp216-e0e3-dsh-2026-09-09",
    taskId: "postgres-change-001",
    sourceCommit: "7f5d0f76769cb4d4b729000265205ccec004de2d",
    revisionDisclosure: "public",
    historicalRevision: "280a408b48d5ee42969f981bceb9e9426c3a344c",
    referenceRevision: "fadcc4e81bd99e6032ae042cae53be0c6eea7580",
    canonicalIssue: "https://github.com/clemenza/honeyrail/issues/216",
    canonicalReport: "https://github.com/clemenza/honeyrail/pull/220",
    defaultSource: "output/historical-pg-212/exp216-e0e3-dsh-2026-09-09",
    expectedAgentImageId: SHARED_AGENT_IMAGE_ID,
    attempts: [
      { attemptId: "E0", condition: "E0", sourceDirectory: "E0", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      { attemptId: "E1", condition: "E1", sourceDirectory: "E1", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      {
        attemptId: "E2-ATTEMPT-1",
        condition: "E2",
        sourceDirectory: "E2-ATTEMPT-1-INFRASTRUCTURE-ERROR",
        predecessor: null,
        expectedDisposition: "infrastructure_error",
        expectedOfficialResult: null
      },
      {
        attemptId: "E2-ATTEMPT-2",
        condition: "E2",
        sourceDirectory: "E2",
        predecessor: "E2-ATTEMPT-1",
        expectedDisposition: "completed",
        expectedOfficialResult: "miss"
      },
      { attemptId: "E3", condition: "E3", sourceDirectory: "E3", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" }
    ],
    ignoredFormalPrefixDirectories: ["DRY-RUN-E0"]
  },
  "exp222-e0e3-dsh-2026-09-10": {
    shortId: "exp222",
    experimentId: "exp222-e0e3-dsh-2026-09-10",
    taskId: "postgres-change-002",
    sourceCommit: "84b44e47e4623bb2965bcb2fc3f735b89bfb6079",
    revisionDisclosure: "public",
    historicalRevision: "ee895a655ce4341546facd6f23e3e8f2931b96bf",
    referenceRevision: "7f875fb5bd603d8640cc7aca2c79c604aacd3890",
    canonicalIssue: "https://github.com/clemenza/honeyrail/issues/222",
    canonicalReport: "https://github.com/clemenza/honeyrail/pull/224",
    defaultSource: "output/historical-pg-221/exp222-e0e3-dsh-2026-09-10",
    expectedAgentImageId: SHARED_AGENT_IMAGE_ID,
    attempts: [
      { attemptId: "E0", condition: "E0", sourceDirectory: "E0", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      { attemptId: "E1", condition: "E1", sourceDirectory: "E1", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      { attemptId: "E2", condition: "E2", sourceDirectory: "E2", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      { attemptId: "E3", condition: "E3", sourceDirectory: "E3", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" }
    ],
    ignoredFormalPrefixDirectories: []
  },
  "exp233-e0e3-dsh-2026-09-11": {
    shortId: "exp233",
    experimentId: "exp233-e0e3-dsh-2026-09-11",
    taskId: "postgres-historical-003",
    sourceCommit: "b7b99162a093302fea8a346fa44623d89c74892f",
    // Task 003 is a frozen Corpus v0 blind-discovery task (#199/#201/#211);
    // unlike exp216/exp222's change-tasks, its historical/reference
    // revisions are operator-private and must never appear in this public
    // repository - see the revisionDisclosure doc comment above.
    revisionDisclosure: "private",
    canonicalIssue: "https://github.com/clemenza/honeyrail/issues/233",
    canonicalReport: "https://github.com/clemenza/honeyrail/pull/236",
    defaultSource: "output/historical-pg-199/exp233-e0e3-dsh-2026-09-11",
    // Rebuilt fresh on a different machine/session than exp216/exp222 (same
    // unchanged Dockerfiles, per the exp233 report) - a different resolved
    // digest is expected, not a discrepancy.
    expectedAgentImageId: "sha256:0201ea99a292767382fb72bbfb0493e29da1f04d4814c07df47c92904e65a804",
    attempts: [
      { attemptId: "E0", condition: "E0", sourceDirectory: "E0", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      { attemptId: "E1", condition: "E1", sourceDirectory: "E1", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      { attemptId: "E2", condition: "E2", sourceDirectory: "E2", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" },
      { attemptId: "E3", condition: "E3", sourceDirectory: "E3", predecessor: null, expectedDisposition: "completed", expectedOfficialResult: "miss" }
    ],
    ignoredFormalPrefixDirectories: []
  }
};

const ATTEMPT_FILE_ALLOWLIST = [
  "task-manifest.json",
  "reference-manifest.json",
  "agent-result.json",
  "agent-stdout.txt",
  "agent-stderr.txt",
  "workspace-inventory.json",
  "agent-transcript.ndjson",
  "agent-session-stats.json",
  "agent-trajectory.jsonl",
  "agent-postgres.log"
] as const;

const TASK_INPUT_ALLOWLIST = ["prompt.md", "source-manifest.json", "workspace/README.md", "spec.md", "change-set.diff", "harness-profile.md"] as const;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: "bearer credential", pattern: /\bBearer\s+(?!\[REDACTED\])[-A-Za-z0-9._~+/]+=*/i },
  { name: "OpenAI-style secret", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  {
    name: "named credential value",
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)\b\s*["']?\s*[:=]\s*["']?(?!\[REDACTED\])[^\s,"'}]{12,}/i
  }
];

const GENERIC_PRIVATE_PATH_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "macOS user home", pattern: /\/Users\/[^/\s"']+\// },
  { name: "macOS private temp", pattern: /\/(?:private\/)?var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\// },
  { name: "Windows user home", pattern: /[A-Za-z]:\\Users\\[^\\\s"']+\\/ }
];

export class PaperArtifactExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperArtifactExportError";
  }
}

type JsonRecord = Record<string, unknown>;
type SourceEvidence = { sourcePath: string; sourceSha256: string; publicPath: string; projection: "copied" | "sanitized" | "summary" };

type ExportAttemptLedgerEntry = {
  attemptId: string;
  condition: ScaffoldingLevel;
  sourceDirectory: string;
  predecessor: string | null;
  disposition: "completed" | "infrastructure_error";
  scoredEligible: boolean | null;
  officialResult: string | null;
  evidenceDirectory: string;
};

export type PaperArtifactExportResult = {
  experimentId: string;
  shortId: string;
  outputDir: string;
  files: number;
  bytes: number;
  publicEvidenceManifestSha256: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new PaperArtifactExportError(`${label} must be a JSON object.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new PaperArtifactExportError(`${label} must be a non-empty string.`);
  return value;
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForStableJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeForStableJson(value[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(normalizeForStableJson(value), null, 2)}\n`;
}

async function readJson(path: string, label: string): Promise<JsonRecord> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new PaperArtifactExportError(`${label} is missing or unreadable at ${path}: ${(error as Error).message}`);
  }
  try {
    return requiredRecord(JSON.parse(raw), label);
  } catch (error) {
    if (error instanceof PaperArtifactExportError) throw error;
    throw new PaperArtifactExportError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(normalizeForStableJson(actual)) !== JSON.stringify(normalizeForStableJson(expected))) {
    throw new PaperArtifactExportError(`${label} does not match the frozen experiment identity.`);
  }
}

function resolveStudy(experimentId: string): ExperimentSpec {
  const spec = EXPERIMENT_SPECS[experimentId];
  if (!spec) {
    throw new PaperArtifactExportError(`Unsupported paper experiment "${experimentId}". Supported experiments: ${Object.keys(EXPERIMENT_SPECS).join(", ")}.`);
  }
  return spec;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function publicationPrivateRoots(sourceRoot: string): string[] {
  const roots = new Set<string>();
  const home = process.env.HOME;
  if (home && isAbsolute(home) && home !== sep) roots.add(resolve(home));
  roots.add(resolve(sourceRoot));
  return [...roots].sort((a, b) => b.length - a.length);
}

export function assertPublicationSafeText(text: string, label: string, privateRoots: readonly string[] = []): void {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new PaperArtifactExportError(`${label} contains a possible ${name}; refusing publication export.`);
  }
  for (const { name, pattern } of GENERIC_PRIVATE_PATH_PATTERNS) {
    if (pattern.test(text)) throw new PaperArtifactExportError(`${label} contains a possible ${name}; refusing publication export.`);
  }
  for (const root of privateRoots) {
    if (root.length > 1 && text.includes(root)) {
      throw new PaperArtifactExportError(`${label} contains operator-private path ${root}; refusing publication export.`);
    }
  }
}

async function writeGeneratedJson(path: string, value: unknown, privateRoots: readonly string[]): Promise<void> {
  const raw = stableJson(value);
  assertPublicationSafeText(raw, relative(dirname(path), path) || basename(path), privateRoots);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, raw);
}

async function readSafeText(path: string, publicLabel: string, privateRoots: readonly string[]): Promise<Buffer> {
  const contents = await readFile(path);
  if (contents.includes(0)) throw new PaperArtifactExportError(`${publicLabel} appears to be binary; only UTF-8/text evidence is publication-allowlisted.`);
  const text = contents.toString("utf8");
  assertPublicationSafeText(text, publicLabel, privateRoots);
  return contents;
}

async function copySafeText(
  source: string,
  destination: string,
  sourceRoot: string,
  publicRoot: string,
  privateRoots: readonly string[],
  sourceEvidence: SourceEvidence[],
  required = false
): Promise<boolean> {
  if (!(await exists(source))) {
    if (required) throw new PaperArtifactExportError(`Required publication evidence is missing: ${relative(sourceRoot, source)}.`);
    return false;
  }
  const contents = await readSafeText(source, relative(sourceRoot, source), privateRoots);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  sourceEvidence.push({
    sourcePath: relative(sourceRoot, source).split(sep).join("/"),
    sourceSha256: sha256(contents),
    publicPath: relative(publicRoot, destination).split(sep).join("/"),
    projection: "copied"
  });
  return true;
}

function sanitizedExperimentManifest(raw: JsonRecord, sourceSha: string, revisionDisclosure: "public" | "private"): JsonRecord {
  const engineeringDryRun = raw.engineeringDryRun;
  const publicDryRun = isRecord(engineeringDryRun)
    ? { ...engineeringDryRun, path: typeof engineeringDryRun.path === "string" ? basename(engineeringDryRun.path) : engineeringDryRun.path }
    : engineeringDryRun;
  const redactRevisions = revisionDisclosure === "private";
  return {
    ...raw,
    artifactRoot: "[REDACTED_OPERATOR_ARTIFACT_ROOT]",
    ...(redactRevisions ? { postgresRevisions: "[REDACTED_OPERATOR_PRIVATE_REVISIONS]" } : {}),
    engineeringDryRun: publicDryRun,
    publicationProjection: {
      schemaVersion: 1,
      sourceSha256: sourceSha,
      redactions: [
        "artifactRoot",
        ...(redactRevisions ? ["postgresRevisions"] : []),
        ...(isRecord(engineeringDryRun) ? ["engineeringDryRun.path"] : [])
      ]
    }
  };
}

function projectRevisionObservation(value: unknown): JsonRecord {
  const observation = requiredRecord(value, "grader revision observation");
  const execution = isRecord(observation.execution)
    ? {
        ok: observation.execution.ok,
        exitCode: observation.execution.exitCode,
        durationMs: observation.execution.durationMs
      }
    : undefined;
  const attribution = isRecord(observation.attribution)
    ? {
        validity: observation.attribution.validity,
        historicalMatchSatisfied: isRecord(observation.attribution.historicalMatch) ? observation.attribution.historicalMatch.satisfied : undefined,
        referenceMatchSatisfied: isRecord(observation.attribution.referenceMatch) ? observation.attribution.referenceMatch.satisfied : undefined,
        attributedTo: observation.attribution.attributedTo
      }
    : undefined;
  return {
    reproduced: observation.reproduced,
    ...(execution ? { execution } : {}),
    ...(attribution ? { attribution } : {}),
    ...(isRecord(observation.executionEnvironment) ? { executionEnvironment: observation.executionEnvironment } : {})
  };
}

function projectGrade(grade: JsonRecord, sourceSha: string): JsonRecord {
  return {
    schemaVersion: 1,
    projection: "publication-safe-grade-summary-v1",
    sourceSha256: sourceSha,
    taskId: grade.taskId,
    status: grade.status,
    gradingPath: grade.gradingPath,
    historical: projectRevisionObservation(grade.historical),
    reference: projectRevisionObservation(grade.reference),
    gradedAt: grade.gradedAt,
    omitted: ["artifacts", "diagnostics", "oracle-specific match details", "raw stdout/stderr"]
  };
}

async function validateScaffoldingExposure(attemptDir: string, level: ScaffoldingLevel): Promise<void> {
  const taskDir = join(attemptDir, "task-bundle", "task");
  const expected = {
    spec: level !== "E0",
    changeSet: level === "E2" || level === "E3",
    harnessProfile: level === "E3"
  };
  const actual = {
    spec: await exists(join(taskDir, "spec.md")),
    changeSet: await exists(join(taskDir, "change-set.diff")),
    harnessProfile: await exists(join(taskDir, "harness-profile.md"))
  };
  assertEqual(actual, expected, `${level} task exposure`);
}

async function validateCompletedAttempt(sourceRoot: string, spec: ExperimentSpec, attempt: AttemptSpec, manifest: JsonRecord): Promise<void> {
  const attemptDir = join(sourceRoot, attempt.sourceDirectory);
  const taskManifest = await readJson(join(attemptDir, "task-manifest.json"), `${attempt.attemptId} task-manifest.json`);
  const referenceManifest = await readJson(join(attemptDir, "reference-manifest.json"), `${attempt.attemptId} reference-manifest.json`);
  const agentResult = await readJson(join(attemptDir, "agent-result.json"), `${attempt.attemptId} agent-result.json`);
  const grade = await readJson(join(attemptDir, "grader", "grade.json"), `${attempt.attemptId} grader/grade.json`);

  assertEqual(taskManifest.taskId, spec.taskId, `${attempt.attemptId} taskId`);
  assertEqual(taskManifest.scaffoldingLevel, attempt.condition, `${attempt.attemptId} scaffoldingLevel`);
  assertEqual(referenceManifest.taskId, spec.taskId, `${attempt.attemptId} reference taskId`);
  const hashes = requiredRecord(taskManifest.hashes, `${attempt.attemptId} task hashes`);
  assertEqual(referenceManifest.taskDefinitionHash, hashes.taskDefinition, `${attempt.attemptId} taskDefinitionHash`);
  assertEqual(referenceManifest.truthBundleHash, hashes.truthBundle, `${attempt.attemptId} truthBundleHash`);

  const perCondition = requiredRecord(manifest.perConditionMaterializationHashes, "experiment perConditionMaterializationHashes");
  assertEqual(perCondition[attempt.condition], hashes, `${attempt.attemptId} materialization hashes`);

  const isolation = requiredRecord(agentResult.isolation, `${attempt.attemptId} agent isolation`);
  assertEqual(isolation.scoredEligible, true, `${attempt.attemptId} scoredEligible`);
  assertEqual(isolation.restrictedEgressVerified, true, `${attempt.attemptId} restrictedEgressVerified`);
  const imageIdentity = requiredRecord(isolation.imageIdentity, `${attempt.attemptId} imageIdentity`);
  assertEqual(imageIdentity.id, spec.expectedAgentImageId, `${attempt.attemptId} agent image`);
  const agent = requiredRecord(agentResult.agent, `${attempt.attemptId} agent result`);
  assertEqual(agent.ok, true, `${attempt.attemptId} agent completion`);
  assertEqual(grade.taskId, spec.taskId, `${attempt.attemptId} grade taskId`);
  assertEqual(grade.status, attempt.expectedOfficialResult, `${attempt.attemptId} official grader result`);

  await validateScaffoldingExposure(attemptDir, attempt.condition);
}

async function validateExperiment(sourceRoot: string, spec: ExperimentSpec): Promise<JsonRecord> {
  const manifest = await readJson(join(sourceRoot, "experiment-manifest.json"), "experiment-manifest.json");
  assertEqual(manifest.schemaVersion, 1, "experiment manifest schemaVersion");
  assertEqual(manifest.experimentId, spec.experimentId, "experimentId");
  assertEqual(manifest.repositoryCommit, spec.sourceCommit, "repositoryCommit");
  assertEqual(manifest.taskId, spec.taskId, "taskId");
  assertEqual(manifest.scaffoldingLevels, SCAFFOLDING_LEVELS, "scaffoldingLevels");
  assertEqual(manifest.executionOrder, SCAFFOLDING_LEVELS, "executionOrder");
  if (spec.revisionDisclosure === "public") {
    assertEqual(manifest.postgresRevisions, { historical: spec.historicalRevision, reference: spec.referenceRevision }, "PostgreSQL revisions");
  } else {
    // Never compare against a hardcoded literal for a private-revision study
    // (this file is committed to the public clemenza/honeyrail repository) -
    // structural validation only. The real values are redacted from every
    // exported artifact by sanitizedExperimentManifest()/the provenance.json
    // projection below, not merely left unchecked.
    const revisions = requiredRecord(manifest.postgresRevisions, "experiment postgresRevisions");
    const historical = requiredString(revisions.historical, "postgresRevisions.historical");
    const reference = requiredString(revisions.reference, "postgresRevisions.reference");
    if (!/^[a-f0-9]{40}$/i.test(historical) || !/^[a-f0-9]{40}$/i.test(reference)) {
      throw new PaperArtifactExportError("postgresRevisions.historical/reference must each be a 40-character hex SHA.");
    }
    if (historical === reference) {
      throw new PaperArtifactExportError("postgresRevisions.historical and .reference must differ.");
    }
  }
  assertEqual(manifest.agentTimeoutMs, 1_800_000, "agent timeout");
  assertEqual(manifest.trajectoryExpectation, "dsh", "trajectory expectation");
  assertEqual(manifest.modelVersion, "deepseek-v4-flash", "model version");
  const isolationPolicy = requiredRecord(manifest.isolationPolicy, "experiment isolationPolicy");
  assertEqual(isolationPolicy.restrictedEgress, true, "restricted egress policy");
  assertEqual(isolationPolicy.scoredEligibleExpected, true, "scored eligibility policy");
  const image = requiredRecord(manifest.agentImage, "experiment agentImage");
  assertEqual(image.id, spec.expectedAgentImageId, "experiment agent image");

  const rootEntries = await readdir(sourceRoot, { withFileTypes: true });
  const allowedAttemptDirs = new Set(spec.attempts.map((attempt) => attempt.sourceDirectory));
  for (const ignored of spec.ignoredFormalPrefixDirectories) allowedAttemptDirs.add(ignored);
  const unexpectedFormalDirs = rootEntries
    .filter((entry) => entry.isDirectory() && /^E[0-3](?:-|$)/.test(entry.name) && !allowedAttemptDirs.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (unexpectedFormalDirs.length) {
    throw new PaperArtifactExportError(`Unexpected E0-E3 attempt directories would be omitted: ${unexpectedFormalDirs.join(", ")}.`);
  }

  for (const attempt of spec.attempts) {
    const attemptDir = join(sourceRoot, attempt.sourceDirectory);
    if (!(await exists(attemptDir))) throw new PaperArtifactExportError(`Expected formal attempt directory is missing: ${attempt.sourceDirectory}.`);
    if (attempt.expectedDisposition === "completed") await validateCompletedAttempt(sourceRoot, spec, attempt, manifest);
  }
  return manifest;
}

async function exportAttempt(
  sourceRoot: string,
  publicRoot: string,
  spec: ExperimentSpec,
  attempt: AttemptSpec,
  privateRoots: readonly string[],
  sourceEvidence: SourceEvidence[]
): Promise<ExportAttemptLedgerEntry> {
  const sourceDir = join(sourceRoot, attempt.sourceDirectory);
  const publicDir = join(publicRoot, attempt.sourceDirectory);
  await mkdir(publicDir, { recursive: true });

  for (const file of ATTEMPT_FILE_ALLOWLIST) {
    const required = attempt.expectedDisposition === "completed" && ["task-manifest.json", "reference-manifest.json", "agent-result.json", "workspace-inventory.json", "agent-transcript.ndjson"].includes(file);
    await copySafeText(join(sourceDir, file), join(publicDir, file), sourceRoot, publicRoot, privateRoots, sourceEvidence, required);
  }

  for (const file of TASK_INPUT_ALLOWLIST) {
    const source = join(sourceDir, "task-bundle", "task", file);
    const destination = join(publicDir, "task", file);
    const required =
      attempt.expectedDisposition === "completed" &&
      (file === "prompt.md" || file === "source-manifest.json" || file === "workspace/README.md" ||
        (file === "spec.md" && attempt.condition !== "E0") ||
        (file === "change-set.diff" && (attempt.condition === "E2" || attempt.condition === "E3")) ||
        (file === "harness-profile.md" && attempt.condition === "E3"));
    await copySafeText(source, destination, sourceRoot, publicRoot, privateRoots, sourceEvidence, required);
  }

  const findingPath = join(sourceDir, "agent-workspace", "finding.json");
  if (await exists(findingPath)) {
    await copySafeText(findingPath, join(publicDir, "submission", "finding.json"), sourceRoot, publicRoot, privateRoots, sourceEvidence, true);
    const finding = await readJson(findingPath, `${attempt.attemptId} finding.json`);
    if (finding.status === "reproduced") {
      const reproducer = requiredString(finding.reproducer, `${attempt.attemptId} finding.reproducer`);
      if (basename(reproducer) !== reproducer || reproducer === "." || reproducer === "..") {
        throw new PaperArtifactExportError(`${attempt.attemptId} finding.json names a non-local reproducer path.`);
      }
      await copySafeText(join(sourceDir, "agent-workspace", reproducer), join(publicDir, "submission", reproducer), sourceRoot, publicRoot, privateRoots, sourceEvidence, true);
    }
  } else if (attempt.expectedDisposition === "completed") {
    throw new PaperArtifactExportError(`${attempt.attemptId} completed attempt has no agent-workspace/finding.json.`);
  }

  let scoredEligible: boolean | null = null;
  let officialResult: string | null = null;
  if (attempt.expectedDisposition === "completed") {
    const agentResultPath = join(sourceDir, "agent-result.json");
    const agentResult = await readJson(agentResultPath, `${attempt.attemptId} agent-result.json`);
    const isolation = requiredRecord(agentResult.isolation, `${attempt.attemptId} isolation`);
    scoredEligible = isolation.scoredEligible === true;

    const gradePath = join(sourceDir, "grader", "grade.json");
    const gradeRaw = await readFile(gradePath);
    const grade = requiredRecord(JSON.parse(gradeRaw.toString("utf8")), `${attempt.attemptId} grade.json`);
    officialResult = requiredString(grade.status, `${attempt.attemptId} grade.status`);
    const gradeSummary = projectGrade(grade, sha256(gradeRaw));
    const publicGradePath = join(publicDir, "grader-summary.json");
    await writeGeneratedJson(publicGradePath, gradeSummary, privateRoots);
    sourceEvidence.push({
      sourcePath: relative(sourceRoot, gradePath).split(sep).join("/"),
      sourceSha256: sha256(gradeRaw),
      publicPath: relative(publicRoot, publicGradePath).split(sep).join("/"),
      projection: "summary"
    });
  }

  return {
    attemptId: attempt.attemptId,
    condition: attempt.condition,
    sourceDirectory: attempt.sourceDirectory,
    predecessor: attempt.predecessor,
    disposition: attempt.expectedDisposition,
    scoredEligible,
    officialResult,
    evidenceDirectory: attempt.sourceDirectory
  };
}

async function listFiles(root: string): Promise<Array<{ path: string; absolutePath: string; bytes: number; sha256: string }>> {
  const files: Array<{ path: string; absolutePath: string; bytes: number; sha256: string }> = [];
  async function walk(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new PaperArtifactExportError(`Publication output contains unsupported non-file entry: ${relative(root, absolutePath)}.`);
      const contents = await readFile(absolutePath);
      files.push({ path: relative(root, absolutePath).split(sep).join("/"), absolutePath, bytes: contents.length, sha256: sha256(contents) });
    }
  }
  await walk(root);
  return files;
}

async function assertOutputTreePublicationSafe(root: string, privateRoots: readonly string[]): Promise<void> {
  for (const file of await listFiles(root)) {
    if (file.path === "SHA256SUMS") continue;
    const contents = await readSafeText(file.absolutePath, file.path, privateRoots);
    if (contents.includes(0)) throw new PaperArtifactExportError(`${file.path} is binary.`);
  }
}

export async function exportPaperArtifact(input: {
  experimentId: string;
  sourceDir?: string;
  outputDir: string;
  rawArchiveSha256?: string | null;
}): Promise<PaperArtifactExportResult> {
  const spec = resolveStudy(input.experimentId);
  const sourceRoot = resolve(input.sourceDir ?? spec.defaultSource);
  const outputRoot = resolve(input.outputDir);
  if (isWithin(sourceRoot, outputRoot) || isWithin(outputRoot, sourceRoot)) {
    throw new PaperArtifactExportError("Source and publication output directories must be disjoint; the exporter never sanitizes L0 in place.");
  }
  if (!(await exists(sourceRoot))) throw new PaperArtifactExportError(`Source experiment directory does not exist: ${sourceRoot}.`);
  if (await exists(outputRoot)) throw new PaperArtifactExportError(`Output directory already exists: ${outputRoot}. Export into a fresh directory to prevent stale/selective evidence.`);

  if (input.rawArchiveSha256 != null && !/^[a-f0-9]{64}$/i.test(input.rawArchiveSha256)) {
    throw new PaperArtifactExportError("rawArchiveSha256 must be a 64-character SHA-256 hex digest when supplied.");
  }

  const manifest = await validateExperiment(sourceRoot, spec);
  const privateRoots = publicationPrivateRoots(sourceRoot);
  const stagingRoot = `${outputRoot}.paper-artifact-export-${process.pid}`;
  await rm(stagingRoot, { recursive: true, force: true });
  const sourceEvidence: SourceEvidence[] = [];

  try {
    await mkdir(stagingRoot, { recursive: true });
    const rawManifest = await readFile(join(sourceRoot, "experiment-manifest.json"));
    const rawManifestSha = sha256(rawManifest);
    const publicManifestPath = join(stagingRoot, "experiment-manifest.json");
    await writeGeneratedJson(publicManifestPath, sanitizedExperimentManifest(manifest, rawManifestSha, spec.revisionDisclosure), privateRoots);
    sourceEvidence.push({ sourcePath: "experiment-manifest.json", sourceSha256: rawManifestSha, publicPath: "experiment-manifest.json", projection: "sanitized" });

    const ledgerEntries: ExportAttemptLedgerEntry[] = [];
    for (const attempt of spec.attempts) {
      ledgerEntries.push(await exportAttempt(sourceRoot, stagingRoot, spec, attempt, privateRoots, sourceEvidence));
    }

    await writeGeneratedJson(
      join(stagingRoot, "attempt-ledger.json"),
      {
        schemaVersion: 1,
        experimentId: spec.experimentId,
        source: "frozen experiment evidence plus the canonical report disposition for retained non-scored infrastructure attempts",
        attempts: ledgerEntries
      },
      privateRoots
    );

    const evidenceFiles = (await listFiles(stagingRoot)).sort((a, b) => a.path.localeCompare(b.path));
    const evidenceManifest = {
      schemaVersion: 1,
      artifactExportVersion: PAPER_ARTIFACT_EXPORT_VERSION,
      experimentId: spec.experimentId,
      files: evidenceFiles.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest }))
    };
    const evidenceManifestRaw = stableJson(evidenceManifest);
    const evidenceManifestSha = sha256(evidenceManifestRaw);
    await writeFile(join(stagingRoot, "PUBLIC-EVIDENCE-MANIFEST.json"), evidenceManifestRaw);

    const provenance = {
      schemaVersion: 1,
      artifactExportVersion: PAPER_ARTIFACT_EXPORT_VERSION,
      experimentId: spec.experimentId,
      shortId: spec.shortId,
      sourceRepository: "clemenza/honeyrail",
      sourceCommit: spec.sourceCommit,
      taskId: spec.taskId,
      historicalRevision: spec.revisionDisclosure === "public" ? spec.historicalRevision : "[REDACTED_OPERATOR_PRIVATE_REVISION]",
      referenceRevision: spec.revisionDisclosure === "public" ? spec.referenceRevision : "[REDACTED_OPERATOR_PRIVATE_REVISION]",
      rawArtifactSha256: input.rawArchiveSha256 ?? null,
      publicEvidenceManifestSha256: evidenceManifestSha,
      canonicalIssue: spec.canonicalIssue,
      canonicalReport: spec.canonicalReport,
      declassificationStatus: "frozen-private",
      sourceEvidence: sourceEvidence.sort((a, b) => a.publicPath.localeCompare(b.publicPath) || a.sourcePath.localeCompare(b.sourcePath))
    };
    await writeGeneratedJson(join(stagingRoot, "provenance.json"), provenance, privateRoots);

    await assertOutputTreePublicationSafe(stagingRoot, privateRoots);
    const checksumFiles = (await listFiles(stagingRoot)).filter((file) => file.path !== "SHA256SUMS").sort((a, b) => a.path.localeCompare(b.path));
    await writeFile(join(stagingRoot, "SHA256SUMS"), checksumFiles.map((file) => `${file.sha256}  ${file.path}`).join("\n") + "\n");
    await assertOutputTreePublicationSafe(stagingRoot, privateRoots);

    await rename(stagingRoot, outputRoot);
    const finalFiles = await listFiles(outputRoot);
    return {
      experimentId: spec.experimentId,
      shortId: spec.shortId,
      outputDir: outputRoot,
      files: finalFiles.length,
      bytes: finalFiles.reduce((sum, file) => sum + file.bytes, 0),
      publicEvidenceManifestSha256: evidenceManifestSha
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function defaultPaperArtifactSource(experimentId: string): string {
  return resolveStudy(experimentId).defaultSource;
}
