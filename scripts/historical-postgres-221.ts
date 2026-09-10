import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { historicalPostgresChange18574TaskSpec, runHistoricalPostgresTrial } from "../server/postgres/historical-task.js";

const mirror = String(process.env.HONEYRAIL_PG_221_MIRROR || "").trim();
const command = String(process.env.HONEYRAIL_PG_221_AGENT_COMMAND || "").trim();
if (!mirror || !command) {
  throw new Error(
    "Set HONEYRAIL_PG_221_MIRROR to the local PostgreSQL mirror and HONEYRAIL_PG_221_AGENT_COMMAND to the agent command."
  );
}
const args = process.env.HONEYRAIL_PG_221_AGENT_ARGS ? JSON.parse(process.env.HONEYRAIL_PG_221_AGENT_ARGS) : [];
if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
  throw new Error("HONEYRAIL_PG_221_AGENT_ARGS must be a JSON array of strings when set.");
}
const knownReproducer = String(process.env.HONEYRAIL_PG_221_REPRODUCER || "").trim();
if (!knownReproducer) {
  throw new Error(
    "HONEYRAIL_PG_221_REPRODUCER is required to run this task's real trial with canonical truth provenance - same discipline as scripts/historical-postgres-200.ts."
  );
}
const knownFixEvidence = String(process.env.HONEYRAIL_PG_221_FIX_EVIDENCE || "").trim();
if (!knownFixEvidence) {
  throw new Error(
    "HONEYRAIL_PG_221_FIX_EVIDENCE is required: the introducing and fix commits are ~3.5 years apart on master, so " +
      "auto-generating fix evidence from a historical-vs-reference diff would produce years of unrelated changes, not " +
      "focused fix evidence. Supply the fix commit's own diff instead (e.g. `git show <fix-commit> > fix-evidence.diff`)."
  );
}
const scaffoldingLevel = (String(process.env.HONEYRAIL_PG_221_SCAFFOLDING || "E0").trim()) as "E0" | "E1" | "E2" | "E3";
if (!["E0", "E1", "E2", "E3"].includes(scaffoldingLevel)) {
  throw new Error(`HONEYRAIL_PG_221_SCAFFOLDING must be E0, E1, E2, or E3; got "${scaffoldingLevel}".`);
}
const network = String(process.env.HONEYRAIL_PG_221_AGENT_NETWORK || "").trim();
const image = String(process.env.HONEYRAIL_PG_221_AGENT_IMAGE || "").trim();
// Scored real-model egress (same #216/#217 mechanism, reused unchanged - see
// scripts/historical-postgres-212.ts's identical comment).
const egressUpstreamUrl = String(process.env.HONEYRAIL_PG_221_EGRESS_UPSTREAM_URL || "").trim();
if (network && egressUpstreamUrl) {
  throw new Error(
    "HONEYRAIL_PG_221_AGENT_NETWORK and HONEYRAIL_PG_221_EGRESS_UPSTREAM_URL are mutually exclusive: a restricted-egress session derives its own internal network."
  );
}
// Explicit DSH trajectory expectation ("dsh" or unset) - see
// scripts/historical-postgres-212.ts's identical comment (#210 review round 5, Blocking 1).
const trajectoryExpectation = String(process.env.HONEYRAIL_PG_221_AGENT_TRAJECTORY || "").trim();
if (trajectoryExpectation && trajectoryExpectation !== "dsh") {
  throw new Error('HONEYRAIL_PG_221_AGENT_TRAJECTORY must be "dsh" when set.');
}
const artifactDir = resolve(process.env.HONEYRAIL_PG_221_ARTIFACT_DIR || "output/historical-pg-221");
const timeoutMs = Number(process.env.HONEYRAIL_PG_221_AGENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("HONEYRAIL_PG_221_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");

await mkdir(artifactDir, { recursive: true });
const result = await runHistoricalPostgresTrial({
  task: historicalPostgresChange18574TaskSpec(resolve(mirror), scaffoldingLevel, resolve(knownReproducer), resolve(knownFixEvidence)),
  agent: { command, args, timeoutMs, env: process.env.HONEYRAIL_PG_221_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_PG_221_AGENT_ENV) : undefined },
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
