import { Router } from "express";
import { validate, createRunBody, rejectStepBody } from "../validation.js";
import { asyncRoute, httpError } from "../route-context.js";
import type { OrchestrationService } from "./service.js";

export function runRoutes(orchestration: OrchestrationService) {
  const router = Router();

  router.post("/api/runs", validate(createRunBody), asyncRoute(async (req, res) => {
    let result;
    try {
      result = await orchestration.createRun(req.body);
    } catch (error) {
      throw httpError((error as Error).message === "Project not found" ? 404 : 400, (error as Error).message);
    }
    res.status(201).json(result);
  }));

  router.get("/api/runs", asyncRoute(async (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json({ runs: await orchestration.listRuns(projectId) });
  }));

  router.get("/api/runs/:runId", asyncRoute(async (req, res) => {
    const detail = await orchestration.getRunDetail(String(req.params.runId));
    if (!detail) return res.status(404).json({ error: "Run not found" });
    res.json(detail);
  }));

  router.post("/api/runs/:runId/cancel", asyncRoute(async (req, res) => {
    res.json({ run: await orchestration.cancelRun(String(req.params.runId)) });
  }));

  router.post("/api/runs/:runId/steps/:stepId/approve", asyncRoute(async (req, res) => {
    res.json(await orchestration.approveStep(String(req.params.runId), String(req.params.stepId)));
  }));

  router.post("/api/runs/:runId/steps/:stepId/reject", validate(rejectStepBody), asyncRoute(async (req, res) => {
    res.json(await orchestration.rejectStep(String(req.params.runId), String(req.params.stepId), req.body.reason));
  }));

  return router;
}
