// "First valid submission is final" tool-call processing for the #184
// mini-agent, split out of mini-agent.mjs so the semantics can be unit
// tested without a real API call or a container.
//
// A single assistant turn can contain several tool_calls. Without this,
// a model that returns `submit_finding(...)` followed by `run_shell(...)`
// (or two `submit_finding` calls) could mutate the workspace or overwrite
// finding.json *after* a valid submission was already accepted - the
// grader would then read a post-submission workspace instead of the
// snapshot the agent actually submitted. Once a `submit_finding` call
// returns `ok: true`, every remaining call in the same batch is recorded as
// skipped and never executed - not even a second `submit_finding`.
export function processToolCalls(toolCalls, { runShell, trySubmitFinding }) {
  const entries = [];
  let submissionAccepted = false;
  for (const call of toolCalls) {
    if (submissionAccepted) {
      entries.push({ call, executed: false, skippedReason: "first valid submission is final; remaining tool calls in this batch were not executed" });
      continue;
    }
    let args = {};
    let argsParseError = null;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch (error) {
      // Malformed JSON from the model: still routed through the real
      // handler below, which reports a proper tool error rather than the
      // driver silently proceeding as if empty arguments were intentional.
      argsParseError = String(error && error.message ? error.message : error);
    }
    let result;
    if (call.function.name === "run_shell") {
      result = runShell(String(args.command || ""));
    } else if (call.function.name === "submit_finding") {
      result = argsParseError ? { ok: false, error: `arguments were not valid JSON: ${argsParseError}` } : trySubmitFinding(args);
      if (result && result.ok === true) submissionAccepted = true;
    } else {
      result = { error: `unknown tool ${call.function.name}` };
    }
    entries.push({ call, args, argsParseError, result, executed: true });
  }
  return { entries, submissionAccepted };
}
