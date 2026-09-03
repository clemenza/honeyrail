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
//
// Exit-code contract (research-session.ts reads only exitCode === 0 as
// agent.ok): 0 is reserved for "a valid finding.json was produced". Every
// other outcome - missing credential, an LLM API/driver exception, or
// exhausting the turn budget without a valid submit_finding call - exits
// non-zero, so HistoricalPostgresTrial classifies it as "blocked" rather
// than silently reporting agent.ok = true for a run that never actually
// produced a gradable submission.
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateSubmitFindingArgs } from "./finding-validation.mjs";
import { processToolCalls } from "./tool-loop.mjs";

const EXIT_OK = 0;
const EXIT_CONFIG_ERROR = 1;
const EXIT_DRIVER_ERROR = 2;
const EXIT_BUDGET_EXHAUSTED = 3;

const apiKey = String(process.env.HONEYRAIL_AGENT_LLM_API_KEY || "").trim();
const baseUrl = String(process.env.HONEYRAIL_AGENT_LLM_BASE_URL || "https://api.deepseek.com").trim();
const model = String(process.env.HONEYRAIL_AGENT_LLM_MODEL || "deepseek-chat").trim();
const workDir = String(process.env.HR_PG_WORK_DIR || process.cwd()).trim();
const prompt = String(process.env.HONEYRAIL_TASK_PROMPT || "").trim();
const maxTurns = Number(process.env.HONEYRAIL_AGENT_MAX_TURNS || 14);
const shellTimeoutMs = Number(process.env.HONEYRAIL_AGENT_SHELL_TIMEOUT_MS || 45_000);

if (!apiKey) {
  console.error("HONEYRAIL_AGENT_LLM_API_KEY is required inside the agent container; this is a driver configuration failure.");
  process.exit(EXIT_CONFIG_ERROR);
}
if (!prompt) {
  console.error("HONEYRAIL_TASK_PROMPT was not injected; this is a driver/session configuration failure, not an agent decision.");
  process.exit(EXIT_CONFIG_ERROR);
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
      description: "Submit your final finding.json. Calling this with a valid payload ends the trial.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["reproduced", "not-reproduced"] },
          summary: { type: "string" },
          reproducer_filename: { type: "string", description: 'Required when status is "reproduced"; the workspace filename you also wrote the SQL to.' },
          reproducer_sql: { type: "string", description: 'Required when status is "reproduced"; written to reproducer_filename in your workspace.' }
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

/**
 * Strictly validates the attempted submission (via the pure, unit-tested
 * `validateSubmitFindingArgs`) and returns a tool error on anything invalid -
 * it never silently normalizes a malformed call into a valid finding.json
 * (no defaulting `status` to "not-reproduced", no placeholder summary). An
 * invalid attempt is recorded in the transcript by the caller exactly as the
 * model produced it; this function's only side effect on success is writing
 * finding.json (and the reproducer file, when applicable).
 */
function submitFinding(args) {
  const validated = validateSubmitFindingArgs(args);
  if (!validated.ok) return validated;
  if (validated.reproducerFile) {
    writeFileSync(join(workDir, validated.reproducerFile.filename), `${validated.reproducerFile.sql}\n`);
  }
  writeFileSync(join(workDir, "finding.json"), `${JSON.stringify(validated.finding, null, 2)}\n`);
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
    // Deliberately not caught here: an API 401/429/500 must propagate out of
    // main() so the driver exits non-zero (EXIT_DRIVER_ERROR), not report a
    // successful agent run that happened to produce no finding.
    throw new Error(`LLM API error ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  }
  const responseBody = await response.json();
  const choice = responseBody && responseBody.choices && responseBody.choices[0];
  if (!choice || !choice.message) {
    throw new Error(`LLM API returned an unexpected response shape: ${JSON.stringify(responseBody).slice(0, 2000)}`);
  }
  return choice.message;
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
        "exactly once with a valid payload - a timely \"not-reproduced\" with your best partial findings beats never " +
        "submitting, but an unsubmitted trial is graded as incomplete, not as a miss. If status is \"reproduced\", " +
        "both reproducer_filename and reproducer_sql are required, and the SQL must encode its own assertion via " +
        "psql's ON_ERROR_STOP: exit 0 only when the suspect behavior is actually observed (e.g. raise an exception " +
        "when the *correct* result is seen, so a correct run exits non-zero and a buggy run exits 0)."
    },
    { role: "user", content: prompt }
  ];

  for (let turn = 0; turn < maxTurns && !submitted; turn += 1) {
    const remaining = maxTurns - turn;
    const forceSubmit = remaining === 1;
    if (remaining <= 5 && !forceSubmit) {
      messages.push({
        role: "user",
        content: `You have ${remaining} tool-call turns left before this trial ends. Call submit_finding now with a valid payload if you have not already.`
      });
    } else if (forceSubmit) {
      messages.push({ role: "user", content: "This is your last turn. You must call submit_finding now with a valid payload." });
    }
    const message = await callModel(messages, forceSubmit);
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls });
    logTranscript({ turn, role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls ?? null });
    if (!message.tool_calls || message.tool_calls.length === 0) {
      // No tool call and no submission yet - nudge once more, then stop rather than loop forever.
      messages.push({ role: "user", content: "Please call run_shell to continue investigating, or submit_finding to finish." });
      continue;
    }
    // "First valid submission is final": once submit_finding returns ok:true,
    // no further call in this same batch runs - not a second submit_finding,
    // and not a trailing run_shell that could mutate the workspace after the
    // grading-relevant files were already written. See tool-loop.mjs.
    const { entries } = processToolCalls(message.tool_calls, { runShell, trySubmitFinding: submitFinding });
    for (const entry of entries) {
      if (!entry.executed) {
        logTranscript({ turn, role: "driver", event: "trailing-tool-call-skipped", tool: entry.call.function.name, reason: entry.skippedReason });
        // Every tool_call_id the API sent needs a matching "tool" message in
        // the next request, even one this driver deliberately did not run.
        messages.push({ role: "tool", tool_call_id: entry.call.id, content: JSON.stringify({ ok: false, skipped: true, reason: entry.skippedReason }) });
        continue;
      }
      // The raw attempted call (including malformed/rejected submit_finding
      // attempts) is always recorded, exactly as the model produced it -
      // never silently repaired into a valid submission.
      logTranscript({ turn, role: "tool", tool: entry.call.function.name, args: entry.args, argsParseError: entry.argsParseError, result: entry.result });
      messages.push({ role: "tool", tool_call_id: entry.call.id, content: JSON.stringify(entry.result) });
    }
  }

  if (!submitted) {
    // Exhausting the turn budget without a valid submit_finding call is a
    // protocol/budget failure, not an agent conclusion - it must not produce
    // finding.json at all. HistoricalPostgresTrial then sees agent.ok=false
    // (from the non-zero exit below) and reports "blocked", never a graded
    // miss.
    console.error(`Agent did not produce a valid submit_finding call within its ${maxTurns}-turn budget.`);
    logTranscript({ role: "driver", event: "budget-exhausted-no-valid-submission", maxTurns });
    process.exitCode = EXIT_BUDGET_EXHAUSTED;
  }
}

main()
  .catch((error) => {
    console.error(`mini-agent driver failed: ${error && error.stack ? error.stack : error}`);
    try {
      logTranscript({ role: "driver", event: "driver-exception", error: String(error && error.message ? error.message : error) });
    } catch {
      // Best-effort: if the transcript itself is unwritable, the exit code below still reports failure.
    }
    process.exitCode = EXIT_DRIVER_ERROR;
  })
  .finally(() => {
    // process.exitCode defaults to 0 (EXIT_OK) and is only ever raised above -
    // never lowered back to 0 - so a config/driver/budget failure always
    // surfaces as a non-zero exit to research-session's agent.ok check.
    process.exit(process.exitCode ?? EXIT_OK);
  });
