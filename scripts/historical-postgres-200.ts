import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { historicalPostgres002TaskSpec, runHistoricalPostgresTrial } from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_200_MIRROR || "").trim();
const command = String(process.env.HONEYRAIL_PG_200_AGENT_COMMAND || "").trim();
if (!mirror || !command) {
  throw new Error(
    "Set HONEYRAIL_PG_200_MIRROR to the local PostgreSQL mirror and HONEYRAIL_PG_200_AGENT_COMMAND to the agent command available in the research image."
  );
}
const args = process.env.HONEYRAIL_PG_200_AGENT_ARGS ? JSON.parse(process.env.HONEYRAIL_PG_200_AGENT_ARGS) : [];
if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
  throw new Error("HONEYRAIL_PG_200_AGENT_ARGS must be a JSON array of strings when set.");
}
const knownReproducer = String(process.env.HONEYRAIL_PG_200_REPRODUCER || "").trim();
const network = String(process.env.HONEYRAIL_PG_200_AGENT_NETWORK || "").trim();
const image = String(process.env.HONEYRAIL_PG_200_AGENT_IMAGE || "").trim();
const artifactDir = resolve(process.env.HONEYRAIL_PG_200_ARTIFACT_DIR || "output/historical-pg-200");
const timeoutMs = Number(process.env.HONEYRAIL_PG_200_AGENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HONEYRAIL_PG_200_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");
await mkdir(artifactDir, { recursive: true });
const result = await runHistoricalPostgresTrial({
  task: historicalPostgres002TaskSpec(resolve(mirror), knownReproducer ? resolve(knownReproducer) : undefined),
  agent: { command, args, timeoutMs, env: process.env.HONEYRAIL_PG_200_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_PG_200_AGENT_ENV) : undefined },
  artifactDir,
  session: network || image ? { isolation: { ...(network ? { network: network as "none" | "bridge" } : {}), ...(image ? { image } : {}) } } : undefined
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

// Deliberately three separate facts, printed together so a reader (or a CI
// log) cannot mistake an unscored integration smoke run for an official
// scored result: "completed" alone does not mean scored, and a diagnostic
// grade computed on an unscored run is never the same thing as a score.
const officialScoredResult =
  result.status === "completed" && result.scoredEligible && result.grade ? result.grade.status : "N/A";
process.stdout.write(
  "\nReal-agent trial summary:\n" +
    `  integration status:      ${result.status}\n` +
    `  scoredEligible:           ${result.scoredEligible}\n` +
    `  diagnostic grader result: ${result.grade ? result.grade.status : "N/A"}\n` +
    `  official scored result:   ${officialScoredResult}\n`
);

// "unscored" is a legitimate, successful integration run (real agent, real
// environment, isolation just wasn't the scored configuration) - it must not
// fail the CLI. Only a genuine setup/agent/grader failure should.
const integrationFailed = result.status === "blocked" || result.status === "infrastructure_error" || result.status === "integrity_error";
if (integrationFailed) {
  process.exitCode = 1;
}
