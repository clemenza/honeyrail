// Pure validation for the mini-agent's `submit_finding` tool call, split out
// of mini-agent.mjs so it can be unit-tested without a real API call or a
// container. No side effects: callers decide what to do with a valid result
// (mini-agent.mjs writes finding.json/the reproducer file to $HR_PG_WORK_DIR).
//
// Deliberately strict: an invalid attempt is reported as `{ ok: false, error }`
// and never coerced into a valid finding - no defaulting `status` to
// "not-reproduced", no placeholder summary, no synthesized reproducer.
export function validateSubmitFindingArgs(args) {
  const status = args && args.status;
  if (status !== "reproduced" && status !== "not-reproduced") {
    return { ok: false, error: 'status must be exactly "reproduced" or "not-reproduced"' };
  }
  const summary = typeof (args && args.summary) === "string" ? args.summary.trim() : "";
  if (!summary) {
    return { ok: false, error: "summary must be a non-empty string" };
  }
  if (status === "not-reproduced") {
    return { ok: true, finding: { status, summary } };
  }
  const filename = typeof args.reproducer_filename === "string" ? args.reproducer_filename.trim() : "";
  const sql = typeof args.reproducer_sql === "string" ? args.reproducer_sql.trim() : "";
  if (!filename) return { ok: false, error: 'reproducer_filename must be a non-empty string when status is "reproduced"' };
  if (!sql) return { ok: false, error: 'reproducer_sql must be a non-empty string when status is "reproduced"' };
  return { ok: true, finding: { status, summary, reproducer: filename }, reproducerFile: { filename, sql } };
}
