/**
 * Pure aggregation for the instruction-file A/B eval demo (#25): turns the
 * per-trial records collected by scripts/evals-ab-demo.ts into a Markdown
 * comparison report in which every aggregate number links back to the
 * per-trial runs (and their evidence) it was computed from. Deliberately
 * store-agnostic - the demo drives everything over REST - so it can be unit
 * tested and later reused when TrialSet (v0.4) makes this a first-class
 * entity.
 */

export type TrialRecord = {
  variant: string;
  taskId: string;
  /** 1-based trial index within the (variant, task) cell. */
  trial: number;
  runId: string;
  /** Terminal run status observed by the driver ("succeeded", "failed", "cancelled", or "timeout" when the driver gave up). */
  runStatus: string;
  /** True when the run succeeded and every quality gate decision passed - the demo's per-trial pass/fail. */
  gatePassed: boolean;
  startedAt?: string;
  finishedAt?: string;
  wallTimeMs?: number;
  /** Evidence recorded on the run, so report rows can name what backs them. */
  evidence: Array<{ id: string; kind: string; claim?: string }>;
  error?: string;
};

export type ComparisonReportInput = {
  generatedAt: string;
  baseUrl: string;
  recipeId: string;
  projectId: string;
  agent: string;
  smoke: boolean;
  variants: Array<{ label: string; path: string; sha256: string }>;
  trials: TrialRecord[];
};

export type VariantSummary = {
  variant: string;
  trials: number;
  passes: number;
  passRate: number | null;
  meanWallTimeMs: number | null;
};

export type TaskCellSummary = {
  taskId: string;
  variant: string;
  trials: number;
  passes: number;
  /** True when trials of the same cell disagree - the unit of trial-to-trial noise the report reasons about. */
  mixed: boolean;
};

export function summarizeVariants(trials: TrialRecord[]): VariantSummary[] {
  const byVariant = new Map<string, TrialRecord[]>();
  for (const trial of trials) {
    const list = byVariant.get(trial.variant) || [];
    list.push(trial);
    byVariant.set(trial.variant, list);
  }
  return [...byVariant.entries()].map(([variant, records]) => {
    const passes = records.filter((record) => record.gatePassed).length;
    const wallTimes = records.map((record) => record.wallTimeMs).filter((ms): ms is number => typeof ms === "number");
    return {
      variant,
      trials: records.length,
      passes,
      passRate: records.length ? passes / records.length : null,
      meanWallTimeMs: wallTimes.length ? Math.round(wallTimes.reduce((sum, ms) => sum + ms, 0) / wallTimes.length) : null
    };
  });
}

export function summarizeTaskCells(trials: TrialRecord[]): TaskCellSummary[] {
  const byCell = new Map<string, TrialRecord[]>();
  for (const trial of trials) {
    const key = `${trial.taskId}\u0000${trial.variant}`;
    const list = byCell.get(key) || [];
    list.push(trial);
    byCell.set(key, list);
  }
  return [...byCell.entries()].map(([key, records]) => {
    const [taskId, variant] = key.split("\u0000");
    const passes = records.filter((record) => record.gatePassed).length;
    return { taskId, variant, trials: records.length, passes, mixed: passes > 0 && passes < records.length };
  });
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 1000) / 10}%`;
}

function seconds(ms: number | null | undefined): string {
  return typeof ms === "number" ? `${Math.round(ms / 100) / 10}s` : "n/a";
}

function runLink(baseUrl: string, runId: string): string {
  return `[${runId}](${baseUrl}/api/runs/${runId})`;
}

/**
 * The honest noise statement the acceptance criteria ask for: with N this
 * small, the within-cell flip count is the only noise estimate available,
 * so the report states the pass-rate delta, states the observed
 * trial-to-trial instability, and says which is bigger - no more.
 */
function noiseAssessment(variantSummaries: VariantSummary[], cells: TaskCellSummary[]): string {
  if (variantSummaries.length !== 2) {
    return "Noise assessment requires exactly two variants; skipped.";
  }
  const [a, b] = variantSummaries;
  if (a.passRate === null || b.passRate === null) {
    return "Noise assessment skipped: at least one variant has no completed trials.";
  }
  const delta = Math.abs(a.passRate - b.passRate);
  const mixedCells = cells.filter((cell) => cell.mixed);
  const totalCells = cells.length;
  const perTrial = cells.length ? Math.max(...cells.map((cell) => cell.trials)) : 0;
  const lines = [
    `Pass-rate delta between variants: **${percent(delta)}** (${percent(a.passRate)} for \`${a.variant}\` vs ${percent(b.passRate)} for \`${b.variant}\`).`,
    `Trial-to-trial noise observed: **${mixedCells.length} of ${totalCells}** (task, variant) cells had mixed outcomes across their trials${mixedCells.length ? ` (${mixedCells.map((cell) => `\`${cell.taskId}\`/\`${cell.variant}\``).join(", ")})` : ""}.`
  ];
  if (perTrial < 2) {
    lines.push("With a single trial per cell no within-cell noise can be observed - treat the delta as unvalidated and rerun with more trials before drawing conclusions.");
  } else if (mixedCells.length === 0 && delta > 0) {
    lines.push("Every cell was internally consistent across trials, so the measured delta exceeded observed trial-to-trial noise in this matrix.");
  } else if (delta === 0) {
    lines.push("The variants tied on pass rate in this matrix; any difference between them is below what this trial count can resolve.");
  } else {
    const noiseShare = totalCells ? mixedCells.length / totalCells : 0;
    lines.push(
      delta > noiseShare
        ? "The pass-rate delta is larger than the share of unstable cells, so the difference likely exceeds trial-to-trial noise - but the unstable cells above deserve a look before trusting it."
        : "The pass-rate delta is within the observed trial-to-trial instability; treat the variants as indistinguishable at this trial count and raise N (input to the v0.4 TrialSet minimum-N choice)."
    );
  }
  return lines.join("\n");
}

export function buildComparisonReport(input: ComparisonReportInput): string {
  const variantSummaries = summarizeVariants(input.trials);
  const cells = summarizeTaskCells(input.trials);
  const taskIds = [...new Set(input.trials.map((trial) => trial.taskId))];
  const variants = input.variants.map((variant) => variant.label);

  const lines: string[] = [];
  lines.push("# Instruction-file A/B comparison report");
  lines.push("");
  lines.push(`Generated ${input.generatedAt} against ${input.baseUrl} (project \`${input.projectId}\`, recipe \`${input.recipeId}\`, agent \`${input.agent}\`${input.smoke ? ", smoke mode" : ""}).`);
  lines.push("");
  lines.push("## Variants");
  lines.push("");
  lines.push("| Label | Injected path | Content sha256 |");
  lines.push("| --- | --- | --- |");
  for (const variant of input.variants) {
    lines.push(`| \`${variant.label}\` | \`${variant.path}\` | \`${variant.sha256.slice(0, 12)}…\` |`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Variant | Trials | Gate passes | Pass rate | Mean wall time |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const summary of variantSummaries) {
    lines.push(`| \`${summary.variant}\` | ${summary.trials} | ${summary.passes} | ${percent(summary.passRate)} | ${seconds(summary.meanWallTimeMs)} |`);
  }
  lines.push("");
  lines.push("## Per-task breakdown");
  lines.push("");
  lines.push(`| Task | ${variants.map((label) => `\`${label}\``).join(" | ")} |`);
  lines.push(`| --- | ${variants.map(() => "---").join(" | ")} |`);
  for (const taskId of taskIds) {
    const row = variants.map((variant) => {
      const cell = cells.find((item) => item.taskId === taskId && item.variant === variant);
      return cell ? `${cell.passes}/${cell.trials}${cell.mixed ? " (mixed)" : ""}` : "—";
    });
    lines.push(`| \`${taskId}\` | ${row.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Noise assessment");
  lines.push("");
  lines.push(noiseAssessment(variantSummaries, cells));
  lines.push("");
  lines.push("## Per-trial evidence");
  lines.push("");
  lines.push("Every aggregate above is computed from exactly these runs; each run link exposes its own `/artifacts`, `/evidence`, and `/gate-decisions` sub-resources.");
  lines.push("");
  lines.push("| Variant | Task | Trial | Run | Status | Gate | Wall time | Evidence |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  const sorted = [...input.trials].sort((a, b) =>
    a.variant.localeCompare(b.variant) || a.taskId.localeCompare(b.taskId) || a.trial - b.trial
  );
  for (const trial of sorted) {
    const evidenceSummary = trial.evidence.length
      ? `${trial.evidence.length} items ([list](${input.baseUrl}/api/runs/${trial.runId}/evidence))`
      : "none";
    lines.push(
      `| \`${trial.variant}\` | \`${trial.taskId}\` | ${trial.trial} | ${runLink(input.baseUrl, trial.runId)} | ${trial.runStatus} | ${trial.gatePassed ? "passed" : "failed"} | ${seconds(trial.wallTimeMs)} | ${evidenceSummary} |`
    );
  }
  lines.push("");
  return lines.join("\n");
}
