export type ToolCall = {
  id: string;
  function: { name: string; arguments?: string };
};

export type ToolCallEntry =
  | { call: ToolCall; executed: true; args: Record<string, unknown>; argsParseError: string | null; result: unknown }
  | { call: ToolCall; executed: false; skippedReason: string };

export type ProcessToolCallsResult = {
  entries: ToolCallEntry[];
  submissionAccepted: boolean;
};

export function processToolCalls(
  toolCalls: ToolCall[],
  deps: { runShell: (command: string) => unknown; trySubmitFinding: (args: unknown) => { ok: boolean; error?: string } }
): ProcessToolCallsResult;
