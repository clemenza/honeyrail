import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { historicalPostgres001TaskSpec, runHistoricalPostgresTrial } from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_184_MIRROR || "").trim();
const command = String(process.env.HONEYRAIL_PG_184_AGENT_COMMAND || "").trim();
if (!mirror || !command) {
  throw new Error(
    "Set HONEYRAIL_PG_184_MIRROR to the local PostgreSQL mirror and HONEYRAIL_PG_184_AGENT_COMMAND to the agent command available in the research image."
  );
}
const args = process.env.HONEYRAIL_PG_184_AGENT_ARGS ? JSON.parse(process.env.HONEYRAIL_PG_184_AGENT_ARGS) : [];
if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
  throw new Error("HONEYRAIL_PG_184_AGENT_ARGS must be a JSON array of strings when set.");
}
const knownReproducer = String(process.env.HONEYRAIL_PG_184_REPRODUCER || "").trim();
const network = String(process.env.HONEYRAIL_PG_184_AGENT_NETWORK || "").trim();
const image = String(process.env.HONEYRAIL_PG_184_AGENT_IMAGE || "").trim();
const artifactDir = resolve(process.env.HONEYRAIL_PG_184_ARTIFACT_DIR || "output/historical-pg-184");
const timeoutMs = Number(process.env.HONEYRAIL_PG_184_AGENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HONEYRAIL_PG_184_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");
await mkdir(artifactDir, { recursive: true });
const result = await runHistoricalPostgresTrial({
  task: historicalPostgres001TaskSpec(resolve(mirror), knownReproducer ? resolve(knownReproducer) : undefined),
  agent: { command, args, timeoutMs, env: process.env.HONEYRAIL_PG_184_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_PG_184_AGENT_ENV) : undefined },
  artifactDir,
  session: network || image ? { isolation: { ...(network ? { network: network as "none" | "bridge" } : {}), ...(image ? { image } : {}) } } : undefined
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (
  result.status !== "completed" ||
  !result.grade ||
  (result.grade.status !== "rediscovered" && result.grade.status !== "miss")
) {
  process.exitCode = 1;
}
