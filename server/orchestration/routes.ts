import { Router } from "express";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { validate, answerStepBody, createRunBody, rejectStepBody } from "../validation.js";
import { asyncRoute, httpError } from "../route-context.js";
import type { OrchestrationService } from "./service.js";

const MAX_ARTIFACT_CONTENT_BYTES = 2 * 1024 * 1024;

export function runRoutes(orchestration: OrchestrationService, attachmentRoot: string) {
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

  router.get("/api/runs/:runId/artifacts", asyncRoute(async (req, res) => {
    const stepId = typeof req.query.stepId === "string" ? req.query.stepId : undefined;
    res.json({ artifacts: await orchestration.listArtifacts(String(req.params.runId), stepId) });
  }));

  router.get("/api/runs/:runId/evidence", asyncRoute(async (req, res) => {
    const stepId = typeof req.query.stepId === "string" ? req.query.stepId : undefined;
    res.json({ evidence: await orchestration.listEvidence(String(req.params.runId), stepId) });
  }));

  router.get("/api/runs/:runId/evaluations", asyncRoute(async (req, res) => {
    const stepId = typeof req.query.stepId === "string" ? req.query.stepId : undefined;
    res.json({ evaluations: await orchestration.listEvaluations(String(req.params.runId), stepId) });
  }));

  router.get("/api/runs/:runId/gate-decisions", asyncRoute(async (req, res) => {
    const stepId = typeof req.query.stepId === "string" ? req.query.stepId : undefined;
    res.json({ gateDecisions: await orchestration.listQualityGateDecisions(String(req.params.runId), stepId) });
  }));

  router.get("/api/artifacts/:artifactId", asyncRoute(async (req, res) => {
    const artifact = await orchestration.getArtifact(String(req.params.artifactId));
    if (!artifact) return res.status(404).json({ error: "Artifact not found" });
    res.json({ artifact });
  }));

  router.get("/api/artifacts/:artifactId/content", asyncRoute(async (req, res) => {
    const artifact = await orchestration.getArtifact(String(req.params.artifactId));
    if (!artifact) return res.status(404).json({ error: "Artifact not found" });
    if (!artifact.path) return res.status(404).json({ error: "Artifact has no file content" });

    const resolvedRoot = resolve(attachmentRoot);
    const resolvedPath = resolve(artifact.path);
    const withinRoot = resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep);
    if (!withinRoot) return res.status(404).json({ error: "Artifact not found" });

    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch {
      return res.status(404).json({ error: "Artifact file not found on disk" });
    }
    if (!stats.isFile()) return res.status(404).json({ error: "Artifact file not found on disk" });

    const truncated = stats.size > MAX_ARTIFACT_CONTENT_BYTES;
    res.setHeader("Content-Type", artifact.mediaType || "application/octet-stream");
    res.setHeader("X-Artifact-Size", String(stats.size));
    res.setHeader("X-Artifact-Truncated", truncated ? "true" : "false");

    const stream = createReadStream(resolvedPath, truncated ? { start: 0, end: MAX_ARTIFACT_CONTENT_BYTES - 1 } : undefined);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
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

  router.post("/api/runs/:runId/steps/:stepId/answer", validate(answerStepBody), asyncRoute(async (req, res) => {
    res.json(await orchestration.answerStep(String(req.params.runId), String(req.params.stepId), req.body.text));
  }));

  router.post("/api/runs/:runId/steps/:stepId/retry", asyncRoute(async (req, res) => {
    res.json(await orchestration.retryStep(String(req.params.runId), String(req.params.stepId)));
  }));

  return router;
}
