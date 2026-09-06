import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  historicalPostgres001TaskSpec,
  historicalPostgres002TaskSpec,
  historicalPostgres003TaskSpec,
  loadHistoricalPostgres003PrivateTruth,
  type HistoricalPostgresTaskSpec
} from "../server/postgres/historical-task.js";
import { runHistoricalPostgresPilotTrial } from "../server/postgres/historical-postgres-preflight.js";
import type { HistoricalPostgresCorpusManifest } from "../server/postgres/historical-corpus.js";

/**
 * Issue #180: the first trustworthy Historical PostgreSQL pilot run. A thin
 * CLI shell around `runHistoricalPostgresPilotTrial()` - same shape as
 * `scripts/historical-postgres-184.ts`/`-200.ts` - with no scoring or
 * grading logic of its own. `HONEYRAIL_PG_180_TASK_ID` selects which of the
 * three frozen Corpus v0 tasks to run; that selection (and each task's own
 * mirror/reproducer/private-truth requirements) is the only place this
 * script varies per task - the pilot wrapper itself has no taskId branch.
 */

const corpusPath = resolve(String(process.env.HONEYRAIL_PG_180_CORPUS || "corpus/historical-postgres-corpus-v0.json").trim());
const corpusManifest = JSON.parse(await readFile(corpusPath, "utf8")) as HistoricalPostgresCorpusManifest;

const taskId = String(process.env.HONEYRAIL_PG_180_TASK_ID || "postgres-historical-001").trim();

async function resolveTaskSpec(): Promise<HistoricalPostgresTaskSpec> {
  if (taskId === "postgres-historical-001") {
    const mirror = String(process.env.HONEYRAIL_PG_184_MIRROR || "").trim();
    if (!mirror) throw new Error("Set HONEYRAIL_PG_184_MIRROR to the local PostgreSQL mirror for postgres-historical-001.");
    const knownReproducer = String(process.env.HONEYRAIL_PG_184_REPRODUCER || "").trim();
    return historicalPostgres001TaskSpec(resolve(mirror), knownReproducer ? resolve(knownReproducer) : undefined);
  }
  if (taskId === "postgres-historical-002") {
    const mirror = String(process.env.HONEYRAIL_PG_200_MIRROR || "").trim();
    const knownReproducer = String(process.env.HONEYRAIL_PG_200_REPRODUCER || "").trim();
    if (!mirror || !knownReproducer) {
      throw new Error("Set HONEYRAIL_PG_200_MIRROR and HONEYRAIL_PG_200_REPRODUCER for postgres-historical-002.");
    }
    return historicalPostgres002TaskSpec(resolve(mirror), resolve(knownReproducer));
  }
  if (taskId === "postgres-historical-003") {
    const mirror = String(process.env.HONEYRAIL_PG_199_MIRROR || "").trim();
    const knownReproducer = String(process.env.HONEYRAIL_PG_199_REPRODUCER || "").trim();
    const privateTruthPath = String(process.env.HONEYRAIL_PG_199_PRIVATE_TRUTH || "").trim();
    if (!mirror || !knownReproducer || !privateTruthPath) {
      throw new Error("Set HONEYRAIL_PG_199_MIRROR, HONEYRAIL_PG_199_REPRODUCER, and HONEYRAIL_PG_199_PRIVATE_TRUTH for postgres-historical-003.");
    }
    const privateTruth = await loadHistoricalPostgres003PrivateTruth(privateTruthPath);
    return historicalPostgres003TaskSpec(resolve(mirror), privateTruth, resolve(knownReproducer));
  }
  throw new Error(`HONEYRAIL_PG_180_TASK_ID must be one of postgres-historical-001|002|003, got "${taskId}"`);
}

const task = await resolveTaskSpec();

/**
 * `HONEYRAIL_PG_180_STUB_AGENT=1` selects a deterministic, scored
 * (`network: "none"`) shell command that writes a `not-reproduced` finding
 * instead of a real agent CLI - proves the real preflight -> build -> run ->
 * grade -> evidence lifecycle end-to-end without needing any LLM
 * credentials. It is a genuine scored trial (not a diagnostic-only smoke
 * run): it never claims agentic rediscovery capability, only pipeline
 * trustworthiness.
 */
const useStubAgent = String(process.env.HONEYRAIL_PG_180_STUB_AGENT || "").trim() === "1";
const command = useStubAgent
  ? "sh"
  : String(process.env.HONEYRAIL_PG_180_AGENT_COMMAND || "").trim();
const args = useStubAgent
  ? ["-c", 'printf \'{"status":"not-reproduced","summary":"deterministic #180 smoke-trial stub agent"}\' > finding.json']
  : process.env.HONEYRAIL_PG_180_AGENT_ARGS
    ? JSON.parse(process.env.HONEYRAIL_PG_180_AGENT_ARGS)
    : [];
if (!command) {
  throw new Error("Set HONEYRAIL_PG_180_AGENT_COMMAND (or HONEYRAIL_PG_180_STUB_AGENT=1 for the deterministic smoke-trial stub).");
}
if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
  throw new Error("HONEYRAIL_PG_180_AGENT_ARGS must be a JSON array of strings when set.");
}

const network = useStubAgent ? "none" : String(process.env.HONEYRAIL_PG_180_AGENT_NETWORK || "").trim();
const image = String(process.env.HONEYRAIL_PG_180_AGENT_IMAGE || "").trim();
const artifactDir = resolve(process.env.HONEYRAIL_PG_180_ARTIFACT_DIR || "output/historical-pg-180");
const timeoutMs = Number(process.env.HONEYRAIL_PG_180_AGENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HONEYRAIL_PG_180_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");
await mkdir(artifactDir, { recursive: true });

const result = await runHistoricalPostgresPilotTrial({
  corpusManifest,
  taskSpec: task,
  agent: {
    command,
    args,
    timeoutMs,
    env: process.env.HONEYRAIL_PG_180_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_PG_180_AGENT_ENV) : undefined
  },
  artifactDir,
  session: network || image ? { isolation: { ...(network ? { network: network as "none" | "bridge" } : {}), ...(image ? { image } : {}) } } : undefined
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// Three separate facts, printed together so a reader (or CI log) cannot
// mistake a preflight-failed run, an unscored run, or a diagnostic grade for
// an official score - see historical-postgres-184.ts's identical discipline.
const officialScoredResult =
  result.preflight.status === "passed" &&
  result.trial?.status === "completed" &&
  result.trial.scoredEligible &&
  result.trial.grade
    ? result.trial.grade.status
    : "N/A";
process.stdout.write(
  "\n#180 pilot trial summary:\n" +
    `  preflight status:         ${result.preflight.status}${result.preflight.status === "failed" ? ` (${result.preflight.failedDimension})` : ""}\n` +
    `  agentRunCount:            ${result.agentRunCount}\n` +
    `  trial status:             ${result.trial?.status ?? "N/A"}\n` +
    `  scoredEligible:           ${result.trial?.scoredEligible ?? "N/A"}\n` +
    `  diagnostic grader result: ${result.trial?.grade ? result.trial.grade.status : "N/A"}\n` +
    `  official scored result:   ${officialScoredResult}\n`
);

// A failed preflight is always a hard failure (integrity_error, agent never
// started). Once the agent did run, "unscored" is a legitimate, successful
// integration outcome and must not fail the CLI - only a genuine
// setup/agent/grader failure should.
const preflightFailed = result.preflight.status === "failed";
const trialFailed =
  result.trial?.status === "blocked" || result.trial?.status === "infrastructure_error" || result.trial?.status === "integrity_error";
if (preflightFailed || trialFailed) {
  process.exitCode = 1;
}
