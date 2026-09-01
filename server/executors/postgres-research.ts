import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentEnvRoot,
  DEFAULT_CONFIGURE_ARGS,
  withPostgresResearchEnvironment,
  type PostgresQueryResult,
  type PostgresResearchEnvironment,
  type PostgresResearchSpec
} from "../postgres/research-environment.js";
import { createDbEvidence, createDbFileArtifact, registerDbFileArtifact } from "./db-evidence.js";
import { ConfigError, type ExecutionHandle, type ExecutionState, type Executor, type PreflightContext, type StepExecutionContext } from "./types.js";

/**
 * `postgres-research` executor (#179): a thin, bug-agnostic wrapper that
 * turns one PostgreSQL research environment (see
 * server/postgres/research-environment.ts) into the runtime's standard
 * Artifact/Evidence record.
 *
 * It is a sibling of the `postgres` executor's transaction-restart alpha,
 * not a replacement: that scenario asserts fixed expectations about a stock
 * server, this one materializes an exact source ref, builds it, and runs
 * whatever SQL the caller supplies. Nothing here knows what is being looked
 * for - "buggy" and "fixed" differ only by input.source.ref.
 *
 * Everything it writes lands under attachmentRoot (operator/grader side) and
 * carries the full provenance a grader needs. The environment's own
 * agent-visible root deliberately does *not* live under attachmentRoot: it
 * is created under agentEnvRoot() so that no `..` walk from a path in
 * agentEnvironment() arrives at the manifests below. See the eval-isolation
 * contract on PostgresResearchEnvironment.agentEnvironment().
 */

const SCENARIO = "postgres-research-environment";

type ExperimentSpec = { name: string; sql: string };

export type PostgresResearchInput = {
  source: { repoPath: string; ref: string };
  build: { configureArgs: string[]; jobs?: number; cacheRoot?: string };
  experiments: ExperimentSpec[];
  restart: boolean;
  timeoutMs?: number;
  retainDataDir: boolean;
  removeSourceDir: boolean;
  label?: string;
};

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = String(record[key] ?? "").trim();
  if (!value) throw new ConfigError(`${context} requires a non-empty ${key}`);
  return value;
}

function stringArray(value: unknown, context: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${context} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Validated at run-creation time (see preflight) so a misconfigured research
 * step is rejected before any source is materialized or built - the
 * expensive part.
 */
export function parsePostgresResearchInput(input: Record<string, unknown> | undefined): PostgresResearchInput {
  const record = input ?? {};
  const sourceValue = record.source;
  if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) {
    throw new ConfigError("postgres-research step requires input.source of shape { repoPath, ref }");
  }
  const source = sourceValue as Record<string, unknown>;
  const buildValue = record.build;
  if (buildValue !== undefined && (typeof buildValue !== "object" || buildValue === null || Array.isArray(buildValue))) {
    throw new ConfigError("postgres-research input.build must be an object");
  }
  const build = (buildValue ?? {}) as Record<string, unknown>;
  const jobs = build.jobs === undefined ? undefined : Number(build.jobs);
  if (jobs !== undefined && (!Number.isFinite(jobs) || jobs < 1)) {
    throw new ConfigError("postgres-research input.build.jobs must be a positive number");
  }
  const experimentsValue = record.experiments;
  if (experimentsValue !== undefined && !Array.isArray(experimentsValue)) {
    throw new ConfigError("postgres-research input.experiments must be an array of { name, sql }");
  }
  const experiments = ((experimentsValue ?? []) as unknown[]).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ConfigError(`postgres-research input.experiments[${index}] must be an object of shape { name, sql }`);
    }
    const entry = item as Record<string, unknown>;
    return {
      name: String(entry.name ?? `experiment-${index + 1}`).trim() || `experiment-${index + 1}`,
      sql: requiredString(entry, "sql", `postgres-research input.experiments[${index}]`)
    };
  });
  const timeoutMs = record.timeoutMs === undefined ? undefined : Number(record.timeoutMs);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new ConfigError("postgres-research input.timeoutMs must be a positive number of milliseconds");
  }
  return {
    source: {
      repoPath: requiredString(source, "repoPath", "postgres-research input.source"),
      ref: requiredString(source, "ref", "postgres-research input.source")
    },
    build: {
      configureArgs: stringArray(build.configureArgs, "postgres-research input.build.configureArgs") ?? [...DEFAULT_CONFIGURE_ARGS],
      jobs,
      cacheRoot: build.cacheRoot === undefined ? undefined : String(build.cacheRoot)
    },
    experiments,
    restart: record.restart === true,
    timeoutMs,
    retainDataDir: record.retainDataDir === true,
    removeSourceDir: record.removeSourceDir === true,
    label: record.label === undefined ? undefined : String(record.label)
  };
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function metadata(phase: string, extra: Record<string, unknown> = {}) {
  return { database: "postgresql", scenario: SCENARIO, phase, ...extra };
}

async function registerIfPresent(ctx: StepExecutionContext, name: string, path: string, phase: string, extra: Record<string, unknown> = {}) {
  if (!(await stat(path).catch(() => null))) return null;
  return registerDbFileArtifact(ctx, {
    name,
    path,
    kind: "log",
    mediaType: "text/plain",
    metadata: metadata(phase, extra)
  });
}

export class PostgresResearchExecutor implements Executor {
  type = "postgres-research";

  async preflight(ctx: PreflightContext): Promise<void> {
    parsePostgresResearchInput(ctx.step.input);
  }

  async start(ctx: StepExecutionContext): Promise<ExecutionHandle> {
    const input = parsePostgresResearchInput(ctx.step.input);
    const attemptDir = join(ctx.attachmentRoot, "runs", ctx.runId, ctx.step.id, `attempt-${ctx.step.attempt}`);
    await mkdir(attemptDir, { recursive: true });
    // Agent-visible state goes in its own hierarchy; grader-private state
    // (build logs, and the manifests written below) stays under attemptDir.
    const envRoot = await createAgentEnvRoot(`${ctx.step.id}-`);

    const spec: PostgresResearchSpec = {
      root: envRoot,
      privateDir: join(attemptDir, "env-private"),
      source: input.source,
      build: input.build,
      runCommand: ctx.runCommand,
      label: input.label
    };

    // Captured from inside the body so the cleanup record - which only
    // exists after withPostgresResearchEnvironment's finally has run - is
    // still reachable here, including on the failure and timeout paths.
    let environment: PostgresResearchEnvironment | undefined;
    try {
      const outcome = await withPostgresResearchEnvironment(
        spec,
        async (env) => {
          environment = env;
          await createDbFileArtifact(ctx, {
            baseDir: attemptDir,
            name: "source-manifest.json",
            content: json(env.sourceManifest),
            kind: "json",
            mediaType: "application/json",
            metadata: metadata("source", { ref: env.sourceManifest.ref, sourceHash: env.sourceManifest.sourceHash })
          });
          await createDbEvidence(ctx, {
            kind: "db.source.snapshot",
            source: "postgres-research",
            claim: `Materialized PostgreSQL source at exact ref "${env.sourceManifest.ref}" with no .git directory`,
            value: {
              ref: env.sourceManifest.ref,
              resolvedCommit: env.sourceManifest.resolvedCommit,
              sourceHash: env.sourceManifest.sourceHash,
              gitDirPresent: env.sourceManifest.gitDirPresent,
              sourceDir: env.sourceManifest.sourceDir
            },
            metadata: metadata("source")
          });

          await createDbFileArtifact(ctx, {
            baseDir: attemptDir,
            name: "build-manifest.json",
            content: json(env.buildManifest),
            kind: "json",
            mediaType: "application/json",
            metadata: metadata("build", { cacheKey: env.buildManifest.cacheKey, cacheHit: env.buildManifest.cacheHit })
          });
          await createDbEvidence(ctx, {
            kind: "db.build",
            source: "postgres-research",
            claim: env.buildManifest.cacheHit
              ? `Reused cached PostgreSQL build ${env.buildManifest.cacheKey}`
              : `Built PostgreSQL from source into ${env.buildManifest.installDir}`,
            value: {
              cacheKey: env.buildManifest.cacheKey,
              cacheHit: env.buildManifest.cacheHit,
              configureArgs: env.buildManifest.configureArgs,
              compiler: env.buildManifest.compiler,
              platform: env.buildManifest.platform,
              arch: env.buildManifest.arch,
              installDir: env.buildManifest.installDir,
              binaries: env.buildManifest.binaries,
              durationMs: env.buildManifest.durationMs
            },
            metadata: metadata("build")
          });
          for (const command of env.buildManifest.commands) {
            if (command.logName) {
              await registerIfPresent(ctx, command.logName, join(env.buildLogDir, command.logName), "build-log", {
                command: command.command,
                durationMs: command.durationMs
              });
            }
          }

          const readiness = await env.start();
          await createDbEvidence(ctx, {
            kind: "db.server.ready",
            source: "postgres-research",
            claim: "PostgreSQL research cluster accepted connections",
            value: readiness,
            metadata: metadata("initial-readiness", { port: env.port })
          });

          const results: Array<ExperimentSpec & PostgresQueryResult> = [];
          for (const experiment of input.experiments) {
            const result = await env.psql(experiment.sql);
            results.push({ ...experiment, ...result });
            await createDbEvidence(ctx, {
              kind: "db.query.result",
              source: "postgres-research",
              claim: `Experiment "${experiment.name}" executed against the research cluster`,
              value: { name: experiment.name, ok: result.ok, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs },
              metadata: metadata("experiment", { name: experiment.name })
            });
          }

          if (input.restart) {
            const restarted = await env.restart();
            await createDbEvidence(ctx, {
              kind: "db.restart",
              source: "postgres-research",
              claim: "PostgreSQL research cluster restarted and became ready",
              value: { passed: restarted.ready, durationMs: restarted.latencyMs },
              metadata: metadata("restart", { port: env.port })
            });
          }

          if (results.length) {
            await createDbFileArtifact(ctx, {
              baseDir: attemptDir,
              name: "experiments.json",
              content: json(results),
              kind: "json",
              mediaType: "application/json",
              metadata: metadata("experiments", { count: results.length })
            });
          }

          await createDbEvidence(ctx, {
            kind: "db.process.health",
            source: "postgres-research",
            claim: "PostgreSQL research cluster completed its experiments before cleanup",
            value: { alive: env.isRunning(), exitCode: null },
            metadata: metadata("process-health", { port: env.port })
          });

          return {
            connection: env.connectionInfo(),
            readiness,
            results,
            cacheKey: env.buildManifest.cacheKey,
            cacheHit: env.buildManifest.cacheHit
          };
        },
        {
          timeoutMs: input.timeoutMs,
          cleanup: { retainDataDir: input.retainDataDir, removeSourceDir: input.removeSourceDir }
        }
      );

      await this.recordRuntime(ctx, attemptDir, environment);
      return {
        status: "succeeded",
        output: {
          scenario: SCENARIO,
          port: outcome.connection.port,
          databaseReady: outcome.readiness.ready,
          cacheKey: outcome.cacheKey,
          cacheHit: outcome.cacheHit,
          installDir: environment?.installDir,
          sourceDir: outcome.connection.sourceDir,
          experiments: outcome.results.map((item) => ({ name: item.name, ok: item.ok, stdout: item.stdout }))
        }
      };
    } catch (error) {
      // The environment has already been cleaned up by the helper's finally;
      // record what is on disk so a failed research step is still auditable.
      await this.recordRuntime(ctx, attemptDir, environment).catch(() => {});
      throw error;
    }
  }

  private async recordRuntime(ctx: StepExecutionContext, attemptDir: string, env: PostgresResearchEnvironment | undefined) {
    if (!env) return;
    const runtime = env.runtimeManifest();
    await createDbFileArtifact(ctx, {
      baseDir: attemptDir,
      name: "runtime-manifest.json",
      content: json(runtime),
      kind: "json",
      mediaType: "application/json",
      metadata: metadata("runtime", { port: env.port })
    });
    // Copied rather than registered in place: the server log lives in the
    // agent-visible root, which is outside attachmentRoot and transient, so
    // the grader-side copy is the one that has to survive.
    const serverLog = await readFile(env.logPath, "utf8").catch(() => null);
    const logArtifact = serverLog === null
      ? null
      : await createDbFileArtifact(ctx, {
          baseDir: attemptDir,
          name: "postgres.log",
          content: serverLog,
          kind: "log",
          mediaType: "text/plain",
          metadata: metadata("postgres-log", { port: env.port })
        });
    await createDbEvidence(ctx, {
      kind: "db.environment.cleanup",
      source: "postgres-research",
      claim: runtime.cleanup?.stopped
        ? "PostgreSQL research environment was stopped and cleaned up"
        : "PostgreSQL research environment cleanup completed with warnings",
      value: runtime.cleanup ?? { stopped: false, reason: "cleanup did not run" },
      artifactIds: logArtifact ? [logArtifact.id] : undefined,
      metadata: metadata("cleanup", { port: env.port })
    });
  }

  async inspect(_ctx: StepExecutionContext, handle: ExecutionHandle): Promise<ExecutionState> {
    return {
      status: String(handle.status || "succeeded") as ExecutionState["status"],
      output: handle.output as Record<string, unknown> | undefined,
      error: handle.error as string | undefined
    };
  }
}
