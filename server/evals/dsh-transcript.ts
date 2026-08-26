/**
 * Writes a per-trial transcript that survives a `--trial-timeout-minutes`
 * kill (#140). #134/#136 documented 6/115 trials (5.2%) timing out with an
 * empty `container.log`: `dsh --profile headless` only prints its
 * human-readable output once, at the very end of the run, so a mid-loop
 * `docker kill` (scripts/tinytable-exam-room.ts's `runInExamRoom`) leaves
 * nothing in the stdout/stderr scripts/dsh-evals-demo.ts's `executeCell`
 * captures for `container.log` - a timed-out trial's transcript was a total
 * loss for debugging.
 *
 * dsh's own `@deepseek-ai/dsh-session-persistence-jsonl` plugin, however,
 * already appends each raw session event to
 * `$DSH_HOME/sessions/**\/*.jsonl`(`.zstd`) *as the trial runs* - the same
 * log server/evals/dsh-session-stats.ts folds into turn/step telemetry and
 * server/evals/dsh-trajectory-bridge.ts derives tool_call/shell_command
 * events from. Because `dshHomeDir` is a host bind mount (not the
 * container's ephemeral, `--rm`-destroyed tmpfs $HOME - see
 * scripts/tinytable-exam-room.ts's `dshHomeDir` option), whatever dsh wrote
 * before a kill is already durable on disk by the time this runs: this is
 * exactly why `33-baseline-4`'s `session-stats.json` survived its timeout
 * (#134) even though its `container.log` didn't. So there is no real-time
 * streaming to build here - the source is already incremental; this module
 * just needs to persist it as a per-trial artifact instead of leaving it
 * buried inside `dshHomeDir`.
 *
 * Each raw event is written through unfiltered, one JSON line per event,
 * rather than reassembled into a curated conversational transcript:
 * `tool/call`/`tool/result`'s envelope shape is confirmed from
 * `@deepseek-ai/dsh-session@0.1.0-rc.7`'s published types (see
 * dsh-trajectory-bridge.ts's provenance note), but `assistant/message`'s
 * actual assembled-text field was never traced end to end, so guessing at
 * it here would risk silently misrepresenting the transcript instead of
 * just passing it through verbatim and letting a reader interpret it.
 */

import { writeFile } from "node:fs/promises";
import { readRawSessionFiles, type DshRawEvent } from "./dsh-session-stats.js";

export type TranscriptLine = { seq: number; ts: string | null; session: string; type: string; data: Record<string, unknown> };

// `DshRawEvent.time` is declared as always-present because
// dsh-session-stats.ts's foldSessionStats only ever switches on event kinds
// that do carry it - that invariant doesn't hold across the *full* raw
// stream this module reads unfiltered. The leading `session` event (no
// `seq`/`time` at all, just `createdAt`) and dsh's un-coalesced streaming
// envelopes (`reasoning-chunks`/`tool-call-chunks`/`text-chunks`, which use
// `seq0`/`time0` instead of `seq`/`time` - confirmed against a real session
// log while investigating clemenza/honeyrail#145's timeout retries) have no
// `.time` at all, so `new Date(event.time).toISOString()` threw
// `RangeError: Invalid time value` on the first line of every real session
// - silently swallowed by executeCell's `.catch(() => null)`, so
// transcript.ndjson was never actually written by any trial since #140
// landed. Falls back through the other timestamp-shaped fields a raw event
// might carry; `null` (not a fabricated guess) when none of them parse.
function eventTimestamp(event: DshRawEvent): string | null {
  const raw = event as unknown as { time0?: unknown; createdAt?: unknown };
  for (const candidate of [event.time, raw.time0, raw.createdAt]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return new Date(candidate).toISOString();
  }
  return null;
}

/** Pure: flattens every session's raw events (in readRawSessionFiles's file order) into one ordered, replayable line list. */
export function buildTranscriptLines(sessions: Array<{ file: string; events: DshRawEvent[] }>): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let seq = 0;
  for (const { file, events } of sessions) {
    for (const event of events) {
      seq += 1;
      lines.push({ seq, ts: eventTimestamp(event), session: file, type: event.type, data: event.data ?? {} });
    }
  }
  return lines;
}

/**
 * Reads `${dshHomeDir}/sessions/**\/*.jsonl`(`.zstd`) and writes
 * `transcriptPath` as newline-delimited JSON (one line per raw session
 * event, in file order) - non-empty even for a trial killed mid-run, since
 * the source log is already durable at kill time (see this module's
 * docstring). Returns the line count written, or null under the same
 * "nothing captured" condition as readSessionStats (the mount didn't work,
 * or this dsh version doesn't ship the session-persistence plugin) -
 * best-effort, same as readSessionStats/appendDerivedTrajectoryEvents: this
 * must never fail a trial, only omit the artifact.
 */
export async function writeTranscript(dshHomeDir: string, transcriptPath: string): Promise<number | null> {
  const sessions = await readRawSessionFiles(dshHomeDir);
  if (sessions === null) return null;
  const lines = buildTranscriptLines(sessions);
  if (lines.length === 0) return 0;
  await writeFile(transcriptPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  return lines.length;
}
