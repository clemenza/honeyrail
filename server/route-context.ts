import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { EventBus } from "./events.js";
import type { SessionSummaryClient } from "./session-helpers.js";
import type { TmuxManager } from "./tmux.js";
import type { Store } from "./types.js";
import type { runCommandSafe } from "./utils.js";
import type { WorktreeManager } from "./worktrees.js";

export type HttpError = Error & { status: number };

export type RouteContext = {
  store: Store;
  bus: EventBus;
  tmux: TmuxManager;
  worktrees: WorktreeManager;
  run: typeof runCommandSafe;
  sessionSummaryClient: SessionSummaryClient;
  summaryModel: string;
  attachmentRoot: string;
  sessionLogRoot: string;
  defaultWorkspace: string;
};

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}
