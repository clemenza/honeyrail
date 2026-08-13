import type { EventBus } from "./events.js";
import { publishEvent } from "./events.js";
import type { CheckRun, GatewayEvent, Session, Store, Worktree } from "./types.js";
import type { ImageAttachment } from "./attachments.js";
import { publicAttachmentPayload } from "./attachments.js";

type Context = { store: Store; bus: EventBus };

export async function publishProjectCreated({ store, bus }: Context, projectId: string, name: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "project.created", projectId, payload: { name } });
}

export async function publishProjectUnregistered({ store, bus }: Context, projectId: string, name: string, repoPath: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "project.unregistered", projectId, payload: { name, repoPath } });
}

export async function publishWorktreeCreated({ store, bus }: Context, projectId: string, worktree: Partial<Worktree>): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "worktree.created", projectId, payload: worktree as Record<string, unknown> });
}

export async function publishWorktreeCommitted({ store, bus }: Context, projectId: string, taskId: string | undefined, worktreeId: string, branch: string, headRevision: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "worktree.committed", projectId, taskId, payload: { worktreeId, branch, headRevision } });
}

export async function publishWorktreeCheckResult({ store, bus }: Context, ok: boolean, projectId: string, taskId: string | undefined, worktreeId: string, commands: string[]): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: ok ? "worktree.checks_passed" : "worktree.checks_failed", projectId, taskId, payload: { worktreeId, commands, ok } });
}

export async function publishWorktreeDiscarded({ store, bus }: Context, projectId: string, taskId: string | undefined, worktreeId: string, branch: string, force: boolean): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "worktree.discarded", projectId, taskId, payload: { worktreeId, branch, force } });
}

export async function publishWorktreeMerged({ store, bus }: Context, projectId: string, taskId: string | undefined, worktreeId: string, branch: string, targetBranch: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "worktree.merged", projectId, taskId, payload: { worktreeId, branch, targetBranch } });
}

export async function publishSessionCreated({ store, bus }: Context, projectId: string | undefined, sessionId: string, agent: string, tmuxSessionName: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "session.created", projectId, sessionId, payload: { agent, tmuxSessionName } });
}

export async function publishSessionUpdated({ store, bus }: Context, session: Session, updates: Record<string, unknown>): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "session.updated", projectId: session.projectId ?? undefined, sessionId: session.id, payload: updates });
}

export async function publishSessionInputSent({ store, bus }: Context, session: Session, text: string, attachments: ImageAttachment[] = []): Promise<GatewayEvent> {
  return publishEvent(store, bus, {
    type: "session.input_sent",
    projectId: session.projectId ?? undefined,
    sessionId: session.id,
    payload: { preview: text.slice(0, 120), attachments: publicAttachmentPayload(attachments) }
  });
}

export async function publishSessionKeySent({ store, bus }: Context, session: Session, key: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "session.key_sent", projectId: session.projectId ?? undefined, sessionId: session.id, payload: { key } });
}

export async function publishSessionStatusChanged({ store, bus }: Context, session: Session, status: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "session.status_changed", projectId: session.projectId ?? undefined, sessionId: session.id, payload: { status } });
}

export async function publishSessionDeleted({ store, bus }: Context, session: Session): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "session.deleted", projectId: session.projectId ?? undefined, sessionId: session.id, payload: { name: session.name, status: session.status } });
}

export async function publishTaskStarted({ store, bus }: Context, projectId: string, sessionId: string, taskId: string, title: string, agent: string, worktreePath: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "task.started", projectId, sessionId, taskId, payload: { title, agent, worktreePath } });
}

export async function publishTaskFailed({ store, bus }: Context, projectId: string, sessionId: string | undefined, taskId: string, title: string, agent: string, worktreeId: string | undefined, reason: string): Promise<GatewayEvent> {
  return publishEvent(store, bus, { type: "task.failed", projectId, sessionId, taskId, payload: { title, agent, worktreeId, reason } });
}
