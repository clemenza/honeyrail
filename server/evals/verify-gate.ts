/**
 * Pure classification for the #72 verify-gate self-test: given the run
 * status a null-agent trial reached (or never reached), is the target's
 * verification gate behaving correctly? Kept separate from
 * scripts/verify-gate-self-test.ts (which drives everything over REST and
 * has a top-level `main()` that runs unconditionally on import) so this can
 * be unit tested in isolation - the same split ab-report.ts uses relative
 * to scripts/evals-ab-demo.ts (#25).
 */

/**
 * "timeout": the run never reached a terminal state within the driver's
 * deadline. "driver_error": the run couldn't even be launched (e.g. the API
 * call itself failed) - distinct from "timeout" since it never started
 * executing at all. Both count as defects alongside "defect" itself; only
 * "ok" means the gate behaved correctly.
 */
export type SelfTestOutcome = "ok" | "defect" | "timeout" | "driver_error";

/**
 * "succeeded" is always a defect - a null agent that did no real work must
 * never pass a real verification gate. A run that never reached a terminal
 * state is also a defect: the self-test has to give a definite verdict, not
 * leave the question open. Anything else terminal ("failed"/"blocked"/
 * "cancelled") means the gate correctly rejected it, for whatever specific
 * reason.
 */
export function classifySelfTestOutcome(runStatus: string | undefined): SelfTestOutcome {
  if (runStatus === undefined) return "timeout";
  if (runStatus === "succeeded") return "defect";
  return "ok";
}
