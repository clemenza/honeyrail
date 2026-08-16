import assert from "node:assert/strict";
import { test } from "node:test";

import { replayTerminalLog } from "../server/session-helpers.js";

// Issue #45: the dead-session log fallback used to replay the raw
// `pipe-pane -o` byte stream through a regex heuristic (stripAnsi) instead
// of real terminal emulation. Once two redraw frames genuinely overwrite the
// same screen cells in that raw stream, no amount of pattern matching can
// recover the "correct" final line - only replaying the bytes through an
// actual terminal (tracking cursor position, \r, and escape sequences the
// same way tmux capture-pane does) reconstructs the real final screen.

test("replayTerminalLog resolves \\r spinner-frame overwrites to the final frame, not a concatenation of every frame", async () => {
  const frames = ["Fiddl-faddling…", "Networking…", "Assembling…"];
  let raw = "";
  for (const frame of frames) raw += `\r\x1b[K${frame}`;
  raw += "\r\x1b[KDone.\n";

  const output = await replayTerminalLog(raw);

  assert.equal(output, "Done.");
  for (const frame of frames) {
    assert.ok(!output.includes(frame), `stale spinner frame "${frame}" must not survive into the resolved output`);
  }
  assert.equal(output.split("\n").length, 1, "overwritten spinner frames must collapse onto one line, not stack as separate lines");
});

test("replayTerminalLog resolves a wide-glyph spinner character redraw without dropping the text that overwrites it", async () => {
  // The reported bug's spinner used ambiguous/wide-width glyphs (✳,
  // ★, ...) alongside plain-width preamble text; a regex stripper
  // dropped characters and spaces mid-word ("are running unattended" ->
  // "arerunningunattended") because it has no notion of on-screen column
  // position. A real terminal emulator resolves the overwrite exactly.
  const raw = "\r\x1b[K✳ thinking\r\x1b[K★ You are running unattended in a terminal\n";

  const output = await replayTerminalLog(raw);

  assert.equal(output, "★ You are running unattended in a terminal");
});

test("replayTerminalLog strips ANSI styling and OSC sequences down to plain resolved text", async () => {
  const raw = "\x1b]0;window title\x07\x1b[32m$ implement the feature\x1b[0m\nDone.\n";

  const output = await replayTerminalLog(raw);

  assert.equal(output, "$ implement the feature\nDone.");
  assert.ok(!output.includes("\x1b"), "resolved output must not contain raw ANSI escapes");
});

test("replayTerminalLog returns an empty string for empty input", async () => {
  assert.equal(await replayTerminalLog(""), "");
});
