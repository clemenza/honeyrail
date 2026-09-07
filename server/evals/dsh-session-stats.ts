/**
 * Offline re-fold of dsh's own `sessionStats` projection - a follow-up to
 * #93's trial driver that closes a gap found while investigating trial
 * turn-count visibility: turn/step counts and LLM/tool/first-token/decode
 * wall times, computed from the raw event log
 * dsh's `@deepseek-ai/dsh-session-persistence-jsonl` plugin already writes
 * to `$DSH_HOME/sessions/<project>/<session>.jsonl(.zstd)` - a log this
 * driver never used to capture at all (see readSessionStats's own
 * docstring and scripts/tinytable-exam-room.ts's `dshHomeDir` option).
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

import { lstat, opendir, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { zstdDecompressSync } from "node:zlib";

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

/**
 * #141: `llmMs`/`toolMs` are each sums of disjoint sub-intervals of one
 * trial's real wall-clock span (`step/start`->`assistant/message` steps,
 * `tool/call`->`tool/result` pairs) - a subset can never exceed the whole,
 * so either one reading higher than the trial's own driver-measured
 * `wallTimeMs` is never legitimate, regardless of what produced it.
 * Observed on exactly two real trials so far (#134's `33-baseline-4`,
 * #136's `9-baseline-5` - `llmMs` 1021.6s vs. `wallTimeMs` 787.1s), both
 * also the only `turns: 2` sessions seen across 115 tracked trials.
 *
 * Root-cause note: this module's `foldSessionStats` is a verified
 * byte-for-byte port of the pinned `@deepseek-ai/dsh-session-stats@0.1.0-rc.7`
 * tarball's own `apply`/`view` (re-diffed against the published `lib/
 * index.js` while investigating this issue - no divergence), so the
 * accumulation logic itself isn't the source. The upstream package's own
 * projection docstring says its whole point is serving "full-session
 * figures that paging and compaction cannot change" - i.e. dsh's live,
 * in-process projection is explicitly designed to survive a session's
 * context being compacted mid-run. `foldSessionStats` has no such live
 * state to read: it can only cold-refold whatever raw events the
 * persisted JSONL log currently holds, so if compaction (plausible given
 * both known cases are also the only 2-turn, unusually-long sessions on
 * record) causes that persisted log to reflect pre-compaction step events
 * more than once, a cold refold would double-count them in exactly this
 * shape - inflated `llmMs`, but `turns` still only 2 (compaction
 * resuming into the *same* turn number wouldn't trip the `lastTurn`
 * increment). Confirming this exactly would need a real affected trial's
 * raw session log, which isn't available in-repo; this function is the
 * defensive mitigation the acceptance criteria call for either way - never
 * trust an impossible number, whatever produced it.
 */
export function findSessionStatsTimingInconsistency(stats: SessionStats, wallTimeMs: number): string | null {
  if (stats.llmMs > wallTimeMs) return `llmMs (${stats.llmMs}ms) exceeds wallTimeMs (${wallTimeMs}ms)`;
  if (stats.toolMs > wallTimeMs) return `toolMs (${stats.toolMs}ms) exceeds wallTimeMs (${wallTimeMs}ms)`;
  return null;
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

// `@deepseek-ai/dsh-session-persistence-jsonl`'s DEFAULT_COMPRESSION is
// "zstd" (confirmed in its published lib/index.js), so a real session log is
// `session.jsonl.zstd`, not `session.jsonl`, on every trial unless an
// operator explicitly configures compression: "none" - this is the default
// path, not an edge case. `.jsonl.zstd` is a *concatenated-frame* Zstandard
// container (one frame per durable event batch the writer appended), not a
// single stream: node:zlib's one-shot zstdDecompressSync only decodes the
// first frame of a multi-frame buffer and silently drops the rest (verified
// against a real dsh session log - a naive `zstdDecompressSync(wholeFile)`
// recovered only the file's first line). Frame boundaries must be located
// before decompressing each one independently, exactly as dsh's own
// PublicZstdFrameDecoder does.
//
// scanZstdFrames below is a direct, dependency-free port of
// `scanZstdFrames` from `@deepseek-ai/dsh-session-persistence-jsonl@0.1.0-rc.7`'s
// published lib/index.js - same pin, same "ported verbatim, not
// reimplemented from a guess" rationale as foldSessionStats above.
const ZSTD_MAGIC = 0xfd2fb528;

type ZstdFrameRange = { start: number; end: number };

/**
 * Locate complete Zstandard frames in `buffer` without decompressing their
 * blocks. Throws on structurally invalid input; a torn/incomplete final
 * frame (the log was read mid-write) is reported via `tornStart` rather
 * than thrown on, and its bytes are simply excluded from `frames`.
 */
function scanZstdFrames(buffer: Buffer): { frames: ZstdFrameRange[]; tornStart?: number } {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * Thrown when a Historical-PG bounded telemetry read (see
 * `readBoundedDshSessionTelemetry()` below) exceeds one of its caller-supplied
 * limits - discovery entries, matching files, on-disk bytes, decoded bytes,
 * or recovered events (PR #210 review round 6, Blocking 1). A distinct type
 * from a genuine corruption error (invalid JSON, a malformed Zstandard
 * frame): both are still evidence-extraction failures from the caller's
 * point of view and are handled identically by
 * `runHistoricalPostgresTrial()`'s existing evidence boundary, but keeping
 * this as its own class lets a limit violation be recognized unambiguously
 * wherever that turns out to matter.
 */
export class DshSessionTelemetryLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshSessionTelemetryLimitExceededError";
  }
}

/**
 * Decode a dsh session log's concatenated-frame Zstandard container into its
 * plaintext JSONL. A structurally torn final frame is dropped, not thrown
 * on - readSessionStats already treats a session as best-effort telemetry,
 * not an integrity check, and a trial's log is sometimes read immediately
 * after the writer's last append.
 *
 * `options.maxOutputLength`, when given, bounds the *decoded* output across
 * every frame in this buffer combined (PR #210 review round 6, Blocking 1b):
 * a small compressed `.jsonl.zstd` file can still expand into a much larger
 * plaintext buffer, so the on-disk/compressed byte bound alone
 * (`measureDshSessionTelemetry`'s bound, or the caller's own file-size check)
 * cannot protect against that. Each frame is decompressed with Node's own
 * `maxOutputLength` enforcement (`zlib.zstdDecompressSync`, which rejects
 * before allocating past the bound - never fully materializes an oversized
 * decoded buffer first) against the *remaining* budget, so the cumulative
 * decoded size across all frames in this buffer can never exceed the given
 * bound. Omitted (the default): fully unbounded, exactly the prior
 * behavior - existing callers (scripts/dsh-evals-demo.ts's tinytable path,
 * and this module's own unbounded `readRawSessionFiles`) are unaffected.
 */
export function decodeZstdSessionLog(buffer: Buffer, options: { maxOutputLength?: number } = {}): string {
  const { frames } = scanZstdFrames(buffer);
  const decoded: Buffer[] = [];
  let total = 0;
  for (const frame of frames) {
    const frameBuffer = buffer.subarray(frame.start, frame.end);
    let chunk: Buffer;
    if (options.maxOutputLength === undefined) {
      chunk = zstdDecompressSync(frameBuffer);
    } else {
      const remaining = Math.max(0, options.maxOutputLength - total);
      try {
        chunk = zstdDecompressSync(frameBuffer, { maxOutputLength: remaining });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
          throw new DshSessionTelemetryLimitExceededError(
            `DSH telemetry decoded output exceeds the decoded-byte bound (> ${options.maxOutputLength} bytes)`
          );
        }
        throw error;
      }
    }
    decoded.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(decoded).toString("utf8");
}

export type SessionStatsReport = {
  /** Sum of every session file's fold - what an --trial-timeout-minutes report should show. */
  aggregate: SessionStats;
  /** One entry per `$DSH_HOME/sessions/**\/*.jsonl`(`.zstd`) file found, for provenance/debugging. */
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
 * doesn't exist or holds no `.jsonl`/`.jsonl.zstd` file - that's a
 * distinct, worth-flagging outcome (the mount didn't work, or this dsh
 * version doesn't ship the session-persistence plugin) from "a session ran
 * and genuinely did nothing yet".
 */
export async function readSessionStats(dshHomeDir: string): Promise<SessionStatsReport | null> {
  const sessions = await readRawSessionFiles(dshHomeDir);
  if (sessions === null) return null;
  return foldSessionStatsReport(sessions);
}

/**
 * Folds already-loaded raw session events into a `SessionStatsReport`,
 * without touching the filesystem - shared by `readSessionStats()` (which
 * reads via the unbounded `readRawSessionFiles()`) and
 * `runHistoricalPostgresTrial()` (PR #210 review round 6), which already
 * holds its own bounded `readBoundedDshSessionTelemetry()` result and must
 * not re-read/re-decode the same files a second time - independent of, and
 * without reintroducing, the unbounded discovery this round's Blocking 1
 * removes from the Historical-PG path.
 */
export function foldSessionStatsReport(sessions: Array<{ file: string; events: DshRawEvent[] }>): SessionStatsReport {
  const folded = sessions.map(({ file, events }) => ({ file, stats: foldSessionStats(events) }));
  return { aggregate: sumStats(folded.map((s) => s.stats)), sessions: folded };
}

/**
 * Reads and parses every session log file under `${dshHomeDir}/sessions/`,
 * sorted by filename for a deterministic (if in practice almost always
 * single-file) order - the shared file-discovery this module's
 * `readSessionStats` and server/evals/dsh-trajectory-bridge.ts's
 * tool_call/shell_command derivation both build on. Returns null under the
 * same "nothing captured" condition documented on `readSessionStats`.
 *
 * Matches both `.jsonl` (compression: "none") and `.jsonl.zstd`
 * (compression: "zstd", the plugin's default - see decodeZstdSessionLog's
 * docstring) - a filter that only matched `.jsonl` found zero files on
 * every real trial, since dsh writes zstd by default.
 */
export async function readRawSessionFiles(dshHomeDir: string): Promise<Array<{ file: string; events: DshRawEvent[] }> | null> {
  const listing = await listDshSessionFiles(dshHomeDir);
  if (listing === null) return null;
  const { sessionsDir, files } = listing;

  return Promise.all(
    files.map(async (file) => {
      const text = file.endsWith(".jsonl.zstd")
        ? decodeZstdSessionLog(await readFile(join(sessionsDir, file)))
        : await readFile(join(sessionsDir, file), "utf8");
      return { file, events: parseSessionLog(text) };
    })
  );
}

/** Shared session-file discovery between readRawSessionFiles() and measureDshSessionTelemetry() - one definition of "which files count", never two that could silently disagree. */
async function listDshSessionFiles(dshHomeDir: string): Promise<{ sessionsDir: string; files: string[] } | null> {
  const sessionsDir = join(dshHomeDir, "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.endsWith(".jsonl") || entry.endsWith(".jsonl.zstd")).sort();
  if (files.length === 0) return null;
  return { sessionsDir, files };
}

/**
 * The Historical-PG-specific telemetry sanity policy `readBoundedDshSessionTelemetry()`
 * enforces (PR #210 review round 6, Blocking 1). `$DSH_HOME` is written by a
 * process running *inside* the agent container - agent-tamperable
 * diagnostic telemetry, not grader-owned evidence - so nothing else bounds
 * its growth. Every field is a hard ceiling on a distinct resource, checked
 * in the order a caller would actually pay for it (cheapest first):
 * directory entries visited, matching files found, their on-disk bytes,
 * their decoded bytes, and finally the raw events recovered from them.
 */
export type DshSessionTelemetryLimits = {
  /** Every directory entry visited during discovery under `sessions/` - files, directories, and non-matching files all count, checked before any `lstat`/read on that entry. */
  maxEntries: number;
  /** Matching (`.jsonl`/`.jsonl.zstd`) *regular* files - a symlink or any other non-regular entry is never counted here (see below). */
  maxFiles: number;
  /** Sum of on-disk bytes (compressed, for `.jsonl.zstd`) across matching files, from `lstat`, before any file content is read. */
  maxBytes: number;
  /** Sum of decoded/plaintext JSONL bytes across matching files - independent of `maxBytes`, since a small compressed file can still decode much larger. */
  maxDecodedBytes: number;
  /** Sum of recovered raw events across matching files. */
  maxEvents: number;
};

type BoundedDshSessionFile = { relativePath: string; absolutePath: string };

/** Tolerates a `for await...of`-already-closed `fs.Dir` the same way `measureHistoricalPostgresWorkspace()` (historical-task.ts) does - shared discipline, not shared code. */
async function closeDirQuietly(dir: { close: () => Promise<void> }): Promise<void> {
  try {
    await dir.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ERR_DIR_CLOSED") throw error;
  }
}

/**
 * Bounded discovery for the Historical-PG telemetry path (PR #210 review
 * round 6, Blocking 1): walks `${dshHomeDir}/sessions/` with `opendir()`'s
 * async iterator - never `readdir(..., {recursive: true})`, which
 * materializes an entire, potentially agent-controlled directory tree into
 * one array *before* any limit in `limits` is ever consulted. Every visited
 * entry - matching or not, file or directory - counts against
 * `limits.maxEntries`, checked immediately on each entry, so a tree of
 * millions of non-matching files stops cheaply rather than being fully
 * enumerated first.
 *
 * A matching entry is `lstat`'d (never `stat`) and accepted only when
 * `isFile()` is true (Blocking 1a): a symlink - `fake.jsonl ->
 * huge-file-elsewhere` - is skipped outright, counted as neither a matching
 * file nor toward `maxBytes`, and its target is never read by this
 * function or by `readBoundedDshSessionTelemetry()` below. `lstat`
 * reporting a symlink's own tiny size cannot be used to smuggle a much
 * larger target past the byte bound, because the target is simply never
 * opened.
 *
 * Returns null under the same "nothing captured" condition as
 * `readRawSessionFiles()` - `sessions/` doesn't exist, or holds no matching
 * regular file after a full (bounded) walk.
 */
async function discoverBoundedDshSessionFiles(dshHomeDir: string, limits: DshSessionTelemetryLimits): Promise<BoundedDshSessionFile[] | null> {
  const sessionsDir = join(dshHomeDir, "sessions");
  let rootDir;
  try {
    rootDir = await opendir(sessionsDir);
  } catch {
    return null;
  }

  let entriesVisited = 0;
  let totalBytes = 0;
  const matched: BoundedDshSessionFile[] = [];

  const visitEntry = async (entryPath: string, name: string, isDirectory: boolean): Promise<void> => {
    entriesVisited += 1;
    if (entriesVisited > limits.maxEntries) {
      throw new DshSessionTelemetryLimitExceededError(
        `DSH telemetry discovery exceeds the entry sanity bound (> ${limits.maxEntries} directory entries visited under sessions/)`
      );
    }
    if (isDirectory) {
      await walkDir(entryPath);
      return;
    }
    if (!(name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd"))) return;
    const details = await lstat(entryPath);
    if (!details.isFile()) return; // symlinks (and anything else non-regular): never followed, never counted.
    matched.push({ relativePath: relative(sessionsDir, entryPath), absolutePath: entryPath });
    if (matched.length > limits.maxFiles) {
      throw new DshSessionTelemetryLimitExceededError(
        `DSH telemetry exceeds the matching-file bound (> ${limits.maxFiles} .jsonl/.jsonl.zstd files under sessions/)`
      );
    }
    totalBytes += details.size;
    if (totalBytes > limits.maxBytes) {
      throw new DshSessionTelemetryLimitExceededError(
        `DSH telemetry exceeds the on-disk byte bound (> ${limits.maxBytes} bytes across .jsonl/.jsonl.zstd files under sessions/)`
      );
    }
  };

  async function walkDir(dir: string): Promise<void> {
    const handle = await opendir(dir);
    try {
      for await (const entry of handle) {
        await visitEntry(join(dir, entry.name), entry.name, entry.isDirectory());
      }
    } finally {
      await closeDirQuietly(handle);
    }
  }

  try {
    for await (const entry of rootDir) {
      await visitEntry(join(sessionsDir, entry.name), entry.name, entry.isDirectory());
    }
  } finally {
    await closeDirQuietly(rootDir);
  }

  if (matched.length === 0) return null;
  matched.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return matched;
}

/**
 * The bounded replacement for `readRawSessionFiles()` on the Historical-PG
 * path (PR #210 review round 6): bounded discovery
 * (`discoverBoundedDshSessionFiles()`, Blocking 1/1a), then reads and
 * decodes each matching file with an explicit, shrinking decoded-byte
 * budget (Blocking 1b - `decodeZstdSessionLog()`'s own `maxOutputLength`,
 * which rejects a frame before fully materializing an oversized decoded
 * buffer, never after), and finally bounds the cumulative recovered event
 * count. Any limit violation throws `DshSessionTelemetryLimitExceededError`;
 * a genuine corruption error (invalid JSON, a malformed Zstandard frame)
 * propagates as whatever error `parseSessionLog()`/`decodeZstdSessionLog()`
 * already throws for it - both are left for the caller's own evidence
 * boundary to handle identically, exactly as `readRawSessionFiles()`'s
 * corruption errors already were before this round.
 *
 * Returns null under the same "nothing captured" condition as
 * `readRawSessionFiles()`.
 */
export async function readBoundedDshSessionTelemetry(
  dshHomeDir: string,
  limits: DshSessionTelemetryLimits
): Promise<Array<{ file: string; events: DshRawEvent[] }> | null> {
  const matched = await discoverBoundedDshSessionFiles(dshHomeDir, limits);
  if (matched === null) return null;

  let decodedBytesSoFar = 0;
  let eventsSoFar = 0;
  const sessions: Array<{ file: string; events: DshRawEvent[] }> = [];
  for (const file of matched) {
    const raw = await readFile(file.absolutePath);
    const remainingDecodedBudget = limits.maxDecodedBytes - decodedBytesSoFar;
    let text: string;
    if (file.relativePath.endsWith(".jsonl.zstd")) {
      text = decodeZstdSessionLog(raw, { maxOutputLength: Math.max(0, remainingDecodedBudget) });
    } else {
      if (raw.length > remainingDecodedBudget) {
        throw new DshSessionTelemetryLimitExceededError(
          `DSH telemetry exceeds the decoded-byte bound (> ${limits.maxDecodedBytes} bytes decoded across .jsonl/.jsonl.zstd files under sessions/)`
        );
      }
      text = raw.toString("utf8");
    }
    decodedBytesSoFar += Buffer.byteLength(text, "utf8");
    const events = parseSessionLog(text);
    eventsSoFar += events.length;
    if (eventsSoFar > limits.maxEvents) {
      throw new DshSessionTelemetryLimitExceededError(
        `DSH telemetry exceeds the recovered-event bound (> ${limits.maxEvents} events across .jsonl/.jsonl.zstd files under sessions/)`
      );
    }
    sessions.push({ file: file.relativePath, events });
  }
  return sessions;
}
