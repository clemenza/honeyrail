/**
 * Drives the "Demo1: DSH x test-engineering trial-evals" fixture matrix
 * (#87-#93): (fixtures x profiles x trials) scored dsh-testengineer-trial
 * cells, then aggregates them into a Markdown comparison report via
 * server/evals/dsh-report.ts.
 *
 * Per #93's P0 amendment (following the #103 postmortem: an agent escaped
 * its sandbox and read examples/tinytable-eval's answer key straight off
 * the shared host filesystem), a scored cell never becomes a registered
 * honeyrail project or a HoneyRail Run - it goes straight through the
 * three-zone design:
 *   1. #104's buildSeedRoot() materializes an answer-free seed-root for the
 *      chosen mutant.
 *   2. #106's findManifestMismatches() preflight-checks that seed-root
 *      against its own manifest before launch (defense in depth - the
 *      builder should already guarantee this).
 *   3. #105's runInExamRoom() runs dsh inside an isolated container with
 *      only that seed-root mounted.
 *   4. The same #106 check re-verifies the seed-root's protected files
 *      afterward - the actual #103 integrity check - and #107's transcript
 *      audit (server/evals/transcript-audit.ts) scans the container's
 *      captured output and the agent's artifacts for references to
 *      material outside the exam room. Either forces outcome "invalidated"
 *      regardless of what score.py itself reports.
 *   5. score.py (run on the host, the grader zone) produces the real
 *      kill/false-alarm/contract verdict, plus a #107 kill matrix - the
 *      same sql-tests/agent/ suite replayed against every other mutant in
 *      the private pool (never mounted into the exam room), quantifying
 *      "spray and pray" hedging.
 *
 * Budget note: every cell launches a real dsh CLI session against a real
 * model API. The full default matrix is 8 fixtures x 2 profiles x 3 trials
 * = 48 dsh runs. Always start with --smoke (2 fixtures x 2 profiles x 1
 * trial = 4 runs) to validate the setup.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... node --import tsx scripts/dsh-evals-demo.ts --smoke
 *   node --import tsx scripts/dsh-evals-demo.ts --out ./dsh-evals-report
 *   node --import tsx scripts/dsh-evals-demo.ts --report-only --out ./dsh-evals-report
 *
 * Options:
 *   --out <dir>                 Output directory for state.json + comparison-report.md (default ./dsh-evals-report)
 *   --image <tag>                Exam-room image (default tinytable-exam-room:latest - see docker/tinytable-exam-room/Dockerfile)
 *   --fixtures <id,id>            Subset of mutant ids (default: every mutants/mNN under examples/tinytable-eval)
 *   --profiles <label=path,...>   cordis.patch.yml variants (default baseline/candidate fixtures under examples/tinytable-eval/profiles)
 *   --trials <n>                  Trials per (fixture, profile) cell (default 3)
 *   --trial-timeout-minutes <n>   Per-trial container timeout before killing it (default 15)
 *   --smoke                       2 fixtures x 2 profiles x 1 trial - cheap end-to-end validation
 *   --dry-run                     Print the matrix and budget note, launch nothing
 *   --report-only                 Skip execution; rebuild the report from state.json
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBlockedReason, withUnattendedPreamble } from "../server/agents/common.js";
import { dshAdapter } from "../server/agents/dsh.js";
import { buildDshComparisonReport, classifyDshOutcome, type DshComparisonReportInput, type DshTrialRecord } from "../server/evals/dsh-report.js";
import { describeManifestMismatch, findManifestMismatches } from "../server/evals/manifest-preflight.js";
import { auditTranscript } from "../server/evals/transcript-audit.js";
import { runCommandSafe } from "../server/utils.js";
import { buildSeedRoot, type SeedRootManifest } from "./tinytable-seed-root-builder.js";
import { DEFAULT_IMAGE, runInExamRoom } from "./tinytable-exam-room.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tinytableEvalDir = resolve(__dirname, "..", "examples", "tinytable-eval");
const profilesDir = join(tinytableEvalDir, "profiles");
const scorePyPath = join(tinytableEvalDir, "score.py");
const cleanDir = join(tinytableEvalDir, "clean");
const taskPromptPath = join(tinytableEvalDir, "task-prompt.md");
// #107: the private mutant pool score.py's --kill-matrix-pool replays the
// agent's suite against. Grader-only (host-side) - never mounted into the
// exam room; #104's buildSeedRoot() only ever materializes one mutant's
// tinytable/ into the seed-root the container actually sees.
const mutantsDir = join(tinytableEvalDir, "mutants");

const PROFILE_PATCH_FILENAME = "cordis.patch.yml";

type ProfileSpec = { label: string; content: string; sha256: string };
type CliOptions = {
  out: string;
  image: string;
  fixtureIds?: string[];
  profileArgs?: string[];
  trials: number;
  trialTimeoutMinutes: number;
  smoke: boolean;
  dryRun: boolean;
  reportOnly: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    out: "./dsh-evals-report",
    image: DEFAULT_IMAGE,
    trials: 3,
    trialTimeoutMinutes: 15,
    smoke: false,
    dryRun: false,
    reportOnly: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const value = argv[i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--out": options.out = next(); break;
      case "--image": options.image = next(); break;
      case "--fixtures": options.fixtureIds = next().split(",").map((id) => id.trim()).filter(Boolean); break;
      case "--profiles": options.profileArgs = next().split(",").map((pair) => pair.trim()).filter(Boolean); break;
      case "--trials": options.trials = Number(next()); break;
      case "--trial-timeout-minutes": options.trialTimeoutMinutes = Number(next()); break;
      case "--smoke": options.smoke = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--report-only": options.reportOnly = true; break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/dsh-evals-demo.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error("--trials must be a positive integer");
  if (!Number.isFinite(options.trialTimeoutMinutes) || options.trialTimeoutMinutes < 1) {
    throw new Error("--trial-timeout-minutes must be >= 1");
  }
  return options;
}

async function loadFixtures(options: CliOptions): Promise<string[]> {
  const mutantsDir = join(tinytableEvalDir, "mutants");
  const allFixtures = (await readdir(mutantsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  let fixtures = allFixtures;
  if (options.fixtureIds?.length) {
    fixtures = options.fixtureIds.map((id) => {
      if (!allFixtures.includes(id)) throw new Error(`Unknown fixture id "${id}" (known: ${allFixtures.join(", ")})`);
      return id;
    });
  }
  if (options.smoke) fixtures = fixtures.slice(0, 2);
  return fixtures;
}

async function loadProfiles(options: CliOptions): Promise<ProfileSpec[]> {
  const pairs = options.profileArgs?.length
    ? options.profileArgs.map((pair) => {
        const separator = pair.indexOf("=");
        if (separator < 1) throw new Error(`--profiles entries must be label=path, got "${pair}"`);
        return { label: pair.slice(0, separator), file: resolve(pair.slice(separator + 1)) };
      })
    : [
        { label: "baseline", file: join(profilesDir, "baseline.cordis.patch.yml") },
        { label: "candidate", file: join(profilesDir, "candidate.cordis.patch.yml") }
      ];
  const profiles = await Promise.all(
    pairs.map(async ({ label, file }) => {
      const content = await readFile(file, "utf8");
      return { label, content, sha256: createHash("sha256").update(content).digest("hex") };
    })
  );
  if (options.smoke) return profiles.slice(0, 2);
  return profiles;
}

async function gitInitCommit(repoPath: string): Promise<void> {
  // score.py's own docstring requires the worktree to already be "its own
  // git repository, freshly committed before the agent touched it" - its
  // protected-path check (step 3, `_check_protected_paths_untouched`) runs
  // `git status` and reports "not a git repository" (failing contract_ok)
  // otherwise. #104's buildSeedRoot() deliberately doesn't do this (it's a
  // builder-zone concern, not the exam room's), so the driver does it here,
  // right before handing the seed-root to the container.
  await runCommandSafe("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
  await runCommandSafe(
    "git",
    ["-c", "user.name=dsh-evals-demo", "-c", "user.email=dsh-evals-demo@localhost", "add", "-A"],
    { cwd: repoPath }
  );
  await runCommandSafe(
    "git",
    ["-c", "user.name=dsh-evals-demo", "-c", "user.email=dsh-evals-demo@localhost", "commit", "-q", "-m", "seed"],
    { cwd: repoPath }
  );
}

export type ScoreJson = {
  killed: boolean;
  false_alarms: number;
  contract_ok: boolean;
  passed: boolean;
  /** #107: null unless --kill-matrix-pool was passed. */
  kill_matrix: Record<string, boolean> | null;
};

// #114: score.py's own JSON output always includes a literal "error" key
// (null on success - see examples/tinytable-eval/score.py's `result` dict),
// so a plain `ScoreJson | { error: string }` union with an `"error" in x`
// discriminant is unsound: `JSON.parse(raw) as ScoreJson` doesn't strip
// score.py's extra fields at runtime, so that check is true for *every*
// successfully-parsed score.json, not just the driver's own failure
// sentinel - the actual score (killed/false_alarms/contract_ok) was being
// silently discarded and every trial misreported as driver_error, whether
// it actually passed or not. `ok` can't collide with anything score.py's
// schema will ever name, unlike `error`.
export type RunScorePyResult = { ok: true; score: ScoreJson } | { ok: false; error: string };

// `run` defaults to the real subprocess call; overridable so tests can
// exercise the read/parse/discriminate logic (the actual site of #114's
// bug) against a pre-written score.json without needing python3 or a real
// tinytable-eval fixture on disk.
export async function runScorePy(
  worktreePath: string,
  run: typeof runCommandSafe = runCommandSafe
): Promise<RunScorePyResult> {
  const result = await run("python3", [
    scorePyPath,
    "--worktree", worktreePath,
    "--clean", cleanDir,
    "--out", "score.json",
    "--kill-matrix-pool", mutantsDir
  ]);
  try {
    const raw = await readFile(join(worktreePath, "score.json"), "utf8");
    return { ok: true, score: JSON.parse(raw) as ScoreJson };
  } catch {
    return { ok: false, error: `score.py produced no score.json (exit ${result.code}): ${(result.stderr || result.stdout).slice(-2000)}` };
  }
}

/** #107 transcript audit: everything the agent produced or said, gathered for auditTranscript(). */
async function gatherAuditableText(seedRootDir: string, containerLog: string): Promise<string> {
  const parts = [containerLog];
  const findingsPath = join(seedRootDir, "findings.json");
  const agentTestsDir = join(seedRootDir, "sql-tests", "agent");
  parts.push(await readFile(findingsPath, "utf8").catch(() => ""));
  const testFiles = await readdir(agentTestsDir, { recursive: true }).catch(() => [] as string[]);
  for (const name of testFiles) {
    const content = await readFile(join(agentTestsDir, name), "utf8").catch(() => "");
    if (content) parts.push(content);
  }
  return parts.join("\n");
}

async function executeCell(
  options: CliOptions,
  taskPrompt: string,
  fixture: string,
  profile: ProfileSpec,
  trial: number,
  cellsDir: string
): Promise<DshTrialRecord> {
  const trialId = `${fixture}-${profile.label}-${trial}`;
  const artifactsDir = join(cellsDir, trialId);
  const seedRootDir = join(artifactsDir, "seed-root");
  const base: Pick<DshTrialRecord, "fixture" | "profile" | "trial" | "trialId" | "artifactsDir"> = {
    fixture, profile: profile.label, trial, trialId, artifactsDir
  };

  let manifest: SeedRootManifest;
  try {
    await mkdir(artifactsDir, { recursive: true });
    manifest = await buildSeedRoot({ mutantId: fixture, outDir: seedRootDir });
    await writeFile(join(artifactsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  } catch (error) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk: false, transcriptAuditHits: [], killMatrix: null, error: (error as Error).message };
  }

  const preflightMismatches = await findManifestMismatches(seedRootDir, { files: manifest.files });
  if (preflightMismatches.length) {
    return {
      ...base,
      killed: null,
      falseAlarms: null,
      contractOk: null,
      integrityOk: false,
      transcriptAuditHits: [],
      killMatrix: null,
      error: `#106 preflight: freshly-built seed-root doesn't match its own manifest: ${preflightMismatches.map(describeManifestMismatch).join("; ")}`
    };
  }

  await gitInitCommit(seedRootDir);
  await writeFile(join(seedRootDir, PROFILE_PATCH_FILENAME), profile.content);

  const prompt = withUnattendedPreamble(taskPrompt);
  const startedAt = Date.now();
  const result = await runInExamRoom({
    seedRootDir,
    image: options.image,
    command: ["dsh", "--profile", "headless", "--patch", PROFILE_PATCH_FILENAME, prompt],
    env: {
      ...(process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
      // #115: dsh's default `workspace-write` mode makes its own tool-bash
      // build a nested sandbox for every command, which needs to mount a
      // fresh /proc - blocked by Docker's default seccomp profile
      // regardless of --cap-drop/--security-opt, so bash is completely
      // unusable inside this container otherwise. The exam-room container
      // itself (--cap-drop=ALL, --read-only, only the seed-root mounted -
      // see scripts/tinytable-exam-room.ts) is already the real security
      // boundary for a scored trial, so dsh's own redundant nested sandbox
      // is unnecessary here, not just broken.
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "danger-full-access"
    },
    timeoutMs: options.trialTimeoutMinutes * 60_000
  });
  const wallTimeMs = Date.now() - startedAt;
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  await writeFile(join(artifactsDir, "container.log"), `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`);

  // #107 transcript audit: whatever the agent said (container output) and
  // wrote (findings.json, its .test files, if it got that far) - run once,
  // reused across every return path below, since it costs nothing beyond
  // an in-memory regex pass and a run that fails early still deserves the
  // same scrutiny as one that completes.
  const auditableText = await gatherAuditableText(seedRootDir, combinedOutput);
  const transcriptAuditHits = auditTranscript(auditableText).map((hit) => hit.pattern);
  if (transcriptAuditHits.length) {
    console.error(`  ${trialId}: TRANSCRIPT AUDIT HIT(S): ${transcriptAuditHits.join(", ")}`);
  }

  if (result.timedOut) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk: true, transcriptAuditHits, killMatrix: null, wallTimeMs, error: `trial timed out after ${options.trialTimeoutMinutes}m and was killed` };
  }
  const fatal = dshAdapter.findFatalError?.(combinedOutput);
  if (fatal) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk: true, transcriptAuditHits, killMatrix: null, wallTimeMs, error: `dsh fatal error (${fatal.code}): ${fatal.message}` };
  }
  const blocked = findBlockedReason(combinedOutput);

  const scoreOrError = await runScorePy(seedRootDir);
  const postMismatches = await findManifestMismatches(seedRootDir, { files: manifest.files });
  const integrityOk = postMismatches.length === 0;
  if (!integrityOk) {
    console.error(`  ${trialId}: INTEGRITY FAILURE - protected fixture files changed: ${postMismatches.map(describeManifestMismatch).join("; ")}`);
  }

  if (!scoreOrError.ok) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk, transcriptAuditHits, killMatrix: null, wallTimeMs, blockedReason: blocked?.message, error: scoreOrError.error };
  }

  return {
    ...base,
    killed: scoreOrError.score.killed,
    falseAlarms: scoreOrError.score.false_alarms,
    contractOk: scoreOrError.score.contract_ok,
    integrityOk,
    transcriptAuditHits,
    killMatrix: scoreOrError.score.kill_matrix,
    wallTimeMs,
    blockedReason: blocked?.message
  };
}

type StateFile = {
  config: { image: string; smoke: boolean; dshVersion: string };
  profiles: Array<{ label: string; sha256: string }>;
  fixtures: string[];
  trials: DshTrialRecord[];
};

async function fingerprintDshVersion(image: string): Promise<string> {
  const scratchDir = await mkdtemp(join(tmpdir(), "dsh-evals-fingerprint-"));
  const result = await runInExamRoom({ seedRootDir: scratchDir, image, command: ["dsh", "--version"], timeoutMs: 30_000 });
  return result.stdout.trim() || "(unknown)";
}

async function writeReport(outDir: string, state: StateFile): Promise<string> {
  const profilePaths = new Map(state.profiles.map((p) => [p.label, join(profilesDir, `${p.label}.cordis.patch.yml`)]));
  const input: DshComparisonReportInput = {
    generatedAt: new Date().toISOString(),
    dshVersion: state.config.dshVersion,
    image: state.config.image,
    smoke: state.config.smoke,
    profiles: state.profiles.map((p) => ({ label: p.label, path: profilePaths.get(p.label) || PROFILE_PATCH_FILENAME, sha256: p.sha256 })),
    fixtures: state.fixtures,
    trials: state.trials
  };
  const reportPath = join(outDir, "comparison-report.md");
  await writeFile(reportPath, buildDshComparisonReport(input));
  return reportPath;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const statePath = join(outDir, "state.json");

  if (options.reportOnly) {
    const state = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
    const reportPath = await writeReport(outDir, state);
    console.log(`Report rebuilt from ${statePath}: ${reportPath}`);
    return;
  }

  const fixtures = await loadFixtures(options);
  const profiles = await loadProfiles(options);
  const trialsPerCell = options.smoke ? 1 : options.trials;
  const totalRuns = fixtures.length * profiles.length * trialsPerCell;

  console.log(`Matrix: ${fixtures.length} fixtures x ${profiles.length} profiles x ${trialsPerCell} trials = ${totalRuns} dsh runs.`);
  console.log(`Budget note: each run launches a real dsh CLI session against a real model API (typically a few cents to tens of cents and 1-10 minutes each). Use --smoke to validate cheaply first.`);
  if (options.dryRun) {
    for (const fixture of fixtures) {
      for (const profile of profiles) {
        for (let trial = 1; trial <= trialsPerCell; trial += 1) {
          console.log(`  would run: ${fixture}/${profile.label}/trial-${trial}`);
        }
      }
    }
    return;
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn("Warning: DEEPSEEK_API_KEY is not set - every trial will hit dsh's MISSING_CREDENTIAL fatal error and be recorded as driver_error.");
  }

  console.log("Fingerprinting dsh version inside the exam-room image...");
  const dshVersion = await fingerprintDshVersion(options.image);
  console.log(`dsh ${dshVersion} (image ${options.image})`);

  const taskPrompt = await readFile(taskPromptPath, "utf8");
  const cellsDir = join(outDir, "cells");
  await mkdir(cellsDir, { recursive: true });

  const state: StateFile = {
    config: { image: options.image, smoke: options.smoke, dshVersion },
    profiles: profiles.map(({ label, sha256 }) => ({ label, sha256 })),
    fixtures,
    trials: []
  };

  // Sequential on purpose, mirroring scripts/evals-ab-demo.ts (#25): keeps
  // driver-side resource usage (docker containers, host CPU for score.py)
  // bounded and cell logs easy to follow; parallelizing across containers
  // is safe to add later since each cell is fully isolated from the others.
  for (const fixture of fixtures) {
    for (const profile of profiles) {
      for (let trial = 1; trial <= trialsPerCell; trial += 1) {
        const label = `${fixture}/${profile.label}/trial-${trial}`;
        console.log(`Cell ${label} (${state.trials.length + 1}/${totalRuns}):`);
        const record = await executeCell(options, taskPrompt, fixture, profile, trial, cellsDir);
        state.trials.push(record);
        console.log(`  ${label} finished: outcome=${classifyDshOutcome(record)} killed=${record.killed} falseAlarms=${record.falseAlarms} contractOk=${record.contractOk} integrityOk=${record.integrityOk}${record.blockedReason ? ` blocked="${record.blockedReason}"` : ""}${record.error ? ` error="${record.error}"` : ""}`);
        await writeFile(statePath, JSON.stringify(state, null, 2));
      }
    }
  }

  const reportPath = await writeReport(outDir, state);
  console.log(`State: ${statePath}`);
  console.log(`Report: ${reportPath}`);
}

// #114: without this guard, merely *importing* this module (e.g. from a
// test that wants to exercise runScorePy() in isolation) unconditionally
// launched the full 48-run production matrix against real dsh/model-API
// calls - discovered exactly that way while adding this file's own
// regression test. Same pattern as scripts/tinytable-exam-room.ts.
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
