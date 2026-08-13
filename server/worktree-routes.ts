import { Router } from "express";
import { getAgentAdapter } from "./agents/registry.js";
import { asyncRoute, type RouteContext } from "./route-context.js";
import { defaultCheckCommands, mergeCheckRuns, requireWorktreeAndProject } from "./project-helpers.js";
import {
  publishWorktreeCheckResult,
  publishWorktreeCommitted,
  publishWorktreeCreated,
  publishWorktreeDiscarded,
  publishWorktreeMerged
} from "./domain-events.js";
import { validate, createWorktreeBody, commitWorktreeBody, runChecksBody, discardWorktreeBody, mergeWorktreeBody } from "./validation.js";
import type { Worktree } from "./types.js";

export function worktreeRoutes(ctx: RouteContext) {
  const { store, worktrees } = ctx;
  const router = Router();

  router.get("/api/projects/:projectId/worktrees", asyncRoute(async (req, res) => {
    res.json({ worktrees: await store.listWorktrees(String(req.params.projectId)) });
  }));

  router.post("/api/projects/:projectId/worktrees", validate(createWorktreeBody), asyncRoute(async (req, res) => {
    const project = await store.getProject(String(req.params.projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const adapter = getAgentAdapter(req.body.agent || project.defaultAgent);
    const created = await worktrees.create({
      project,
      title: req.body.title || "agent task",
      agent: adapter.id,
      baseBranch: req.body.baseBranch
    });
    const worktree = await store.createWorktree(created as Partial<Worktree>);
    await publishWorktreeCreated(ctx, project.id, worktree);
    res.status(201).json({ worktree });
  }));

  router.get("/api/worktrees/:worktreeId/diff", asyncRoute(async (req, res) => {
    const { worktree } = await requireWorktreeAndProject(store, String(req.params.worktreeId));
    res.json(await worktrees.diff(worktree));
  }));

  router.post("/api/worktrees/:worktreeId/commit", validate(commitWorktreeBody), asyncRoute(async (req, res) => {
    const { worktree, project } = await requireWorktreeAndProject(store, String(req.params.worktreeId));
    const commit = await worktrees.commit({ worktree, message: req.body.message });
    const committedAt = new Date().toISOString();
    const updatedWorktree = await store.updateWorktree(worktree.id, {
      status: "committed",
      committedAt,
      headRevision: commit.headRevision,
      commit
    });
    const task = worktree.taskId
      ? await store.updateTask(worktree.taskId, { status: "ready_to_merge", committedAt, headRevision: commit.headRevision })
      : null;
    await publishWorktreeCommitted(ctx, project.id, worktree.taskId, worktree.id, worktree.branch, commit.headRevision);
    res.json({ ok: true, worktree: updatedWorktree, task, commit });
  }));

  router.post("/api/worktrees/:worktreeId/checks", validate(runChecksBody), asyncRoute(async (req, res) => {
    const { worktree, project } = await requireWorktreeAndProject(store, String(req.params.worktreeId));
    const commands = defaultCheckCommands(project, req.body.commands);
    if (!commands.length) return res.status(400).json({ error: "No check commands configured" });
    const result = await worktrees.runChecks({ worktree, commands });
    const checkedAt = new Date().toISOString();
    const checkRuns = mergeCheckRuns(worktree.checkRuns, result.runs);
    const updatedWorktree = await store.updateWorktree(worktree.id, {
      status: result.ok ? "checks_passed" : "checks_failed",
      checkedAt,
      checkRuns
    });
    const task = worktree.taskId
      ? await store.updateTask(worktree.taskId, {
          status: result.ok ? "ready_to_merge" : "checks_failed",
          checkedAt,
          checkRuns: mergeCheckRuns((await store.getTask(worktree.taskId))?.checkRuns, result.runs)
        })
      : null;
    await publishWorktreeCheckResult(ctx, result.ok, project.id, worktree.taskId, worktree.id, commands);
    res.json({ ok: result.ok, worktree: updatedWorktree, task, checkRuns: result.runs });
  }));

  router.post("/api/worktrees/:worktreeId/discard", validate(discardWorktreeBody), asyncRoute(async (req, res) => {
    const { worktree, project } = await requireWorktreeAndProject(store, String(req.params.worktreeId));
    const discard = await worktrees.discard({ project, worktree, force: Boolean(req.body.force) });
    const discardedAt = new Date().toISOString();
    const updatedWorktree = await store.updateWorktree(worktree.id, { status: "discarded", discardedAt, discard });
    const task = worktree.taskId
      ? await store.updateTask(worktree.taskId, { status: "cancelled", cancelledAt: discardedAt })
      : null;
    await publishWorktreeDiscarded(ctx, project.id, worktree.taskId, worktree.id, worktree.branch, Boolean(req.body.force));
    res.json({ ok: true, worktree: updatedWorktree, task, discard });
  }));

  router.post("/api/worktrees/:worktreeId/merge", validate(mergeWorktreeBody), asyncRoute(async (req, res) => {
    const { worktree, project } = await requireWorktreeAndProject(store, String(req.params.worktreeId));
    const merge = await worktrees.merge({ project, worktree, targetBranch: req.body.targetBranch });
    const mergedAt = new Date().toISOString();
    const updatedWorktree = await store.updateWorktree(worktree.id, { status: "merged", mergedAt, merge });
    const task = worktree.taskId
      ? await store.updateTask(worktree.taskId, { status: "merged", mergedAt })
      : null;
    await publishWorktreeMerged(ctx, project.id, worktree.taskId, worktree.id, worktree.branch, merge.targetBranch);
    res.json({ ok: true, worktree: updatedWorktree, task, merge });
  }));

  return router;
}
