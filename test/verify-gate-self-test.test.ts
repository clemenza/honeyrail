import assert from "node:assert/strict";
import { test } from "node:test";

import { classifySelfTestOutcome } from "../server/evals/verify-gate.js";

// #72: the null-agent verify-gate self-test's classification logic - a
// "succeeded" run is always a defect (a null agent that did no real work
// must never pass a real verification gate), a run that never reaches a
// terminal state is also a defect (the self-test has to give a definite
// verdict), and anything else terminal ("failed"/"blocked"/"cancelled") is
// the gate correctly rejecting it.

test("classifySelfTestOutcome flags a succeeded null-agent run as a defect", () => {
  assert.equal(classifySelfTestOutcome("succeeded"), "defect");
});

test("classifySelfTestOutcome treats any other terminal status as the gate working correctly", () => {
  assert.equal(classifySelfTestOutcome("failed"), "ok");
  assert.equal(classifySelfTestOutcome("blocked"), "ok");
  assert.equal(classifySelfTestOutcome("cancelled"), "ok");
});

test("classifySelfTestOutcome treats a run that never reached a terminal state as a timeout defect", () => {
  assert.equal(classifySelfTestOutcome(undefined), "timeout");
});
