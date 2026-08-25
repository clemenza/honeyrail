/**
 * Pure aggregation for scripts/dsh-evals-demo.ts (#93): turns the per-cell
 * records collected by the driver into a Markdown comparison report.
 *
 * Unlike server/evals/ab-report.ts (#25), a cell here never becomes a
 * HoneyRail Run - per #93's P0 amendment (following #103), a scored trial
 * runs inside #105's isolated container against a #104-built seed-root, not
 * as a registered honeyrail project sharing host filesystem access - so
 * there is no `/api/runs/:id` to link to. Every number here instead links
 * back to a local artifacts directory (the seed-root, its score.json, and
 * the container's captured stdout/stderr) the driver wrote to disk.
 */

import type { SessionStats } from "./dsh-session-stats.js";

export type DshTrialOutcome = "passed" | "task_failed" | "verify_failed" | "invalidated" | "blocked" | "driver_error";

export type DshTrialRecord = {
  fixture: string;
  profile: string;
  /** 1-based trial index within the (fixture, profile) cell. */
  trial: number;
  /** Local identifier, e.g. "m01-baseline-1" - what every report link traces back to. */
  trialId: string;
  /** Directory holding this trial's seed-root, manifest.json, score.json, and container log - the receipts behind every number in its report row. */
  artifactsDir: string;
  killed: boolean | null;
  falseAlarms: number | null;
  contractOk: boolean | null;
  /**
   * Protected-path integrity re-check (#93's amendment, step 4): the same
   * #106 manifest, re-verified against the seed-root's files after the
   * agent ran. False means tinytable/, sql-tests/official/, SPEC.md,
   * run_sql_tests.py, or findings.schema.json changed - the exact #103
   * failure mode (an agent tampering with/replacing protected content) -
   * and always forces outcome "invalidated" regardless of what grade.py
   * reported, since a tampered fixture proves nothing about the agent's
   * real test-engineering ability.
   */
  integrityOk: boolean;
  /**
   * #107's transcript audit: hits from server/evals/transcript-audit.ts
   * against the container's captured output and the agent's own artifacts
   * (findings.json, its .test files). Any hit forces "invalidated" - the
   * same reasoning as integrityOk, extended to cover what the agent *said*
   * or *wrote* about material outside the exam room, not just whether it
   * actually tampered with protected files.
   */
  transcriptAuditHits: string[];
  /**
   * #126 (vendor/tinytable-evals's grade.py, its own issue #21 "Grader
   * v2"): fraction of --grader-runs probabilistic-scoring seeds that
   * killed this fixture's mutant - a generalization of `killed` for
   * nondeterministic bugs. null whenever `killed` is (the trial never
   * reached scoring, or scoring errored).
   */
  killRate: number | null;
  /** Killed tests split by whether they're an "invariant" (assert_stats/--check-admissibility) violation vs a plain "assertion". null alongside killRate. */
  killedByKind: { assertion: number; invariant: number } | null;
  blockedReason?: string;
  wallTimeMs?: number;
  /**
   * Turn/step/wall-time telemetry folded from dsh's own session-
   * persistence JSONL log (server/evals/dsh-session-stats.ts) - null when
   * the trial never launched a dsh session, or that session wrote nothing
   * readable (a version without the session-stats plugin, or a launch
   * that failed before any event landed). Summed across every session
   * file the trial's dshHomeDir held, since a normal trial writes exactly
   * one.
   */
  sessionStats?: SessionStats | null;
  /**
   * #57, opt-in via --pg-adjudicate (off by default): summed across
   * --grader-runs seeds' F_mutant & F_clean disputes, settled by a
   * PostgreSQL oracle into reference_bug (a real clean/ bug - see
   * clemenza/honeyrail#130/#134 - not counted against the agent) vs
   * false_alarm vs unknown. null when --pg-adjudicate wasn't passed, or
   * scoring never reached that step.
   */
  pgAdjudicationTally?: { reference_bug: number; false_alarm: number; unknown: number } | null;
  error?: string;
};

/**
 * Scores one cell. "invalidated" takes priority over everything else - see
 * DshTrialRecord.integrityOk/transcriptAuditHits. "blocked" is next: an
 * agent that printed BLOCKED: per UNATTENDED_PREAMBLE made no claim about
 * the fixture at all. Otherwise this reads grade.py's own verdict:
 * killed==false means the agent's suite never caught the seeded defect
 * (task_failed - the black-box test-engineering task itself wasn't done);
 * killed==true but false_alarms>0 or contract_ok==false means it found
 * *something* but failed the scoring contract (verify_failed); killed &&
 * no false alarms && contract_ok is a clean pass.
 */
export function classifyDshOutcome(
  cell: Pick<
    DshTrialRecord,
    "integrityOk" | "transcriptAuditHits" | "blockedReason" | "killed" | "falseAlarms" | "contractOk" | "error"
  >
): DshTrialOutcome {
  if (cell.error) return "driver_error";
  if (!cell.integrityOk || cell.transcriptAuditHits.length > 0) return "invalidated";
  if (cell.blockedReason) return "blocked";
  if (cell.killed === null || cell.contractOk === null) return "driver_error";
  if (!cell.killed) return "task_failed";
  if ((cell.falseAlarms ?? 0) > 0 || !cell.contractOk) return "verify_failed";
  return "passed";
}

export type ProfileSummary = {
  profile: string;
  trials: number;
  passed: number;
  taskFailed: number;
  verifyFailed: number;
  invalidated: number;
  blocked: number;
  driverError: number;
  /** Excludes blocked/invalidated/driver_error from the denominator - none of those carry a pass/fail signal about the agent's test-engineering. */
  passRate: number | null;
  meanWallTimeMs: number | null;
};

export type FixtureCellSummary = {
  fixture: string;
  profile: string;
  trials: number;
  killRate: number | null;
  falseAlarmRate: number | null;
  contractComplianceRate: number | null;
  medianWallTimeMs: number | null;
  /** Mean of scorable trials' probabilistic killRate (#126); null if none have one. */
  meanKillRate: number | null;
  /** Summed killedByKind across scorable trials that have one; null if none do. */
  killedByKind: { assertion: number; invariant: number } | null;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarizeProfiles(trials: DshTrialRecord[]): ProfileSummary[] {
  const byProfile = new Map<string, DshTrialRecord[]>();
  for (const trial of trials) {
    const list = byProfile.get(trial.profile) || [];
    list.push(trial);
    byProfile.set(trial.profile, list);
  }
  return [...byProfile.entries()].map(([profile, records]) => {
    const outcomes = records.map((record) => classifyDshOutcome(record));
    const count = (outcome: DshTrialOutcome) => outcomes.filter((item) => item === outcome).length;
    const excluded = count("blocked") + count("invalidated") + count("driver_error");
    const passed = count("passed");
    const scored = records.length - excluded;
    const wallTimes = records.map((r) => r.wallTimeMs).filter((ms): ms is number => typeof ms === "number");
    return {
      profile,
      trials: records.length,
      passed,
      taskFailed: count("task_failed"),
      verifyFailed: count("verify_failed"),
      invalidated: count("invalidated"),
      blocked: count("blocked"),
      driverError: count("driver_error"),
      passRate: scored > 0 ? passed / scored : null,
      meanWallTimeMs: wallTimes.length ? Math.round(wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length) : null
    };
  });
}

/** Per-fixture table columns the original #93 scope specified: kill rate, false-alarm rate, contract compliance, median wall time. */
export function summarizeFixtureCells(trials: DshTrialRecord[]): FixtureCellSummary[] {
  const byCell = new Map<string, DshTrialRecord[]>();
  for (const trial of trials) {
    const key = `${trial.fixture}\u0000${trial.profile}`;
    const list = byCell.get(key) || [];
    list.push(trial);
    byCell.set(key, list);
  }
  return [...byCell.entries()].map(([key, records]) => {
    const [fixture, profile] = key.split("\u0000");
    // Scorable records: grade.py's verdict is actually trustworthy for this
    // cell - i.e. classifyDshOutcome would call it "passed"/"task_failed"/
    // "verify_failed", not "blocked"/"invalidated"/"driver_error". An
    // invalidated trial (integrityOk=false) can still carry non-null
    // killed/contractOk fields from a stale grade.py run against tampered
    // content - those must not count toward kill rate/false-alarm rate/
    // contract compliance any more than a blocked or driver-errored trial
    // would.
    const scorableOutcomes = new Set<DshTrialOutcome>(["passed", "task_failed", "verify_failed"]);
    const scorable = records.filter((r) => scorableOutcomes.has(classifyDshOutcome(r)));
    const killRate = scorable.length ? scorable.filter((r) => r.killed).length / scorable.length : null;
    const falseAlarmRate = scorable.length
      ? scorable.filter((r) => (r.falseAlarms ?? 0) > 0).length / scorable.length
      : null;
    const contractComplianceRate = scorable.length
      ? scorable.filter((r) => r.contractOk).length / scorable.length
      : null;
    const wallTimes = records.map((r) => r.wallTimeMs).filter((ms): ms is number => typeof ms === "number");
    const probabilisticKillRates = scorable.map((r) => r.killRate).filter((rate): rate is number => rate !== null);
    const kindTallies = scorable.map((r) => r.killedByKind).filter((k): k is { assertion: number; invariant: number } => k !== null);
    return {
      fixture,
      profile,
      trials: records.length,
      killRate,
      falseAlarmRate,
      contractComplianceRate,
      medianWallTimeMs: median(wallTimes),
      meanKillRate: probabilisticKillRates.length
        ? probabilisticKillRates.reduce((a, b) => a + b, 0) / probabilisticKillRates.length
        : null,
      killedByKind: kindTallies.length
        ? kindTallies.reduce((acc, k) => ({ assertion: acc.assertion + k.assertion, invariant: acc.invariant + k.invariant }), { assertion: 0, invariant: 0 })
        : null
    };
  });
}

function percent(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 1000) / 10}%`;
}

function seconds(ms: number | null | undefined): string {
  return typeof ms === "number" ? `${Math.round(ms / 100) / 10}s` : "n/a";
}

export type DshComparisonReportInput = {
  generatedAt: string;
  dshVersion: string;
  image: string;
  smoke: boolean;
  profiles: Array<{ label: string; path: string; sha256: string }>;
  fixtures: string[];
  trials: DshTrialRecord[];
};

/**
 * A per-fixture pass-rate delta between exactly two profiles, with an
 * explicit "no significance claims" disclaimer - mirrors ab-report.ts's own
 * honesty about what a handful of trials can and can't establish, adapted
 * to kill rate (the metric this scope actually asked for) instead of pass
 * rate.
 */
function pairedDeltaTable(cells: FixtureCellSummary[], fixtures: string[], profiles: string[]): string[] {
  if (profiles.length !== 2) {
    return ["Paired delta requires exactly two profiles; skipped."];
  }
  const [a, b] = profiles;
  const lines = [
    `Kill-rate delta per fixture, \`${a}\` minus \`${b}\`. No significance testing is applied - with this few trials per cell, treat any delta as a lead to investigate, not a proven effect.`,
    "",
    `| Fixture | \`${a}\` kill rate | \`${b}\` kill rate | Delta |`,
    "| --- | --- | --- | --- |"
  ];
  for (const fixture of fixtures) {
    const cellA = cells.find((c) => c.fixture === fixture && c.profile === a);
    const cellB = cells.find((c) => c.fixture === fixture && c.profile === b);
    const rateA = cellA?.killRate ?? null;
    const rateB = cellB?.killRate ?? null;
    const delta = rateA !== null && rateB !== null ? rateA - rateB : null;
    lines.push(
      `| \`${fixture}\` | ${percent(rateA)} | ${percent(rateB)} | ${delta === null ? "n/a" : `${delta >= 0 ? "+" : ""}${Math.round(delta * 1000) / 10}pp`} |`
    );
  }
  return lines;
}

export function buildDshComparisonReport(input: DshComparisonReportInput): string {
  const profileSummaries = summarizeProfiles(input.trials);
  const cells = summarizeFixtureCells(input.trials);
  const profiles = input.profiles.map((p) => p.label);

  const lines: string[] = [];
  lines.push("# DSH test-engineering trial-evals comparison report");
  lines.push("");
  lines.push(
    `Generated ${input.generatedAt}. dsh \`${input.dshVersion}\`, exam-room image \`${input.image}\`${input.smoke ? ", smoke mode" : ""}.`
  );
  lines.push("");
  lines.push("## Profiles");
  lines.push("");
  lines.push("| Label | Patch path | Content sha256 |");
  lines.push("| --- | --- | --- |");
  for (const profile of input.profiles) {
    lines.push(`| \`${profile.label}\` | \`${profile.path}\` | \`${profile.sha256.slice(0, 12)}…\` |`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    "Pass rate excludes `blocked`, `invalidated`, and `driver_error` trials from its denominator - none carry a pass/fail signal about the agent's test-engineering. `invalidated` (#107) means either the post-run manifest re-check (#106) found tinytable/, sql-tests/official/, or another protected fixture file changed, or the transcript audit found the agent's own output/artifacts referencing material outside the exam room - the #103 failure mode - regardless of what grade.py itself reported."
  );
  lines.push("");
  lines.push(
    "| Profile | Trials | Passed | Task failed | Verify failed | Invalidated | Blocked | Driver error | Pass rate (excl. blocked/invalidated/driver_error) | Mean wall time |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const summary of profileSummaries) {
    lines.push(
      `| \`${summary.profile}\` | ${summary.trials} | ${summary.passed} | ${summary.taskFailed} | ${summary.verifyFailed} | ${summary.invalidated} | ${summary.blocked} | ${summary.driverError} | ${percent(summary.passRate)} | ${seconds(summary.meanWallTimeMs)} |`
    );
  }
  lines.push("");
  lines.push("## Per-fixture breakdown");
  lines.push("");
  lines.push(
    "Mean kill rate (#126) is the mean, across this cell's scorable trials, of vendor/tinytable-evals's grade.py `kill_rate` - the fraction of `--grader-runs` probabilistic-scoring seeds that killed the trial's own mutant (a generalization of the boolean `Kill rate` column for nondeterministic bugs; equal to it when `--grader-runs 1`, the default). Killed by kind sums how many killed tests were an \"invariant\" violation (`assert_stats`/`--check-admissibility`) vs a plain assertion, across the same trials."
  );
  lines.push("");
  lines.push("| Fixture | Profile | Trials | Kill rate | False-alarm rate | Contract compliance | Mean kill rate | Killed by kind (assertion/invariant) | Median wall time |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const fixture of input.fixtures) {
    for (const profile of profiles) {
      const cell = cells.find((item) => item.fixture === fixture && item.profile === profile);
      if (!cell) continue;
      const killedByKind = cell.killedByKind ? `${cell.killedByKind.assertion}/${cell.killedByKind.invariant}` : "n/a";
      lines.push(
        `| \`${fixture}\` | \`${profile}\` | ${cell.trials} | ${percent(cell.killRate)} | ${percent(cell.falseAlarmRate)} | ${percent(cell.contractComplianceRate)} | ${percent(cell.meanKillRate)} | ${killedByKind} | ${seconds(cell.medianWallTimeMs)} |`
      );
    }
  }
  lines.push("");
  lines.push("## Paired delta by fixture");
  lines.push("");
  lines.push(...pairedDeltaTable(cells, input.fixtures, profiles));
  lines.push("");
  lines.push("## Per-trial evidence");
  lines.push("");
  lines.push(
    "Every aggregate above is computed from exactly these trials; each row's artifacts directory holds the seed-root (post-run), manifest.json, score.json, and the container's captured stdout/stderr."
  );
  lines.push("");
  lines.push(
    "Turns/LLM time come from dsh's own session-persistence JSONL log, folded by server/evals/dsh-session-stats.ts (a direct port of dsh's `sessionStats` projection) - \"n/a\" means the trial's session captured no readable telemetry, not that it took zero turns."
  );
  lines.push("");
  lines.push("| Fixture | Profile | Trial | Outcome | Killed | False alarms | Contract OK | Integrity OK | Transcript audit | Turns | LLM time | Wall time | Artifacts |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const sorted = [...input.trials].sort(
    (a, b) => a.fixture.localeCompare(b.fixture) || a.profile.localeCompare(b.profile) || a.trial - b.trial
  );
  for (const trial of sorted) {
    const auditCell = trial.transcriptAuditHits.length ? `${trial.transcriptAuditHits.length} hit(s): ${trial.transcriptAuditHits.join(", ")}` : "clean";
    lines.push(
      `| \`${trial.fixture}\` | \`${trial.profile}\` | ${trial.trial} | ${classifyDshOutcome(trial)} | ${trial.killed === null ? "n/a" : trial.killed} | ${trial.falseAlarms ?? "n/a"} | ${trial.contractOk === null ? "n/a" : trial.contractOk} | ${trial.integrityOk} | ${auditCell} | ${trial.sessionStats?.turns ?? "n/a"} | ${seconds(trial.sessionStats?.llmMs)} | ${seconds(trial.wallTimeMs)} | \`${trial.artifactsDir}\` |`
    );
  }
  lines.push("");
  return lines.join("\n");
}
