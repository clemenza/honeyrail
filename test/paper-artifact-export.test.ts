import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { PaperArtifactExportError, exportPaperArtifact } from "../server/postgres/paper-artifact-export.js";

const IMAGE_ID = "sha256:26b7bc8ca5f45f3b043132743309d11baa755576872fb16e999c925fe4342ee9";
const EXP222 = "exp222-e0e3-dsh-2026-09-10";
const EXP216 = "exp216-e0e3-dsh-2026-09-09";

type FixtureConfig = {
  experimentId: typeof EXP222 | typeof EXP216;
  root: string;
};

function identityFor(experimentId: FixtureConfig["experimentId"]) {
  if (experimentId === EXP216) {
    return {
      taskId: "postgres-change-001",
      repositoryCommit: "7f5d0f76769cb4d4b729000265205ccec004de2d",
      historical: "280a408b48d5ee42969f981bceb9e9426c3a344c",
      reference: "fadcc4e81bd99e6032ae042cae53be0c6eea7580"
    };
  }
  return {
    taskId: "postgres-change-002",
    repositoryCommit: "84b44e47e4623bb2965bcb2fc3f735b89bfb6079",
    historical: "ee895a655ce4341546facd6f23e3e8f2931b96bf",
    reference: "7f875fb5bd603d8640cc7aca2c79c604aacd3890"
  };
}

async function tempDir(prefix = "paper-artifact-export-") {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeJson(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function hashesFor(level: string) {
  return {
    sourceTree: `source-${level}`,
    prompt: `prompt-${level}`,
    taskDefinition: `task-${level}`,
    truthBundle: `truth-${level}`,
    agentWorkspace: `workspace-${level}`,
    buildContract: "build-contract"
  };
}

async function writeCompletedAttempt(root: string, taskId: string, level: "E0" | "E1" | "E2" | "E3") {
  const dir = join(root, level);
  const hashes = hashesFor(level);
  await mkdir(join(dir, "task-bundle", "task", "workspace"), { recursive: true });
  await mkdir(join(dir, "agent-workspace"), { recursive: true });
  await mkdir(join(dir, "grader"), { recursive: true });

  await writeJson(join(dir, "task-manifest.json"), {
    schemaVersion: 1,
    taskId,
    database: "postgresql",
    taskType: "historical-correctness-regression",
    scaffoldingLevel: level,
    budget: { wallClockMs: 1_800_000 },
    buildProfile: "fixture",
    artifacts: { sourceManifest: "source-manifest.json", prompt: "prompt.md", workspace: "workspace" },
    hashes
  });
  await writeJson(join(dir, "reference-manifest.json"), {
    schemaVersion: 1,
    taskId,
    gradingProtocol: taskId === "postgres-change-001" ? "submitted-reproducer-structured-oracle-v1" : "submitted-reproducer-behavioral-oracle-v1",
    taskDefinitionHash: hashes.taskDefinition,
    truthBundleHash: hashes.truthBundle
  });
  await writeJson(join(dir, "agent-result.json"), {
    schemaVersion: 1,
    agent: { ok: true, exitCode: 0, signal: null, timedOut: false, startedAt: "2026-09-10T00:00:00.000Z", durationMs: 1000 },
    isolation: {
      mode: "restrictedEgress",
      isolated: true,
      scoredEligible: true,
      restrictedEgressVerified: true,
      imageIdentity: { reference: "honeyrail-postgres-research-agent-dsh:latest", id: IMAGE_ID }
    },
    executionEnvironment: {
      buildMode: "container",
      buildProfileVersion: "fixture",
      configureArgs: ["--without-readline"],
      buildEnv: {},
      builderImage: { reference: "builder", id: "sha256:builder" },
      runtimeImage: { reference: "runtime", id: "sha256:runtime" },
      compiler: { command: "cc", version: "12.2.0", target: "aarch64-linux-gnu" }
    }
  });
  await writeJson(join(dir, "workspace-inventory.json"), {
    schemaVersion: 1,
    totalFiles: 2,
    totalBytes: 128,
    limits: { maxFiles: 2048, maxBytes: 16777216 },
    exceeded: { files: false, bytes: false },
    topLevelEntries: [],
    largestFiles: []
  });
  await writeFile(join(dir, "agent-transcript.ndjson"), `${JSON.stringify({ role: "assistant", content: `investigated ${level}` })}\n`);
  await writeFile(join(dir, "agent-trajectory.jsonl"), `${JSON.stringify({ type: "shell_command", command: "psql", exit_code: null })}\n`);
  await writeJson(join(dir, "agent-session-stats.json"), { steps: 1, decodeTokens: 10 });
  await writeFile(join(dir, "agent-stdout.txt"), "agent stdout\n");
  await writeFile(join(dir, "agent-stderr.txt"), "");
  await writeFile(join(dir, "agent-postgres.log"), "database log\n");

  await writeJson(join(dir, "agent-workspace", "finding.json"), {
    status: "reproduced",
    summary: `fixture finding ${level}`,
    reproducer: "repro.sql"
  });
  await writeFile(join(dir, "agent-workspace", "repro.sql"), "SELECT 1;\n");
  await writeFile(join(dir, "agent-workspace", "scratch.txt"), "must not be exported\n");

  const revision = (attributedTo: "historical" | "reference") => ({
    reproduced: attributedTo === "historical",
    execution: { ok: attributedTo === "historical", stdout: "PRIVATE-RUNTIME-DETAIL", stderr: "", exitCode: attributedTo === "historical" ? 0 : 1, durationMs: 5 },
    attribution: {
      validity: { valid: true },
      historicalMatch: { satisfied: attributedTo === "historical", diagnostics: ["HIDDEN-ORACLE-SENTINEL"] },
      referenceMatch: { satisfied: attributedTo === "reference", diagnostics: ["HIDDEN-ORACLE-SENTINEL"] },
      attributedTo,
      oracleSpecificSecret: "HIDDEN-ORACLE-SENTINEL"
    },
    executionEnvironment: { buildMode: "container", buildProfileVersion: "fixture", configureArgs: [], buildEnv: {}, builderImage: null, runtimeImage: null, compiler: { command: "cc", version: "12", target: "arm64" } }
  });
  await writeJson(join(dir, "grader", "grade.json"), {
    taskId,
    status: "miss",
    gradingPath: "reproducer",
    historical: revision("reference"),
    reference: revision("reference"),
    artifacts: ["PRIVATE-HOST-PATH"],
    diagnostics: ["HIDDEN-ORACLE-SENTINEL"],
    gradedAt: "2026-09-10T00:01:00.000Z"
  });

  await writeFile(join(dir, "task-bundle", "task", "prompt.md"), `public prompt ${level}\n`);
  await writeJson(join(dir, "task-bundle", "task", "source-manifest.json"), { schemaVersion: 1, sourceHash: `source-${level}`, gitDirPresent: false });
  await writeFile(join(dir, "task-bundle", "task", "workspace", "README.md"), "public workspace contract\n");
  if (level !== "E0") await writeFile(join(dir, "task-bundle", "task", "spec.md"), "contemporaneous spec\n");
  if (level === "E2" || level === "E3") await writeFile(join(dir, "task-bundle", "task", "change-set.diff"), "diff --git a/a b/a\n");
  if (level === "E3") await writeFile(join(dir, "task-bundle", "task", "harness-profile.md"), "generic methodology\n");

  await mkdir(join(dir, "task-bundle", "task", "source", "src"), { recursive: true });
  await writeFile(join(dir, "task-bundle", "task", "source", "src", "large-derived.c"), "must not be exported\n");
  await mkdir(join(dir, "agent-private"), { recursive: true });
  await writeFile(join(dir, "agent-private", "secret.txt"), "must not be exported\n");
  await mkdir(join(dir, "grader", "historical", "PGDATA"), { recursive: true });
  await writeFile(join(dir, "grader", "historical", "PGDATA", "derived"), "must not be exported\n");
  await writeJson(join(dir, "reference-truth.json"), { structuredOracle: { secret: "HIDDEN-ORACLE-SENTINEL" }, canonicalReproducer: "verification/canonical-reproducer.sql" });
}

async function makeFixture(config: FixtureConfig) {
  const identity = identityFor(config.experimentId);
  await mkdir(config.root, { recursive: true });
  const perConditionMaterializationHashes: Record<string, unknown> = {};
  for (const level of ["E0", "E1", "E2", "E3"] as const) {
    await writeCompletedAttempt(config.root, identity.taskId, level);
    perConditionMaterializationHashes[level] = hashesFor(level);
  }
  if (config.experimentId === EXP216) {
    await mkdir(join(config.root, "E2-ATTEMPT-1-INFRASTRUCTURE-ERROR"), { recursive: true });
    await writeFile(join(config.root, "E2-ATTEMPT-1-INFRASTRUCTURE-ERROR", "agent-stderr.txt"), "driver interrupted before scored completion\n");
    await mkdir(join(config.root, "DRY-RUN-E0"), { recursive: true });
  }
  await writeJson(join(config.root, "experiment-manifest.json"), {
    schemaVersion: 1,
    createdAt: "2026-09-10T00:00:00.000Z",
    experimentId: config.experimentId,
    repositoryCommit: identity.repositoryCommit,
    taskId: identity.taskId,
    scaffoldingLevels: ["E0", "E1", "E2", "E3"],
    executionOrder: ["E0", "E1", "E2", "E3"],
    agentBackend: "DSH CLI, headless profile",
    agentImage: { reference: "honeyrail-postgres-research-agent-dsh:latest", id: IMAGE_ID },
    postgresRevisions: { historical: identity.historical, reference: identity.reference },
    agentTimeoutMs: 1_800_000,
    tokenToolBudgetPolicy: "not enforced by this path",
    isolationPolicy: { restrictedEgress: true, upstreamUrl: "https://api.deepseek.com", scoredEligibleExpected: true },
    trajectoryExpectation: "dsh",
    retryPolicy: "A retry gets a new attempt ID linked to its predecessor.",
    artifactRoot: config.root,
    dshVersion: "0.1.0-rc.7",
    modelProvider: "api.deepseek.com",
    modelVersion: "deepseek-v4-flash",
    engineeringDryRun: config.experimentId === EXP216 ? { path: join(config.root, "DRY-RUN-E0"), excludedFromFormalLedger: true } : null,
    perConditionMaterializationHashes
  });
}

async function walkHashes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else {
        const raw = await readFile(path);
        out[relative(root, path).split(sep).join("/")] = createHash("sha256").update(raw).digest("hex");
      }
    }
  }
  await walk(root);
  return out;
}

test("exports exact exp222 formal evidence through an allowlist and publication-safe grader projection", async () => {
  const root = await tempDir();
  const source = join(root, EXP222);
  const output = join(root, "out");
  await makeFixture({ experimentId: EXP222, root: source });

  const result = await exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: output });
  assert.equal(result.experimentId, EXP222);
  assert.ok(await readFile(join(output, "E0", "agent-transcript.ndjson"), "utf8"));
  assert.ok(await readFile(join(output, "E2", "task", "change-set.diff"), "utf8"));
  assert.ok(await readFile(join(output, "E3", "task", "harness-profile.md"), "utf8"));
  assert.equal(await readFile(join(output, "E0", "submission", "repro.sql"), "utf8"), "SELECT 1;\n");

  await assert.rejects(() => readFile(join(output, "E0", "task", "source", "src", "large-derived.c")), /ENOENT/);
  await assert.rejects(() => readFile(join(output, "E0", "agent-private", "secret.txt")), /ENOENT/);
  await assert.rejects(() => readFile(join(output, "E0", "reference-truth.json")), /ENOENT/);
  await assert.rejects(() => readFile(join(output, "E0", "submission", "scratch.txt")), /ENOENT/);

  const gradeSummary = await readFile(join(output, "E0", "grader-summary.json"), "utf8");
  assert.match(gradeSummary, /"status": "miss"/);
  assert.doesNotMatch(gradeSummary, /HIDDEN-ORACLE-SENTINEL|PRIVATE-RUNTIME-DETAIL|PRIVATE-HOST-PATH/);
  const publicExperimentManifest = JSON.parse(await readFile(join(output, "experiment-manifest.json"), "utf8"));
  assert.equal(publicExperimentManifest.artifactRoot, "[REDACTED_OPERATOR_ARTIFACT_ROOT]");
  assert.doesNotMatch(JSON.stringify(publicExperimentManifest), new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("rejects wrong frozen experiment identity and unexpected E-level attempts", async () => {
  const root = await tempDir();
  const source = join(root, EXP222);
  await makeFixture({ experimentId: EXP222, root: source });
  const manifestPath = join(source, "experiment-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.repositoryCommit = "wrong";
  await writeJson(manifestPath, manifest);
  await assert.rejects(
    () => exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: join(root, "out-wrong") }),
    (error: unknown) => error instanceof PaperArtifactExportError && /repositoryCommit/.test(error.message)
  );

  await makeFixture({ experimentId: EXP222, root: source });
  await mkdir(join(source, "E2-ATTEMPT-EXTRA"), { recursive: true });
  await assert.rejects(
    () => exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: join(root, "out-extra") }),
    /would be omitted/
  );
});

test("fails closed on possible credential and private host path in an allowlisted file", async () => {
  const root = await tempDir();
  const source = join(root, EXP222);
  await makeFixture({ experimentId: EXP222, root: source });
  await writeFile(join(source, "E0", "agent-stdout.txt"), "api_key=abcdefghijklmnopQRSTUV123456\n");
  await assert.rejects(() => exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: join(root, "secret-out") }), /possible named credential value/);

  await writeFile(join(source, "E0", "agent-stdout.txt"), "safe\n");
  await writeFile(join(source, "E1", "agent-stderr.txt"), "opened /Users/alice/Workspace/private/file\n");
  await assert.rejects(() => exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: join(root, "path-out") }), /possible macOS user home/);
});

test("preserves Study 1 infrastructure attempt and retry relationship in the public ledger", async () => {
  const root = await tempDir();
  const source = join(root, EXP216);
  const output = join(root, "out");
  await makeFixture({ experimentId: EXP216, root: source });
  await exportPaperArtifact({ experimentId: EXP216, sourceDir: source, outputDir: output });

  const ledger = JSON.parse(await readFile(join(output, "attempt-ledger.json"), "utf8"));
  assert.equal(ledger.attempts.length, 5);
  const infra = ledger.attempts.find((entry: { attemptId: string }) => entry.attemptId === "E2-ATTEMPT-1");
  const retry = ledger.attempts.find((entry: { attemptId: string }) => entry.attemptId === "E2-ATTEMPT-2");
  assert.deepEqual(infra, {
    attemptId: "E2-ATTEMPT-1",
    condition: "E2",
    disposition: "infrastructure_error",
    evidenceDirectory: "E2-ATTEMPT-1-INFRASTRUCTURE-ERROR",
    officialResult: null,
    predecessor: null,
    scoredEligible: null,
    sourceDirectory: "E2-ATTEMPT-1-INFRASTRUCTURE-ERROR"
  });
  assert.equal(retry.predecessor, "E2-ATTEMPT-1");
  assert.equal(retry.officialResult, "miss");
  assert.equal(await readFile(join(output, "E2-ATTEMPT-1-INFRASTRUCTURE-ERROR", "agent-stderr.txt"), "utf8"), "driver interrupted before scored completion\n");
});

test("same frozen input exported twice is byte-equivalent", async () => {
  const root = await tempDir();
  const source = join(root, EXP222);
  const out1 = join(root, "out1");
  const out2 = join(root, "out2");
  await makeFixture({ experimentId: EXP222, root: source });
  const first = await exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: out1 });
  const second = await exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: out2 });
  assert.equal(first.publicEvidenceManifestSha256, second.publicEvidenceManifestSha256);
  assert.deepEqual(await walkHashes(out1), await walkHashes(out2));
});

test("missing authoritative evidence fails closed and leaves no partial publication directory", async () => {
  const root = await tempDir();
  const source = join(root, EXP222);
  const output = join(root, "out");
  await makeFixture({ experimentId: EXP222, root: source });
  await rm(join(source, "E3", "agent-transcript.ndjson"));
  await assert.rejects(() => exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: output }), /Required publication evidence is missing/);
  await assert.rejects(() => readFile(join(output, "provenance.json")), /ENOENT/);
});

test("refuses in-place/overlapping export and existing output directories", async () => {
  const root = await tempDir();
  const source = join(root, EXP222);
  await makeFixture({ experimentId: EXP222, root: source });
  await assert.rejects(() => exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: join(source, "public") }), /must be disjoint/);
  const output = join(root, "existing");
  await mkdir(output);
  await assert.rejects(() => exportPaperArtifact({ experimentId: EXP222, sourceDir: source, outputDir: output }), /already exists/);
});
