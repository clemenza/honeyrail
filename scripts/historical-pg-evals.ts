#!/usr/bin/env -S node --import tsx
/**
 * Issue #198: the Historical PG TrialSet Runner MVP - the implementation
 * child of #180. Orchestrates `frozen Corpus v0 task x DSH HarnessProfile x
 * trial index` cells on top of the authoritative single-trial boundary PR
 * #207 introduced, `runHistoricalPostgresPilotTrial()` (see
 * server/postgres/historical-pg-trialset.ts for the shared, tested
 * planning/identity/state/report logic this CLI is a thin shell around).
 *
 * This driver never reimplements corpus integrity validation, environment
 * fingerprint validation, task-entry validation, execution binding, dataset
 * eligibility, official score eligibility, Historical PG grading, PostgreSQL
 * lifecycle, or restricted-egress scoring policy - it only expands the
 * matrix, calls the pilot boundary once per real cell, persists state
 * atomically, and aggregates already-sanitized pilot evidence.
 *
 * TRAIN / FRONTIER discipline (#198): during this issue's own implementation
 * and debugging, real-agent execution is restricted to postgres-historical-001
 * only. postgres-historical-002/003 may only be exercised via --dry-run. This
 * is an *operational* rule, not a hardcoded restriction in this file - #180
 * will need to run real FRONTIER cells later through this same runner.
 *
 * Usage:
 *   node --import tsx scripts/historical-pg-evals.ts \
 *     --corpus corpus/historical-postgres-corpus-v0.json \
 *     --tasks postgres-historical-001 \
 *     --profiles baseline=<path>,candidate=<path> \
 *     --trials 1 \
 *     --out artifacts/historical-pg-evals/train-smoke
 *
 * Options:
 *   --corpus <manifest>            Frozen corpus manifest JSON (default corpus/historical-postgres-corpus-v0.json)
 *   --tasks <id,id,...>            Task IDs to select (default: every task in the corpus manifest, in manifest order)
 *   --profiles <id=path,...>       DSH cordis.patch.yml profiles, arbitrary ids/files (required unless --report-only)
 *   --trials <n>                   Trials per cell (default 1)
 *   --out <dir>                    Output directory for experiment-manifest.json/state.json/trials/comparison-report.md
 *   --dry-run                      Plan and validate the matrix; invoke no agent/model (still resolves the agent image's
 *                                  content identity via `docker image inspect` - an identity check, not an agent/model call)
 *   --report-only                  Skip execution; rebuild comparison-report.md from the existing state.json
 *   --smoke                        Trials=1, and if --tasks was not given, restricts the default selection to TRAIN partition tasks only
 *   --agent-image <ref>            DSH-installed research-agent image reference (default honeyrail-postgres-research-agent-dsh:latest) -
 *                                  resolved to its content identity before execution; see Blocking 1b in PR #208's review.
 *   --upstream-url <url>           Restricted-egress upstream (default https://api.deepseek.com)
 *   --agent-timeout-minutes <n>    Per-cell agent wall clock (default 20)
 *
 * Real (non-dry-run, non-report-only) cells require DEEPSEEK_API_KEY in the
 * launching environment, plus whichever of HONEYRAIL_PG_184_MIRROR/
 * HONEYRAIL_PG_200_MIRROR+REPRODUCER/HONEYRAIL_PG_199_MIRROR+REPRODUCER+PRIVATE_TRUTH
 * the selected task IDs need - the same env vars
 * scripts/historical-postgres-180-pilot.ts already uses (both share
 * server/postgres/historical-postgres-task-env.ts's resolver), so the two
 * drivers can share a launch environment.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveHistoricalPostgresTaskSpecFromEnv } from "../server/postgres/historical-postgres-task-env.js";
import type { HistoricalPostgresTaskSpec } from "../server/postgres/historical-task.js";
import type { HistoricalPostgresCorpusManifest } from "../server/postgres/historical-corpus.js";
import { runCommandSafe } from "../server/utils.js";
import {
  HISTORICAL_PG_TRIALSET_DEFAULT_AGENT_IMAGE,
  HISTORICAL_PG_TRIALSET_DEFAULT_UPSTREAM_URL,
  HISTORICAL_PG_TRIALSET_RUNNER_VERSION,
  assertCompatibleExperimentManifest,
  assertTrialSetStateMatchesPlan,
  assertUniqueProfileIds,
  buildExperimentManifest,
  buildHistoricalPgTrialSetReport,
  defaultTaskIdSelection,
  deriveModelProviderFromUpstreamUrl,
  emptyTrialSetState,
  executeTrialSetCell,
  fingerprintDshVersion,
  loadTrialSetProfile,
  loadTrialSetState,
  planTrialSetCells,
  resolveTrialSetAgentImageIdentity,
  resolveTrialSetTaskSelection,
  selectPendingCells,
  writeTrialSetStateAtomic,
  type TrialSetCellRecord,
  type TrialSetExperimentManifest,
  type TrialSetProfileSpec,
  type TrialSetState
} from "../server/postgres/historical-pg-trialset.js";

type CliOptions = {
  corpus: string;
  tasks?: string[];
  profileArgs?: string[];
  trials: number;
  out: string;
  dryRun: boolean;
  reportOnly: boolean;
  smoke: boolean;
  agentImage: string;
  upstreamUrl: string;
  agentTimeoutMinutes: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    corpus: "corpus/historical-postgres-corpus-v0.json",
    trials: 1,
    out: "./historical-pg-evals",
    dryRun: false,
    reportOnly: false,
    smoke: false,
    agentImage: HISTORICAL_PG_TRIALSET_DEFAULT_AGENT_IMAGE,
    upstreamUrl: HISTORICAL_PG_TRIALSET_DEFAULT_UPSTREAM_URL,
    agentTimeoutMinutes: 20
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
      case "--corpus": options.corpus = next(); break;
      case "--tasks": options.tasks = next().split(",").map((id) => id.trim()).filter(Boolean); break;
      case "--profiles": options.profileArgs = next().split(",").map((pair) => pair.trim()).filter(Boolean); break;
      case "--trials": options.trials = Number(next()); break;
      case "--out": options.out = next(); break;
      case "--dry-run": options.dryRun = true; break;
      case "--report-only": options.reportOnly = true; break;
      case "--smoke": options.smoke = true; break;
      case "--agent-image": options.agentImage = next(); break;
      case "--upstream-url": options.upstreamUrl = next(); break;
      case "--agent-timeout-minutes": options.agentTimeoutMinutes = Number(next()); break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/historical-pg-evals.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.smoke) options.trials = 1;
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error("--trials must be a positive integer");
  if (!Number.isFinite(options.agentTimeoutMinutes) || options.agentTimeoutMinutes < 1) throw new Error("--agent-timeout-minutes must be >= 1");
  return options;
}

async function resolveRepositoryCommit(): Promise<string> {
  const result = await runCommandSafe("git", ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() : "unknown";
}

async function loadProfiles(options: CliOptions): Promise<TrialSetProfileSpec[]> {
  if (!options.profileArgs?.length) throw new Error("--profiles is required (id=path,id=path,...) unless --report-only.");
  const profiles = await Promise.all(
    options.profileArgs.map((pair) => {
      const separator = pair.indexOf("=");
      if (separator < 1) throw new Error(`--profiles entries must be id=path, got "${pair}"`);
      const profileId = pair.slice(0, separator);
      const sourcePath = resolve(pair.slice(separator + 1));
      return loadTrialSetProfile(profileId, sourcePath);
    })
  );
  assertUniqueProfileIds(profiles);
  return profiles;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const manifestPath = join(outDir, "experiment-manifest.json");
  const statePath = join(outDir, "state.json");
  const reportPath = join(outDir, "comparison-report.md");

  if (options.reportOnly) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TrialSetExperimentManifest;
    const state = await loadTrialSetState(statePath);
    if (!state) throw new Error(`--report-only requires an existing state.json at "${statePath}".`);
    // PR #208 review, Blocking 2: report-only must not trust state.json on
    // shape alone either - reconstruct the plan from the manifest itself
    // (no corpus/profile files needed for this) and validate identically to
    // the real-run resume path below.
    const plannedCells = planTrialSetCells({ tasks: manifest.tasks, profiles: manifest.profiles, trialsPerCell: manifest.trialsPerCell });
    assertTrialSetStateMatchesPlan({ state, manifest, plannedCells });
    await writeFile(reportPath, buildHistoricalPgTrialSetReport({ manifest, records: Object.values(state.cells) }));
    console.log(`Report rebuilt from ${statePath}: ${reportPath}`);
    return;
  }

  const corpusManifest = JSON.parse(await readFile(resolve(options.corpus), "utf8")) as HistoricalPostgresCorpusManifest;

  const taskIds = options.tasks?.length ? options.tasks : defaultTaskIdSelection(corpusManifest, { smoke: options.smoke });
  const tasks = resolveTrialSetTaskSelection(corpusManifest, taskIds);
  const profiles = await loadProfiles(options);

  // Identity-relevant docker call (image inspect, not an agent/model
  // invocation) - resolved even under --dry-run so the printed experimentId
  // reflects the real content identity that would actually execute (PR #208
  // review, Blocking 1b).
  const agentImageIdentity = await resolveTrialSetAgentImageIdentity(options.agentImage);
  const repositoryCommit = await resolveRepositoryCommit();
  const agentTimeoutMs = options.agentTimeoutMinutes * 60_000;
  const sessionTimeoutMs = agentTimeoutMs + 10 * 60_000;

  const isolationPolicy = { restrictedEgress: true, upstreamUrl: options.upstreamUrl };
  const identity = {
    repositoryCommit,
    corpusId: corpusManifest.corpusId,
    corpusHash: corpusManifest.corpusHash,
    tasks,
    profiles: profiles.map(({ profileId, profileHash }) => ({ profileId, profileHash })),
    trialsPerCell: options.trials,
    agentImage: agentImageIdentity,
    agentTimeoutMs,
    sessionTimeoutMs,
    isolationPolicy,
    runnerVersion: HISTORICAL_PG_TRIALSET_RUNNER_VERSION
  };

  // Observable provenance only (PR #208 review, Blocking 1d) - never
  // identity-relevant. dshVersion needs an actual (non-agent, non-model)
  // container run, so it's skipped under --dry-run, same precedent as
  // scripts/dsh-evals-demo.ts's own dry-run path; "unknown" is never
  // persisted anyway since dry-run writes no manifest to disk.
  const dshVersion = options.dryRun ? "unknown (not fingerprinted under --dry-run)" : await fingerprintDshVersion(options.agentImage);
  const modelProvider = deriveModelProviderFromUpstreamUrl(options.upstreamUrl);
  const modelVersion = "unknown";

  const currentManifest = buildExperimentManifest({ identity, profiles, dshVersion, modelProvider, modelVersion });

  let manifest: TrialSetExperimentManifest;
  let state: TrialSetState;
  const existingManifestRaw = await readFile(manifestPath, "utf8").catch(() => null);
  if (existingManifestRaw) {
    const existingManifest = JSON.parse(existingManifestRaw) as TrialSetExperimentManifest;
    assertCompatibleExperimentManifest(existingManifest, currentManifest);
    manifest = existingManifest;
    state = (await loadTrialSetState(statePath)) ?? emptyTrialSetState(manifest.experimentId);
  } else {
    manifest = currentManifest;
    state = emptyTrialSetState(manifest.experimentId);
    if (!options.dryRun) await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const cells = planTrialSetCells({ tasks: manifest.tasks, profiles: manifest.profiles, trialsPerCell: manifest.trialsPerCell });
  // Same validation as --report-only above (Blocking 2) - a hand-edited or
  // stale state.json is rejected before any cell is skipped or re-run, not
  // just before reporting.
  assertTrialSetStateMatchesPlan({ state, manifest, plannedCells: cells });

  console.log(`Experiment: ${manifest.experimentId}`);
  console.log(`Agent image: ${manifest.agentImage.reference} (resolved id ${manifest.agentImage.id})`);
  console.log(`Matrix: ${tasks.length} tasks x ${profiles.length} profiles x ${options.trials} trials = ${cells.length} cells.`);
  for (const cell of cells) {
    console.log(`  ${options.dryRun ? "would run" : "planned"}: ${cell.cellId} (partition=${cell.partition})`);
  }
  if (options.dryRun) {
    console.log("--dry-run: no agent/model invocation, no grader execution.");
    return;
  }

  const apiKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY must be set in the launching environment for a real (non-dry-run) TrialSet run.");

  const taskSpecCache = new Map<string, HistoricalPostgresTaskSpec>();
  const profileByLabel = new Map(profiles.map((profile) => [profile.profileId, profile]));

  const pendingCells = selectPendingCells(cells, state);
  const skipped = cells.length - pendingCells.length;
  for (const cell of cells) {
    if (state.cells[cell.cellId]) {
      console.log(`  ${cell.cellId}: already completed (pilotId=${state.cells[cell.cellId].pilotId}) - skipping.`);
    }
  }
  let ran = 0;
  for (const cell of pendingCells) {
    if (!taskSpecCache.has(cell.taskId)) taskSpecCache.set(cell.taskId, await resolveHistoricalPostgresTaskSpecFromEnv(cell.taskId));
    const taskSpec = taskSpecCache.get(cell.taskId)!;
    const profile = profileByLabel.get(cell.profileId)!;
    const cellArtifactRoot = join(outDir, "trials", cell.taskId, cell.profileId, `trial-${cell.trialIndex}`);

    console.log(`Running ${cell.cellId} (${ran + skipped + 1}/${cells.length})...`);
    const record: TrialSetCellRecord = await executeTrialSetCell({
      identity: cell,
      experimentId: manifest.experimentId,
      corpusManifest,
      taskSpec,
      profile,
      cellArtifactRoot,
      apiKey,
      agentImageReference: manifest.agentImage.reference,
      upstreamUrl: options.upstreamUrl,
      agentTimeoutMs: manifest.agentTimeoutMs,
      sessionTimeoutMs: manifest.sessionTimeoutMs
    });
    state.cells[cell.cellId] = record;
    await writeTrialSetStateAtomic(statePath, state);
    ran += 1;
    console.log(
      `  ${cell.cellId} finished: pilotStatus=${record.pilotStatus} datasetEligible=${record.datasetEligible} officialScoredResult=${record.officialScoredResult}`
    );
  }

  await writeFile(reportPath, buildHistoricalPgTrialSetReport({ manifest, records: Object.values(state.cells) }));
  console.log(`Ran ${ran} cell(s), skipped ${skipped} already-completed cell(s).`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`State: ${statePath}`);
  console.log(`Report: ${reportPath}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
