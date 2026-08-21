import { Router } from "express";
import { asyncRoute, httpError } from "../route-context.js";
import type { Store } from "../types.js";
import { normalizeDshOutDir, readDshTrialArtifacts, summarizeDshEvalsState } from "./dsh-run-browser.js";
import { computeEvalMetrics, type EvalMetricsFilter } from "./metrics.js";

const CONTRACT_LEVELS = new Set(["L0", "L1", "L2", "L3"]);

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function evalRoutes(store: Store) {
  const router = Router();

  router.get("/api/evals/metrics", asyncRoute(async (req, res) => {
    const contractLevel = stringParam(req.query.contractLevel);
    if (contractLevel && !CONTRACT_LEVELS.has(contractLevel)) {
      return res.status(400).json({ error: `Invalid contractLevel: ${contractLevel}` });
    }
    const filter: EvalMetricsFilter = {
      projectId: stringParam(req.query.projectId),
      recipeId: stringParam(req.query.recipeId),
      promptVersion: stringParam(req.query.promptVersion),
      instructionLabel: stringParam(req.query.instructionLabel),
      contractLevel: contractLevel as EvalMetricsFilter["contractLevel"]
    };
    res.json(await computeEvalMetrics(store, filter));
  }));

  // #118: read-only view onto a scripts/dsh-evals-demo.ts (#93) --out
  // directory. Deliberately independent of Store/OrchestrationService - a
  // scored dsh-testengineer-trial never becomes a HoneyRail Run (#103/#109),
  // so there is nothing here to look up by run id, only local files an
  // operator points the console at (same trust level as a project's
  // repoPath - see GET /api/filesystem/browse).
  router.get("/api/evals/dsh-runs", asyncRoute(async (req, res) => {
    if (!req.query.outDir) throw httpError(400, "outDir query parameter is required");
    const outDir = normalizeDshOutDir(req.query.outDir);
    res.json(await summarizeDshEvalsState(outDir));
  }));

  router.get("/api/evals/dsh-runs/trial", asyncRoute(async (req, res) => {
    if (!req.query.outDir) throw httpError(400, "outDir query parameter is required");
    if (!req.query.trialId) throw httpError(400, "trialId query parameter is required");
    const outDir = normalizeDshOutDir(req.query.outDir);
    res.json(await readDshTrialArtifacts(outDir, String(req.query.trialId)));
  }));

  return router;
}
