import { isVerifyingStep } from "../orchestration/dag.js";
import type { ContractLevel, Step, Store } from "../types.js";

const TERMINAL_STEP_STATUSES = new Set<Step["status"]>(["succeeded", "failed", "blocked", "skipped", "cancelled"]);

export type EvalMetricsFilter = {
  projectId?: string;
  recipeId?: string;
  contractLevel?: ContractLevel;
  /** Matches a run if any of its agent-task steps' completion evidence recorded this harness prompt version (#52). */
  promptVersion?: string;
  /** Matches a run if any of its agent-task steps' completion evidence recorded an injected instruction file with this variant label (#25 A/B eval). */
  instructionLabel?: string;
};

type RateStat = { satisfied: number; total: number; rate: number | null };

export type EvalMetrics = {
  filter: EvalMetricsFilter;
  runCount: number;
  /** Declared `produces` artifacts actually produced (#51 contract compliance). */
  contractCompliance: RateStat;
  /** Of succeeded agent-task steps, how many left at least one manifest.json-described artifact (#52 convention adoption). */
  manifestEmission: RateStat;
  /** Of verifying steps (executor "check", or one that declares `consumes`) that reached a terminal state, how many actually ran instead of being skipped because an upstream producer failed. */
  verifyRunnable: RateStat;
  /** Of quality gate decisions, how many passed outright. */
  qualityGatePass: RateStat;
  /** Of quality gate decisions, how many required a human (decidedBy "operator" - an override or a rejection). */
  humanOverride: RateStat;
  /** Of terminal, unattended agent-task steps, how many stopped at least once to ask a clarifying question. */
  blockedStep: RateStat;
};

function rate(satisfied: number, total: number): number | null {
  return total > 0 ? satisfied / total : null;
}

function emptyStat(): RateStat {
  return { satisfied: 0, total: 0, rate: null };
}

function finalize(stats: Record<string, RateStat>) {
  for (const stat of Object.values(stats)) stat.rate = rate(stat.satisfied, stat.total);
}

/**
 * Computes the eval metrics from #54 - contract compliance, manifest
 * emission, verify-runnable, quality gate pass, human override, and
 * blocked-step rates - segmented by the filters given, over persisted
 * Run/Step/Evidence/QualityGateDecision state. Deliberately does not read
 * the event log: SQLiteStore.appendEvent prunes it to the most recent 200
 * rows, which makes it unusable as a source for metrics meant to be
 * compared across many historical runs (see the "step.blocked" Evidence
 * OrchestrationService.markStepBlocked now records for exactly this reason).
 */
export async function computeEvalMetrics(store: Store, filter: EvalMetricsFilter = {}): Promise<EvalMetrics> {
  const contractCompliance = emptyStat();
  const manifestEmission = emptyStat();
  const verifyRunnable = emptyStat();
  const qualityGatePass = emptyStat();
  const humanOverride = emptyStat();
  const blockedStep = emptyStat();
  let runCount = 0;

  const runs = await store.listRuns(filter.projectId);
  for (const run of runs) {
    if (filter.recipeId && run.recipeId !== filter.recipeId) continue;
    if (filter.contractLevel && run.contractLevel !== filter.contractLevel) continue;

    const [steps, evidence, gateDecisions] = await Promise.all([
      store.listSteps(run.id),
      store.listEvidence(run.id),
      store.listQualityGateDecisions(run.id)
    ]);

    if (filter.promptVersion) {
      const promptVersions = new Set(
        evidence
          .filter((item) => item.kind === "agent.completion")
          .map((item) => (item.value as Record<string, unknown> | undefined)?.harnessPromptVersion)
          .filter((version): version is string => typeof version === "string")
      );
      if (!promptVersions.has(filter.promptVersion)) continue;
    }

    if (filter.instructionLabel) {
      const labels = new Set(
        evidence
          .filter((item) => item.kind === "agent.completion")
          .map((item) => {
            const injected = (item.value as Record<string, unknown> | undefined)?.instructionFile;
            return (injected as Record<string, unknown> | undefined)?.label;
          })
          .filter((label): label is string => typeof label === "string")
      );
      if (!labels.has(filter.instructionLabel)) continue;
    }

    runCount += 1;
    const evidenceByStep = new Map<string, typeof evidence>();
    for (const item of evidence) {
      if (!item.stepId) continue;
      const list = evidenceByStep.get(item.stepId) || [];
      list.push(item);
      evidenceByStep.set(item.stepId, list);
    }

    for (const step of steps) {
      if (step.produces?.length) {
        if (step.status === "succeeded") {
          contractCompliance.total += 1;
          contractCompliance.satisfied += 1;
        } else if (step.failureKind === "contract_violation") {
          contractCompliance.total += 1;
        }
      }

      if (step.executor === "agent-task" && step.status === "succeeded") {
        manifestEmission.total += 1;
        if ((evidenceByStep.get(step.id) || []).some((item) => item.kind === "agent.manifest")) {
          manifestEmission.satisfied += 1;
        }
      }

      if (isVerifyingStep(step) && TERMINAL_STEP_STATUSES.has(step.status)) {
        verifyRunnable.total += 1;
        if (step.status !== "skipped") verifyRunnable.satisfied += 1;
      }

      if (step.executor === "agent-task" && step.input?.interaction !== "interactive" && TERMINAL_STEP_STATUSES.has(step.status)) {
        blockedStep.total += 1;
        if ((evidenceByStep.get(step.id) || []).some((item) => item.kind === "step.blocked")) {
          blockedStep.satisfied += 1;
        }
      }
    }

    for (const decision of gateDecisions) {
      qualityGatePass.total += 1;
      if (decision.status === "passed") qualityGatePass.satisfied += 1;
      humanOverride.total += 1;
      if (decision.decidedBy === "operator") humanOverride.satisfied += 1;
    }
  }

  const stats = { contractCompliance, manifestEmission, verifyRunnable, qualityGatePass, humanOverride, blockedStep };
  finalize(stats);

  return { filter, runCount, ...stats };
}
