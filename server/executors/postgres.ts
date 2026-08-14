import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { publishEvent } from "../events.js";
import type { Artifact, Evidence, QualityGateDecision } from "../types.js";
import type { ExecutionHandle, ExecutionState, Executor, StepExecutionContext } from "./types.js";

const SCENARIO = "transaction-restart-alpha";

type QueryObservation = {
  sql: string;
  rows: unknown[][];
  rowCount: number;
};

async function allocatePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Failed to allocate PostgreSQL test port");
  return port;
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function artifactMetadata(phase: string, extra: Record<string, unknown> = {}) {
  return { database: "postgresql", scenario: SCENARIO, phase, ...extra };
}

async function publishArtifact(ctx: StepExecutionContext, artifact: Artifact) {
  await publishEvent(ctx.store, ctx.bus, {
    type: "artifact.created",
    projectId: ctx.project.id,
    payload: { runId: ctx.runId, stepId: ctx.step.id, artifactId: artifact.id, kind: artifact.kind, name: artifact.name }
  });
}

async function publishEvidence(ctx: StepExecutionContext, evidence: Evidence) {
  await publishEvent(ctx.store, ctx.bus, {
    type: "evidence.recorded",
    projectId: ctx.project.id,
    payload: { runId: ctx.runId, stepId: ctx.step.id, evidenceId: evidence.id, kind: evidence.kind, claim: evidence.claim }
  });
}

async function createFileArtifact(
  ctx: StepExecutionContext,
  baseDir: string,
  name: string,
  content: string,
  kind: Artifact["kind"],
  mediaType: string,
  phase: string,
  extra: Record<string, unknown> = {}
) {
  const path = join(baseDir, name);
  await writeFile(path, content);
  const artifact = await ctx.store.createArtifact({
    runId: ctx.runId,
    stepId: ctx.step.id,
    attempt: ctx.step.attempt,
    kind,
    name,
    path,
    uri: `honeyrail://runs/${ctx.runId}/steps/${ctx.step.id}/attempts/${ctx.step.attempt}/${name}`,
    mediaType,
    metadata: artifactMetadata(phase, extra)
  });
  await publishArtifact(ctx, artifact);
  return artifact;
}

async function createEvidence(ctx: StepExecutionContext, input: Omit<Partial<Evidence> & Pick<Evidence, "kind">, "runId" | "stepId" | "attempt">) {
  const evidence = await ctx.store.createEvidence({
    runId: ctx.runId,
    stepId: ctx.step.id,
    attempt: ctx.step.attempt,
    source: "postgres",
    ...input
  });
  await publishEvidence(ctx, evidence);
  return evidence;
}

async function commandPath(ctx: StepExecutionContext, name: string) {
  const result = await ctx.runCommand("sh", ["-lc", `command -v ${name}`], { timeout: 5000 });
  const path = result.stdout.trim();
  if (!path) throw new Error(`Required PostgreSQL command not found: ${name}`);
  return path;
}

async function runRequired(ctx: StepExecutionContext, cmd: string, args: string[], cwd: string, timeout = 30000) {
  const result = await ctx.runCommand(cmd, args, { cwd, timeout, maxBuffer: 1024 * 1024 * 8 });
  if (!result.ok) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.code}`);
  }
  return result;
}

async function runPsql(ctx: StepExecutionContext, cwd: string, port: number, sql: string) {
  const result = await runRequired(ctx, "psql", [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-t",
    "-A",
    "-c",
    sql
  ], cwd);
  return result.stdout.trim();
}

async function waitReady(ctx: StepExecutionContext, cwd: string, port: number) {
  const started = Date.now();
  let lastError = "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await ctx.runCommand("psql", [
      "-X",
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      "SELECT 1;"
    ], { cwd, timeout: 2000 });
    if (result.ok && result.stdout.trim() === "1") {
      return { ready: true, latencyMs: Date.now() - started };
    }
    lastError = result.stderr || result.stdout;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError}`);
}

async function readScalar(ctx: StepExecutionContext, cwd: string, port: number, sql: string): Promise<number> {
  const value = await runPsql(ctx, cwd, port, sql);
  return Number(value);
}

async function stopPostgres(ctx: StepExecutionContext, cwd: string, dataDir: string) {
  await ctx.runCommand("pg_ctl", ["-D", dataDir, "stop", "-m", "fast", "-w"], { cwd, timeout: 30000 });
}

export class PostgresExecutor implements Executor {
  type = "postgres";

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const operation = String(ctx.step.input.operation || "transaction-restart-alpha");
    if (operation === "report") return this.generateReport(ctx);
    if (operation !== "transaction-restart-alpha") throw new Error(`Unsupported postgres operation: ${operation}`);
    return this.runTransactionRestartScenario(ctx);
  }

  async inspect(_ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState> {
    return {
      status: String(handle.status || "succeeded") as ExecutionState["status"],
      output: handle.output as Record<string, unknown> | undefined,
      error: handle.error as string | undefined
    };
  }

  private async runTransactionRestartScenario(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const attemptDir = join(ctx.attachmentRoot, "runs", ctx.runId, ctx.step.id, `attempt-${ctx.step.attempt}`);
    const dataDir = join(attemptDir, "pgdata");
    const socketDir = join(attemptDir, "socket");
    await mkdir(socketDir, { recursive: true });
    const port = await allocatePort();
    const logPath = join(attemptDir, "postgres.log");
    const expectedCommittedRows = Number(ctx.step.input.expectedCommittedRows ?? 1);
    const expectedRolledBackRows = Number(ctx.step.input.expectedRolledBackRows ?? 0);
    const expectedTotalRows = Number(ctx.step.input.expectedTotalRows ?? 1);
    const commandPaths = {
      initdb: await commandPath(ctx, "initdb"),
      pg_ctl: await commandPath(ctx, "pg_ctl"),
      psql: await commandPath(ctx, "psql"),
      postgres: await commandPath(ctx, "postgres")
    };

    const setupSql = [
      "DROP TABLE IF EXISTS honeyrail_alpha_transactions;",
      "CREATE TABLE honeyrail_alpha_transactions (id integer PRIMARY KEY, label text NOT NULL);",
      "BEGIN;",
      "INSERT INTO honeyrail_alpha_transactions VALUES (1, 'committed');",
      "COMMIT;",
      "BEGIN;",
      "INSERT INTO honeyrail_alpha_transactions VALUES (2, 'rolled_back');",
      "ROLLBACK;"
    ].join("\n");
    const verificationSql = [
      "SELECT count(*)::int FROM honeyrail_alpha_transactions WHERE label = 'committed';",
      "SELECT count(*)::int FROM honeyrail_alpha_transactions WHERE label = 'rolled_back';",
      "SELECT count(*)::int FROM honeyrail_alpha_transactions;"
    ].join("\n");

    let stopped = false;
    try {
      await runRequired(ctx, "initdb", ["-D", dataDir, "-A", "trust", "-U", "postgres"], attemptDir, 60000);
      await runRequired(ctx, "pg_ctl", ["-D", dataDir, "-l", logPath, "-o", `-p ${port} -h 127.0.0.1 -k ${socketDir}`, "start", "-w"], attemptDir, 60000);
      const initialReady = await waitReady(ctx, attemptDir, port);
      await createEvidence(ctx, {
        kind: "db.server.ready",
        claim: "PostgreSQL accepted connections before schema setup",
        value: initialReady,
        metadata: artifactMetadata("initial-readiness", { port })
      });

      const version = await runPsql(ctx, attemptDir, port, "SELECT version();");
      const envArtifact = await createFileArtifact(ctx, attemptDir, "environment.json", json({
        database: "postgresql",
        version,
        platform: platform(),
        executionMode: "local-binaries",
        commandPaths,
        port,
        scenario: SCENARIO,
        runId: ctx.runId
      }), "json", "application/json", "environment", { version, executionMode: "local-binaries", port });
      const setupArtifact = await createFileArtifact(ctx, attemptDir, "setup.sql", `${setupSql}\n`, "text", "application/sql", "setup");
      const verificationArtifact = await createFileArtifact(ctx, attemptDir, "verification.sql", `${verificationSql}\n`, "text", "application/sql", "verify-before-restart");

      await runPsql(ctx, attemptDir, port, setupSql);
      const before = await this.collectQueries(ctx, attemptDir, port, verificationArtifact.id);

      const restartStarted = Date.now();
      await runRequired(ctx, "pg_ctl", ["-D", dataDir, "restart", "-m", "fast", "-w", "-l", logPath, "-o", `-p ${port} -h 127.0.0.1 -k ${socketDir}`], attemptDir, 60000);
      const restartedReady = await waitReady(ctx, attemptDir, port);
      const restartDurationMs = Date.now() - restartStarted;
      await createEvidence(ctx, {
        kind: "db.restart",
        claim: "PostgreSQL restarted and became ready",
        value: { passed: restartedReady.ready, durationMs: restartDurationMs },
        metadata: artifactMetadata("restart", { port })
      });
      await createEvidence(ctx, {
        kind: "db.server.ready",
        claim: "PostgreSQL accepted connections after restart",
        value: restartedReady,
        metadata: artifactMetadata("post-restart-readiness", { port })
      });

      const after = await this.collectQueries(ctx, attemptDir, port, verificationArtifact.id, "after restart");
      const actual = {
        committedRows: Number(after[0].rows[0]?.[0] ?? 0),
        rolledBackRows: Number(after[1].rows[0]?.[0] ?? 0),
        totalRows: Number(after[2].rows[0]?.[0] ?? 0)
      };
      const assertions = [
        { claim: "Committed rows persisted after restart", expected: expectedCommittedRows, actual: actual.committedRows },
        { claim: "Rolled-back rows remain absent after restart", expected: expectedRolledBackRows, actual: actual.rolledBackRows },
        { claim: "Total row count matches expectation after restart", expected: expectedTotalRows, actual: actual.totalRows },
        { claim: "PostgreSQL became ready after restart", expected: true, actual: restartedReady.ready }
      ];
      const assertionEvidenceIds: string[] = [];
      for (const assertion of assertions) {
        const evidence = await createEvidence(ctx, {
          kind: "db.assertion",
          claim: assertion.claim,
          value: { passed: assertion.actual === assertion.expected, expected: assertion.expected, actual: assertion.actual },
          artifactIds: [verificationArtifact.id],
          metadata: artifactMetadata("assertion")
        });
        assertionEvidenceIds.push(evidence.id);
      }

      const queryResults = { beforeRestart: before, afterRestart: after, assertions };
      const queryArtifact = await createFileArtifact(ctx, attemptDir, "query-results.json", json(queryResults), "json", "application/json", "query-results", { assertionEvidenceIds });
      const summary = {
        scenario: SCENARIO,
        database: "postgresql",
        version,
        ready: restartedReady.ready,
        assertions,
        artifacts: [envArtifact.id, setupArtifact.id, verificationArtifact.id, queryArtifact.id]
      };
      await createFileArtifact(ctx, attemptDir, "test-summary.json", json(summary), "json", "application/json", "summary");
      const logArtifact = await ctx.store.createArtifact({
        runId: ctx.runId,
        stepId: ctx.step.id,
        attempt: ctx.step.attempt,
        kind: "log",
        name: "postgres.log",
        path: logPath,
        uri: `honeyrail://runs/${ctx.runId}/steps/${ctx.step.id}/attempts/${ctx.step.attempt}/postgres.log`,
        mediaType: "text/plain",
        metadata: artifactMetadata("postgres-log", { port })
      });
      await publishArtifact(ctx, logArtifact);
      await createEvidence(ctx, {
        kind: "db.process.health",
        claim: "PostgreSQL process completed scenario before cleanup",
        value: { alive: true, exitCode: null },
        artifactIds: [logArtifact.id],
        metadata: artifactMetadata("process-health")
      });

      await stopPostgres(ctx, attemptDir, dataDir);
      stopped = true;

      return {
        status: "succeeded",
        output: {
          scenario: SCENARIO,
          databaseReady: restartedReady.ready,
          databaseVersion: version,
          port,
          assertionEvidenceIds,
          expected: { expectedCommittedRows, expectedRolledBackRows, expectedTotalRows },
          actual
        }
      };
    } finally {
      if (!stopped) await stopPostgres(ctx, attemptDir, dataDir);
    }
  }

  private async collectQueries(ctx: StepExecutionContext, cwd: string, port: number, artifactId: string, suffix = "before restart"): Promise<QueryObservation[]> {
    const queries = [
      "SELECT count(*)::int FROM honeyrail_alpha_transactions WHERE label = 'committed';",
      "SELECT count(*)::int FROM honeyrail_alpha_transactions WHERE label = 'rolled_back';",
      "SELECT count(*)::int FROM honeyrail_alpha_transactions;"
    ];
    const observations: QueryObservation[] = [];
    for (const sql of queries) {
      const value = await readScalar(ctx, cwd, port, sql);
      const observation = { sql, rows: [[value]], rowCount: 1 };
      observations.push(observation);
      await createEvidence(ctx, {
        kind: "db.query.result",
        claim: `${sql} ${suffix}`,
        value: observation,
        artifactIds: [artifactId],
        metadata: artifactMetadata("query-result")
      });
    }
    return observations;
  }

  private async generateReport(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const sourceStepId = String(ctx.step.input.sourceStepId || ctx.step.dependsOn[0] || "").trim();
    if (!sourceStepId) throw new Error("Postgres report operation requires input.sourceStepId or one dependency");
    const reportDir = join(ctx.attachmentRoot, "runs", ctx.runId, ctx.step.id, `attempt-${ctx.step.attempt}`);
    await mkdir(reportDir, { recursive: true });
    const [sourceStep, artifacts, evidence, evaluations, decisions] = await Promise.all([
      ctx.store.getStep(ctx.runId, sourceStepId),
      ctx.store.listArtifacts(ctx.runId, sourceStepId),
      ctx.store.listEvidence(ctx.runId, sourceStepId),
      ctx.store.listEvaluations(ctx.runId, sourceStepId),
      ctx.store.listQualityGateDecisions(ctx.runId, sourceStepId)
    ]);
    const latestDecision = decisions.at(-1);
    const assertions = evidence.filter((item) => item.kind === "db.assertion");
    const version = String(sourceStep?.output?.databaseVersion || "unknown");
    const finalStatus = latestDecision?.status === "passed"
      ? "VERIFIED"
      : latestDecision?.status === "overridden"
        ? "OVERRIDDEN BY OPERATOR"
        : "FAILED";
    const lines = [
      "# PostgreSQL Transaction + Restart Validation",
      "",
      "## Environment",
      `- PostgreSQL: ${version}`,
      "- Execution mode: local-binaries",
      `- Run: ${ctx.runId}`,
      `- Scenario: ${SCENARIO}`,
      "",
      "## Assertions",
      ...assertions.map((item) => {
        const value = item.value as { passed?: boolean; expected?: unknown; actual?: unknown } | undefined;
        return `- ${value?.passed ? "[PASS]" : "[FAIL]"} ${item.claim || item.kind} (expected ${String(value?.expected)}, actual ${String(value?.actual)})`;
      }),
      "",
      "## Evaluations",
      ...evaluations.map((item) => `- ${item.evaluator}: ${item.status.toUpperCase()} (${item.score ?? "n/a"}/${item.threshold ?? "n/a"})${item.reason ? ` - ${item.reason}` : ""}`),
      "",
      "## Quality Gate",
      ...decisions.map((item: QualityGateDecision) => `- ${item.status.toUpperCase()} by ${item.decidedBy}${item.reason ? ` - ${item.reason}` : ""}`),
      "",
      "## Artifacts",
      ...artifacts.map((item) => `- ${item.name} (${item.kind})`),
      "",
      "## Result",
      finalStatus,
      ""
    ];
    const artifact = await createFileArtifact(ctx, reportDir, "final-report.md", lines.join("\n"), "text", "text/markdown", "final-report", {
      sourceStepId,
      finalStatus
    });
    return { status: "succeeded", output: { reportArtifactId: artifact.id, finalStatus, sourceStepId } };
  }
}
