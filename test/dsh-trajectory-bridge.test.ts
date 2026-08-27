import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { appendDerivedTrajectoryEvents, deriveTrajectoryEvents } from "../server/evals/dsh-trajectory-bridge.js";
import type { DshRawEvent } from "../server/evals/dsh-session-stats.js";

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("deriveTrajectoryEvents: a generic tool call becomes exactly one tool_call event", () => {
  const events: DshRawEvent[] = [
    { type: "tool/call", time: 1000, data: { turn: 1, step: 1, callId: "c1", name: "read_file", arguments: '{"path":"SPEC.md"}' } },
    { type: "tool/result", time: 1050, data: { turn: 1, step: 1, message: { source: { callId: "c1" }, content: "file contents" } } }
  ];
  const derived = deriveTrajectoryEvents(events);
  assert.equal(derived.length, 1);
  assert.deepEqual(derived[0], {
    seq: 1,
    ts: new Date(1050).toISOString(),
    kind: "tool_call",
    name: "read_file",
    input: { path: "SPEC.md" },
    output: { source: { callId: "c1" }, content: "file contents" },
    duration_ms: 50,
    error: null
  });
});

test("deriveTrajectoryEvents: a bash tool call with a real dsh 0.1.0-rc.7 tool-result envelope yields both tool_call and shell_command", () => {
  // Real shape, confirmed against real trial data (clemenza/honeyrail#154):
  // no `meta` field, `message.content[0]` is `{type: "tool-result",
  // toolCallId, content: [{type:"text", text}], isError}` - the same
  // generic envelope every other tool uses, one combined text blob (no
  // stdout/stderr split, no usable exit-code signal).
  const events: DshRawEvent[] = [
    {
      type: "tool/call", time: 2000,
      data: { turn: 1, step: 1, callId: "c2", name: "bash", arguments: '{"command":"python3 run_sql_tests.py --root . sql-tests/official","description":"run the official suite","workdir":"/workspace"}' }
    },
    {
      type: "tool/result", time: 2400,
      data: {
        turn: 1, step: 1,
        message: {
          source: { callId: "c2" },
          content: [{ type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "all 17 file(s) passed\n" }], isError: false }],
          role: "user"
        }
      }
    }
  ];
  const derived = deriveTrajectoryEvents(events);
  assert.equal(derived.length, 2);
  assert.equal(derived[0].kind, "tool_call");
  assert.equal(derived[0].name, "bash");
  assert.deepEqual(derived[1], {
    seq: 2,
    ts: new Date(2400).toISOString(),
    kind: "shell_command",
    command: "python3 run_sql_tests.py --root . sql-tests/official",
    cwd: "/workspace",
    exit_code: null,
    stdout: "all 17 file(s) passed\n",
    stderr: null,
    duration_ms: 400
  });
});

test("deriveTrajectoryEvents: a bash call whose result doesn't match the real tool-result shape still yields tool_call, degrades gracefully (no shell_command)", () => {
  const events: DshRawEvent[] = [
    { type: "tool/call", time: 3000, data: { turn: 1, step: 1, callId: "c3", name: "bash", arguments: '{"command":"ls","description":"list files"}' } },
    // content[0].type isn't "tool-result" - some other envelope shape entirely (e.g. a background-job acknowledgement)
    { type: "tool/result", time: 3010, data: { turn: 1, step: 1, message: { source: { callId: "c3" }, content: [{ type: "background-ack", jobId: "j1" }] } } }
  ];
  const derived = deriveTrajectoryEvents(events);
  assert.equal(derived.length, 1);
  assert.equal(derived[0].kind, "tool_call");
  assert.equal(derived[0].name, "bash");
});

test("deriveTrajectoryEvents: a tool/call with no matching tool/result (session ended mid-call) emits nothing for it", () => {
  const events: DshRawEvent[] = [
    { type: "tool/call", time: 4000, data: { turn: 1, step: 1, callId: "c4", name: "bash", arguments: '{"command":"sleep 999","description":"never finishes"}' } }
  ];
  assert.deepEqual(deriveTrajectoryEvents(events), []);
});

test("deriveTrajectoryEvents: unparseable arguments are passed through as a raw string rather than dropped", () => {
  const events: DshRawEvent[] = [
    { type: "tool/call", time: 5000, data: { turn: 1, step: 1, callId: "c5", name: "weird_tool", arguments: "not json" } },
    { type: "tool/result", time: 5010, data: { turn: 1, step: 1, message: { source: { callId: "c5" } } } }
  ];
  const derived = deriveTrajectoryEvents(events);
  assert.equal(derived[0].input, "not json");
});

test("appendDerivedTrajectoryEvents: appends derived events into <seedRootDir>/trajectory.jsonl, returns null when nothing was captured", async (t) => {
  const dshHomeDir = await tempDir(t, "honeyrail-dsh-home-");
  const seedRootDir = await tempDir(t, "honeyrail-seed-root-");

  assert.equal(await appendDerivedTrajectoryEvents(dshHomeDir, seedRootDir), null, "no sessions/ dir at all");

  const sessionsDir = join(dshHomeDir, "sessions", "proj");
  await mkdir(sessionsDir, { recursive: true });
  const session = [
    { type: "tool/call", time: 0, data: { turn: 1, step: 1, callId: "a", name: "read_file", arguments: "{}" } },
    { type: "tool/result", time: 10, data: { turn: 1, step: 1, message: { source: { callId: "a" } } } }
  ];
  await writeFile(join(sessionsDir, "s.jsonl"), session.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // A pre-existing trajectory.jsonl (as sample_trajectory.py or run_sql_tests.py --trajectory-log would have already written) must be appended to, not clobbered.
  const trajectoryPath = join(seedRootDir, "trajectory.jsonl");
  await writeFile(trajectoryPath, JSON.stringify({ seq: 1, ts: "2026-08-24T00:00:00.000Z", kind: "test_run" }) + "\n");

  const appended = await appendDerivedTrajectoryEvents(dshHomeDir, seedRootDir);
  assert.equal(appended, 1);

  const lines = (await readFile(trajectoryPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).kind, "test_run");
  assert.equal(JSON.parse(lines[1]).kind, "tool_call");
});
