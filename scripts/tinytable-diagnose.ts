/**
 * #174 (TrialDiagnosis v0): CLI driver for server/evals/trial-diagnosis.ts.
 * A thin, opt-in post-hoc stage - it never runs a trial itself, only reads
 * what scripts/dsh-evals-demo.ts already wrote to a trial's artifactsDir
 * (manifest.json, transcript.ndjson, agent-root/sql-tests/agent/*.test) and
 * writes a sibling trial-diagnosis.json next to them. dsh-report.ts picks
 * that file up automatically the next time a report is built (see
 * writeReport() in dsh-evals-demo.ts) - this driver's own flow is otherwise
 * unmodified/unbroken by #174.
 *
 * Usage:
 *   node --import tsx scripts/tinytable-diagnose.ts <trial-id-or-path>
 *   node --import tsx scripts/tinytable-diagnose.ts m01-baseline-1 --out ./dsh-evals-report
 *
 * Options:
 *   --out <dir>   Report directory to resolve a bare trial id against (default
 *                 ./dsh-evals-report) - reads <out>/state.json, same convention
 *                 dsh-evals-demo.ts's --out uses. Ignored if the positional
 *                 argument is already a directory.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { diagnoseTrial, extractProbeShape, PRIVATE_REQUIRED_PROBE_SHAPES } from "../server/evals/trial-diagnosis.js";
import { classifyDshOutcome } from "../server/evals/dsh-report.js";
import { parseTranscript } from "../server/evals/kill-attribution.js";
import type { TranscriptLine } from "../server/evals/dsh-transcript.js";

type StateFileTrial = {
  trialId: string;
  artifactsDir: string;
  killed: boolean | null;
  falseAlarms: number | null;
  contractOk: boolean | null;
  integrityOk: boolean;
  transcriptAuditHits: unknown[];
  blockedReason?: string;
  error?: string;
};

function isDirectory(entryStat: { isDirectory: () => boolean } | null): boolean {
  return entryStat !== null && entryStat.isDirectory();
}

async function resolveArtifactsDir(positional: string, outDir: string): Promise<string> {
  const asPath = resolve(positional);
  const stat = await import("node:fs/promises")
    .then((fs) => fs.stat(asPath))
    .catch(() => null);
  if (isDirectory(stat)) return asPath;

  const statePath = join(resolve(outDir), "state.json");
  const raw = await readFile(statePath, "utf8").catch(() => {
    throw new Error(`"${positional}" is not a directory, and no state.json found at ${statePath} to resolve it as a trial id`);
  });
  const state = JSON.parse(raw) as { trials: StateFileTrial[] };
  const trial = state.trials.find((t) => t.trialId === positional);
  if (!trial) throw new Error(`No trial with trialId "${positional}" found in ${statePath}`);
  return resolve(trial.artifactsDir);
}

/**
 * `sql-tests/agent/*.test`'s grammar (SPEC.md "Test Script Format"):
 * blank-line-separated records, `#`-prefixed comment lines, an optional
 * leading `version N` line. Returns each non-empty, comment-stripped record
 * verbatim - including its `statement ok`/`statement error [substring]`
 * header when present - which is exactly the shape
 * `extractProbeShape`'s `sqlStatements` parameter expects (see that
 * function's own doc-comment for why the header must be preserved).
 */
function splitTestFileRecords(content: string): string[] {
  const withoutVersionLine = content.replace(/^\s*version\s+\d+\s*\r?\n/, "");
  return withoutVersionLine
    .split(/\r?\n\s*\r?\n/)
    .map((record) =>
      record
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n")
        .trim()
    )
    .filter((record) => record.length > 0);
}

async function collectSqlStatements(artifactsDir: string): Promise<string[]> {
  // Oracle mode's agent-root is where the agent's own sql-tests/agent live;
  // source/bytecode mode uses seed-root directly - try both, same fallback
  // shape scripts/tinytable-seed-root-builder.ts's own copyBackAgentArtifacts
  // documents.
  const candidateRoots = [join(artifactsDir, "agent-root"), join(artifactsDir, "seed-root")];
  for (const root of candidateRoots) {
    const agentTestsDir = join(root, "sql-tests", "agent");
    const files = await walkTestFiles(agentTestsDir);
    if (files.length > 0) {
      const statements: string[] = [];
      for (const file of files) {
        const content = await readFile(file, "utf8");
        statements.push(...splitTestFileRecords(content));
      }
      return statements;
    }
  }
  return [];
}

async function walkTestFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkTestFiles(full)));
    else if (entry.name.endsWith(".test")) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let positional: string | null = null;
  let outDir = "./dsh-evals-report";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error("Missing value for --out");
      outDir = value;
    } else if (!arg.startsWith("--") && positional === null) {
      positional = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  if (positional === null) throw new Error("Usage: tinytable-diagnose.ts <trial-id-or-path> [--out <dir>]");

  const artifactsDir = await resolveArtifactsDir(positional, outDir);

  const manifestRaw = await readFile(join(artifactsDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as { operatorId?: string };
  const operatorId = manifest.operatorId ?? "";

  const transcriptText = await readFile(join(artifactsDir, "transcript.ndjson"), "utf8").catch(() => "");
  const transcript: TranscriptLine[] = transcriptText ? parseTranscript(transcriptText) : [];

  const sqlStatements = await collectSqlStatements(artifactsDir);

  const scoreRaw = await readFile(join(artifactsDir, "score.json"), "utf8").catch(() => null);
  const score = scoreRaw ? (JSON.parse(scoreRaw) as { killed?: boolean; false_alarms?: number; contract_ok?: boolean; error?: string }) : null;
  const outcome = score
    ? classifyDshOutcome({
        integrityOk: true,
        transcriptAuditHits: [],
        blockedReason: undefined,
        killed: score.killed ?? null,
        falseAlarms: score.false_alarms ?? null,
        contractOk: score.contract_ok ?? null,
        error: score.error
      })
    : "driver_error";

  const observed = extractProbeShape(transcript, sqlStatements);
  const required = PRIVATE_REQUIRED_PROBE_SHAPES[operatorId] ?? {};
  // "feature" (#174 §7's output contract) has no dedicated field upstream
  // today - operatorId is the closest stable identifier a report reader can
  // trace back to vendor/tinytable-evals's mutate.OPERATORS, so it's used
  // directly rather than inventing a second, looser taxonomy here.
  const diagnosis = diagnoseTrial(observed, required, { trialId: positional, outcome, feature: operatorId || "unknown" }, []);

  const outPath = join(artifactsDir, "trial-diagnosis.json");
  await writeFile(
    outPath,
    JSON.stringify(
      {
        trial_id: diagnosis.trialId,
        outcome: diagnosis.outcome,
        feature: diagnosis.feature,
        observed_probe_shapes: diagnosis.observedProbeShapes,
        required_probe_shapes: diagnosis.requiredProbeShapes,
        capability_gaps: diagnosis.capabilityGaps,
        evidence: diagnosis.evidence
      },
      null,
      2
    ) + "\n"
  );
  console.log(`Wrote ${outPath} (${diagnosis.capabilityGaps.length} capability gap(s): ${diagnosis.capabilityGaps.join(", ") || "none"}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
