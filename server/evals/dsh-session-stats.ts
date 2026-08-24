/**
 * Offline re-fold of dsh's own `sessionStats` projection - a follow-up to
 * #93's trial driver that closes a gap found while investigating trial
 * turn-count visibility: turn/step counts and LLM/tool/first-token/decode
 * wall times, computed from the raw event log
 * dsh's `@deepseek-ai/dsh-session-persistence-jsonl` plugin already writes
 * to `$DSH_HOME/sessions/<project>/<session>.jsonl` - a log this driver
 * never used to capture at all (see readSessionStats's own docstring and
 * scripts/tinytable-exam-room.ts's `dshHomeDir` option).
 *
 * `foldSessionStats` below is a direct, dependency-free port of
 * `sessionStatsProjectionDefinition.apply`/`.view` from
 * `@deepseek-ai/dsh-session-stats@0.1.0-rc.7` (and `isTokenDelta` from
 * `@deepseek-ai/dsh-llm@0.1.0-rc.7`'s `message` module) - the exact dsh
 * version `docker/tinytable-exam-room/Dockerfile` pins - fetched from the
 * npm registry and read directly rather than reimplemented from a guess at
 * the log format, since getting wall-time math like this wrong silently
 * would be worse than not reporting it at all. Ported instead of taken as
 * an npm dependency because the real package's peerDependencies pull in
 * several more `@deepseek-ai/dsh-*` internal packages for one pure
 * reducer; if `--trial-timeout-minutes`/`DSH_VERSION` is ever bumped past
 * 0.1.0-rc.7, re-diff this fold against the new version's published
 * `lib/index.js` (`npm view @deepseek-ai/dsh-session-stats@<version>
 * dist.tarball`) before trusting its output again - dsh's own README notes
 * "expect breakage between versions" (see docs/dsh-adapter-notes.md).
 *
 * Fold semantics (verbatim from the upstream package's README, reproduced
 * here since this file's correctness depends on matching it exactly):
 *   - `steps` counts `step/end` events - completed, failed, cancelled, and
 *     max-tokens steps all count (the loop appends exactly one per entered
 *     step, in a `finally`).
 *   - `turns` counts distinct turns carrying at least one closed step;
 *     rejected/empty turns are uncounted. Turn numbers are host-assigned
 *     and monotonic per session, so the fold only needs to remember the
 *     last counted turn.
 *   - `llmMs` sums `step/start` -> `assistant/message` per step that
 *     assembled a message (in-step `llm/retry` waits count as model time).
 *   - `ttftMs`/`ttftSteps` sum/count `step/start` -> first non-empty delta
 *     chunk; the first attempt's boundary survives an in-step `llm/retry`.
 *   - `decodeMs`/`decodeTokens` sum first-token -> assembled message and
 *     the provider-reported output tokens, only over steps carrying both.
 *   - `toolMs` sums `tool/call` -> `tool/result` pairs matched by callId;
 *     a call still pending at `turn/end` is dropped (results land within
 *     their own turn).
 *   - A cancelled step assembles no message, so its partial stream time
 *     enters no wall-time figure.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type DshRawEvent = {
  type: string;
  time: number;
  data?: Record<string, unknown>;
};

export type SessionStats = {
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
};

type OpenStep = { turn: number; step: number; startTime: number; firstTokenTime: number | null };

type FoldState = SessionStats & {
  lastTurn: number | null;
  openStep: OpenStep | null;
  pendingCalls: Record<string, number>;
};

function initFoldState(): FoldState {
  return {
    turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    lastTurn: null, openStep: null, pendingCalls: {}
  };
}

// Ported verbatim from @deepseek-ai/dsh-llm@0.1.0-rc.7's lib/types/message.js.
function isTokenDelta(chunk: unknown): boolean {
  if (typeof chunk !== "object" || chunk === null) return false;
  const c = chunk as Record<string, unknown>;
  switch (c.type) {
    case "text-delta":
    case "reasoning-delta":
      return c.text !== "";
    case "tool-call-delta":
      return c.argumentsDelta !== "" || c.name !== undefined;
    default:
      return false;
  }
}

// Ported verbatim from @deepseek-ai/dsh-session-stats@0.1.0-rc.7's usageOutputTokens.
function usageOutputTokens(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const value = (usage as Record<string, unknown>).outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function applyEvent(state: FoldState, event: DshRawEvent): FoldState {
  const data = event.data ?? {};
  switch (event.type) {
    case "step/start":
      return {
        ...state,
        openStep: { turn: data.turn as number, step: data.step as number, startTime: event.time, firstTokenTime: null }
      };
    case "assistant/chunk": {
      const open = state.openStep;
      if (open === null || open.turn !== data.turn || open.step !== data.step) return state;
      if (open.firstTokenTime !== null || !isTokenDelta(data.chunk)) return state;
      return { ...state, openStep: { ...open, firstTokenTime: event.time } };
    }
    case "assistant/message": {
      const open = state.openStep;
      if (open === null || open.turn !== data.turn || open.step !== data.step) return state;
      const next: FoldState = { ...state, llmMs: state.llmMs + Math.max(0, event.time - open.startTime), openStep: null };
      if (open.firstTokenTime !== null) {
        next.ttftMs += Math.max(0, open.firstTokenTime - open.startTime);
        next.ttftSteps += 1;
        const outputTokens = usageOutputTokens(data.usage);
        if (outputTokens !== null) {
          next.decodeMs += Math.max(0, event.time - open.firstTokenTime);
          next.decodeTokens += outputTokens;
        }
      }
      return next;
    }
    case "tool/call": {
      const callId = data.callId as string;
      return { ...state, pendingCalls: { ...state.pendingCalls, [callId]: event.time } };
    }
    case "tool/result": {
      const message = data.message as { source?: { callId?: string } } | undefined;
      const callId = message?.source?.callId;
      if (callId === undefined || !Object.hasOwn(state.pendingCalls, callId)) return state;
      const dispatched = state.pendingCalls[callId];
      const pendingCalls = Object.fromEntries(Object.entries(state.pendingCalls).filter(([id]) => id !== callId));
      return { ...state, toolMs: state.toolMs + Math.max(0, event.time - dispatched), pendingCalls };
    }
    case "step/end":
      return {
        ...state,
        turns: state.lastTurn === data.turn ? state.turns : state.turns + 1,
        steps: state.steps + 1,
        lastTurn: data.turn as number,
        openStep: null
      };
    case "turn/end":
      return Object.keys(state.pendingCalls).length === 0 ? state : { ...state, pendingCalls: {} };
    default:
      return state;
  }
}

function viewOf(state: FoldState): SessionStats {
  const { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens } = state;
  return { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens };
}

/** Pure fold over one session's raw event log, in log order. */
export function foldSessionStats(events: DshRawEvent[]): SessionStats {
  return viewOf(events.reduce(applyEvent, initFoldState()));
}

function sumStats(stats: SessionStats[]): SessionStats {
  return stats.reduce(
    (acc, s) => ({
      turns: acc.turns + s.turns,
      steps: acc.steps + s.steps,
      llmMs: acc.llmMs + s.llmMs,
      toolMs: acc.toolMs + s.toolMs,
      ttftMs: acc.ttftMs + s.ttftMs,
      ttftSteps: acc.ttftSteps + s.ttftSteps,
      decodeMs: acc.decodeMs + s.decodeMs,
      decodeTokens: acc.decodeTokens + s.decodeTokens
    }),
    { turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 }
  );
}

/** One `.jsonl` line per event; a blank trailing line (as dsh's own writer leaves) is skipped. */
export function parseSessionLog(text: string): DshRawEvent[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as DshRawEvent);
}

export type SessionStatsReport = {
  /** Sum of every session file's fold - what an --trial-timeout-minutes report should show. */
  aggregate: SessionStats;
  /** One entry per `$DSH_HOME/sessions/**\/*.jsonl` file found, for provenance/debugging. */
  sessions: Array<{ file: string; stats: SessionStats }>;
};

/**
 * Reads and folds every session JSONL file under `${dshHomeDir}/sessions/`
 * (see scripts/tinytable-exam-room.ts's `dshHomeDir` option, which mounts
 * this directory as the container's `$DSH_HOME` so dsh's own session-
 * persistence plugin - confirmed enabled by the headless profile's
 * `--dump-config` - writes there instead of into the container's
 * ephemeral, `--rm`-destroyed tmpfs $HOME).
 *
 * Sessions are folded independently, then summed - never concatenated
 * into one fold - because turn numbers are only monotonic *within* a
 * session; folding two sessions' events together would corrupt `lastTurn`/
 * `openStep` continuity. In practice one headless `dsh` invocation writes
 * exactly one session file, so this only matters if that ever changes.
 *
 * Returns null (not an all-zero report) when `${dshHomeDir}/sessions/`
 * doesn't exist or holds no `.jsonl` file - that's a distinct, worth-
 * flagging outcome (the mount didn't work, or this dsh version doesn't
 * ship the session-persistence plugin) from "a session ran and genuinely
 * did nothing yet".
 */
export async function readSessionStats(dshHomeDir: string): Promise<SessionStatsReport | null> {
  const sessions = await readRawSessionFiles(dshHomeDir);
  if (sessions === null) return null;
  const folded = sessions.map(({ file, events }) => ({ file, stats: foldSessionStats(events) }));
  return { aggregate: sumStats(folded.map((s) => s.stats)), sessions: folded };
}

/**
 * Reads and parses every session JSONL file under `${dshHomeDir}/sessions/`,
 * sorted by filename for a deterministic (if in practice almost always
 * single-file) order - the shared file-discovery this module's
 * `readSessionStats` and server/evals/dsh-trajectory-bridge.ts's
 * tool_call/shell_command derivation both build on. Returns null under the
 * same "nothing captured" condition documented on `readSessionStats`.
 */
export async function readRawSessionFiles(dshHomeDir: string): Promise<Array<{ file: string; events: DshRawEvent[] }> | null> {
  const sessionsDir = join(dshHomeDir, "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  if (files.length === 0) return null;

  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(sessionsDir, file), "utf8");
      return { file, events: parseSessionLog(text) };
    })
  );
}
