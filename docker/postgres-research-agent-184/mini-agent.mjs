#!/usr/bin/env node
// Minimal real-LLM research agent for the #184 vertical-slice trial.
//
// Not a HoneyRail subsystem: this is the "one real agent CLI" the base
// docker/postgres-research image deliberately omits (see its Dockerfile
// comment - "which agent runs is the driver's choice"). It makes genuine
// model calls (no scripted/known-answer path) against an OpenAI-compatible
// chat-completions endpoint, drives psql through a `run_shell` tool inside
// this container, and stops by calling `submit_finding`, which is the only
// thing that writes finding.json.
//
// Runs entirely inside the isolated agent container: everything it can see
// is either baked into the derived image or one of the six paths
// server/postgres/agent-container.ts bind-mounts.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const apiKey = String(process.env.HONEYRAIL_AGENT_LLM_API_KEY || "").trim();
const baseUrl = String(process.env.HONEYRAIL_AGENT_LLM_BASE_URL || "https://api.deepseek.com").trim();
const model = String(process.env.HONEYRAIL_AGENT_LLM_MODEL || "deepseek-chat").trim();
const workDir = String(process.env.HR_PG_WORK_DIR || process.cwd()).trim();
const prompt = String(process.env.HONEYRAIL_TASK_PROMPT || "").trim();
const maxTurns = Number(process.env.HONEYRAIL_AGENT_MAX_TURNS || 14);
const shellTimeoutMs = Number(process.env.HONEYRAIL_AGENT_SHELL_TIMEOUT_MS || 45_000);

if (!apiKey) {
  console.error("HONEYRAIL_AGENT_LLM_API_KEY is required inside the agent container.");
  process.exit(0); // A missing driver credential is a blocked/incomplete agent run, not infrastructure.
}
if (!prompt) {
  console.error("HONEYRAIL_TASK_PROMPT was not injected; nothing to investigate.");
  process.exit(0);
}

const tools = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command (bash -lc) inside your workspace. Use it to inspect source, run psql, write scratch files.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run." } },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "submit_finding",
      description: "Submit your final finding.json. Calling this ends the trial.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["reproduced", "not-reproduced"] },
          summary: { type: "string" },
          reproducer_filename: { type: "string", description: 'Required when status is "reproduced"; the workspace filename you also wrote the SQL to.' },
          reproducer_sql: { type: "string", description: "The full contents of the SQL reproducer; written to reproducer_filename in your workspace." }
        },
        required: ["status", "summary"]
      }
    }
  }
];

function runShell(command) {
  const result = spawnSync("bash", ["-lc", command], {
    cwd: workDir,
    timeout: shellTimeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8"
  });
  const truncate = (value) => (value && value.length > 20_000 ? `${value.slice(0, 20_000)}\n...[truncated]` : value);
  return {
    stdout: truncate(result.stdout || ""),
    stderr: truncate(result.stderr || ""),
    exitCode: result.status,
    signal: result.signal,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT")
  };
}

const transcriptPath = join(workDir, "transcript.jsonl");
function logTranscript(entry) {
  appendFileSync(transcriptPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

let submitted = false;

function submitFinding(args) {
  const status = args.status === "reproduced" ? "reproduced" : "not-reproduced";
  const summary = String(args.summary || "").trim() || "(no summary provided)";
  const finding = { status, summary };
  if (status === "reproduced") {
    const filename = String(args.reproducer_filename || "repro.sql").trim() || "repro.sql";
    finding.reproducer = filename;
    writeFileSync(join(workDir, filename), String(args.reproducer_sql || "").trim() + "\n");
  }
  writeFileSync(join(workDir, "finding.json"), `${JSON.stringify(finding, null, 2)}\n`);
  submitted = true;
  return { ok: true };
}

async function callModel(messages, forceSubmit) {
  const requestBody = forceSubmit
    ? { model, messages, tools: [tools[1]], tool_choice: { type: "function", function: { name: "submit_finding" } }, temperature: 0.2 }
    : { model, messages, tools, tool_choice: "auto", temperature: 0.2 };
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody)
  });
  if (!response.ok) {
    throw new Error(`LLM API error ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  }
  const responseBody = await response.json();
  return responseBody.choices[0].message;
}

async function main() {
  const messages = [
    {
      role: "system",
      content:
        "You are an autonomous PostgreSQL correctness-research agent running inside an isolated container with a live " +
        "local PostgreSQL instance. Use run_shell to inspect $HR_PG_SOURCE_DIR, and to run psql against the live " +
        "instance ($HR_PG_URL, or -h $HR_PG_SOCKET_DIR -p $HR_PG_PORT -U $HR_PG_USER -d $HR_PG_DATABASE via " +
        "$HR_PG_BIN_DIR/psql). Your workspace is $HR_PG_WORK_DIR (your shell's cwd). You have a limited number of " +
        "tool-call turns, so read only as much source as you need to form one or two concrete hypotheses, then " +
        "actually run candidate SQL against the live instance early and iterate empirically rather than only reading " +
        "source. When you are done investigating (or your turn budget is about to run out), call submit_finding " +
        "exactly once - a timely \"not-reproduced\" with your best partial findings beats never submitting. If status " +
        "is \"reproduced\", the SQL you give as reproducer_sql must encode its own assertion via psql's " +
        "ON_ERROR_STOP: exit 0 only when the suspect behavior is actually observed (e.g. raise an exception when the " +
        "*correct* result is seen, so a correct run exits non-zero and a buggy run exits 0)."
    },
    { role: "user", content: prompt }
  ];

  for (let turn = 0; turn < maxTurns && !submitted; turn += 1) {
    const remaining = maxTurns - turn;
    const forceSubmit = remaining === 1;
    if (remaining <= 5 && !forceSubmit) {
      messages.push({
        role: "user",
        content: `You have ${remaining} tool-call turns left before this trial ends. Call submit_finding now with your best current conclusion if you have not already.`
      });
    } else if (forceSubmit) {
      messages.push({ role: "user", content: "This is your last turn. You must call submit_finding now with your best current conclusion." });
    }
    const message = await callModel(messages, forceSubmit);
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    logTranscript({ turn, role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls ?? null });
    if (!message.tool_calls || message.tool_calls.length === 0) {
      // No tool call and no submission yet - nudge once more, then stop rather than loop forever.
      messages.push({ role: "user", content: "Please call run_shell to continue investigating, or submit_finding to finish." });
      continue;
    }
    for (const call of message.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // Malformed arguments from the model; treat as empty rather than crash the driver.
      }
      const result = call.function.name === "run_shell" ? runShell(String(args.command || "")) : call.function.name === "submit_finding" ? submitFinding(args) : { error: `unknown tool ${call.function.name}` };
      logTranscript({ turn, role: "tool", tool: call.function.name, args, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  if (!submitted) {
    // The model exhausted its turn budget (including a final forced-tool-choice
    // attempt) without calling submit_finding. Recording this as a driver-issued
    // not-reproduced - clearly labeled as such in the summary and the transcript,
    // never as a model assertion - is what keeps a genuine budget-exhaustion miss
    // from being misclassified as a malformed/invalid submission.
    console.error(`Agent stopped after ${maxTurns} turns without calling submit_finding; recording a driver-issued not-reproduced.`);
    logTranscript({ role: "driver", event: "stopped-without-submission-fallback-not-reproduced", maxTurns });
    submitFinding({
      status: "not-reproduced",
      summary: `Driver-issued fallback: the agent did not call submit_finding within its ${maxTurns}-turn budget (including a final forced attempt), so no conclusive finding was reached.`
    });
  }
}

main()
  .catch((error) => {
    console.error(`mini-agent driver failed: ${error && error.stack ? error.stack : error}`);
  })
  .finally(() => {
    // The driver's own completion (with or without a submission) is what
    // "agent finished" means to the session; grading below decides the
    // score. A driver crash still exits 0 so a legitimate miss/invalid
    // submission is never misreported as an infrastructure failure.
    process.exit(0);
  });
