import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  historicalPostgres003ChangeContext,
  historicalPostgres003TaskSpec,
  loadHistoricalPostgres003PrivateTruth,
  runHistoricalPostgresTrial
} from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_199_MIRROR || "").trim();
const command = String(process.env.HONEYRAIL_PG_199_AGENT_COMMAND || "").trim();
if (!mirror || !command) {
  throw new Error(
    "Set HONEYRAIL_PG_199_MIRROR to the local PostgreSQL mirror and HONEYRAIL_PG_199_AGENT_COMMAND to the agent command available in the research image."
  );
}
const args = process.env.HONEYRAIL_PG_199_AGENT_ARGS ? JSON.parse(process.env.HONEYRAIL_PG_199_AGENT_ARGS) : [];
if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
  throw new Error("HONEYRAIL_PG_199_AGENT_ARGS must be a JSON array of strings when set.");
}
const knownReproducer = String(process.env.HONEYRAIL_PG_199_REPRODUCER || "").trim();
if (!knownReproducer) {
  throw new Error(
    "HONEYRAIL_PG_199_REPRODUCER is required to run this task's real trial with canonical truth provenance; unlike case 001, case 003 must not run without it."
  );
}
const privateTruthPath = String(process.env.HONEYRAIL_PG_199_PRIVATE_TRUTH || "").trim();
if (!privateTruthPath) {
  throw new Error(
    "HONEYRAIL_PG_199_PRIVATE_TRUTH is required: set it to the path of the operator-supplied private-truth JSON file for case 003."
  );
}
const privateTruth = await loadHistoricalPostgres003PrivateTruth(privateTruthPath);
// #233's within-family sibling-replication E0-E3 ladder, run on this same
// frozen #199/#201 source/oracle. Unset (default "minimal") preserves the
// original Corpus v0 scoring behavior byte-for-byte — same discipline as
// scripts/historical-postgres-212.ts's/-221.ts's HONEYRAIL_PG_{212,221}_SCAFFOLDING.
const scaffoldingLevelRaw = String(process.env.HONEYRAIL_PG_199_SCAFFOLDING || "").trim();
if (scaffoldingLevelRaw && !["E0", "E1", "E2", "E3"].includes(scaffoldingLevelRaw)) {
  throw new Error(`HONEYRAIL_PG_199_SCAFFOLDING must be E0, E1, E2, or E3 when set; got "${scaffoldingLevelRaw}".`);
}
const scaffoldingLevel = (scaffoldingLevelRaw || "minimal") as "minimal" | "E0" | "E1" | "E2" | "E3";
const network = String(process.env.HONEYRAIL_PG_199_AGENT_NETWORK || "").trim();
const image = String(process.env.HONEYRAIL_PG_199_AGENT_IMAGE || "").trim();
const egressUpstreamUrl = String(process.env.HONEYRAIL_PG_199_EGRESS_UPSTREAM_URL || "").trim();
if (network && egressUpstreamUrl) {
  throw new Error(
    "HONEYRAIL_PG_199_AGENT_NETWORK and HONEYRAIL_PG_199_EGRESS_UPSTREAM_URL are mutually exclusive: a restricted-egress session derives its own internal network."
  );
}
const trajectoryExpectation = String(process.env.HONEYRAIL_PG_199_AGENT_TRAJECTORY || "").trim();
if (trajectoryExpectation && trajectoryExpectation !== "dsh") {
  throw new Error('HONEYRAIL_PG_199_AGENT_TRAJECTORY must be "dsh" when set.');
}
const artifactDir = resolve(process.env.HONEYRAIL_PG_199_ARTIFACT_DIR || "output/historical-pg-199");
const timeoutMs = Number(process.env.HONEYRAIL_PG_199_AGENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HONEYRAIL_PG_199_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");
await mkdir(artifactDir, { recursive: true });
const result = await runHistoricalPostgresTrial({
  task: historicalPostgres003TaskSpec(
    resolve(mirror),
    privateTruth,
    knownReproducer ? resolve(knownReproducer) : undefined,
    scaffoldingLevel,
    scaffoldingLevel === "minimal" ? undefined : historicalPostgres003ChangeContext()
  ),
  agent: { command, args, timeoutMs, env: process.env.HONEYRAIL_PG_199_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_PG_199_AGENT_ENV) : undefined },
  artifactDir,
  session:
    network || image || egressUpstreamUrl
      ? {
          isolation: {
            ...(egressUpstreamUrl ? { restrictedEgress: { upstreamUrl: egressUpstreamUrl } } : {}),
            ...(network ? { network: network as "none" | "bridge" } : {}),
            ...(image ? { image } : {})
          }
        }
      : undefined,
  ...(trajectoryExpectation === "dsh" ? { trajectoryExpectation: "dsh" as const } : {})
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
