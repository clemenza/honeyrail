import type { SessionSummaryClient } from "../session-helpers.js";

export type AutoAnswerInput = {
  client: SessionSummaryClient;
  model: string;
  question: string;
  prompt: string;
  projectName: string;
  goal: string;
};

/**
 * Asks the configured LLM to pick an answer on the operator's behalf for a
 * blocked agent-task step, so an onBlocked: "auto_answer" run can continue
 * without a human. Returns null (never throws) when no provider is
 * configured or the call fails, so callers can fall through to onTimeout.
 */
export async function generateAutoAnswer(input: AutoAnswerInput): Promise<string | null> {
  const question = input.question.trim();
  if (!question) return null;

  const prompt = [
    "You are answering on behalf of the operator so an unattended coding-agent run can continue without stopping.",
    `Project: ${input.projectName}`,
    `Run goal: ${input.goal}`,
    `Original task prompt: ${input.prompt || "(none)"}`,
    "",
    "The agent stopped and asked the following question:",
    question,
    "",
    "Pick the option that best serves the original task. If the question is a numbered menu, answer with the number only; otherwise answer in one short sentence. Reply with only the raw text to type — no explanation, no quotes."
  ].join("\n");

  try {
    const answer = await input.client.summarize({ model: input.model, prompt });
    const trimmed = answer.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
