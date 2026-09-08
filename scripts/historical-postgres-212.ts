import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  historicalPostgresChange16867TaskSpec,
  loadHistoricalPostgresChange16867PrivateTruth,
  runHistoricalPostgresTrial
} from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_212_MIRROR || "").trim();
const command = String(process.env.HONEYRAIL_PG_212_AGENT_COMMAND || "").trim();
const privateTruthPath = String(process.env.HONEYRAIL_PG_212_PRIVATE_TRUTH || "").trim();
if (!mirror || !command || !privateTruthPath) {
  throw new Error(
    "Set HONEYRAIL_PG_212_MIRROR to the local PostgreSQL mirror, HONEYRAIL_PG_212_AGENT_COMMAND to the agent command, and HONEYRAIL_PG_212_PRIVATE_TRUTH to the private truth JSON file."
  );
}
const args = process.env.HONEYRAIL_PG_212_AGENT_ARGS ? JSON.parse(process.env.HONEYRAIL_PG_212_AGENT_ARGS) : [];
if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
  throw new Error("HONEYRAIL_PG_212_AGENT_ARGS must be a JSON array of strings when set.");
}
const knownReproducer = String(process.env.HONEYRAIL_PG_212_REPRODUCER || "").trim();
const scaffoldingLevel = (String(process.env.HONEYRAIL_PG_212_SCAFFOLDING || "E0").trim()) as "E0" | "E1" | "E2" | "E3";
if (!["E0", "E1", "E2", "E3"].includes(scaffoldingLevel)) {
  throw new Error(`HONEYRAIL_PG_212_SCAFFOLDING must be E0, E1, E2, or E3; got "${scaffoldingLevel}".`);
}
const network = String(process.env.HONEYRAIL_PG_212_AGENT_NETWORK || "").trim();
const image = String(process.env.HONEYRAIL_PG_212_AGENT_IMAGE || "").trim();
const artifactDir = resolve(process.env.HONEYRAIL_PG_212_ARTIFACT_DIR || "output/historical-pg-212");
const timeoutMs = Number(process.env.HONEYRAIL_PG_212_AGENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HONEYRAIL_PG_212_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");

const privateTruth = await loadHistoricalPostgresChange16867PrivateTruth(privateTruthPath);

await mkdir(artifactDir, { recursive: true });
const result = await runHistoricalPostgresTrial({
  task: historicalPostgresChange16867TaskSpec(resolve(mirror), privateTruth, scaffoldingLevel, knownReproducer ? resolve(knownReproducer) : undefined),
  agent: { command, args, timeoutMs, env: process.env.HONEYRAIL_PG_212_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_PG_212_AGENT_ENV) : undefined },
  artifactDir,
  session: network || image ? { isolation: { ...(network ? { network: network as "none" | "bridge" } : {}), ...(image ? { image } : {}) } } : undefined
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

const officialScoredResult =
  result.status === "completed" && result.scoredEligible && result.grade ? result.grade.status : "N/A";
process.stdout.write(
  "\nReal-agent trial summary:\n" +
    `  integration status:      ${result.status}\n` +
    `  scoredEligible:           ${result.scoredEligible}\n` +
    `  diagnostic grader result: ${result.grade ? result.grade.status : "N/A"}\n` +
    `  official scored result:   ${officialScoredResult}\n` +
    `  scaffoldingLevel:         ${scaffoldingLevel}\n`
);

const integrationFailed = result.status === "blocked" || result.status === "infrastructure_error" || result.status === "integrity_error";
if (integrationFailed) {
  process.exitCode = 1;
}
