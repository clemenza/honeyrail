import { resolve } from "node:path";
import {
  historicalPostgres001TaskSpec,
  historicalPostgres002TaskSpec,
  historicalPostgres003TaskSpec,
  historicalPostgresChange16867TaskSpec,
  historicalPostgresChange18574TaskSpec,
  loadHistoricalPostgres003PrivateTruth,
  loadHistoricalPostgresChange16867PrivateTruth,
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
  if (taskId === "postgres-change-001") {
    const mirror = String(env.HONEYRAIL_PG_212_MIRROR || "").trim();
    const knownReproducer = String(env.HONEYRAIL_PG_212_REPRODUCER || "").trim();
    const knownFixEvidence = String(env.HONEYRAIL_PG_212_FIX_EVIDENCE || "").trim();
    const privateTruthPath = String(env.HONEYRAIL_PG_212_PRIVATE_TRUTH || "").trim();
    const scaffoldingLevel = (String(env.HONEYRAIL_PG_212_SCAFFOLDING || "E0").trim()) as "E0" | "E1" | "E2" | "E3";
    if (!mirror || !privateTruthPath) {
      throw new Error("Set HONEYRAIL_PG_212_MIRROR and HONEYRAIL_PG_212_PRIVATE_TRUTH for postgres-change-001.");
    }
    if (!["E0", "E1", "E2", "E3"].includes(scaffoldingLevel)) {
      throw new Error(`HONEYRAIL_PG_212_SCAFFOLDING must be E0, E1, E2, or E3; got "${scaffoldingLevel}".`);
    }
    const privateTruth = await loadHistoricalPostgresChange16867PrivateTruth(privateTruthPath);
    return historicalPostgresChange16867TaskSpec(
      resolve(mirror),
      privateTruth,
      scaffoldingLevel,
      knownReproducer ? resolve(knownReproducer) : undefined,
      knownFixEvidence ? resolve(knownFixEvidence) : undefined
    );
  }
  if (taskId === "postgres-change-002") {
    const mirror = String(env.HONEYRAIL_PG_221_MIRROR || "").trim();
    const knownReproducer = String(env.HONEYRAIL_PG_221_REPRODUCER || "").trim();
    const knownFixEvidence = String(env.HONEYRAIL_PG_221_FIX_EVIDENCE || "").trim();
    const scaffoldingLevel = (String(env.HONEYRAIL_PG_221_SCAFFOLDING || "E0").trim()) as "E0" | "E1" | "E2" | "E3";
    // Unlike postgres-change-001 (where the reproducer is optional and fix
    // evidence can fall back to an auto-generated historical-vs-reference
    // diff), postgres-change-002's two revisions are ~3.5 years apart on
    // master - an auto-generated diff would be years of unrelated changes,
    // not focused fix evidence. scripts/historical-postgres-221.ts and
    // test/historical-postgres-221-integration.test.ts's FULLY_CONFIGURED
    // already require all three; this shared resolver must not be a looser
    // path to the same task (#223 review round 3, Blocking 1).
    if (!mirror || !knownReproducer || !knownFixEvidence) {
      throw new Error("Set HONEYRAIL_PG_221_MIRROR, HONEYRAIL_PG_221_REPRODUCER, and HONEYRAIL_PG_221_FIX_EVIDENCE for postgres-change-002.");
    }
    if (!["E0", "E1", "E2", "E3"].includes(scaffoldingLevel)) {
      throw new Error(`HONEYRAIL_PG_221_SCAFFOLDING must be E0, E1, E2, or E3; got "${scaffoldingLevel}".`);
    }
    return historicalPostgresChange18574TaskSpec(resolve(mirror), scaffoldingLevel, resolve(knownReproducer), resolve(knownFixEvidence));
  }
  throw new Error(`No task-spec resolver registered for taskId "${taskId}".`);
}
