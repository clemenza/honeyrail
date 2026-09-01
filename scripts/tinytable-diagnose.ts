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

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseTrial, extractProbeShape, encodeTrialDiagnosis, lookupRequiredProbeShape } from "../server/evals/trial-diagnosis.js";
import { classifyDshOutcome, type DshTrialOutcome } from "../server/evals/dsh-report.js";
import { parseTranscript } from "../server/evals/kill-attribution.js";
import { auditTranscript, type TranscriptAuditHit } from "../server/evals/transcript-audit.js";
import { findManifestMismatches } from "../server/evals/manifest-preflight.js";
import { findBlockedReason } from "../server/agents/common.js";
import type { TranscriptLine } from "../server/evals/dsh-transcript.js";

export type StateFileTrial = {
  trialId: string;
  artifactsDir: string;
  killed: boolean | null;
  falseAlarms: number | null;
  contractOk: boolean | null;
  integrityOk: boolean;
  transcriptAuditHits: TranscriptAuditHit[];
  blockedReason?: string;
  error?: string;
};

/** Everything `classifyDshOutcome` needs, reconstructed for a path-only trial that has no `state.json` record (see `resolveTrialOutcome`). */
export type ReconstructedOutcomeInputs = {
  integrityOk: boolean;
  transcriptAuditHits: TranscriptAuditHit[];
  blockedReason?: string;
  killed: boolean | null;
  falseAlarms: number | null;
  contractOk: boolean | null;
  error?: string;
};

/**
 * Review fix (P0): a prior version hard-coded `integrityOk: true`,
 * `transcriptAuditHits: []`, `blockedReason: undefined` when reclassifying a
 * trial's outcome from `score.json` alone - so an invalidated (tampered
 * fixture, or a high-confidence transcript audit hit) or blocked trial could
 * silently reappear here as `passed`/`task_failed`/`verify_failed`, and then
 * get presented as evidence of a genuine capability gap.
 *
 * When a `state.json` trial record is available (the trial id resolved
 * against `--out`), its own already-classified fields are canonical -
 * reused as-is via `classifyDshOutcome`, no re-derivation. Only when
 * resolution was path-only (no matching state.json entry - state.json may
 * not exist, or may predate this trial) does `main()` reconstruct
 * `integrityOk`/`transcriptAuditHits`/`blockedReason` from the trial's own
 * artifacts (manifest.json's protected-file re-check, container.log's
 * transcript audit, container.log's blocked-marker scan) rather than assume
 * a trustworthy default.
 */
export function resolveTrialOutcome(trialRecord: StateFileTrial | null, fallback: ReconstructedOutcomeInputs | null): DshTrialOutcome {
  if (trialRecord) return classifyDshOutcome(trialRecord);
  if (fallback) return classifyDshOutcome(fallback);
  return "driver_error";
}

function isDirectory(entryStat: { isDirectory: () => boolean } | null): boolean {
  return entryStat !== null && entryStat.isDirectory();
}

async function resolveArtifactsDir(positional: string, outDir: string): Promise<{ artifactsDir: string; trialRecord: StateFileTrial | null }> {
  const asPath = resolve(positional);
  const pathStat = await stat(asPath).catch(() => null);
  if (isDirectory(pathStat)) return { artifactsDir: asPath, trialRecord: null };

  const statePath = join(resolve(outDir), "state.json");
  const raw = await readFile(statePath, "utf8").catch(() => {
    throw new Error(`"${positional}" is not a directory, and no state.json found at ${statePath} to resolve it as a trial id`);
  });
  const state = JSON.parse(raw) as { trials: StateFileTrial[] };
  const trial = state.trials.find((t) => t.trialId === positional);
  if (!trial) throw new Error(`No trial with trialId "${positional}" found in ${statePath}`);
  return { artifactsDir: resolve(trial.artifactsDir), trialRecord: trial };
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

/** Same aggregation `scripts/dsh-evals-demo.ts`'s own `gatherAuditableText` performs for a live trial (container output + findings.json + the agent's own .test files) - duplicated here (small, ~10 lines) rather than imported, since that function isn't exported and this is a separate, path-only reconstruction path, not a shared runtime dependency. */
async function gatherAuditableText(seedRootDir: string, containerLog: string): Promise<string> {
  const parts = [containerLog];
  parts.push(await readFile(join(seedRootDir, "findings.json"), "utf8").catch(() => ""));
  const agentTestsDir = join(seedRootDir, "sql-tests", "agent");
  const testFiles = await readdir(agentTestsDir, { recursive: true }).catch(() => [] as string[]);
  for (const name of testFiles) {
    const content = await readFile(join(agentTestsDir, name), "utf8").catch(() => "");
    if (content) parts.push(content);
  }
  return parts.join("\n");
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

  const { artifactsDir, trialRecord } = await resolveArtifactsDir(positional, outDir);

  const manifestRaw = await readFile(join(artifactsDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as { operatorId?: string; files?: Array<{ path: string; sha256: string }> };
  const operatorId = manifest.operatorId ?? "";

  const transcriptText = await readFile(join(artifactsDir, "transcript.ndjson"), "utf8").catch(() => "");
  const transcript: TranscriptLine[] = transcriptText ? parseTranscript(transcriptText) : [];

  const sqlStatements = await collectSqlStatements(artifactsDir);

  let outcome: DshTrialOutcome;
  if (trialRecord) {
    outcome = resolveTrialOutcome(trialRecord, null);
  } else {
    console.warn(
      `No state.json trial record for "${positional}" - reconstructing integrity/audit/blocked state from ${artifactsDir} (best-effort: replicates the protected-file manifest re-check, but not the oracle-mode stray-artifact leak check).`
    );
    const seedRootDir = join(artifactsDir, "seed-root");
    const manifestFiles = manifest.files ?? [];
    const postMismatches = manifestFiles.length ? await findManifestMismatches(seedRootDir, { files: manifestFiles }) : [];
    const containerLog = await readFile(join(artifactsDir, "container.log"), "utf8").catch(() => "");
    const auditableText = await gatherAuditableText(seedRootDir, containerLog);
    const scoreRaw = await readFile(join(artifactsDir, "score.json"), "utf8").catch(() => null);
    const score = scoreRaw ? (JSON.parse(scoreRaw) as { killed?: boolean; false_alarms?: number; contract_ok?: boolean; error?: string }) : null;
    outcome = resolveTrialOutcome(null, {
      integrityOk: postMismatches.length === 0,
      transcriptAuditHits: auditTranscript(auditableText),
      blockedReason: findBlockedReason(containerLog)?.message,
      killed: score?.killed ?? null,
      falseAlarms: score?.false_alarms ?? null,
      contractOk: score?.contract_ok ?? null,
      error: score?.error
    });
  }

  const observed = extractProbeShape(transcript, sqlStatements);
  const { shape: required, evidence } = lookupRequiredProbeShape(operatorId);
  // "feature" (#174 §7's output contract) has no dedicated field upstream
  // today - operatorId is the closest stable identifier a report reader can
  // trace back to vendor/tinytable-evals's mutate.OPERATORS, so it's used
  // directly rather than inventing a second, looser taxonomy here.
  const diagnosis = diagnoseTrial(observed, required, { trialId: positional, outcome, feature: operatorId || "unknown" }, evidence);

  const outPath = join(artifactsDir, "trial-diagnosis.json");
  await writeFile(outPath, JSON.stringify(encodeTrialDiagnosis(diagnosis), null, 2) + "\n");
  const gapSummary = evidence.some((e) => e.kind === "required-shape-unavailable")
    ? "unknown - no required probe shape configured for this operator"
    : diagnosis.capabilityGaps.length
      ? diagnosis.capabilityGaps.join(", ")
      : "none";
  console.log(`Wrote ${outPath} (capability gaps: ${gapSummary}).`);
}

// Guards against running main() as a side effect of import - test/tinytable-diagnose.test.ts
// imports resolveTrialOutcome from this module for direct unit testing, same
// pattern scripts/dsh-evals-demo.ts already uses (and discovered the same way:
// while adding that file's own regression test).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
