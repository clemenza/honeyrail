import { resolve } from "node:path";
import { resolveResearchAgentImageIdentity } from "../server/postgres/agent-container.js";
import { deriveModelProviderFromUpstreamUrl, fingerprintDshVersion } from "../server/postgres/historical-pg-trialset.js";
import {
  HISTORICAL_POSTGRES_212_SCAFFOLDING_LEVELS,
  writeHistoricalPostgres212ExperimentManifest,
  type HistoricalPostgres212ScaffoldingLevel
} from "../server/postgres/historical-postgres-212-experiment-manifest.js";

/**
 * Issue #216: writes/refreshes `<artifactRoot>/experiment-manifest.json` for the
 * preregistered E0-E3 `postgres-change-001` pilot. Run once to freeze the
 * experiment before attempt 1, and again after each attempt to pick up that
 * attempt's `task-manifest.json` hashes - idempotent, and fails closed if any
 * identity-defining field would change from a prior run at the same artifact root.
 */

function required(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

function parseLevels(raw: string, envName: string): HistoricalPostgres212ScaffoldingLevel[] {
  const levels = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const level of levels) {
    if (!(HISTORICAL_POSTGRES_212_SCAFFOLDING_LEVELS as readonly string[]).includes(level)) {
      throw new Error(`${envName} contains invalid scaffolding level "${level}" - must be one of ${HISTORICAL_POSTGRES_212_SCAFFOLDING_LEVELS.join(", ")}.`);
    }
  }
  return levels as HistoricalPostgres212ScaffoldingLevel[];
}

const experimentId = required("HONEYRAIL_PG_212_EXPERIMENT_ID");
const artifactRoot = resolve(required("HONEYRAIL_PG_212_EXPERIMENT_ARTIFACT_ROOT"));
const repositoryCommit = required("HONEYRAIL_PG_212_EXPERIMENT_REPOSITORY_COMMIT");
const taskId = String(process.env.HONEYRAIL_PG_212_EXPERIMENT_TASK_ID || "postgres-change-001").trim();
const agentBackend = required("HONEYRAIL_PG_212_EXPERIMENT_AGENT_BACKEND");
const agentImageReference = required("HONEYRAIL_PG_212_EXPERIMENT_AGENT_IMAGE");
const historicalRevision = required("HONEYRAIL_PG_212_EXPERIMENT_HISTORICAL_REVISION");
const referenceRevision = required("HONEYRAIL_PG_212_EXPERIMENT_REFERENCE_REVISION");
const agentTimeoutMs = Number(process.env.HONEYRAIL_PG_212_EXPERIMENT_TIMEOUT_MS || 30 * 60_000);
if (!Number.isFinite(agentTimeoutMs) || agentTimeoutMs <= 0) {
  throw new Error("HONEYRAIL_PG_212_EXPERIMENT_TIMEOUT_MS must be a positive number of milliseconds.");
}
const tokenToolBudgetPolicy = String(process.env.HONEYRAIL_PG_212_EXPERIMENT_TOKEN_BUDGET_POLICY || "not enforced by this path").trim();
const upstreamUrl = String(process.env.HONEYRAIL_PG_212_EXPERIMENT_EGRESS_UPSTREAM_URL || "").trim() || undefined;
const scoredEligibleExpected = String(process.env.HONEYRAIL_PG_212_EXPERIMENT_SCORED_ELIGIBLE_EXPECTED ?? "true").trim() !== "false";
const trajectoryExpectation = String(process.env.HONEYRAIL_PG_212_EXPERIMENT_TRAJECTORY_EXPECTATION || "dsh").trim();
const retryPolicy = String(
  process.env.HONEYRAIL_PG_212_EXPERIMENT_RETRY_POLICY ||
    "A retry gets a new attempt ID linked to its predecessor; it never replaces or removes a failed attempt; a valid miss is never rerun merely to obtain a rediscovered result."
).trim();
const scaffoldingLevels = parseLevels(
  String(process.env.HONEYRAIL_PG_212_EXPERIMENT_SCAFFOLDING_LEVELS || HISTORICAL_POSTGRES_212_SCAFFOLDING_LEVELS.join(",")),
  "HONEYRAIL_PG_212_EXPERIMENT_SCAFFOLDING_LEVELS"
);
const executionOrder = parseLevels(
  String(process.env.HONEYRAIL_PG_212_EXPERIMENT_EXECUTION_ORDER || scaffoldingLevels.join(",")),
  "HONEYRAIL_PG_212_EXPERIMENT_EXECUTION_ORDER"
);
const dryRunPath = String(process.env.HONEYRAIL_PG_212_EXPERIMENT_DRY_RUN_PATH || "").trim() || undefined;
const modelVersion = String(process.env.HONEYRAIL_PG_212_EXPERIMENT_MODEL_VERSION || "unknown").trim();

const agentImage = await resolveResearchAgentImageIdentity(agentImageReference);
const dshVersion = await fingerprintDshVersion(agentImageReference);
const modelProvider = deriveModelProviderFromUpstreamUrl(upstreamUrl);

const manifest = await writeHistoricalPostgres212ExperimentManifest(artifactRoot, {
  identity: {
    experimentId,
    repositoryCommit,
    taskId,
    scaffoldingLevels,
    executionOrder,
    agentBackend,
    agentImage,
    postgresRevisions: { historical: historicalRevision, reference: referenceRevision },
    agentTimeoutMs,
    tokenToolBudgetPolicy,
    isolationPolicy: { restrictedEgress: Boolean(upstreamUrl), upstreamUrl, scoredEligibleExpected },
    trajectoryExpectation,
    retryPolicy,
    artifactRoot
  },
  dshVersion,
  modelProvider,
  modelVersion,
  engineeringDryRun: dryRunPath ? { path: dryRunPath } : null
});

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
