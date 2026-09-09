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
const knownFixEvidence = String(process.env.HONEYRAIL_PG_212_FIX_EVIDENCE || "").trim();
const scaffoldingLevel = (String(process.env.HONEYRAIL_PG_212_SCAFFOLDING || "E0").trim()) as "E0" | "E1" | "E2" | "E3";
if (!["E0", "E1", "E2", "E3"].includes(scaffoldingLevel)) {
  throw new Error(`HONEYRAIL_PG_212_SCAFFOLDING must be E0, E1, E2, or E3; got "${scaffoldingLevel}".`);
}
const network = String(process.env.HONEYRAIL_PG_212_AGENT_NETWORK || "").trim();
const image = String(process.env.HONEYRAIL_PG_212_AGENT_IMAGE || "").trim();
// Scored real-model egress (#216 execution gap): restricted egress routes the
// agent at a per-trial relay sidecar that can reach exactly one upstream (its
// model API) - see server/postgres/research-session.ts isolation.restrictedEgress.
// Mutually exclusive with HONEYRAIL_PG_212_AGENT_NETWORK, which research-session
// already rejects when combined, but this script validates it up front with a
// clearer operator-facing message.
const egressUpstreamUrl = String(process.env.HONEYRAIL_PG_212_EGRESS_UPSTREAM_URL || "").trim();
if (network && egressUpstreamUrl) {
  throw new Error(
    "HONEYRAIL_PG_212_AGENT_NETWORK and HONEYRAIL_PG_212_EGRESS_UPSTREAM_URL are mutually exclusive: a restricted-egress session derives its own internal network."
  );
}
// Explicit DSH trajectory expectation ("dsh" or unset) - the caller that chose
// the agent says whether DSH-shaped telemetry is owed, never inferred from the
// command (#210 review round 5, Blocking 1). "dsh" requires the agent to
// persist a usable session transcript for a scored-eligible trial.
const trajectoryExpectation = String(process.env.HONEYRAIL_PG_212_AGENT_TRAJECTORY || "").trim();
if (trajectoryExpectation && trajectoryExpectation !== "dsh") {
  throw new Error('HONEYRAIL_PG_212_AGENT_TRAJECTORY must be "dsh" when set.');
}
const artifactDir = resolve(process.env.HONEYRAIL_PG_212_ARTIFACT_DIR || "output/historical-pg-212");
const timeoutMs = Number(process.env.HONEYRAIL_PG_212_AGENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HONEYRAIL_PG_212_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");

const privateTruth = await loadHistoricalPostgresChange16867PrivateTruth(privateTruthPath);

await mkdir(artifactDir, { recursive: true });
const result = await runHistoricalPostgresTrial({
  task: historicalPostgresChange16867TaskSpec(resolve(mirror), privateTruth, scaffoldingLevel, knownReproducer ? resolve(knownReproducer) : undefined, knownFixEvidence ? resolve(knownFixEvidence) : undefined),
  agent: { command, args, timeoutMs, env: process.env.HONEYRAIL_PG_212_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_PG_212_AGENT_ENV) : undefined },
  artifactDir,
  session: network || image || egressUpstreamUrl ? { isolation: { ...(egressUpstreamUrl ? { restrictedEgress: { upstreamUrl: egressUpstreamUrl } } : {}), ...(network ? { network: network as "none" | "bridge" } : {}), ...(image ? { image } : {}) } } : undefined,
  ...(trajectoryExpectation === "dsh" ? { trajectoryExpectation: "dsh" as const } : {})
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
    `  scaffoldingLevel:         ${scaffoldingLevel}\n` +
    `  trajectoryExpectation:    ${trajectoryExpectation || "none"}\n`
);

const integrationFailed = result.status === "blocked" || result.status === "infrastructure_error" || result.status === "integrity_error";
if (integrationFailed) {
  process.exitCode = 1;
}
