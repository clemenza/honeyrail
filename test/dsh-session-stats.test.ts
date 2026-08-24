import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  decodeZstdSessionLog,
  foldSessionStats,
  parseSessionLog,
  readSessionStats,
  type DshRawEvent
} from "../server/evals/dsh-session-stats.js";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

// One turn, one step: step/start -> a token delta (first token) -> a
// heartbeat/empty delta (must not reset firstTokenTime) -> assistant/
// message with usage.outputTokens -> step/end. Exercises llmMs, ttftMs/
// ttftSteps, and decodeMs/decodeTokens all at once against hand-computed
// wall times, matching @deepseek-ai/dsh-session-stats@0.1.0-rc.7's fold.
test("foldSessionStats: one message-assembling step folds llmMs/ttftMs/decodeMs/decodeTokens correctly", () => {
  const events: DshRawEvent[] = [
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", time: 1000, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "" } } }, // empty delta: not a token
    { type: "assistant/chunk", time: 1100, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "Hi" } } }, // first real token
    { type: "assistant/chunk", time: 1150, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: " there" } } }, // must not move firstTokenTime
    { type: "assistant/message", time: 1400, data: { turn: 1, step: 1, usage: { outputTokens: 12 } } },
    { type: "step/end", time: 1400, data: { turn: 1 } }
  ];
  const stats = foldSessionStats(events);
  assert.deepEqual(stats, {
    turns: 1,
    steps: 1,
    llmMs: 400, // 1400 - 1000
    toolMs: 0,
    ttftMs: 100, // 1100 - 1000
    ttftSteps: 1,
    decodeMs: 300, // 1400 - 1100
    decodeTokens: 12
  });
});

// Two steps in the same turn count as exactly one turn (turns increments
// only when data.turn *changes* from the last counted step/end); a second
// turn increments it again.
test("foldSessionStats: turns counts distinct turn values, not step/end events", () => {
  const events: DshRawEvent[] = [
    { type: "step/start", time: 0, data: { turn: 1, step: 1 } },
    { type: "assistant/message", time: 10, data: { turn: 1, step: 1 } },
    { type: "step/end", time: 10, data: { turn: 1 } },
    { type: "step/start", time: 20, data: { turn: 1, step: 2 } },
    { type: "assistant/message", time: 30, data: { turn: 1, step: 2 } },
    { type: "step/end", time: 30, data: { turn: 1 } },
    { type: "step/start", time: 40, data: { turn: 2, step: 1 } },
    { type: "assistant/message", time: 50, data: { turn: 2, step: 1 } },
    { type: "step/end", time: 50, data: { turn: 2 } }
  ];
  const stats = foldSessionStats(events);
  assert.equal(stats.turns, 2);
  assert.equal(stats.steps, 3);
});

// A cancelled step (no assistant/message ever assembles) contributes no
// llmMs/ttftMs/decodeMs, matching the client window fold's "untimed
// interrupted node" - but its step/end still counts toward steps/turns.
test("foldSessionStats: a cancelled step (no assistant/message) is counted but untimed", () => {
  const events: DshRawEvent[] = [
    { type: "step/start", time: 0, data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", time: 50, data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "partial" } } },
    { type: "step/end", time: 100, data: { turn: 1 } } // cancelled: no assistant/message
  ];
  const stats = foldSessionStats(events);
  assert.deepEqual(stats, { turns: 1, steps: 1, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
});

// tool/call -> tool/result pairs (matched by callId, nested under
// data.message.source.callId on the result) sum into toolMs; a call still
// pending when its turn ends is dropped, not counted.
test("foldSessionStats: toolMs pairs tool/call -> tool/result by callId, drops unresolved calls at turn/end", () => {
  const events: DshRawEvent[] = [
    { type: "step/start", time: 0, data: { turn: 1, step: 1 } },
    { type: "tool/call", time: 100, data: { callId: "a" } },
    { type: "tool/call", time: 120, data: { callId: "b" } },
    { type: "tool/result", time: 250, data: { message: { source: { callId: "a" } } } }, // a: 150ms
    { type: "step/end", time: 250, data: { turn: 1 } },
    { type: "turn/end", time: 260, data: {} } // b never resolved - dropped here, not counted
  ];
  const stats = foldSessionStats(events);
  assert.equal(stats.toolMs, 150);
});

test("parseSessionLog: one JSON object per line, tolerant of a trailing blank line", () => {
  const text = '{"type":"step/start","time":0,"data":{"turn":1,"step":1}}\n{"type":"step/end","time":5,"data":{"turn":1}}\n';
  const events = parseSessionLog(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "step/start");
  assert.equal(events[1].type, "step/end");
});

test("readSessionStats: sums independently-folded per-session files, returns null when nothing was captured", async (t) => {
  const dshHomeDir = await tempDir(t, "honeyrail-dsh-home-");

  assert.equal(await readSessionStats(dshHomeDir), null, "no sessions/ dir at all");

  const sessionsDir = join(dshHomeDir, "sessions", "proj");
  await mkdir(sessionsDir, { recursive: true });
  const sessionA = [
    { type: "step/start", time: 0, data: { turn: 1, step: 1 } },
    { type: "assistant/message", time: 100, data: { turn: 1, step: 1 } },
    { type: "step/end", time: 100, data: { turn: 1 } }
  ];
  const sessionB = [
    { type: "step/start", time: 0, data: { turn: 1, step: 1 } },
    { type: "assistant/message", time: 50, data: { turn: 1, step: 1 } },
    { type: "step/end", time: 50, data: { turn: 1 } },
    { type: "step/start", time: 60, data: { turn: 2, step: 1 } },
    { type: "assistant/message", time: 90, data: { turn: 2, step: 1 } },
    { type: "step/end", time: 90, data: { turn: 2 } }
  ];
  await writeFile(join(sessionsDir, "a.jsonl"), sessionA.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(sessionsDir, "b.jsonl"), sessionB.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const report = await readSessionStats(dshHomeDir);
  assert.ok(report);
  assert.equal(report!.sessions.length, 2);
  // Summed independently, not concatenated: if the two sessions' turn=1
  // events were folded together instead, this would read turns=2 (a's
  // turn 1 + b's turn 2, with b's own turn 1 miscounted as a repeat) or
  // similar corruption - summing each session's own {turns:1} and
  // {turns:2} views is the only way to land on exactly 3.
  assert.equal(report!.aggregate.turns, 3);
  assert.equal(report!.aggregate.steps, 3);
  assert.equal(report!.aggregate.llmMs, 100 + 50 + 30);
});

// @deepseek-ai/dsh-session-persistence-jsonl's DEFAULT_COMPRESSION is
// "zstd" - every real trial's session log is a *concatenated-frame*
// Zstandard container (one frame per durable event batch appended), not a
// single stream. node:zlib's one-shot zstdDecompressSync only decodes the
// first frame of a multi-frame buffer and silently drops the rest, so a
// naive `zstdDecompressSync(wholeFile)` would recover only the header line.
test("decodeZstdSessionLog: recovers every appended frame, not just the first", () => {
  const frameA = zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'));
  const frameB = zstdCompressSync(Buffer.from('{"type":"step/start","time":0,"data":{"turn":1,"step":1}}\n'));
  const frameC = zstdCompressSync(Buffer.from('{"type":"step/end","time":5,"data":{"turn":1}}\n'));
  const concatenated = Buffer.concat([frameA, frameB, frameC]);

  // Sanity check the exact failure mode this ports around: the naive
  // one-shot call really does drop everything past the first frame.
  assert.equal(zstdDecompressSync(concatenated).toString("utf8"), '{"type":"session","id":"s1"}\n');

  const text = decodeZstdSessionLog(concatenated);
  const events = parseSessionLog(text);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ["session", "step/start", "step/end"]
  );
});

test("decodeZstdSessionLog: a torn/incomplete final frame is dropped, not thrown on", () => {
  const frameA = zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'));
  const frameB = zstdCompressSync(Buffer.from('{"type":"step/end","time":5,"data":{"turn":1}}\n'));
  const torn = Buffer.concat([frameA, frameB.subarray(0, Math.floor(frameB.length / 2))]);

  const text = decodeZstdSessionLog(torn);
  const events = parseSessionLog(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "session");
});

test("decodeZstdSessionLog: rejects a buffer that isn't a Zstandard frame at all", () => {
  assert.throws(() => decodeZstdSessionLog(Buffer.from("not zstd")), /corrupt Zstandard session log/);
});

test("readSessionStats: reads a real .jsonl.zstd session log (dsh's default compression), matching a .jsonl sibling's stats", async (t) => {
  const dshHomeDir = await tempDir(t, "honeyrail-dsh-home-zstd-");
  const sessionsDir = join(dshHomeDir, "sessions", "proj");
  await mkdir(sessionsDir, { recursive: true });

  const events = [
    { type: "step/start", time: 0, data: { turn: 1, step: 1 } },
    { type: "assistant/message", time: 40, data: { turn: 1, step: 1 } },
    { type: "step/end", time: 40, data: { turn: 1 } }
  ];
  // dsh's own writer appends one Zstandard frame per event batch - split
  // across two frames here to also exercise multi-frame concatenation.
  const frame1 = zstdCompressSync(Buffer.from(events.slice(0, 2).map((e) => JSON.stringify(e)).join("\n") + "\n"));
  const frame2 = zstdCompressSync(Buffer.from(JSON.stringify(events[2]) + "\n"));
  await writeFile(join(sessionsDir, "session.jsonl.zstd"), Buffer.concat([frame1, frame2]));

  const report = await readSessionStats(dshHomeDir);
  assert.ok(report, "a .jsonl.zstd-only sessions/ dir must not read back as null");
  assert.equal(report!.sessions.length, 1);
  assert.equal(report!.sessions[0]!.file, join("proj", "session.jsonl.zstd"));
  assert.deepEqual(report!.aggregate, { turns: 1, steps: 1, llmMs: 40, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 });
});
