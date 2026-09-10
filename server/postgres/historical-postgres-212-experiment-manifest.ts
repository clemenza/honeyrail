import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowIso } from "../utils.js";
import { stableJson } from "./historical-task.js";
import type { ResearchAgentImageIdentity } from "./agent-container.js";

/**
 * Issue #216: the E0-E3 change-task pilot (`postgres-change-001`, single task,
 * one trial per scaffolding level) has no corpus/profile/trials-per-cell shape,
 * so it cannot reuse `TrialSetExperimentManifest` (historical-pg-trialset.ts,
 * built for #198's multi-task/multi-profile TrialSet) directly. It does reuse
 * that module's identity-fingerprinting primitives - `resolveResearchAgentImageIdentity`,
 * `fingerprintDshVersion`, `deriveModelProviderFromUpstreamUrl` - rather than
 * reimplementing them, and mirrors its fail-closed "don't silently overwrite a
 * frozen manifest" pattern.
 */

export const HISTORICAL_POSTGRES_212_SCAFFOLDING_LEVELS = ["E0", "E1", "E2", "E3"] as const;
export type HistoricalPostgres212ScaffoldingLevel = (typeof HISTORICAL_POSTGRES_212_SCAFFOLDING_LEVELS)[number];

export type HistoricalPostgres212ExperimentIdentity = {
  experimentId: string;
  repositoryCommit: string;
  taskId: string;
  scaffoldingLevels: readonly HistoricalPostgres212ScaffoldingLevel[];
  executionOrder: readonly HistoricalPostgres212ScaffoldingLevel[];
  agentBackend: string;
  agentImage: ResearchAgentImageIdentity;
  postgresRevisions: { historical: string; reference: string };
  agentTimeoutMs: number;
  tokenToolBudgetPolicy: string;
  isolationPolicy: { restrictedEgress: boolean; upstreamUrl?: string; scoredEligibleExpected: boolean };
  trajectoryExpectation: string;
  retryPolicy: string;
  artifactRoot: string;
};

export type HistoricalPostgres212ExperimentManifest = HistoricalPostgres212ExperimentIdentity & {
  schemaVersion: 1;
  createdAt: string;
  /** Observable provenance only, never identity-relevant - see historical-pg-trialset.ts's TrialSetExperimentManifest.dshVersion docstring for the same reasoning. */
  dshVersion: string;
  modelProvider: string;
  modelVersion: string;
  engineeringDryRun: { path: string; excludedFromFormalLedger: true } | null;
  /** Per-condition task-manifest.json `hashes`, filled in as each attempt materializes. A level absent from this object has not materialized yet - never a placeholder that could be mistaken for a real hash. Refreshing this must never fail identity comparison. */
  perConditionMaterializationHashes: Partial<Record<HistoricalPostgres212ScaffoldingLevel, unknown>>;
};

function identityOnly(manifest: HistoricalPostgres212ExperimentIdentity): HistoricalPostgres212ExperimentIdentity {
  return {
    experimentId: manifest.experimentId,
    repositoryCommit: manifest.repositoryCommit,
    taskId: manifest.taskId,
    scaffoldingLevels: [...manifest.scaffoldingLevels],
    executionOrder: [...manifest.executionOrder],
    agentBackend: manifest.agentBackend,
    agentImage: manifest.agentImage,
    postgresRevisions: manifest.postgresRevisions,
    agentTimeoutMs: manifest.agentTimeoutMs,
    tokenToolBudgetPolicy: manifest.tokenToolBudgetPolicy,
    isolationPolicy: manifest.isolationPolicy,
    trajectoryExpectation: manifest.trajectoryExpectation,
    retryPolicy: manifest.retryPolicy,
    artifactRoot: manifest.artifactRoot
  };
}

export class HistoricalPostgres212ExperimentManifestIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalPostgres212ExperimentManifestIntegrityError";
  }
}

/**
 * Fails closed: an on-disk `experiment-manifest.json` whose identity-defining
 * fields differ from what this run would produce is refused, never silently
 * overwritten. #216's own protocol says amendments after this manifest is
 * first written are only allowed before attempt 1 starts, and must be a
 * deliberate, recorded change - this makes that a tool-enforced property
 * instead of relying on operator discipline alone.
 */
export function assertHistoricalPostgres212ManifestUnchanged(
  existing: HistoricalPostgres212ExperimentManifest,
  fresh: HistoricalPostgres212ExperimentIdentity
): void {
  const existingIdentity = stableJson(identityOnly(existing));
  const freshIdentity = stableJson(identityOnly(fresh));
  if (existingIdentity !== freshIdentity) {
    throw new HistoricalPostgres212ExperimentManifestIntegrityError(
      `experiment-manifest.json at this artifact root already exists with different identity-defining fields for experiment "${existing.experimentId}". ` +
        "Refusing to overwrite - amendments to frozen experiment constants after this manifest was first written are only allowed before attempt 1 " +
        "starts, and must be a deliberate, recorded change, not a silent rerun of this tool. Use a different artifact root, or delete the file only if " +
        "attempt 1 has not started."
    );
  }
}

export function buildHistoricalPostgres212ExperimentManifest(input: {
  identity: HistoricalPostgres212ExperimentIdentity;
  dshVersion: string;
  modelProvider: string;
  modelVersion: string;
  engineeringDryRun: { path: string } | null;
  perConditionMaterializationHashes?: Partial<Record<HistoricalPostgres212ScaffoldingLevel, unknown>>;
  createdAt?: string;
}): HistoricalPostgres212ExperimentManifest {
  return {
    ...input.identity,
    schemaVersion: 1,
    createdAt: input.createdAt ?? nowIso(),
    dshVersion: input.dshVersion,
    modelProvider: input.modelProvider,
    modelVersion: input.modelVersion,
    engineeringDryRun: input.engineeringDryRun ? { path: input.engineeringDryRun.path, excludedFromFormalLedger: true } : null,
    perConditionMaterializationHashes: input.perConditionMaterializationHashes ?? {}
  };
}

/** Scans `<artifactRoot>/<level>/task-manifest.json` for each declared scaffolding level and returns whatever has materialized so far. A level with no materialized task-manifest.json yet is simply omitted from the result. */
export async function collectHistoricalPostgres212ConditionHashes(
  artifactRoot: string,
  scaffoldingLevels: readonly HistoricalPostgres212ScaffoldingLevel[]
): Promise<Partial<Record<HistoricalPostgres212ScaffoldingLevel, unknown>>> {
  const out: Partial<Record<HistoricalPostgres212ScaffoldingLevel, unknown>> = {};
  for (const level of scaffoldingLevels) {
    try {
      const raw = await readFile(join(artifactRoot, level, "task-manifest.json"), "utf8");
      out[level] = JSON.parse(raw).hashes;
    } catch {
      // Not materialized yet - omit rather than guess.
    }
  }
  return out;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadHistoricalPostgres212ExperimentManifest(artifactRoot: string): Promise<HistoricalPostgres212ExperimentManifest | null> {
  try {
    const raw = await readFile(join(artifactRoot, "experiment-manifest.json"), "utf8");
    return JSON.parse(raw) as HistoricalPostgres212ExperimentManifest;
  } catch {
    return null;
  }
}

/**
 * Idempotent: safe to call again after each E0/E1/E2/E3 attempt completes to
 * pick up newly materialized per-condition hashes. Refuses (fail-closed) if
 * an existing manifest's identity-defining fields would change.
 */
export async function writeHistoricalPostgres212ExperimentManifest(
  artifactRoot: string,
  input: {
    identity: HistoricalPostgres212ExperimentIdentity;
    dshVersion: string;
    modelProvider: string;
    modelVersion: string;
    engineeringDryRun: { path: string } | null;
  }
): Promise<HistoricalPostgres212ExperimentManifest> {
  const existing = await loadHistoricalPostgres212ExperimentManifest(artifactRoot);
  const perConditionMaterializationHashes = await collectHistoricalPostgres212ConditionHashes(artifactRoot, input.identity.scaffoldingLevels);
  const manifest = buildHistoricalPostgres212ExperimentManifest({
    ...input,
    createdAt: existing?.createdAt,
    perConditionMaterializationHashes
  });
  if (existing) {
    assertHistoricalPostgres212ManifestUnchanged(existing, manifest);
  }
  await mkdir(artifactRoot, { recursive: true });
  await writeJson(join(artifactRoot, "experiment-manifest.json"), manifest);
  return manifest;
}
