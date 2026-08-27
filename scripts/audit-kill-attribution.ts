/**
 * #148: walks every `dsh-evals-report-*` directory's `state.json` and, for
 * each trial that has a `transcript.ndjson` (#144/#146), classifies how a
 * *killed* trial actually found the seeded defect - test-driven, code-
 * review, black-box reasoning, or invalid (a leak/oracle-exploit channel) -
 * via server/evals/kill-attribution.ts's `classifyKillAttribution()`. Every
 * trial with a transcript is also leak-scanned regardless of outcome (#148
 * AC3), since a non-killed trial's transcript is just as capable of
 * revealing an information leak as a killed one.
 *
 * No new trials are run - this is a pure re-read of whatever
 * `dsh-evals-report-*`/`transcript.ndjson` data already exists locally
 * (#144/#146 made that artifact reliable; before that fix it never
 * existed, so older report directories - #130/#134/#136's - show up as
 * "no transcript" rather than throwing).
 *
 * Usage:
 *   node --import tsx scripts/audit-kill-attribution.ts
 *   node --import tsx scripts/audit-kill-attribution.ts --glob "dsh-evals-report-*" --out ./audit-kill-attribution.md
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyKillAttribution,
  loadOperatorMetadata,
  parseTranscript,
  type AttributionResult,
  type Channel,
  type OperatorMeta
} from "../server/evals/kill-attribution.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultVendorDir = resolve(repoRoot, "vendor", "tinytable-evals");

type CliOptions = { root: string; glob: string; out: string; vendorDir: string };

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { root: repoRoot, glob: "dsh-evals-report-*", out: resolve(repoRoot, "audit-kill-attribution.md"), vendorDir: defaultVendorDir };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--root": options.root = resolve(next()); break;
      case "--glob": options.glob = next(); break;
      case "--out": options.out = resolve(next()); break;
      case "--vendor-dir": options.vendorDir = resolve(next()); break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/audit-kill-attribution.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

/** Minimal single-`*`-wildcard glob, sufficient for "dsh-evals-report-*" - not a general glob implementation. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`);
}

type StateFileTrial = { fixture: string; profile: string; trialId: string; artifactsDir: string; killed: boolean | null };
type StateFile = { trials: StateFileTrial[] };

async function findReportDirs(root: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort();
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

type TrialAudit = {
  reportDir: string;
  trialId: string;
  fixture: string;
  profile: string;
  operatorId: string | null;
  family: string | null;
  killed: boolean | null;
  hasTranscript: boolean;
  attribution: AttributionResult | null; // null when not killed, or no transcript
};

async function auditTrial(reportDir: string, trial: StateFileTrial, operators: Map<string, OperatorMeta>): Promise<TrialAudit> {
  const manifest = await readJson<{ operatorId?: string; seed?: number }>(join(trial.artifactsDir, "manifest.json"));
  const operatorId = manifest?.operatorId ?? null;
  const operator = operatorId ? operators.get(operatorId) ?? null : null;

  const transcriptPath = join(trial.artifactsDir, "transcript.ndjson");
  const transcriptText = await readFile(transcriptPath, "utf8").catch(() => null);
  const base = { reportDir, trialId: trial.trialId, fixture: trial.fixture, profile: trial.profile, operatorId, family: operator?.family ?? null, killed: trial.killed };

  if (transcriptText === null) {
    return { ...base, hasTranscript: false, attribution: null };
  }
  const lines = parseTranscript(transcriptText);
  // Always classified, regardless of `killed` - AC3 wants every trial's
  // transcript leak-scanned. `channel` (test-driven/code-review/...) is
  // only meaningful for killed trials; the report layer below only reads
  // it for those, but leakHits/oracleHits are used for every trial.
  const attribution = classifyKillAttribution(lines, operator);
  return { ...base, hasTranscript: true, attribution };
}

function buildReport(audits: TrialAudit[]): string {
  const withTranscript = audits.filter((a) => a.hasTranscript);
  const withoutTranscript = audits.filter((a) => !a.hasTranscript);
  const killed = withTranscript.filter((a) => a.killed === true);

  const channelCounts = new Map<string, number>();
  for (const a of killed) {
    const ch = a.attribution?.channel ?? "unattributable";
    channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push("# Kill attribution audit (#148)");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}. ${audits.length} trials scanned across all matched report directories; ${withTranscript.length} had a \`transcript.ndjson\`, ${withoutTranscript.length} did not (predate #144/#146's fix, or the mount never captured a session log).`);
  lines.push("");

  lines.push("## Channel shares (killed trials with a transcript)");
  lines.push("");
  lines.push(`${killed.length} killed trial(s) with transcript data.`);
  lines.push("");
  lines.push("| channel | count | share |");
  lines.push("| --- | --- | --- |");
  const channelOrder: Channel[] = ["test-driven", "code-review", "black-box-reasoning", "leak", "oracle-exploit", "unattributable"];
  for (const ch of channelOrder) {
    const count = channelCounts.get(ch) ?? 0;
    const share = killed.length > 0 ? `${((count / killed.length) * 100).toFixed(0)}%` : "n/a";
    lines.push(`| ${ch} | ${count} | ${share} |`);
  }
  lines.push("");

  const families = [...new Set(killed.map((a) => a.family))].sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  if (families.length > 1 || (families.length === 1 && families[0] !== null)) {
    lines.push("## Channel shares by operator family (Gen2 only - Gen1 operators have no family)");
    lines.push("");
    lines.push(`| family | ${channelOrder.join(" | ")} | n |`);
    lines.push(`| --- | ${channelOrder.map(() => "---").join(" | ")} | --- |`);
    for (const family of families) {
      const inFamily = killed.filter((a) => a.family === family);
      const counts = channelOrder.map((ch) => inFamily.filter((a) => (a.attribution?.channel ?? "unattributable") === ch).length);
      lines.push(`| ${family ?? "(Gen1, no family)"} | ${counts.join(" | ")} | ${inFamily.length} |`);
    }
    lines.push("");
  }

  lines.push("## Decision rule (per #148)");
  lines.push("");
  const leakCount = channelCounts.get("leak") ?? 0;
  const codeReviewShare = killed.length > 0 ? (channelCounts.get("code-review") ?? 0) / killed.length : 0;
  if (leakCount > 0) {
    lines.push(`- **leak > 0 on ${leakCount} trial(s)** - those trials' kill counts need a correction note wherever they're cited (e.g. #145), and should be excluded from tinytable-evals#38's ceiling-effect data. See "Leak-scanned trials" below for which ones.`);
  } else {
    lines.push("- No leak-channel trials found in this scan.");
  }
  if (killed.length > 0) {
    if (codeReviewShare >= 0.3) {
      lines.push(`- **code-review share is ${(codeReviewShare * 100).toFixed(0)}% (>= 30%)** - per #148, black-box mode (source hidden, API/CLI only) becomes P0 ahead of any further operator work and ahead of tinytable-evals#64's full calibration protocol.`);
    } else {
      lines.push(`- code-review share is ${(codeReviewShare * 100).toFixed(0)}% (< 30%) - the ceiling looks real under white-box conditions in this sample; proceed with multi-mutant scoring and keep white-box, per #148's decision rule.`);
    }
  } else {
    lines.push("- No killed trials with transcript data to evaluate the code-review threshold against.");
  }
  lines.push("");

  lines.push("## Leak/oracle-exploit scan (every trial with a transcript, killed or not - #148 AC3)");
  lines.push("");
  lines.push("| trial | report dir | operator | killed | leak hits | oracle hits | channel |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const a of withTranscript) {
    const leakN = a.attribution?.leakHits.length ?? 0;
    const oracleN = a.attribution?.oracleHits.length ?? 0;
    if (leakN === 0 && oracleN === 0 && a.killed !== true) continue; // keep the table focused on killed trials + any hit at all
    const channel = a.killed === true ? a.attribution?.channel ?? "n/a" : "n/a (not killed)";
    lines.push(`| ${a.trialId} | ${a.reportDir} | ${a.operatorId ?? "?"} | ${String(a.killed)} | ${leakN} | ${oracleN} | ${channel} |`);
  }
  lines.push("");

  lines.push("## Per-trial detail (killed trials only)");
  lines.push("");
  lines.push("| trial | report dir | operator | channel | claim matched by | t_claim | t_first_fail | t_first_source_read |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const a of killed) {
    const attr = a.attribution;
    lines.push(
      `| ${a.trialId} | ${a.reportDir} | ${a.operatorId ?? "?"} | ${attr?.channel ?? "n/a"} | ${attr?.claim?.matchedBy ?? "-"} | ${attr?.claim?.ts ?? "-"} | ${attr?.firstOwnFailingTest?.ts ?? "-"} | ${attr?.firstSourceRead?.ts ?? "-"} |`
    );
  }
  lines.push("");

  if (withoutTranscript.length > 0) {
    lines.push("## Trials with no transcript.ndjson (not classified, not leak-scanned)");
    lines.push("");
    lines.push("| trial | report dir | killed |");
    lines.push("| --- | --- | --- |");
    for (const a of withoutTranscript) {
      lines.push(`| ${a.trialId} | ${a.reportDir} | ${String(a.killed)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pattern = globToRegExp(options.glob);
  const reportDirs = await findReportDirs(options.root, pattern);
  console.log(`Found ${reportDirs.length} report director${reportDirs.length === 1 ? "y" : "ies"} matching "${options.glob}": ${reportDirs.map((d) => d.split("/").pop()).join(", ") || "(none)"}`);

  const operators = await loadOperatorMetadata(options.vendorDir);
  console.log(`Resolved ${operators.size} operator(s) from ${options.vendorDir}`);

  const audits: TrialAudit[] = [];
  for (const reportDir of reportDirs) {
    const state = await readJson<StateFile>(join(reportDir, "state.json"));
    if (state === null || !Array.isArray(state.trials)) {
      console.error(`  skipping ${reportDir}: no readable state.json`);
      continue;
    }
    for (const trial of state.trials) {
      audits.push(await auditTrial(reportDir, trial, operators));
    }
  }

  const report = buildReport(audits);
  await writeFile(options.out, report);
  console.log(`Report: ${options.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
