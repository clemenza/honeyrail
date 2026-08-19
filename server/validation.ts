import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";

const agentType = z.enum(["shell", "codex", "claude", "hermes"]);

const imageAttachmentInput = z.object({
  dataUrl: z.string(),
  name: z.string().optional()
});

export const updateWorkspaceBody = z.object({
  path: z.string()
});

export const createProjectBody = z.object({
  create: z.boolean().optional(),
  name: z.string().optional(),
  repoPath: z.string().optional(),
  githubRepoUrl: z.string().optional(),
  defaultBranch: z.string().optional(),
  defaultAgent: agentType.optional(),
  testCommands: z.array(z.string()).optional(),
  runCommands: z.array(z.string()).optional()
});

export const createWorktreeBody = z.object({
  title: z.string().optional(),
  agent: agentType.optional(),
  baseBranch: z.string().optional()
});

export const commitWorktreeBody = z.object({
  message: z.string().optional()
});

export const runChecksBody = z.object({
  commands: z.array(z.string()).optional()
});

export const discardWorktreeBody = z.object({
  force: z.boolean().optional()
});

export const mergeWorktreeBody = z.object({
  targetBranch: z.string().optional()
});

export const createSessionBody = z.object({
  projectId: z.string().optional(),
  cwd: z.string().optional(),
  agent: agentType.optional(),
  name: z.string().optional(),
  tmuxSessionName: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  worktreeId: z.string().nullable().optional()
});

export const updateSessionBody = z.object({
  model: z.string().nullable().optional()
});

export const sessionInputBody = z.object({
  text: z.string().optional(),
  attachments: z.array(imageAttachmentInput).optional()
});

export const sessionKeyBody = z.object({
  key: z.string().optional()
});

export const sessionSummarizeBody = z.object({
  lines: z.number().optional()
});

export const createTaskBody = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  prompt: z.string().optional(),
  agent: agentType.optional(),
  model: z.string().optional(),
  attachments: z.array(imageAttachmentInput).optional()
});

const stepInput = z.record(z.string(), z.unknown());
const evaluatorBody = z.object({
  id: z.string().optional(),
  type: z.string().min(1),
  source: z.string().optional(),
  expected: z.union([z.boolean(), z.string(), z.number()]).optional(),
  operator: z.enum(["==", "!=", ">", ">=", "<", "<="]).optional(),
  threshold: z.number().optional(),
  reason: z.string().optional()
});

const qualityGateBody = z.object({
  evaluators: z.array(evaluatorBody).min(1),
  onFail: z.enum(["fail", "wait_approval"]).optional()
});

const onBlockedBody = z.object({
  action: z.enum(["mark_blocked", "auto_retry", "auto_answer", "wait_approval"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  onTimeout: z.enum(["auto_answer", "auto_retry"]).optional(),
  maxAutoAnswers: z.number().int().positive().optional()
});

export const createRunBody = z.object({
  projectId: z.string(),
  goal: z.string().min(1),
  contractLevel: z.enum(["L0", "L1", "L2", "L3"]).optional(),
  recipeId: z.string().optional(),
  maxParallel: z.number().int().positive().optional(),
  steps: z.array(z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    executor: z.string().min(1),
    input: stepInput.optional(),
    dependsOn: z.array(z.string()).optional(),
    maxAttempts: z.number().int().positive().optional(),
    qualityGate: qualityGateBody.optional(),
    onBlocked: onBlockedBody.optional(),
    produces: z.array(z.string().min(1)).optional(),
    consumes: z.array(z.string().min(1)).optional()
  })).min(1)
});

export const rejectStepBody = z.object({
  reason: z.string().optional()
});

export const answerStepBody = z.object({
  text: z.string().min(1)
});

export const recipeRunBody = z.object({
  projectId: z.string().min(1),
  goal: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional()
});

export function validate(schema: z.ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body ?? {});
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const message = error.issues
          .map((issue) => issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)
          .join("; ");
        const httpErr = new Error(message) as Error & { status: number };
        httpErr.status = 400;
        next(httpErr);
        return;
      }
      next(error);
    }
  };
}
