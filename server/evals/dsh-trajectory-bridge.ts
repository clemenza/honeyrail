/**
 * Derives `tool_call` and `shell_command` trajectory events (the two event
 * kinds vendor/tinytable-evals's `trajectory.py` schema documents as coming
 * from "whatever drives the agent" - see its module docstring, and
 * `trajectory_schema.json`, once clemenza/tinytable-evals#40 lands and this
 * repo's submodule pin picks it up) directly from dsh's own raw session
 * event log - the same log server/evals/dsh-session-stats.ts folds into
 * turn/step counters, read from the same `dshHomeDir` mount
 * (scripts/tinytable-exam-room.ts). This closes that gap without waiting on
 * the submodule bump: the written JSONL matches the documented schema
 * exactly (envelope `{seq, ts, kind}` plus each kind's fields), so once
 * `trajectory.py` *is* vendored, both writers target the same file/schema
 * with no format migration needed - trajectory.py's own docstring already
 * documents multiple independent writers appending to one log as the
 * expected shape (`seq` is per-writer, not globally unique).
 *
 * What this does NOT cover: `test_run` events (every `run_sql_tests.py`
 * invocation + result) still need `run_sql_tests.py --trajectory-log`
 * itself - only tinytable-evals's own code has the per-file failure/skip
 * breakdown that event carries, so that piece still depends on #40 landing
 * and this driver passing `--trajectory-log` through when it calls
 * `grade.py`. `file_diff`/`agent_snapshot` are equally derivable from this
 * driver's own filesystem access to the seed-root (see
 * `findManifestMismatches`'s post-run git check in scripts/dsh-evals-
 * demo.ts) but aren't produced here - out of this module's scope until
 * asked for.
 *
 * ## Provenance and confidence
 *
 * `tool/call`'s `{turn, step, callId, name, arguments}` and `tool/result`'s
 * `{turn, step, message, error?, meta?}` envelopes are taken verbatim from
 * `@deepseek-ai/dsh-session@0.1.0-rc.7`'s published `lib/types/types.d.ts`
 * (fetched from the npm registry) - the same session-log format
 * server/evals/dsh-session-stats.ts's fold already depends on, so this is
 * exactly as trustworthy as that.
 *
 * `bash` (dsh's built-in shell tool)'s tool name (`"bash"`, hardcoded) and
 * its argument shape (`command`, `description`, optional `timeoutMs`/
 * `workdir`/`run_in_background`) come from `@deepseek-ai/dsh-tool-
 * bash@0.1.0-rc.7`'s published `lib/index.js`. Its *result* shape
 * (`{exitCode, stdout: {text, ...}, stderr: {text, ...}, ...}`, via
 * `canonicalBashResult()`) is confirmed from the same source, but exactly
 * where that lands in the persisted `tool/result` event - `data.meta` is
 * the closest documented fit (the event type's own doc comment gives
 * `dsh-tool-fs`'s result-time diff as exactly this pattern) - was not
 * traced end to end through the tool-execution plumbing. `extractBashResult`
 * below is written defensively: it only emits a `shell_command` event when
 * it actually finds an object shaped like `canonicalBashResult()`'s output;
 * otherwise it emits nothing extra for that call rather than guessing at a
 * different location or fabricating a shape. The `tool_call` event for the
 * same call - built only from the always-verified `tool/call`/`tool/result`
 * envelope fields - is emitted unconditionally, so a bash call is never
 * dropped from the trajectory even when `shell_command` derivation misses.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { readRawSessionFiles, type DshRawEvent } from "./dsh-session-stats.js";

export type DerivedTrajectoryEvent = { seq: number; ts: string; kind: "tool_call" | "shell_command"; [field: string]: unknown };

const BASH_TOOL_NAME = "bash";

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // not valid JSON - pass the raw string through rather than drop it
  }
}

function isTextStream(value: unknown): value is { text: string } {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).text === "string";
}

/** True iff `value` is shaped like dsh-tool-bash's `canonicalBashResult()` output - see this module's docstring. */
function looksLikeBashResult(value: unknown): value is { exitCode: number; stdout: { text: string }; stderr: { text: string } } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.exitCode === "number" && isTextStream(v.stdout) && isTextStream(v.stderr);
}

function extractBashResult(resultData: Record<string, unknown>): { exitCode: number; stdout: string; stderr: string } | null {
  const meta = resultData.meta;
  if (looksLikeBashResult(meta)) {
    return { exitCode: meta.exitCode, stdout: meta.stdout.text, stderr: meta.stderr.text };
  }
  return null;
}

/**
 * One pass over a single session's raw events (in log order), pairing
 * `tool/call` with its `tool/result` by `callId` (same pairing
 * server/evals/dsh-session-stats.ts's `toolMs` fold uses) and emitting a
 * `tool_call` event per completed pair, plus a `shell_command` event for
 * every `bash`-tool pair whose result matches `extractBashResult`. A call
 * with no matching result (session ended mid-call) emits nothing for that
 * call - there is no result to report yet.
 */
export function deriveTrajectoryEvents(events: DshRawEvent[]): DerivedTrajectoryEvent[] {
  const out: DerivedTrajectoryEvent[] = [];
  let seq = 0;
  const pending = new Map<string, { name: string; input: unknown; time: number }>();

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "tool/call") {
      const callId = data.callId as string | undefined;
      if (callId !== undefined) {
        pending.set(callId, { name: data.name as string, input: parseArguments(data.arguments), time: event.time });
      }
      continue;
    }
    if (event.type !== "tool/result") continue;

    const message = data.message as Record<string, unknown> | undefined;
    const source = message?.source as Record<string, unknown> | undefined;
    const callId = source?.callId as string | undefined;
    if (callId === undefined) continue;
    const call = pending.get(callId);
    if (call === undefined) continue;
    pending.delete(callId);

    const durationMs = Math.max(0, event.time - call.time);
    const ts = new Date(event.time).toISOString();
    const errorInfo = data.error as { name: string; code: string } | undefined;

    seq += 1;
    out.push({
      seq, ts, kind: "tool_call",
      name: call.name,
      input: call.input,
      output: message ?? null,
      duration_ms: durationMs,
      error: errorInfo ? `${errorInfo.name}: ${errorInfo.code}` : null
    });

    if (call.name === BASH_TOOL_NAME) {
      const bashResult = extractBashResult(data);
      if (bashResult !== null) {
        const input = call.input as Record<string, unknown> | null;
        seq += 1;
        out.push({
          seq, ts, kind: "shell_command",
          command: input?.command ?? null,
          cwd: input?.workdir ?? null,
          exit_code: bashResult.exitCode,
          stdout: bashResult.stdout,
          stderr: bashResult.stderr,
          duration_ms: durationMs
        });
      }
    }
  }
  return out;
}

/**
 * Reads `${dshHomeDir}/sessions/**\/*.jsonl`(`.zstd`), derives tool_call/
 * shell_command events from each session file independently (in the same
 * filename order `readRawSessionFiles` returns), and appends them all to
 * `${seedRootDir}/trajectory.jsonl` - the same path/schema
 * `sample_trajectory.py` and `run_sql_tests.py --trajectory-log` write to
 * on the tinytable-evals side. Returns the count of events appended, or
 * null under the same "nothing captured" condition as `readSessionStats`
 * (never throws for that case - this is best-effort telemetry, not
 * something that should fail a trial).
 */
export async function appendDerivedTrajectoryEvents(dshHomeDir: string, seedRootDir: string): Promise<number | null> {
  const sessions = await readRawSessionFiles(dshHomeDir);
  if (sessions === null) return null;

  const lines: string[] = [];
  for (const { events } of sessions) {
    for (const event of deriveTrajectoryEvents(events)) {
      lines.push(JSON.stringify(event));
    }
  }
  if (lines.length === 0) return 0;

  await appendFile(join(seedRootDir, "trajectory.jsonl"), lines.join("\n") + "\n", "utf8");
  return lines.length;
}
