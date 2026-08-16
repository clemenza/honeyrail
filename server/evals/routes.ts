import { Router } from "express";
import { asyncRoute } from "../route-context.js";
import type { Store } from "../types.js";
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
      contractLevel: contractLevel as EvalMetricsFilter["contractLevel"]
    };
    res.json(await computeEvalMetrics(store, filter));
  }));

  return router;
}
