import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyKillAttribution,
  extractAssistantTextBlocks,
  extractOperatorTokens,
  findFirstClaim,
  findFirstOwnFailingTest,
  findFirstSourceRead,
  parseTranscript,
  scanForPatterns,
  type OperatorMeta
} from "../server/evals/kill-attribution.js";
import type { TranscriptLine } from "../server/evals/dsh-transcript.js";
import { deriveTrajectoryEvents } from "../server/evals/dsh-trajectory-bridge.js";
import type { DshRawEvent } from "../server/evals/dsh-session-stats.js";

function toolCall(seq: number, ts: string, turn: number, step: number, callId: string, name: string, args: Record<string, unknown>): TranscriptLine {
  return { seq, ts, session: "s.jsonl", type: "tool/call", data: { turn, step, callId, name, arguments: JSON.stringify(args) } };
}

function toolResultText(seq: number, ts: string, turn: number, step: number, callId: string, text: string): TranscriptLine {
  return { seq, ts, session: "s.jsonl", type: "tool/result", data: { turn, step, message: { source: { callId }, content: [{ type: "text", text }] } } };
}

// Real dsh 0.1.0-rc.7 bash tool/result shape (confirmed against real trial
// data, clemenza/honeyrail#150/#154) - no `meta` field at all, two levels
// of nested `content` (same generic `{type: "tool-result", content:
// [{type:"text",...}]}` envelope every other tool uses), no separate
// stdout/stderr split. `exitCode`/`stderr` accepted for call-site
// compatibility but unused - dsh doesn't expose a reliable exit-code
// signal here (see extractBashOutputText's own docstring).
function bashResult(seq: number, ts: string, turn: number, step: number, callId: string, opts: { exitCode: number; stdout: string; stderr?: string }): TranscriptLine {
  return {
    seq, ts, session: "s.jsonl", type: "tool/result",
    data: {
      turn, step,
      message: { source: { callId }, content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: opts.stdout }], isError: false }], role: "user" }
    }
  };
}

function assistantMessage(seq: number, ts: string, turn: number, step: number, blocks: Array<{ type: "reasoning" | "text"; text: string } | { type: "tool-call"; id: string; name: string; arguments: string }>): TranscriptLine {
  return { seq, ts, session: "s.jsonl", type: "assistant/message", data: { turn, step, message: { role: "assistant", content: blocks } } };
}

const OPERATOR: OperatorMeta = {
  id: "not-null-check-skipped-on-update",
  file: "sql.py",
  specSection: "Constraints: NOT NULL, CHECK, FOREIGN KEY",
  tokens: ["_check_not_null", "_check_check_constraints"],
  family: null
};

test("parseTranscript: parses ndjson lines back into TranscriptLine objects", () => {
  const text = `${JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00.000Z", session: "s", type: "turn/start", data: { turn: 1 } })}\n`;
  const lines = parseTranscript(text);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "turn/start");
});

test("parseTranscript: skips blank lines", () => {
  const text = `${JSON.stringify({ seq: 1, ts: null, session: "s", type: "a", data: {} })}\n\n${JSON.stringify({ seq: 2, ts: null, session: "s", type: "b", data: {} })}\n`;
  assert.equal(parseTranscript(text).length, 2);
});

test("extractAssistantTextBlocks: pulls reasoning and text blocks in order, skips tool-call blocks", () => {
  const lines: TranscriptLine[] = [
    assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [
      { type: "reasoning", text: "first thought" },
      { type: "tool-call", id: "c1", name: "bash", arguments: "{}" },
      { type: "text", text: "final answer" }
    ])
  ];
  const blocks = extractAssistantTextBlocks(lines);
  assert.deepEqual(blocks.map((b) => [b.kind, b.text]), [["reasoning", "first thought"], ["text", "final answer"]]);
});

test("extractAssistantTextBlocks: ignores blank/whitespace-only text", () => {
  const lines: TranscriptLine[] = [assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "   " }])];
  assert.equal(extractAssistantTextBlocks(lines).length, 0);
});

test("extractOperatorTokens: pulls identifier-shaped tokens, drops stopwords and short/numeric tokens", () => {
  const tokens = extractOperatorTokens("    def _check_not_null(self, table, row):\n        return self and None or 1234\n");
  assert.ok(tokens.includes("_check_not_null"));
  assert.ok(!tokens.includes("self"));
  assert.ok(!tokens.includes("None"));
  assert.ok(!tokens.some((t) => /^\d+$/.test(t)));
});

// --- leak / oracle-exploit scanning -----------------------------------------

test("scanForPatterns: finds a __pycache__ hit in a bash command's output", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "bash", { command: "ls -la tinytable" }),
    bashResult(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", { exitCode: 0, stdout: "core.py\n__pycache__\nsql.py\n" })
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  const hits = scanForPatterns(lines, derived, [{ name: "__pycache__", re: /__pycache__/ }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "output");
});

test("scanForPatterns: a `read` of .gitignore does not false-positive on its own __pycache__/*.pyc ignore-glob lines", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "read", { file_path: "/workspace/.gitignore" }),
    toolResultText(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", "__pycache__/\n*.pyc\n.pytest_cache/\n")
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  const hits = scanForPatterns(lines, derived, [{ name: "__pycache__", re: /__pycache__/ }, { name: ".pyc", re: /\.pyc\b/ }]);
  assert.equal(hits.length, 0);
});

test("scanForPatterns: a `read` of run_sql_tests.py does not false-positive on its own docstring's abstract description of the grading methodology", () => {
  // Confirmed against real trial data (clemenza/honeyrail#150's clean
  // re-run): run_sql_tests.py's own docstring explains "clean/ is...the
  // sole arbiter of correct behavior", mentions "golden" test files, and
  // says it "mirrors score.py's own...design" - every trial that reads
  // this sanctioned, task-prompt.md-mandated file (nearly all of them)
  // hit all three oracle-exploit patterns from that read alone.
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "read", { file_path: "/workspace/run_sql_tests.py" }),
    toolResultText(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", "clean/ is the sole arbiter of correct behavior. See golden test files. Mirrors score.py's own design.")
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  const hits = scanForPatterns(lines, derived, [
    { name: "clean/", re: /\bclean\// },
    { name: "golden", re: /\bgolden\b/ },
    { name: "score.py", re: /\bscore\.py\b/ }
  ]);
  assert.equal(hits.length, 0);
});

test("scanForPatterns: a `read` of SPEC.md does not false-positive on its own explanation of the grading methodology", () => {
  // Confirmed against real trial data (clemenza/honeyrail#150's clean
  // re-run): SPEC.md itself - mandatory reading, it's the task - explains
  // "clean/ is...the sole arbiter of correct behavior" and mentions
  // "golden" test files. Every single trial reads SPEC.md, so without this
  // exclusion, oracle-exploit fires on literally every trial regardless of
  // anything the agent actually did.
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "read", { file_path: "/workspace/SPEC.md" }),
    toolResultText(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", "clean/ is the sole arbiter of correct behavior. See golden test files.")
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  const hits = scanForPatterns(lines, derived, [{ name: "clean/", re: /\bclean\// }, { name: "golden", re: /\bgolden\b/ }]);
  assert.equal(hits.length, 0);
});

test("scanForPatterns: a `read` of a different file still gets scanned even if it happens to end in a similar name", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "read", { file_path: "/workspace/tinytable/__pycache__/sql.cpython-310.pyc" }),
    toolResultText(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", "binary garbage with source_size embedded")
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  const hits = scanForPatterns(lines, derived, [{ name: "source_size", re: /\bsource_size\b/ }]);
  assert.equal(hits.length, 1);
});

test("scanForPatterns: finds a hit in assistant reasoning text too, not just tool events", () => {
  const lines: TranscriptLine[] = [assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "let me check git log for history" }])];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  const hits = scanForPatterns(lines, derived, [{ name: "git log/diff/show", re: /\bgit\s+(?:log|diff|show)\b/ }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "text");
});

// --- source-read / own-failing-test ------------------------------------------

test("findFirstSourceRead: a `read` of tinytable/sql.py is detected", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "read", { file_path: "/workspace/tinytable/sql.py" }),
    toolResultText(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", "... source ...")
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  assert.notEqual(findFirstSourceRead(derived), null);
});

test("findFirstSourceRead: a bash `cat` of tinytable/core.py is detected", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "bash", { command: "cat tinytable/core.py" }),
    bashResult(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", { exitCode: 0, stdout: "... source ..." })
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  assert.notEqual(findFirstSourceRead(derived), null);
});

test("findFirstSourceRead: reading SPEC.md alone does not count", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "read", { file_path: "/workspace/SPEC.md" }),
    toolResultText(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", "... spec ...")
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  assert.equal(findFirstSourceRead(derived), null);
});

test("findFirstOwnFailingTest: a run_sql_tests.py invocation against sql-tests/agent/*.test that FAILs is detected", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/agent/mytest.test" }),
    bashResult(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", { exitCode: 1, stdout: "FAIL sql-tests/agent/mytest.test (1 failure(s))\n" })
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  assert.notEqual(findFirstOwnFailingTest(derived), null);
});

test("findFirstOwnFailingTest: a bare `sql-tests/agent` directory invocation (no specific filename) is detected too", () => {
  // Confirmed against real trials (clemenza/honeyrail#150's clean re-run):
  // `python3 run_sql_tests.py --root . sql-tests/agent` (letting the
  // runner discover every .test file itself) is the dominant real
  // invocation style, not a specific filename - a regex requiring one
  // missed every real self-verification run.
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/agent" }),
    bashResult(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", { exitCode: 1, stdout: "FAIL sql-tests/agent/mytest.test (1 failure(s))\n" })
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  assert.notEqual(findFirstOwnFailingTest(derived), null);
});

test("findFirstOwnFailingTest: a passing run of the agent's own test is not a failing test", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/agent/mytest.test" }),
    bashResult(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", { exitCode: 0, stdout: "ok   sql-tests/agent/mytest.test\n\nall 1 file(s) passed\n" })
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  assert.equal(findFirstOwnFailingTest(derived), null);
});

test("findFirstOwnFailingTest: running the official suite (not sql-tests/agent/) does not count, even if it fails", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/official" }),
    bashResult(2, "2026-01-01T00:00:00.100Z", 1, 1, "c1", { exitCode: 1, stdout: "FAIL sql-tests/official/foo.test (1 failure(s))\n" })
  ];
  const derived = deriveTrajectoryEvents(lines.map(toRaw));
  assert.equal(findFirstOwnFailingTest(derived), null);
});

// --- bug-claim detection ------------------------------------------------------

test("findFirstClaim: matches a generic defect-assertion phrase", () => {
  const lines: TranscriptLine[] = [assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "This looks correct so far." }, { type: "reasoning", text: "Wait, this is a bug: UPDATE skips the NOT NULL check." }])];
  const claim = findFirstClaim(lines, null);
  assert.notEqual(claim, null);
  assert.equal(claim?.matchedBy, "generic");
});

test("findFirstClaim: matches via the operator's spec_section when no generic phrase is present", () => {
  const lines: TranscriptLine[] = [assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "Reading through the Constraints: NOT NULL, CHECK, FOREIGN KEY section carefully now." }])];
  const claim = findFirstClaim(lines, OPERATOR);
  assert.equal(claim?.matchedBy, "spec-section");
});

test("findFirstClaim: matches via an operator token (mutated function name) when no other signal fires", () => {
  const lines: TranscriptLine[] = [assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "Tracing through _check_not_null to see what it validates." }])];
  const claim = findFirstClaim(lines, OPERATOR);
  assert.equal(claim?.matchedBy, "token");
  assert.equal(claim?.token, "_check_not_null");
});

test("findFirstClaim: returns null when nothing matches", () => {
  const lines: TranscriptLine[] = [assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "Let me look at the schema first." }])];
  assert.equal(findFirstClaim(lines, null), null);
});

// --- full classification ------------------------------------------------------

function toRaw(line: TranscriptLine): DshRawEvent {
  return { type: line.type, time: line.ts ? Date.parse(line.ts) : 0, data: line.data };
}

test("classifyKillAttribution: test-driven - own test fails, then the agent explains why", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "write", { file_path: "/workspace/sql-tests/agent/nn.test", content: "..." }),
    toolResultText(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", "ok"),
    toolCall(3, "2026-01-01T00:00:01.000Z", 1, 2, "c2", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/agent/nn.test" }),
    bashResult(4, "2026-01-01T00:00:01.100Z", 1, 2, "c2", { exitCode: 1, stdout: "FAIL sql-tests/agent/nn.test (1 failure(s))\n" }),
    assistantMessage(5, "2026-01-01T00:00:02.000Z", 1, 3, [{ type: "reasoning", text: "My test failed - this confirms a bug: UPDATE isn't re-checking NOT NULL." }])
  ];
  const result = classifyKillAttribution(lines, null);
  assert.equal(result.channel, "test-driven");
});

test("classifyKillAttribution: code-review - source read, bug claimed in reasoning, confirming test written after", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "read", { file_path: "/workspace/tinytable/sql.py" }),
    toolResultText(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", "... source ..."),
    assistantMessage(3, "2026-01-01T00:00:01.000Z", 1, 2, [{ type: "reasoning", text: "Looking at this code, UPDATE skips the NOT NULL check - this is a bug." }]),
    toolCall(4, "2026-01-01T00:00:02.000Z", 1, 3, "c2", "write", { file_path: "/workspace/sql-tests/agent/nn.test", content: "..." }),
    toolResultText(5, "2026-01-01T00:00:02.050Z", 1, 3, "c2", "ok"),
    toolCall(6, "2026-01-01T00:00:03.000Z", 1, 4, "c3", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/agent/nn.test" }),
    bashResult(7, "2026-01-01T00:00:03.100Z", 1, 4, "c3", { exitCode: 1, stdout: "FAIL sql-tests/agent/nn.test (1 failure(s))\n" })
  ];
  const result = classifyKillAttribution(lines, null);
  assert.equal(result.channel, "code-review");
});

test("classifyKillAttribution: black-box-reasoning - a claim with neither a source read nor an own failing test before it", () => {
  const lines: TranscriptLine[] = [
    assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "Based on the behavior I'm seeing via ad-hoc queries, I suspect this is a bug in how UPDATE handles constraints." }])
  ];
  const result = classifyKillAttribution(lines, null);
  assert.equal(result.channel, "black-box-reasoning");
});

test("classifyKillAttribution: leak - a __pycache__ hit before the claim invalidates the trial, even with a real failing test", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "bash", { command: "ls -la tinytable" }),
    bashResult(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", { exitCode: 0, stdout: "core.py\n__pycache__\nsql.py\n" }),
    toolCall(3, "2026-01-01T00:00:01.000Z", 1, 2, "c2", "write", { file_path: "/workspace/sql-tests/agent/nn.test", content: "..." }),
    toolResultText(4, "2026-01-01T00:00:01.050Z", 1, 2, "c2", "ok"),
    toolCall(5, "2026-01-01T00:00:02.000Z", 1, 3, "c3", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/agent/nn.test" }),
    bashResult(6, "2026-01-01T00:00:02.100Z", 1, 3, "c3", { exitCode: 1, stdout: "FAIL sql-tests/agent/nn.test (1 failure(s))\n" }),
    assistantMessage(7, "2026-01-01T00:00:03.000Z", 1, 4, [{ type: "reasoning", text: "Confirmed a bug in UPDATE's NOT NULL handling." }])
  ];
  const result = classifyKillAttribution(lines, null);
  assert.equal(result.channel, "leak");
  assert.ok(result.leakHits.length >= 1);
});

test("classifyKillAttribution: oracle-exploit - a 'golden'/'clean/' mention before the claim, with no hard-leak pattern", () => {
  const lines: TranscriptLine[] = [
    assistantMessage(1, "2026-01-01T00:00:00.000Z", 1, 1, [{ type: "reasoning", text: "SPEC.md explains clean/ is the reference implementation used for grading." }]),
    assistantMessage(2, "2026-01-01T00:00:01.000Z", 1, 2, [{ type: "reasoning", text: "Confirmed a bug in UPDATE's NOT NULL handling." }])
  ];
  const result = classifyKillAttribution(lines, null);
  assert.equal(result.channel, "oracle-exploit");
});

test("classifyKillAttribution: unattributable - killed but no claim was ever articulated in reasoning text", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "write", { file_path: "/workspace/sql-tests/agent/nn.test", content: "..." }),
    toolResultText(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", "ok")
  ];
  const result = classifyKillAttribution(lines, null);
  assert.equal(result.channel, "unattributable");
  assert.equal(result.claim, null);
});

test("classifyKillAttribution: a leak hit AFTER the claim does not retroactively invalidate a test-driven kill", () => {
  const lines: TranscriptLine[] = [
    toolCall(1, "2026-01-01T00:00:00.000Z", 1, 1, "c1", "write", { file_path: "/workspace/sql-tests/agent/nn.test", content: "..." }),
    toolResultText(2, "2026-01-01T00:00:00.050Z", 1, 1, "c1", "ok"),
    toolCall(3, "2026-01-01T00:00:01.000Z", 1, 2, "c2", "bash", { command: "python3 run_sql_tests.py --root . sql-tests/agent/nn.test" }),
    bashResult(4, "2026-01-01T00:00:01.100Z", 1, 2, "c2", { exitCode: 1, stdout: "FAIL sql-tests/agent/nn.test (1 failure(s))\n" }),
    assistantMessage(5, "2026-01-01T00:00:02.000Z", 1, 3, [{ type: "reasoning", text: "My test failed - this confirms a bug: UPDATE isn't re-checking NOT NULL." }]),
    toolCall(6, "2026-01-01T00:00:03.000Z", 1, 4, "c3", "bash", { command: "ls -la tinytable" }),
    bashResult(7, "2026-01-01T00:00:03.050Z", 1, 4, "c3", { exitCode: 0, stdout: "core.py\n__pycache__\nsql.py\n" })
  ];
  const result = classifyKillAttribution(lines, null);
  assert.equal(result.channel, "test-driven");
});
