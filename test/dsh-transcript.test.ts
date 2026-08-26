import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { buildTranscriptLines, writeTranscript } from "../server/evals/dsh-transcript.js";
import type { DshRawEvent } from "../server/evals/dsh-session-stats.js";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("buildTranscriptLines: every raw event becomes one line, passed through unfiltered, in file order with a running seq", () => {
  const events: DshRawEvent[] = [
    { type: "step/start", time: 1000, data: { turn: 1, step: 1 } },
    { type: "tool/call", time: 1050, data: { turn: 1, step: 1, callId: "c1", name: "bash" } }
  ];
  const lines = buildTranscriptLines([{ file: "s.jsonl", events }]);
  assert.deepEqual(lines, [
    { seq: 1, ts: new Date(1000).toISOString(), session: "s.jsonl", type: "step/start", data: { turn: 1, step: 1 } },
    { seq: 2, ts: new Date(1050).toISOString(), session: "s.jsonl", type: "tool/call", data: { turn: 1, step: 1, callId: "c1", name: "bash" } }
  ]);
});

test("buildTranscriptLines: an event with no data becomes an empty object, never dropped", () => {
  const lines = buildTranscriptLines([{ file: "s.jsonl", events: [{ type: "turn/end", time: 2000 }] }]);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].data, {});
});

test("buildTranscriptLines: a leading `session` event (createdAt, no time/seq at all) doesn't throw - falls back to createdAt", () => {
  // The exact shape of a real session log's first line (confirmed against
  // clemenza/honeyrail#145's timeout-retry artifacts) - no `time` field at
  // all, unlike every other event kind.
  const events = [{ type: "session", version: 0, id: "session-abc", createdAt: 1787743598992, cwd: "/workspace", delegationDepth: 0 }] as unknown as DshRawEvent[];
  const lines = buildTranscriptLines([{ file: "s.jsonl", events }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ts, new Date(1787743598992).toISOString());
  assert.equal(lines[0].type, "session");
});

test("buildTranscriptLines: streaming-chunk events (reasoning-chunks/tool-call-chunks/text-chunks: seq0/time0, not seq/time) don't throw - falls back to time0", () => {
  const events = [
    { type: "reasoning-chunks", seq0: 13, time0: 1787743599437, data: { turn: 1, step: 1 } },
    { type: "tool-call-chunks", seq0: 28, time0: 1787743599661, data: { turn: 1, step: 1 } },
    { type: "text-chunks", seq0: 40, time0: 1787743599700, data: { turn: 1, step: 1 } }
  ] as unknown as DshRawEvent[];
  const lines = buildTranscriptLines([{ file: "s.jsonl", events }]);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].ts, new Date(1787743599437).toISOString());
  assert.equal(lines[1].ts, new Date(1787743599661).toISOString());
  assert.equal(lines[2].ts, new Date(1787743599700).toISOString());
});

test("buildTranscriptLines: an event with no time/time0/createdAt at all gets ts: null, not a thrown RangeError", () => {
  const events = [{ type: "mystery/event", data: {} }] as unknown as DshRawEvent[];
  const lines = buildTranscriptLines([{ file: "s.jsonl", events }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ts, null);
});

test("buildTranscriptLines: seq keeps incrementing across multiple session files, in readRawSessionFiles's sorted order", () => {
  const lines = buildTranscriptLines([
    { file: "a.jsonl", events: [{ type: "step/start", time: 0, data: {} }] },
    { file: "b.jsonl", events: [{ type: "step/end", time: 10, data: {} }] }
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].seq, 1);
  assert.equal(lines[0].session, "a.jsonl");
  assert.equal(lines[1].seq, 2);
  assert.equal(lines[1].session, "b.jsonl");
});

test("writeTranscript: returns null when dshHomeDir has no sessions/ directory at all", async (t) => {
  const dshHomeDir = await tempDir(t, "honeyrail-dsh-home-");
  const transcriptPath = join(await tempDir(t, "honeyrail-artifacts-"), "transcript.ndjson");
  assert.equal(await writeTranscript(dshHomeDir, transcriptPath), null);
});

test("writeTranscript: writes one ndjson line per raw session event, non-empty even for a session with only partial (pre-kill) events", async (t) => {
  const dshHomeDir = await tempDir(t, "honeyrail-dsh-home-");
  const artifactsDir = await tempDir(t, "honeyrail-artifacts-");
  const transcriptPath = join(artifactsDir, "transcript.ndjson");

  // Simulates what dsh's session-persistence plugin leaves on disk when a
  // trial is killed mid-run (#134/#136): only the events durably appended
  // before the kill, no trailing turn/end or final assistant/message.
  const sessionsDir = join(dshHomeDir, "sessions", "proj");
  await mkdir(sessionsDir, { recursive: true });
  const partialSession: DshRawEvent[] = [
    { type: "turn/start", time: 0, data: { turn: 1 } },
    { type: "step/start", time: 10, data: { turn: 1, step: 1 } },
    { type: "tool/call", time: 50, data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: '{"command":"ls"}' } }
    // no tool/result, no step/end - the kill landed here
  ];
  await writeFile(join(sessionsDir, "s.jsonl"), partialSession.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const count = await writeTranscript(dshHomeDir, transcriptPath);
  assert.equal(count, 3);

  const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].type, "turn/start");
  assert.equal(lines[2].type, "tool/call");
  assert.equal(lines[2].data.name, "bash");
});

test("writeTranscript: a real session log's leading `session` event (no time field) doesn't abort the whole write", async (t) => {
  const dshHomeDir = await tempDir(t, "honeyrail-dsh-home-");
  const artifactsDir = await tempDir(t, "honeyrail-artifacts-");
  const transcriptPath = join(artifactsDir, "transcript.ndjson");

  const sessionsDir = join(dshHomeDir, "sessions", "proj");
  await mkdir(sessionsDir, { recursive: true });
  // Every real session log starts with this exact shape (no `time`, just
  // `createdAt`) - before this fix, buildTranscriptLines threw on this very
  // first line, and executeCell's `.catch(() => null)` silently swallowed
  // it, so transcript.ndjson was never written by any real trial.
  const realisticSession = [
    { type: "session", version: 0, id: "session-abc", createdAt: 1000, cwd: "/workspace", delegationDepth: 0 },
    { type: "turn/start", seq: 1, time: 1010, data: { turn: 1 } }
  ] as unknown as DshRawEvent[];
  await writeFile(join(sessionsDir, "s.jsonl"), realisticSession.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const count = await writeTranscript(dshHomeDir, transcriptPath);
  assert.equal(count, 2);
  const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "session");
  assert.equal(lines[0].ts, new Date(1000).toISOString());
  assert.equal(lines[1].type, "turn/start");
});

test("writeTranscript: returns 0 (not null) when sessions/ exists but every session file is empty", async (t) => {
  const dshHomeDir = await tempDir(t, "honeyrail-dsh-home-");
  const artifactsDir = await tempDir(t, "honeyrail-artifacts-");
  const sessionsDir = join(dshHomeDir, "sessions", "proj");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "s.jsonl"), "");

  const count = await writeTranscript(dshHomeDir, join(artifactsDir, "transcript.ndjson"));
  assert.equal(count, 0);
});
