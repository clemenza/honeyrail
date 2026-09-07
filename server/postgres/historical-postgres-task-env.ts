import { resolve } from "node:path";
import {
  historicalPostgres001TaskSpec,
  historicalPostgres002TaskSpec,
  historicalPostgres003TaskSpec,
  loadHistoricalPostgres003PrivateTruth,
  type HistoricalPostgresTaskSpec
} from "./historical-task.js";

/**
 * The one place that knows which environment variables each frozen Corpus v0
 * task needs to materialize (a local PostgreSQL mirror, and per-task
 * reproducer/private-truth paths). Both `scripts/historical-postgres-180-pilot.ts`
 * (the single-cell #180 pilot) and `scripts/historical-pg-evals.ts` (the #198
 * TrialSet runner) call this rather than each keeping their own copy of this
 * per-taskId branching (PR #208 review, Blocking 3).
 *
 * Deliberately still one function with a branch per known taskId - not a
 * generic provider/registry abstraction. Corpus v0 has exactly three tasks,
 * each requiring genuinely different inputs (001 needs only a mirror; 002
 * additionally needs a known reproducer; 003 additionally needs private
 * truth) - that variation is inherent to the tasks, not something a runner
 * should paper over.
 */
export async function resolveHistoricalPostgresTaskSpecFromEnv(taskId: string, env: NodeJS.ProcessEnv = process.env): Promise<HistoricalPostgresTaskSpec> {
  if (taskId === "postgres-historical-001") {
    const mirror = String(env.HONEYRAIL_PG_184_MIRROR || "").trim();
    if (!mirror) throw new Error("Set HONEYRAIL_PG_184_MIRROR to the local PostgreSQL mirror for postgres-historical-001.");
    const knownReproducer = String(env.HONEYRAIL_PG_184_REPRODUCER || "").trim();
    return historicalPostgres001TaskSpec(resolve(mirror), knownReproducer ? resolve(knownReproducer) : undefined);
  }
  if (taskId === "postgres-historical-002") {
    const mirror = String(env.HONEYRAIL_PG_200_MIRROR || "").trim();
    const knownReproducer = String(env.HONEYRAIL_PG_200_REPRODUCER || "").trim();
    if (!mirror || !knownReproducer) throw new Error("Set HONEYRAIL_PG_200_MIRROR and HONEYRAIL_PG_200_REPRODUCER for postgres-historical-002.");
    return historicalPostgres002TaskSpec(resolve(mirror), resolve(knownReproducer));
  }
  if (taskId === "postgres-historical-003") {
    const mirror = String(env.HONEYRAIL_PG_199_MIRROR || "").trim();
    const knownReproducer = String(env.HONEYRAIL_PG_199_REPRODUCER || "").trim();
    const privateTruthPath = String(env.HONEYRAIL_PG_199_PRIVATE_TRUTH || "").trim();
    if (!mirror || !knownReproducer || !privateTruthPath) {
      throw new Error("Set HONEYRAIL_PG_199_MIRROR, HONEYRAIL_PG_199_REPRODUCER, and HONEYRAIL_PG_199_PRIVATE_TRUTH for postgres-historical-003.");
    }
    const privateTruth = await loadHistoricalPostgres003PrivateTruth(privateTruthPath);
    return historicalPostgres003TaskSpec(resolve(mirror), privateTruth, resolve(knownReproducer));
  }
  throw new Error(`No task-spec resolver registered for taskId "${taskId}".`);
}
