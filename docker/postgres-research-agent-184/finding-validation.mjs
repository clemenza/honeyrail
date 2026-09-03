// Pure validation for the mini-agent's `submit_finding` tool call, split out
// of mini-agent.mjs so it can be unit-tested without a real API call or a
// container. No side effects: callers decide what to do with a valid result
// (mini-agent.mjs writes finding.json/the reproducer file to $HR_PG_WORK_DIR).
//
// Deliberately strict: an invalid attempt is reported as `{ ok: false, error }`
// and never coerced into a valid finding - no defaulting `status` to
// "not-reproduced", no placeholder summary, no synthesized reproducer.
import { basename } from "node:path";

/**
 * The historical grader's own contract (validateHistoricalPostgresSubmission
 * in server/postgres/historical-task.ts) requires `reproducer` to name a
 * file directly inside the workspace - no path separators, no `.`/`..`. The
 * adapter enforces the identical rule here so a value it accepts can never
 * be one the grader would reject as an integrity violation.
 */
function isBareWorkspaceFilename(value) {
  return value !== "" && value !== "." && value !== ".." && basename(value) === value;
}

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
  if (!isBareWorkspaceFilename(filename)) {
    return { ok: false, error: "reproducer_filename must name a file directly inside the workspace (no path separators, not \".\" or \"..\")" };
  }
  if (!sql) return { ok: false, error: 'reproducer_sql must be a non-empty string when status is "reproduced"' };
  return { ok: true, finding: { status, summary, reproducer: filename }, reproducerFile: { filename, sql } };
}
