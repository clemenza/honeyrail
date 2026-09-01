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
 *      chosen fixture (#126: now a seed into vendor/tinytable-evals's own
 *      generative mutation-operator library, not a static mutant id).
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
 *      regardless of what grade.py itself reports.
 *   5. vendor/tinytable-evals's grade.py (run on the host, the grader zone)
 *      produces the real kill/false-alarm/contract verdict - #126 migrated
 *      this driver onto its probabilistic, multi-run kill-rate scoring
 *      (killRate/killedByKind) in place of the single-run score.py this
 *      repo used to hold a stale copy of. The private-mutant-pool kill
 *      matrix / "spray and pray" hedging signal (#107) has no equivalent
 *      here: vendor/tinytable-evals generates mutants on demand from a seed
 *      and never persists a pool to replay a suite against - see
 *      docs/dsh-evals-demo.md.
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
 *   --fixtures <seed,seed>        Subset of fixture seeds (default: 0..7 - see vendor/tinytable-evals's mutate.OPERATORS)
 *   --profiles <label=path,...>   cordis.patch.yml variants (default baseline/candidate fixtures under examples/tinytable-eval/profiles)
 *   --trials <n>                  Trials per (fixture, profile) cell (default 3)
 *   --grader-runs <n>             vendor/tinytable-evals grade.py --runs: probabilistic-kill sampling per trial (default 1)
 *   --kill-rate-threshold <t>     grade.py --kill-rate-threshold (default 1.0 - every grader run must kill)
 *   --trial-timeout-minutes <n>   Per-trial container timeout before killing it (default 15)
 *   --pg-adjudicate               grade.py --pg-adjudicate (issue #57, off by default): ask a PostgreSQL
 *                                 oracle to settle F_mutant & F_clean disputes as reference_bug (a real
 *                                 clean/ bug, not counted against the agent) vs false_alarm vs unknown -
 *                                 requires psycopg2 and a reachable server (docker compose -f
 *                                 vendor/tinytable-evals/docker-compose.postgres.yml up -d; PGHOST etc.
 *                                 env vars, same setup as tinytable-evals's oracle.py --backend postgres)
 *   --smoke                       2 fixtures x 2 profiles x 1 trial - cheap end-to-end validation
 *   --dry-run                     Print the matrix and budget note, launch nothing
 *   --report-only                 Skip execution; rebuild the report from state.json
 *   --engine-access <mode>        source (default) | bytecode | oracle - honeyrail#168's mode taxonomy,
 *                                 see server/evals/kill-attribution.ts's own EngineAccess docstring.
 *                                 "bytecode" is #158's old --black-box (below), kept as a research mode.
 *                                 "oracle" is #168's real process-boundary black-box: builds a
 *                                 privateRoot/agentRoot split (scripts/tinytable-seed-root-builder.ts's
 *                                 buildOracleAgentRoot()), starts a separate engine-service container
 *                                 (scripts/tinytable-engine-service.ts) owning the real tinytable/, and
 *                                 runs the agent against agentRoot only - no .py/.pyc ever enters its
 *                                 container.
 *   --black-box                   Back-compat alias for `--engine-access bytecode` (#158's original
 *                                 flag name, before #168 introduced the 3-mode taxonomy)
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBlockedReason, withUnattendedPreamble } from "../server/agents/common.js";
import { dshAdapter } from "../server/agents/dsh.js";
import { buildDshComparisonReport, classifyDshOutcome, type DshComparisonReportInput, type DshTrialRecord } from "../server/evals/dsh-report.js";
import { decodeTrialDiagnosis } from "../server/evals/trial-diagnosis.js";
import { describeManifestMismatch, findManifestMismatches } from "../server/evals/manifest-preflight.js";
import { findSessionStatsTimingInconsistency, readSessionStats } from "../server/evals/dsh-session-stats.js";
import { appendDerivedTrajectoryEvents } from "../server/evals/dsh-trajectory-bridge.js";
import { writeTranscript } from "../server/evals/dsh-transcript.js";
import { classifyKillAttribution, loadOperatorMetadata, parseTranscript, type EngineAccess, type OperatorMeta } from "../server/evals/kill-attribution.js";
import { logAgentSnapshot, logFileDiff } from "../server/evals/dsh-trajectory-filesystem-events.js";
import { auditTranscript } from "../server/evals/transcript-audit.js";
import { findStrayArtifacts, ORACLE_STRAY_ARTIFACT_PATTERNS } from "../server/evals/manifest-preflight.js";
import { runCommandSafe } from "../server/utils.js";
import { buildOracleAgentRoot, buildSeedRoot, copyBackAgentArtifacts, gitInitCommit, type SeedRootManifest } from "./tinytable-seed-root-builder.js";
import { DEFAULT_IMAGE, runInExamRoom } from "./tinytable-exam-room.js";
import { startEngineService } from "./tinytable-engine-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tinytableEvalDir = resolve(__dirname, "..", "examples", "tinytable-eval");
const profilesDir = join(tinytableEvalDir, "profiles");
// #126: the builder/grader/task-prompt now come from the pinned vendored
// checkout, not a static in-repo copy - see docs/dsh-evals-demo.md's
// "Pinned upstream commit" section for the pin and its re-pin process.
const vendorDir = resolve(__dirname, "..", "vendor", "tinytable-evals");
const gradePyPath = join(vendorDir, "grade.py");
const taskPromptPath = join(vendorDir, "task-prompt.md");

const PROFILE_PATCH_FILENAME = "cordis.patch.yml";

/** Default fixture seeds - 8, matching this driver's original 8-mutant default matrix/budget note. */
const DEFAULT_FIXTURE_SEEDS = [0, 1, 2, 3, 4, 5, 6, 7];

type ProfileSpec = { label: string; content: string; sha256: string };
type CliOptions = {
  out: string;
  image: string;
  fixtureSeeds?: number[];
  profileArgs?: string[];
  trials: number;
  graderRuns: number;
  killRateThreshold: number;
  trialTimeoutMinutes: number;
  pgAdjudicate: boolean;
  engineAccess: EngineAccess;
  smoke: boolean;
  dryRun: boolean;
  reportOnly: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    out: "./dsh-evals-report",
    image: DEFAULT_IMAGE,
    trials: 3,
    graderRuns: 1,
    killRateThreshold: 1.0,
    trialTimeoutMinutes: 15,
    pgAdjudicate: false,
    engineAccess: "source",
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
      case "--fixtures":
        options.fixtureSeeds = next().split(",").map((id) => id.trim()).filter(Boolean).map((id) => {
          const seed = Number(id);
          if (!Number.isInteger(seed) || seed < 0) throw new Error(`--fixtures entries must be non-negative integer seeds, got "${id}"`);
          return seed;
        });
        break;
      case "--profiles": options.profileArgs = next().split(",").map((pair) => pair.trim()).filter(Boolean); break;
      case "--trials": options.trials = Number(next()); break;
      case "--grader-runs": options.graderRuns = Number(next()); break;
      case "--kill-rate-threshold": options.killRateThreshold = Number(next()); break;
      case "--trial-timeout-minutes": options.trialTimeoutMinutes = Number(next()); break;
      case "--pg-adjudicate": options.pgAdjudicate = true; break;
      case "--engine-access": {
        const value = next();
        if (value !== "source" && value !== "bytecode" && value !== "oracle") {
          throw new Error(`--engine-access must be one of source|bytecode|oracle, got "${value}"`);
        }
        options.engineAccess = value;
        break;
      }
      // Back-compat alias for the pre-#168 flag name - identical to `--engine-access bytecode`.
      case "--black-box": options.engineAccess = "bytecode"; break;
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
  if (!Number.isInteger(options.graderRuns) || options.graderRuns < 1) throw new Error("--grader-runs must be a positive integer");
  if (!Number.isFinite(options.killRateThreshold) || options.killRateThreshold < 0 || options.killRateThreshold > 1) {
    throw new Error("--kill-rate-threshold must be between 0 and 1");
  }
  if (!Number.isFinite(options.trialTimeoutMinutes) || options.trialTimeoutMinutes < 1) {
    throw new Error("--trial-timeout-minutes must be >= 1");
  }
  return options;
}

function loadFixtureSeeds(options: CliOptions): number[] {
  let seeds = options.fixtureSeeds?.length ? options.fixtureSeeds : DEFAULT_FIXTURE_SEEDS;
  if (options.smoke) seeds = seeds.slice(0, 2);
  return seeds;
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

// gitInitCommit() now lives in ./tinytable-seed-root-builder.js - hoisted
// from here since engineAccess=oracle's agentRoot (buildOracleAgentRoot())
// needs the exact same defense-in-depth re-init this file's own privateRoot
// call below already did.

export type ScoreJson = {
  artifacts: string;
  clean: string;
  runs: number;
  /** #126 (vendor/tinytable-evals's grade.py, its own issue #21 "Grader v2"): fraction of --runs grader seeds that killed the mutant. */
  kill_rate: number;
  kill_rate_threshold: number;
  killed: boolean;
  killed_tests: string[];
  /** Killed tests split by whether they're an "invariant" (assert_stats/--check-admissibility) violation vs a plain "assertion". */
  killed_by_kind: { assertion: number; invariant: number };
  false_alarms: number;
  /** #57, opt-in via --pg-adjudicate: whether this run asked a PostgreSQL oracle to adjudicate F_mutant & F_clean disputes. */
  pg_adjudicate: boolean;
  /** Summed across --runs seeds; null when pg_adjudicate is false. */
  pg_adjudication_tally: { reference_bug: number; false_alarm: number; unknown: number } | null;
  contract_ok: boolean;
  contract_errors: string[];
  f_mutant: string[];
  f_clean: string[];
  per_run: Array<{
    seed: number;
    killed: boolean;
    killed_tests: string[];
    killed_by_kind: { assertion: number; invariant: number };
    false_alarms: number;
    f_mutant: string[];
    f_clean: string[];
    /** "<path>:<line>" -> verdict, only for ids in this run's F_mutant & F_clean; empty object when pg_adjudicate is false. */
    pg_adjudicated: Record<string, { outcome: "reference_bug" | "false_alarm" | "unknown"; detail?: string }>;
    pg_adjudication_tally: { reference_bug: number; false_alarm: number; unknown: number } | null;
  }>;
  error: string | null;
  passed: boolean;
};

// #114: grade.py's own JSON output always includes a literal "error" key
// (null on success), so a plain `ScoreJson | { error: string }` union with
// an `"error" in x` discriminant is unsound: `JSON.parse(raw) as ScoreJson`
// doesn't strip grade.py's extra fields at runtime, so that check is true
// for *every* successfully-parsed score.json, not just the driver's own
// failure sentinel. `ok` can't collide with anything grade.py's schema
// will ever name, unlike `error`.
export type RunScorePyResult = { ok: true; score: ScoreJson } | { ok: false; error: string };

export type GraderOptions = { runs?: number; killRateThreshold?: number; trajectoryLog?: string; pgAdjudicate?: boolean; pythonBin?: string };

// `run` defaults to the real subprocess call; overridable so tests can
// exercise the read/parse/discriminate logic (the actual site of #114's
// bug) against a pre-written score.json without needing python3 or a real
// tinytable-evals checkout on disk.
export async function runScorePy(
  worktreePath: string,
  run: typeof runCommandSafe = runCommandSafe,
  graderOptions: GraderOptions = {}
): Promise<RunScorePyResult> {
  const result = await run(graderOptions.pythonBin ?? "python3", [
    gradePyPath,
    "--artifacts", worktreePath,
    "--out", "score.json",
    ...(graderOptions.runs && graderOptions.runs !== 1 ? ["--runs", String(graderOptions.runs)] : []),
    ...(graderOptions.killRateThreshold !== undefined && graderOptions.killRateThreshold !== 1
      ? ["--kill-rate-threshold", String(graderOptions.killRateThreshold)]
      : []),
    // #40 (grade.py's own side, clemenza/tinytable-evals#51): relative to
    // --artifacts (worktreePath) unless absolute, same convention grade.py
    // already uses for --out - so a plain "trajectory.jsonl" lands
    // directly in the seed-root, the same file run_sql_tests.py
    // --trajectory-log and sample_trajectory.py already write to.
    ...(graderOptions.trajectoryLog ? ["--trajectory-log", graderOptions.trajectoryLog] : []),
    // #57, opt-in: needs psycopg2 and a reachable PostgreSQL server (see
    // this file's own header comment) - grade.py degrades to its original
    // blanket false-alarm treatment whenever this is omitted.
    ...(graderOptions.pgAdjudicate ? ["--pg-adjudicate"] : [])
  ]);
  try {
    const raw = await readFile(join(worktreePath, "score.json"), "utf8");
    return { ok: true, score: JSON.parse(raw) as ScoreJson };
  } catch {
    return { ok: false, error: `grade.py produced no score.json (exit ${result.code}): ${(result.stderr || result.stdout).slice(-2000)}` };
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
  fixtureSeed: number,
  profile: ProfileSpec,
  trial: number,
  cellsDir: string,
  operators: Map<string, OperatorMeta>,
  graderPythonBin: string
): Promise<DshTrialRecord> {
  const fixture = String(fixtureSeed);
  const trialId = `${fixture}-${profile.label}-${trial}`;
  const artifactsDir = join(cellsDir, trialId);
  const seedRootDir = join(artifactsDir, "seed-root");
  const base: Pick<DshTrialRecord, "fixture" | "profile" | "trial" | "trialId" | "artifactsDir"> = {
    fixture, profile: profile.label, trial, trialId, artifactsDir
  };

  let manifest: SeedRootManifest;
  try {
    await mkdir(artifactsDir, { recursive: true });
    manifest = await buildSeedRoot({ seed: fixtureSeed, outDir: seedRootDir, engineAccess: options.engineAccess, image: options.image });
    await writeFile(join(artifactsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  } catch (error) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk: false, transcriptAuditHits: [], killRate: null, killedByKind: null, difficultyTier: null, error: (error as Error).message };
  }

  // #139: known as soon as the manifest names an operator id - independent
  // of whether the trial ever reaches scoring, so every return path below
  // (including the early error ones above/below) carries it.
  const difficultyTier = operators.get(manifest.operatorId)?.tier ?? null;

  const preflightMismatches = await findManifestMismatches(seedRootDir, { files: manifest.files });
  if (preflightMismatches.length) {
    return {
      ...base,
      killed: null,
      falseAlarms: null,
      contractOk: null,
      integrityOk: false,
      transcriptAuditHits: [],
      killRate: null,
      killedByKind: null,
      difficultyTier,
      error: `#106 preflight: freshly-built seed-root doesn't match its own manifest: ${preflightMismatches.map(describeManifestMismatch).join("; ")}`
    };
  }

  await gitInitCommit(seedRootDir);

  // engineAccess=oracle (#168): the agent works in a separate agentRoot -
  // no tinytable/ or its direct-execution-only siblings, run_sql_tests.py
  // swapped for the HTTP proxy client - joined to a private network whose
  // only other member is a freshly-started engine-service container owning
  // the real (privateRoot's) tinytable/. source/bytecode modes are
  // unchanged: the agent works directly in seedRootDir (privateRoot),
  // "bridge" networking, no engine-service.
  const isOracle = options.engineAccess === "oracle";
  const agentRootDir = join(artifactsDir, "agent-root");
  const workspaceDir = isOracle ? agentRootDir : seedRootDir;
  const engineHandle = isOracle ? await startEngineService({ mutantRootDir: join(seedRootDir, "tinytable") }) : null;

  const dshHomeDir = join(artifactsDir, "dsh-home");
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof runInExamRoom>>;
  try {
    if (isOracle) {
      const oracleAgentRoot = await buildOracleAgentRoot(seedRootDir, agentRootDir);
      await writeFile(join(artifactsDir, "agent-manifest.json"), JSON.stringify(oracleAgentRoot, null, 2));
    }
    await writeFile(join(workspaceDir, PROFILE_PATCH_FILENAME), profile.content);

    const prompt = withUnattendedPreamble(taskPrompt);
    result = await runInExamRoom({
      seedRootDir: workspaceDir,
      image: options.image,
      dshHomeDir,
      network: engineHandle?.networkName,
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
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? "danger-full-access",
        ...(engineHandle ? { ENGINE_SERVICE_URL: `http://${engineHandle.hostname}:${engineHandle.port}` } : {})
      },
      timeoutMs: options.trialTimeoutMinutes * 60_000
    });
  } catch (error) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk: false, transcriptAuditHits: [], killRate: null, killedByKind: null, difficultyTier, error: (error as Error).message };
  } finally {
    // AC#10: the engine-service container and its private network must be
    // torn down on every exit path - success, agent timeout, or a thrown
    // error above - not just the happy path. Nothing after this point needs
    // the engine-service still running.
    await engineHandle?.stop();
  }

  const wallTimeMs = Date.now() - startedAt;
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  await writeFile(join(artifactsDir, "container.log"), `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`);

  // #168: copy back *only* sql-tests/agent/** + findings.json from
  // agentRoot into privateRoot (seedRootDir) - the sole allowlisted path
  // grade.py's protected-path check (git status against tinytable/ and
  // sql-tests/official/) tolerates. Everything downstream (gatherAuditableText,
  // runScorePy) reads seedRootDir exactly as source/bytecode mode already did.
  let strayArtifacts: string[] = [];
  if (isOracle) {
    await copyBackAgentArtifacts(workspaceDir, seedRootDir);
    // Defense-in-depth re-check: buildOracleAgentRoot() already refused to
    // produce a leaky agentRoot up front, but the agent's own container has
    // read-write access to agentRoot for the whole trial - re-verify nothing
    // showed up there afterward (e.g. the agent creating a decoy) before
    // trusting this trial's result.
    strayArtifacts = await findStrayArtifacts(workspaceDir, ORACLE_STRAY_ARTIFACT_PATTERNS);
    if (strayArtifacts.length) {
      console.error(`  ${trialId}: ORACLE INTEGRITY FAILURE - stray artifact(s) appeared in agentRoot during the trial: ${strayArtifacts.join(", ")}`);
    }
  }

  // Turn/step/wall-time telemetry from dsh's own session-persistence JSONL
  // log, now that dshHomeDir gave it somewhere durable to write - see
  // server/evals/dsh-session-stats.ts. Best-effort: null (nothing written,
  // or this dsh version doesn't ship the plugin) must never fail the
  // trial, only omit sessionStats from its record.
  const sessionStatsReport = await readSessionStats(dshHomeDir).catch(() => null);
  if (sessionStatsReport) {
    await writeFile(join(artifactsDir, "session-stats.json"), JSON.stringify(sessionStatsReport, null, 2));
  }

  // Same source, derived instead of folded: per-tool-call (and, for dsh's
  // built-in bash tool, per-shell-command) trajectory events, appended into
  // the seed-root in vendor/tinytable-evals's #40 trajectory.jsonl schema -
  // see server/evals/dsh-trajectory-bridge.ts for what this can and can't
  // verify. Best-effort, same reasoning as sessionStatsReport above.
  await appendDerivedTrajectoryEvents(dshHomeDir, seedRootDir).catch(() => null);

  // #140: a per-trial transcript.ndjson, sourced from the same durable
  // session log as sessionStatsReport/appendDerivedTrajectoryEvents above -
  // unlike container.log (built from the container's stdout/stderr, empty
  // on a mid-run timeout kill since headless dsh only prints once at the
  // end), this is non-empty even for a killed trial. Best-effort, same
  // reasoning as those two.
  await writeTranscript(dshHomeDir, join(artifactsDir, "transcript.ndjson")).catch(() => null);

  // The remaining two #40 event kinds this driver can produce on its own
  // (see server/evals/dsh-trajectory-filesystem-events.ts) - gitInitCommit
  // above is exactly the "HEAD" baseline_ref this diffs against. Also
  // best-effort: neither should ever fail the trial.
  await logFileDiff(seedRootDir).catch(() => undefined);
  await logAgentSnapshot(seedRootDir).catch(() => undefined);

  // #107 transcript audit: whatever the agent said (container output) and
  // wrote (findings.json, its .test files, if it got that far) - run once,
  // reused across every return path below, since it costs nothing beyond
  // an in-memory regex pass and a run that fails early still deserves the
  // same scrutiny as one that completes.
  const auditableText = await gatherAuditableText(seedRootDir, combinedOutput);
  const transcriptAuditHits = auditTranscript(auditableText);
  if (transcriptAuditHits.length) {
    const summary = transcriptAuditHits.map((hit) => `${hit.pattern}(${hit.confidence})`).join(", ");
    console.error(`  ${trialId}: TRANSCRIPT AUDIT HIT(S): ${summary}`);
  }

  const sessionStats = sessionStatsReport?.aggregate ?? null;

  // #141: llmMs/toolMs can never legitimately exceed the trial's own
  // driver-measured wallTimeMs (both are sums of sub-intervals of that
  // same real-time span) - flag it rather than silently report an
  // impossible number. See findSessionStatsTimingInconsistency's own
  // docstring for the investigation into why this happens.
  const sessionStatsTimingIssue = sessionStats ? findSessionStatsTimingInconsistency(sessionStats, wallTimeMs) : null;
  if (sessionStatsTimingIssue) {
    console.error(`  ${trialId}: SESSION STATS TIMING INCONSISTENCY: ${sessionStatsTimingIssue}`);
  }

  if (result.timedOut) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk: true, transcriptAuditHits, killRate: null, killedByKind: null, difficultyTier, wallTimeMs, sessionStats, sessionStatsTimingIssue, error: `trial timed out after ${options.trialTimeoutMinutes}m and was killed` };
  }
  const fatal = dshAdapter.findFatalError?.(combinedOutput);
  if (fatal) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk: true, transcriptAuditHits, killRate: null, killedByKind: null, difficultyTier, wallTimeMs, sessionStats, sessionStatsTimingIssue, error: `dsh fatal error (${fatal.code}): ${fatal.message}` };
  }
  const blocked = findBlockedReason(combinedOutput);

  // #126: vendor/tinytable-evals's grade.py has no --agent-blocked-reason
  // equivalent to the old score.py's #108 waiver, so a correctly-BLOCKED
  // trial's contract_ok may now read false here for an empty submission.
  // That's cosmetic, not a classification regression: classifyDshOutcome
  // (server/evals/dsh-report.ts) already returns "blocked" before ever
  // consulting killed/contractOk whenever blockedReason is set - see
  // docs/dsh-evals-demo.md.
  const scoreOrError = await runScorePy(seedRootDir, runCommandSafe, {
    runs: options.graderRuns,
    killRateThreshold: options.killRateThreshold,
    trajectoryLog: "trajectory.jsonl",
    pgAdjudicate: options.pgAdjudicate,
    pythonBin: graderPythonBin
  });
  const postMismatches = await findManifestMismatches(seedRootDir, { files: manifest.files });
  const integrityOk = postMismatches.length === 0 && strayArtifacts.length === 0;
  if (postMismatches.length) {
    console.error(`  ${trialId}: INTEGRITY FAILURE - protected fixture files changed: ${postMismatches.map(describeManifestMismatch).join("; ")}`);
  }

  if (!scoreOrError.ok) {
    return { ...base, killed: null, falseAlarms: null, contractOk: null, integrityOk, transcriptAuditHits, killRate: null, killedByKind: null, difficultyTier, wallTimeMs, sessionStats, sessionStatsTimingIssue, blockedReason: blocked?.message, error: scoreOrError.error };
  }

  // #148: classify a killed trial's discovery channel (test-driven / code-
  // review / black-box-reasoning / leak / oracle-exploit) from the
  // transcript.ndjson just written above, so every future run carries
  // attribution by default instead of needing a separate audit pass
  // (scripts/audit-kill-attribution.ts) over old data. Best-effort, same
  // reasoning as sessionStats/trajectory above: must never fail a trial.
  let killAttribution: DshTrialRecord["killAttribution"] = null;
  if (scoreOrError.score.killed) {
    try {
      const transcriptText = await readFile(join(artifactsDir, "transcript.ndjson"), "utf8");
      const attr = classifyKillAttribution(parseTranscript(transcriptText), operators.get(manifest.operatorId) ?? null, options.engineAccess);
      killAttribution = {
        channel: attr.channel,
        claimMatchedBy: attr.claim?.matchedBy ?? null,
        tClaim: attr.claim?.ts ?? null,
        tFirstOwnFailingTest: attr.firstOwnFailingTest?.ts ?? null,
        tFirstSourceRead: attr.firstSourceRead?.ts ?? null,
        tFirstBytecodeIntrospection: attr.firstBytecodeIntrospection?.ts ?? null,
        leakHitCount: attr.leakHits.length,
        oracleHitCount: attr.oracleHits.length
      };
    } catch {
      // transcript.ndjson missing/unwritable - leave killAttribution null.
    }
  }

  return {
    ...base,
    killed: scoreOrError.score.killed,
    falseAlarms: scoreOrError.score.false_alarms,
    contractOk: scoreOrError.score.contract_ok,
    integrityOk,
    transcriptAuditHits,
    killRate: scoreOrError.score.kill_rate,
    killedByKind: scoreOrError.score.killed_by_kind,
    // #139: score.json's own f_mutant - every record the agent's suite
    // asserted as failing against the mutant, the denominator precision
    // (server/evals/dsh-report.ts's FixtureCellSummary.precision) divides
    // killedByKind's genuine-kill numerator by.
    assertedFailingCount: scoreOrError.score.f_mutant.length,
    difficultyTier,
    wallTimeMs,
    sessionStats,
    sessionStatsTimingIssue,
    pgAdjudicationTally: scoreOrError.score.pg_adjudication_tally,
    killAttribution,
    blockedReason: blocked?.message
  };
}

type StateFile = {
  config: { image: string; smoke: boolean; dshVersion: string; graderRuns: number; killRateThreshold: number; engineAccess: EngineAccess };
  profiles: Array<{ label: string; sha256: string }>;
  fixtures: string[];
  trials: DshTrialRecord[];
};

async function fingerprintDshVersion(image: string): Promise<string> {
  const scratchDir = await mkdtemp(join(tmpdir(), "dsh-evals-fingerprint-"));
  const result = await runInExamRoom({ seedRootDir: scratchDir, image, command: ["dsh", "--version"], timeoutMs: 30_000 });
  return result.stdout.trim() || "(unknown)";
}

/**
 * #158: grade.py (the grader zone, run on the *host*, after the exam-room
 * container has already exited) imports both `--artifacts` (the seed-root
 * the agent left behind) and `clean/` to compare behavior. Under
 * `--black-box`, `--artifacts`'s `tinytable/{core,sql}.pyc` is
 * version-locked to whatever Python compiled it (`buildSeedRoot`'s own
 * transform, matched to `image`'s Python via `runInExamRoom` - see
 * BuildSeedRootOptions.image's docstring) - if the host's own `python3`
 * happens to be a different minor version, grade.py crashes on import with
 * "ImportError: bad magic number", not a graded verdict. A real trial hit
 * exactly this: grade.py's own exception handling folded the crash into a
 * `killed: false` verdict indistinguishable from a genuine miss, silently
 * reporting `task_failed` for a trial the agent's own test (re-graded with
 * a matching interpreter afterward) had actually killed.
 *
 * Resolves a host `python3.<minor>` binary matching `image`'s own Python
 * minor version (CPython's `.pyc` magic number is stable across patch
 * releases within a minor series, so an exact patch match isn't needed).
 * Falls back to plain `python3` with a loud warning if no matching binary
 * is found on the host - grading will likely crash exactly as above, but
 * silently defaulting to a wrong interpreter would be worse than a clear
 * warning up front. Only called when `--black-box` is set; the host's
 * `python3` grades a normal (source-visible) seed-root just fine
 * regardless of its own version, since nothing there is precompiled.
 */
async function resolveGraderPythonBin(image: string): Promise<string> {
  const scratchDir = await mkdtemp(join(tmpdir(), "dsh-evals-pyversion-"));
  const versionResult = await runInExamRoom({
    seedRootDir: scratchDir,
    image,
    network: "none",
    command: ["python3", "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
    timeoutMs: 30_000
  });
  const minorVersion = versionResult.stdout.trim();
  if (!/^\d+\.\d+$/.test(minorVersion)) {
    console.warn(`  warning: could not determine ${image}'s Python version (got "${minorVersion}") - grading will use the host's own python3, which may not match`);
    return "python3";
  }
  const candidate = `python3.${minorVersion.split(".")[1]}`;
  const probe = await runCommandSafe(candidate, ["--version"]);
  if (!probe.ok) {
    console.warn(`  warning: ${image} runs Python ${minorVersion}, but no matching "${candidate}" was found on the host PATH - grading black-box artifacts with the host's own python3 instead, which will crash on import if it's a different minor version`);
    return "python3";
  }
  return candidate;
}

async function writeReport(outDir: string, state: StateFile): Promise<string> {
  const profilePaths = new Map(state.profiles.map((p) => [p.label, join(profilesDir, `${p.label}.cordis.patch.yml`)]));
  // #174: best-effort attach a sibling trial-diagnosis.json, if
  // scripts/tinytable-diagnose.ts already wrote one for this trial - a
  // separate, opt-in stage this driver never runs itself, so a trial with no
  // trial-diagnosis.json (the common case) is unaffected, same ".catch(() =>
  // null)" pattern writeTranscript already uses below. Goes through
  // decodeTrialDiagnosis rather than a raw JSON.parse + spread - the on-disk
  // file is snake_case (#174 §7), TrialDiagnosis is camelCase; spreading the
  // raw parse directly used to leave d.capabilityGaps/d.trialId/etc
  // undefined on every real diagnosed trial (review fix).
  const trialsWithDiagnosis = await Promise.all(
    state.trials.map(async (trial) => {
      const raw = await readFile(join(trial.artifactsDir, "trial-diagnosis.json"), "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => null);
      const diagnosis = raw ? decodeTrialDiagnosis(raw) : null;
      return diagnosis ? { ...trial, diagnosis } : trial;
    })
  );
  const input: DshComparisonReportInput = {
    generatedAt: new Date().toISOString(),
    dshVersion: state.config.dshVersion,
    image: state.config.image,
    smoke: state.config.smoke,
    profiles: state.profiles.map((p) => ({ label: p.label, path: profilePaths.get(p.label) || PROFILE_PATCH_FILENAME, sha256: p.sha256 })),
    fixtures: state.fixtures,
    trials: trialsWithDiagnosis
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

  const fixtureSeeds = loadFixtureSeeds(options);
  const profiles = await loadProfiles(options);
  const trialsPerCell = options.smoke ? 1 : options.trials;
  const totalRuns = fixtureSeeds.length * profiles.length * trialsPerCell;

  console.log(`Matrix: ${fixtureSeeds.length} fixtures x ${profiles.length} profiles x ${trialsPerCell} trials = ${totalRuns} dsh runs.`);
  console.log(`Budget note: each run launches a real dsh CLI session against a real model API (typically a few cents to tens of cents and 1-10 minutes each). Use --smoke to validate cheaply first.`);
  if (options.dryRun) {
    for (const fixtureSeed of fixtureSeeds) {
      for (const profile of profiles) {
        for (let trial = 1; trial <= trialsPerCell; trial += 1) {
          console.log(`  would run: seed-${fixtureSeed}/${profile.label}/trial-${trial}`);
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
  const operators = await loadOperatorMetadata(vendorDir);

  // #158: only matters for engineAccess=bytecode (a source-visible
  // privateRoot - "source" and "oracle" both are, "oracle"'s tinytable/
  // never gets compiled to .pyc - grades fine with any host python3) - see
  // resolveGraderPythonBin's own docstring for the real trial that found
  // this gap.
  let graderPythonBin = "python3";
  if (options.engineAccess === "bytecode") {
    graderPythonBin = await resolveGraderPythonBin(options.image);
    console.log(`Bytecode mode: grading with ${graderPythonBin} (matched to ${options.image}'s own Python)`);
  }

  const state: StateFile = {
    config: { image: options.image, smoke: options.smoke, dshVersion, graderRuns: options.graderRuns, killRateThreshold: options.killRateThreshold, engineAccess: options.engineAccess },
    profiles: profiles.map(({ label, sha256 }) => ({ label, sha256 })),
    fixtures: fixtureSeeds.map(String),
    trials: []
  };

  // Sequential on purpose, mirroring scripts/evals-ab-demo.ts (#25): keeps
  // driver-side resource usage (docker containers, host CPU for grade.py)
  // bounded and cell logs easy to follow; parallelizing across containers
  // is safe to add later since each cell is fully isolated from the others.
  for (const fixtureSeed of fixtureSeeds) {
    for (const profile of profiles) {
      for (let trial = 1; trial <= trialsPerCell; trial += 1) {
        const label = `seed-${fixtureSeed}/${profile.label}/trial-${trial}`;
        console.log(`Cell ${label} (${state.trials.length + 1}/${totalRuns}):`);
        const record = await executeCell(options, taskPrompt, fixtureSeed, profile, trial, cellsDir, operators, graderPythonBin);
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
