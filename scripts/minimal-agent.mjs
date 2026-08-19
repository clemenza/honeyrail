#!/usr/bin/env node
/**
 * The #71 "minimal-agent" calibration probe: a bare ReAct loop that calls a
 * model API directly and runs whatever shell commands it asks for, with no
 * CLI, no interactive prompts, and a controllable temperature. Launched by
 * server/agents/minimal-agent.ts as the tmux pane's process, exactly like
 * codex/claude/hermes are - the difference is this script is HoneyRail's
 * own code, not a wrapped third-party CLI, so its output shape and the
 * absence of any stdin-reading code path are both guaranteed by
 * construction rather than by pattern-matching someone else's TUI.
 *
 * Deliberately dependency-free (only Node builtins: no npm install step
 * could ever run from inside an arbitrary worktree before this script
 * starts) and plain JavaScript, not TypeScript - it runs as a child process
 * launched via a shell command string, potentially from a worktree that
 * has no relationship to HoneyRail's own node_modules, so it can't rely on
 * a TypeScript loader being resolvable from its cwd.
 *
 * Usage: node minimal-agent.mjs --prompt <text> [--model <id>] [--temperature <n>]
 *
 * Environment:
 *   MINIMAL_AGENT_API_KEY / DEEPSEEK_API_KEY / AGENT_SESSION_SUMMARY_API_KEY
 *     - checked in that order for the API key.
 *   MINIMAL_AGENT_BASE_URL - OpenAI-chat-completions-compatible base URL,
 *     default https://api.deepseek.com. Overridable so tests can point this
 *     at a local mock server instead of a real API.
 *   MINIMAL_AGENT_MAX_ITERATIONS - caps the ReAct loop (default 10), so a
 *     model that never says DONE still terminates in bounded time.
 */

import { execSync } from "node:child_process";

const DONE_MARKER = "MINIMAL_AGENT_DONE";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_OBSERVATION_CHARS = 4000;
const COMMAND_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const options = { prompt: "", model: DEFAULT_MODEL, temperature: DEFAULT_TEMPERATURE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[i += 1];
    if (arg === "--prompt") options.prompt = next() ?? "";
    else if (arg === "--model") options.model = next() || DEFAULT_MODEL;
    else if (arg === "--temperature") {
      const value = Number(next());
      options.temperature = Number.isFinite(value) ? value : DEFAULT_TEMPERATURE;
    }
  }
  return options;
}

function truncate(text, maxChars) {
  const str = String(text || "");
  if (str.length <= maxChars) return str;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${str.slice(0, head)}\n...[truncated ${str.length - maxChars} chars]...\n${str.slice(-tail)}`;
}

// Never resolves - keeps the process (and thus this tmux pane) alive after
// signaling completion, mirroring every CLI-wrapping adapter: they return
// to an idle prompt rather than exiting, so the harness's poller has time
// to observe the final output before explicitly killing the session. A bare
// unresolved Promise does NOT do this - it registers no libuv handle, so
// Node exits as soon as every other pending handle (the last HTTP request,
// the last child process) settles, even with the Promise still pending. A
// ref'd interval is a real handle that keeps the event loop - and the
// process - alive until something external kills it.
function idleForever() {
  return new Promise(() => {
    setInterval(() => {}, 1 << 30);
  });
}

function finish(status, detail) {
  const suffix = detail ? ` ${detail}` : "";
  console.log(`${DONE_MARKER} status=${status}${suffix}`);
  return idleForever();
}

const SYSTEM_PROMPT = [
  "You are a minimal autonomous coding agent. You operate entirely by running shell commands in the current working directory, which is the target git repository.",
  "",
  "Protocol - every reply must be EXACTLY ONE of the following, nothing else:",
  '1. A single shell command to run next, as a fenced block:\n```bash\n<command>\n```',
  '2. The literal line `DONE` (nothing else) once the task is complete.',
  "",
  "Rules:",
  "- One command per turn. You will be shown its stdout/stderr/exit code, then asked again.",
  "- Prefer small, verifiable steps over one large command.",
  "- Never invent output you have not actually observed.",
  "- If a command fails, read the error and adjust - do not repeat the same failing command.",
  "- Reply with DONE as soon as the task described below is actually accomplished, not before."
].join("\n");

function extractBashBlock(text) {
  const match = text.match(/```bash\s*\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

function isDone(text) {
  return text.trim() === "DONE";
}

async function callModel({ baseUrl, apiKey, model, temperature, messages }) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: 800 }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const bodyError = body?.error;
    const msg = typeof bodyError === "object" ? bodyError?.message : bodyError;
    throw new Error(`model API request failed (${response.status}): ${msg || "no error detail"}`);
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("model API response had no message content");
  return String(text);
}

function runShellCommand(command) {
  try {
    const stdout = execSync(command, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      shell: "/bin/sh",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return `exit code: 0\n${truncate(stdout, MAX_OBSERVATION_CHARS)}`;
  } catch (error) {
    const stdout = error?.stdout ? String(error.stdout) : "";
    const stderr = error?.stderr ? String(error.stderr) : String(error?.message || error);
    const code = typeof error?.status === "number" ? error.status : "unknown";
    return `exit code: ${code}\nstdout:\n${truncate(stdout, MAX_OBSERVATION_CHARS / 2)}\nstderr:\n${truncate(stderr, MAX_OBSERVATION_CHARS / 2)}`;
  }
}

async function main() {
  // This function reads no input from the controlling terminal at all - the
  // "no code path that can produce an interactive prompt" #71 acceptance
  // criterion holds by never having any input source other than the model
  // API response and each shell command's own stdout/stderr.
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.MINIMAL_AGENT_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.AGENT_SESSION_SUMMARY_API_KEY;
  const baseUrl = process.env.MINIMAL_AGENT_BASE_URL || DEFAULT_BASE_URL;
  const maxIterations = Number(process.env.MINIMAL_AGENT_MAX_ITERATIONS) || DEFAULT_MAX_ITERATIONS;

  if (!apiKey) {
    await finish("error", "no API key configured (set DEEPSEEK_API_KEY, AGENT_SESSION_SUMMARY_API_KEY, or MINIMAL_AGENT_API_KEY)");
    return;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: options.prompt || "(no task prompt provided)" }
  ];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    let reply;
    try {
      reply = await callModel({ baseUrl, apiKey, model: options.model, temperature: options.temperature, messages });
    } catch (error) {
      await finish("error", `(iteration ${iteration}) ${error.message || error}`);
      return;
    }
    messages.push({ role: "assistant", content: reply });

    if (isDone(reply)) {
      await finish("done", `(${iteration} iteration${iteration === 1 ? "" : "s"})`);
      return;
    }

    const command = extractBashBlock(reply);
    if (command === null) {
      messages.push({
        role: "user",
        content: "That reply didn't match the protocol. Reply with EXACTLY one ```bash fenced command block, or the single line DONE."
      });
      continue;
    }

    console.log(`$ ${command}`);
    const observation = runShellCommand(command);
    console.log(observation);
    messages.push({ role: "user", content: `Observation:\n${observation}` });
  }

  await finish("max_iterations", `(${maxIterations})`);
}

main().catch(async (error) => {
  await finish("error", `unexpected: ${error?.message || error}`);
});
