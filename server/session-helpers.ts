import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import xtermHeadless from "@xterm/headless";
import { getAgentAdapter } from "./agents/registry.js";
import { type EventBus, publishEvent } from "./events.js";
import type { TmuxManager } from "./tmux.js";
import type { GatewayEvent, Session, Store } from "./types.js";
import { makeId, slugify } from "./utils.js";

// @xterm/headless ships as CJS with its named exports assigned dynamically,
// which cjs-module-lexer (Node's ESM/CJS interop) can't statically detect -
// only the default (the whole `exports` object) resolves reliably here.
const { Terminal } = xtermHeadless;

type HttpError = Error & { status: number };

function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export function truncateForPrompt(value: unknown, maxChars: number) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.floor(maxChars * 0.25))}\n\n...[truncated ${text.length - maxChars} chars]...\n\n${text.slice(-Math.floor(maxChars * 0.75))}`;
}

export function sessionLogPath(sessionLogRoot: string, sessionId: string) {
  return join(sessionLogRoot, `${basename(sessionId)}.log`);
}

function stripAnsiCodes(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
    .replace(/\x1b[P_^][^\x1b]*\x1b\\/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b./g, "")
    .replace(/\r/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function cleanTuiLine(line: string): string {
  let cleaned = line;
  cleaned = cleaned.replace(/•(?:Running|Working)[^\n]*$/g, "");
  cleaned = cleaned.replace(/›[^\n]*$/g, "");
  cleaned = cleaned.replace(/\d[A-Z][•\dA-Za-z\s·/…]*$/g, "");
  cleaned = cleaned.replace(/[A-Z]?[a-z]{0,7}(?:•[A-Za-z]{0,8}){2,}[A-Za-z]*/g, "");
  cleaned = cleaned.replace(/(?:Working|Running)(?:\([\dm\s]*s\s*•\s*esc to interrupt\)|•|\d)[^\n]*/g, "");
  cleaned = cleaned.replace(/[A-Z]{1,3}[a-z]{0,6}•[A-Z]?[a-z]*$/g, "");
  cleaned = cleaned.replace(/•[A-Z][a-z]{0,8}$/g, "");
  return cleaned.trimEnd();
}

function isTuiArtifact(line: string): boolean {
  if (line.trim().length < 2) return true;
  const bulletFragments = line.split("•").length - 1;
  if (bulletFragments >= 3 && bulletFragments > line.length / 20) return true;
  if (/^[─━═╌╍┄┅┈┉\-]{4,}[A-Za-z]*$/.test(line.trim())) return true;
  if (/^[RWrw][A-Za-z•]{0,20}$/.test(line.trim())) return true;
  if (/^[a-z]{1,2}$/.test(line.trim())) return true;
  return false;
}

export function stripAnsi(text: string): string {
  const screenClears = /\x1b\[2J|\x1b\[H\x1b\[J/g;
  const chunks = text.split(screenClears);
  const lastChunk = chunks.length > 1 ? chunks.slice(-1)[0] : text;
  const cleaned = stripAnsiCodes(lastChunk);
  return cleaned
    .split("\n")
    .map(cleanTuiLine)
    .filter((line) => !isTuiArtifact(line))
    .reduce<string[]>((acc, line) => {
      if (acc.length === 0 || acc[acc.length - 1] !== line) acc.push(line);
      return acc;
    }, [])
    .join("\n");
}

export async function readSessionLog(path: unknown) {
  if (!path) return "";
  try {
    return await readFile(String(path), "utf8");
  } catch {
    return "";
  }
}

// Must match the pane size tmux gives a session that no client ever attaches
// to (tmux's `default-size`, 80x24) so line wrapping in the replayed screen
// matches what actually appeared on screen.
const REPLAY_COLS = 80;
const REPLAY_ROWS = 24;
// Long-running agent sessions can produce far more than one screenful of
// output; keep enough scrollback that nothing written before the process
// ended falls off the reconstructed buffer.
const REPLAY_SCROLLBACK = 100_000;

/**
 * Reconstructs the final resolved terminal screen from a raw `pipe-pane -o`
 * byte log, the same way `tmux capture-pane -p` does for a live pane: by
 * feeding the bytes through a real terminal emulator that tracks cursor
 * position and resolves `\r`/escape-sequence overwrites, rather than
 * heuristically stripping lines that look like redraw noise. A regex-based
 * stripper can't recover a screen cell once two frames have genuinely
 * overwritten each other in the raw stream.
 */
export async function replayTerminalLog(raw: string): Promise<string> {
  const text = String(raw || "");
  if (!text) return "";
  const term = new Terminal({
    cols: REPLAY_COLS,
    rows: REPLAY_ROWS,
    scrollback: REPLAY_SCROLLBACK,
    allowProposedApi: true,
    // The pty normally turns outgoing "\n" into "\r\n" (ONLCR), and that's
    // what a real pipe-pane log almost always contains - but treat a bare
    // "\n" as a full newline too, so output stays readable even if some
    // byte in the stream skipped that translation.
    convertEol: true
  });
  try {
    await new Promise<void>((resolve) => term.write(text, () => resolve()));
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  } finally {
    term.dispose();
  }
}

export function tmuxName(prefix: string, name: string) {
  const suffix = slugify(name).replaceAll("-", "_").slice(0, 36);
  return `honeyrail_${prefix}_${Date.now().toString(36)}_${suffix}`;
}

export async function restartSessionWithModel({ store, bus, tmux, session, model, sessionLogRoot }: {
  store: Store;
  bus: EventBus;
  tmux: TmuxManager;
  session: Session;
  model: string | null;
  sessionLogRoot: string;
}) {
  const normalizedModel = String(model || "").trim() || null;
  const adapter = getAgentAdapter(session.agent);
  if (adapter.id === "shell") {
    return store.updateSession(session.id, { model: normalizedModel });
  }

  try {
    await tmux.killSession(session.tmuxSessionName);
  } catch {
    // The session may already be gone; we'll recreate it below.
  }

  const logPath = session.logPath || sessionLogPath(sessionLogRoot, session.id);
  await tmux.startSession({
    name: session.tmuxSessionName,
    cwd: session.cwd,
    command: adapter.buildLaunchCommand({ prompt: session.prompt, model: normalizedModel }),
    logPath
  });

  const updated = await store.updateSession(session.id, {
    model: normalizedModel,
    status: "running",
    lastOutputAt: new Date().toISOString(),
    logPath
  });
  await publishEvent(store, bus, {
    type: "session.status_changed",
    projectId: session.projectId ?? undefined,
    sessionId: session.id,
    payload: { status: "running", model: normalizedModel }
  });
  return updated;
}

export async function markSessionFailed({ store, bus, session, reason }: {
  store: Store;
  bus: EventBus;
  session: Session;
  reason: string;
}) {
  const failedAt = new Date().toISOString();
  const latestSession = await store.getSession(session.id);
  if (latestSession?.status === "killed") {
    await store.updateSession(session.id, { lastOutputAt: failedAt });
    return;
  }

  await store.updateSession(session.id, { status: "failed", lastOutputAt: failedAt, error: reason });

  const tasks = await store.listTasks();
  const task = tasks.find((item) => item.sessionId === session.id || (session.worktreeId && item.worktreeId === session.worktreeId));
  if (task && !["done", "failed", "cancelled", "merged"].includes(task.status)) {
    await store.updateTask(task.id, { status: "failed", failedAt, error: reason });
  }
  if (session.worktreeId) {
    const worktree = await store.getWorktree(session.worktreeId);
    if (worktree && !["failed", "merged"].includes(worktree.status)) {
      await store.updateWorktree(worktree.id, { status: "failed", failedAt, error: reason });
    }
  }

  await publishEvent(store, bus, {
    type: "session.status_changed",
    projectId: session.projectId ?? undefined,
    sessionId: session.id,
    taskId: task?.id,
    payload: { status: "failed", reason }
  });
}

export type SessionSummaryClient = {
  summarize(input: { model: string; prompt: string }): Promise<string>;
};

export function createDeepSeekSummaryClient({ apiKey, baseUrl = "https://api.deepseek.com" }: { apiKey?: string | null; baseUrl?: string } = {}): SessionSummaryClient {
  return {
    async summarize({ model, prompt }) {
      if (!apiKey) {
        throw httpError(503, "Session summary API key is not configured. Set DEEPSEEK_API_KEY or AGENT_SESSION_SUMMARY_API_KEY.");
      }
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "你是移动端会话复盘助手。请只基于提供的 session 上下文总结，不要编造未出现的信息。"
            },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 1200
        }),
        signal: AbortSignal.timeout(60000)
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        const bodyError = body?.error as Record<string, unknown> | string | undefined;
        const msg = typeof bodyError === "object" ? (bodyError?.message as string) : (bodyError as string | undefined);
        throw httpError(response.status, msg || "Session summary request failed");
      }
      const choices = body?.choices as Array<{ message?: { content?: string } }> | undefined;
      const text = choices?.[0]?.message?.content;
      if (!text) throw httpError(502, "Session summary response was empty");
      return String(text).trim();
    }
  };
}

export async function buildSessionSummaryPrompt({ store, tmux, run, session, lines }: {
  store: Store;
  tmux: TmuxManager;
  run: typeof import("./utils.js").runCommandSafe;
  session: Session;
  lines: number;
}) {
  let output = "";
  try {
    output = await tmux.capture(session.tmuxSessionName, lines);
  } catch (error) {
    output = `capture unavailable: ${errorMessage(error)}`;
  }
  const logOutput = await readSessionLog(session.logPath);
  let events: GatewayEvent[] = [];
  try {
    events = await store.listEvents(80);
  } catch {
    events = [];
  }
  const sessionEvents = events
    .filter((event) => event.sessionId === session.id)
    .map((event) => `${event.createdAt || ""} ${event.type}: ${(event.payload?.preview as string) || JSON.stringify(event.payload || {})}`)
    .join("\n");
  let gitStatus = "";
  if (session.cwd) {
    const result = await run("git", ["status", "--short"], { cwd: session.cwd });
    if (result?.ok) gitStatus = result.stdout.trim();
  }

  return [
    "请为这个 agent session 生成适合手机查看的中文摘要。",
    "",
    "必须使用以下五个小节，保持精练，每节 1-4 条：",
    "1. 本轮做了什么",
    "2. 改了哪些文件",
    "3. 测试结果",
    "4. 当前阻塞点",
    "5. 下一步建议",
    "",
    '如果某项没有证据，请写"未发现"或"无"。',
    "",
    "Session metadata:",
    JSON.stringify({
      id: session.id,
      name: session.name,
      agent: session.agent,
      model: session.model,
      status: session.status,
      cwd: session.cwd,
      prompt: session.prompt
    }, null, 2),
    "",
    "Recent user/session events:",
    truncateForPrompt(sessionEvents || "No session events.", 6000),
    "",
    "Git status:",
    truncateForPrompt(gitStatus || "No git status changes detected.", 4000),
    "",
    "Terminal capture:",
    truncateForPrompt(output || "No terminal output.", 24000),
    "",
    "Session log:",
    truncateForPrompt(logOutput || "No session log.", 16000)
  ].join("\n");
}

export async function publishInitialAgentPrompt({ store, bus, session, text, attachments = [] }: {
  store: Store;
  bus: EventBus;
  session: Session;
  text: string;
  attachments?: import("./attachments.js").ImageAttachment[];
}) {
  const prompt = String(text || "").trim();
  const adapter = getAgentAdapter(session.agent);
  if ((!prompt && !attachments.length) || adapter.id === "shell") return;

  const { publicAttachmentPayload } = await import("./attachments.js");
  await publishEvent(store, bus, {
    type: "session.input_sent",
    projectId: session.projectId ?? undefined,
    sessionId: session.id,
    payload: {
      preview: prompt.slice(0, 120),
      attachments: publicAttachmentPayload(attachments)
    }
  });
}
