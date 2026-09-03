import assert from "node:assert/strict";
import test from "node:test";
import { processToolCalls } from "../docker/postgres-research-agent-184/tool-loop.mjs";

/**
 * Pure unit tests for the #184 mini-agent's "first valid submission is
 * final" tool-call semantics, exercised with fake `runShell`/
 * `trySubmitFinding` dependencies so nothing here spawns a shell, writes a
 * file, or calls a real API.
 */

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, function: { name, arguments: JSON.stringify(args) } };
}

test("a run_shell call after a valid submit_finding in the same batch is never executed", () => {
  const runShellCalls: string[] = [];
  const submitCalls: unknown[] = [];
  const { entries, submissionAccepted } = processToolCalls(
    [toolCall("1", "submit_finding", { status: "not-reproduced", summary: "done" }), toolCall("2", "run_shell", { command: "echo mutated > repro.sql" })],
    {
      runShell: (command: string) => {
        runShellCalls.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      trySubmitFinding: (args: unknown) => {
        submitCalls.push(args);
        return { ok: true };
      }
    }
  );
  assert.equal(submissionAccepted, true);
  assert.deepEqual(runShellCalls, [], "run_shell must not execute after a valid submission in the same batch");
  assert.equal(submitCalls.length, 1);
  assert.equal(entries[0].executed, true);
  assert.equal(entries[1].executed, false);
});

test("a second submit_finding after a valid first one is never executed - first submission is final", () => {
  const submitCalls: Record<string, unknown>[] = [];
  const { entries, submissionAccepted } = processToolCalls(
    [
      toolCall("1", "submit_finding", { status: "not-reproduced", summary: "finding A" }),
      toolCall("2", "submit_finding", { status: "reproduced", summary: "finding B", reproducer_filename: "repro.sql", reproducer_sql: "SELECT 1;" })
    ],
    {
      runShell: () => {
        throw new Error("run_shell should not be called in this test");
      },
      trySubmitFinding: (args) => {
        submitCalls.push(args as Record<string, unknown>);
        return { ok: true };
      }
    }
  );
  assert.equal(submissionAccepted, true);
  // trySubmitFinding was invoked exactly once, with finding A - the second
  // call never reaches it, so a real submitFinding() could not have
  // overwritten finding.json with B.
  assert.equal(submitCalls.length, 1);
  assert.equal((submitCalls[0] as { summary: string }).summary, "finding A");
  assert.equal(entries[1].executed, false);
});

test("run_shell calls before a valid submission still execute normally", () => {
  const runShellCalls: string[] = [];
  const { entries, submissionAccepted } = processToolCalls(
    [toolCall("1", "run_shell", { command: "ls" }), toolCall("2", "submit_finding", { status: "not-reproduced", summary: "done" })],
    {
      runShell: (command: string) => {
        runShellCalls.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      trySubmitFinding: () => ({ ok: true })
    }
  );
  assert.equal(submissionAccepted, true);
  assert.deepEqual(runShellCalls, ["ls"]);
  assert.equal(entries[0].executed, true);
  assert.equal(entries[1].executed, true);
});

test("a malformed (rejected) submit_finding does not end the batch, so a following call still executes", () => {
  const runShellCalls: string[] = [];
  const { entries, submissionAccepted } = processToolCalls(
    [toolCall("1", "submit_finding", { summary: "missing status" }), toolCall("2", "run_shell", { command: "echo still-going" })],
    {
      runShell: (command: string) => {
        runShellCalls.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      trySubmitFinding: () => ({ ok: false, error: "status must be exactly \"reproduced\" or \"not-reproduced\"" })
    }
  );
  assert.equal(submissionAccepted, false);
  assert.deepEqual(runShellCalls, ["echo still-going"]);
  assert.equal(entries[0].executed, true);
  assert.equal((entries[0] as { result: { ok: boolean } }).result.ok, false);
  assert.equal(entries[1].executed, true);
});

test("an unknown tool name is reported without executing run_shell or submit_finding", () => {
  const { entries, submissionAccepted } = processToolCalls([toolCall("1", "delete_everything", {})], {
    runShell: () => {
      throw new Error("run_shell should not be called");
    },
    trySubmitFinding: () => {
      throw new Error("trySubmitFinding should not be called");
    }
  });
  assert.equal(submissionAccepted, false);
  assert.equal(entries[0].executed, true);
  assert.ok((entries[0] as { result: { error: string } }).result.error.includes("delete_everything"));
});
