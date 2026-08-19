/**
 * Drives the instruction-file A/B eval matrix (#25) over the REST API:
 * (variants x tasks x trials) runs of the `eval-instruction-ab-trial`
 * recipe, then aggregates gate outcomes into a Markdown comparison report
 * via server/evals/ab-report.ts.
 *
 * Budget note: every cell launches a real agent CLI session. The full
 * default matrix is 2 variants x 5 tasks x 3 trials = 30 agent runs;
 * depending on backend and model that is typically a few cents to tens of
 * cents per trial, and 1-10 minutes of wall time each. Always start with
 * --smoke (2 tasks x 1 trial = 4 runs) to validate the setup.
 *
 * Usage (HoneyRail server already running):
 *   node --import tsx scripts/evals-ab-demo.ts --seed-into ~/harness-ab-seed --smoke
 *   node --import tsx scripts/evals-ab-demo.ts --project-id proj_abc123
 *   node --import tsx scripts/evals-ab-demo.ts --report-only --out ./harness-ab-report
 *
 * Options:
 *   --base-url <url>            HoneyRail API base (default http://127.0.0.1:4178)
 *   --token <token>             Bearer token for auth (default: $HONEYRAIL_TOKEN)
 *   --project-id <id>           Existing project to run against
 *   --seed-into <dir>           Create the seed repo fixture there and register it as a project
 *   --agent <id>                Agent backend for every trial (default codex; codex|claude|hermes|shell|null|minimal - see docs/agent-adapters.md. "null"/"minimal" are #71 calibration baselines, not real agents)
 *   --model <id>                Model override passed to the agent (default: agent default)
 *   --trials <n>                Trials per (variant, task) cell (default 3)
 *   --tasks <id,id>             Subset of task ids from tasks.json (default all)
 *   --variants <label=path,...> Instruction-file variants (default baseline/improved fixtures)
 *   --instruction-path <path>   Path injected into the worktree (default AGENTS.md)
 *   --out <dir>                 Output directory for state.json + comparison-report.md (default ./harness-ab-report)
 *   --poll-seconds <n>          Poll interval while a run executes (default 10)
 *   --run-timeout-minutes <n>   Per-run timeout before cancelling it (default 30)
 *   --smoke                     2 tasks x 1 trial - cheap end-to-end validation
 *   --dry-run                   Print the matrix and budget note, launch nothing
 *   --report-only               Skip execution; rebuild the report from state.json
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildComparisonReport,
  classifyTrialOutcome,
  type ComparisonReportInput,
  type TrialRecord
} from "../server/evals/ab-report.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(__dirname, "..", "examples", "harness-ab-eval");

const RECIPE_ID = "eval-instruction-ab-trial";
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "blocked", "cancelled"]);

let authToken: string | undefined;

type TaskSpec = { id: string; title: string; prompt: string; checkCommand: string };
type VariantSpec = { label: string; path: string; content: string; sha256: string };
type CliOptions = {
  baseUrl: string;
  token?: string;
  projectId?: string;
  seedInto?: string;
  agent: string;
  model: string;
  trials: number;
  taskIds?: string[];
  variantArgs?: string[];
  instructionPath: string;
  out: string;
  pollSeconds: number;
  runTimeoutMinutes: number;
  smoke: boolean;
  dryRun: boolean;
  reportOnly: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: "http://127.0.0.1:4178",
    token: process.env.HONEYRAIL_TOKEN || undefined,
    agent: "codex",
    model: "",
    trials: 3,
    instructionPath: "AGENTS.md",
    out: "./harness-ab-report",
    pollSeconds: 10,
    runTimeoutMinutes: 30,
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
      case "--base-url": options.baseUrl = next().replace(/\/$/, ""); break;
      case "--token": options.token = next(); break;
      case "--project-id": options.projectId = next(); break;
      case "--seed-into": options.seedInto = next(); break;
      case "--agent": options.agent = next(); break;
      case "--model": options.model = next(); break;
      case "--trials": options.trials = Number(next()); break;
      case "--tasks": options.taskIds = next().split(",").map((id) => id.trim()).filter(Boolean); break;
      case "--variants": options.variantArgs = next().split(",").map((pair) => pair.trim()).filter(Boolean); break;
      case "--instruction-path": options.instructionPath = next(); break;
      case "--out": options.out = next(); break;
      case "--poll-seconds": options.pollSeconds = Number(next()); break;
      case "--run-timeout-minutes": options.runTimeoutMinutes = Number(next()); break;
      case "--smoke": options.smoke = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--report-only": options.reportOnly = true; break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/evals-ab-demo.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) throw new Error("--trials must be a positive integer");
  if (!Number.isFinite(options.pollSeconds) || options.pollSeconds < 1) throw new Error("--poll-seconds must be >= 1");
  if (!Number.isFinite(options.runTimeoutMinutes) || options.runTimeoutMinutes < 1) throw new Error("--run-timeout-minutes must be >= 1");
  return options;
}

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(init?.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function ensureProject(options: CliOptions): Promise<string> {
  if (options.projectId) return options.projectId;
  if (!options.seedInto) throw new Error("Pass --project-id <id> or --seed-into <dir>");
  const target = resolve(options.seedInto);
  const existing = await readdir(target).catch(() => null);
  if (existing && existing.length) {
    throw new Error(`--seed-into directory is not empty: ${target}`);
  }
  await mkdir(target, { recursive: true });
  await cp(join(fixtureRoot, "seed-repo"), target, { recursive: true });
  await git(target, ["init", "-b", "main"]);
  await git(target, ["add", "-A"]);
  await git(target, ["-c", "user.name=harness-ab-demo", "-c", "user.email=harness-ab-demo@localhost", "commit", "-m", "Seed harness A/B eval fixture"]);
  const { project } = await api<{ project: { id: string } }>(options.baseUrl, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ repoPath: target, name: basename(target), defaultBranch: "main" })
  });
  console.log(`Registered seed project ${project.id} at ${target}`);
  return project.id;
}

async function loadVariants(options: CliOptions): Promise<VariantSpec[]> {
  const pairs = options.variantArgs?.length
    ? options.variantArgs.map((pair) => {
        const separator = pair.indexOf("=");
        if (separator < 1) throw new Error(`--variants entries must be label=path, got "${pair}"`);
        return { label: pair.slice(0, separator), file: resolve(pair.slice(separator + 1)) };
      })
    : [
        { label: "baseline", file: join(fixtureRoot, "variants", "baseline.md") },
        { label: "improved", file: join(fixtureRoot, "variants", "improved.md") }
      ];
  return Promise.all(
    pairs.map(async ({ label, file }) => {
      const content = await readFile(file, "utf8");
      return { label, path: options.instructionPath, content, sha256: createHash("sha256").update(content).digest("hex") };
    })
  );
}

async function loadTasks(options: CliOptions): Promise<TaskSpec[]> {
  const raw = await readFile(join(fixtureRoot, "tasks.json"), "utf8");
  const allTasks = (JSON.parse(raw) as { tasks: TaskSpec[] }).tasks;
  let tasks = allTasks;
  if (options.taskIds?.length) {
    tasks = options.taskIds.map((id) => {
      const task = allTasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error(`Unknown task id "${id}" (known: ${allTasks.map((t) => t.id).join(", ")})`);
      return task;
    });
  }
  if (options.smoke) tasks = tasks.slice(0, 2);
  return tasks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

type RunDetail = {
  run: { id: string; status: string; startedAt?: string; finishedAt?: string; error?: string };
  steps?: Array<{ status: string; failureKind?: string }>;
};

async function executeCell(
  options: CliOptions,
  projectId: string,
  variant: VariantSpec,
  task: TaskSpec,
  trial: number
): Promise<TrialRecord> {
  const goal = `A/B eval ${variant.label}/${task.id}/trial-${trial}`;
  const created = await api<RunDetail>(options.baseUrl, `/api/recipes/${RECIPE_ID}/runs`, {
    method: "POST",
    body: JSON.stringify({
      projectId,
      goal,
      parameters: {
        agent: options.agent,
        title: `[${variant.label}] ${task.title} (trial ${trial})`,
        prompt: task.prompt,
        checkCommand: task.checkCommand,
        instructionPath: variant.path,
        instructionContent: variant.content,
        instructionLabel: variant.label,
        model: options.model
      }
    })
  });
  const runId = created.run.id;
  console.log(`  launched run ${runId} (${goal})`);

  const deadline = Date.now() + options.runTimeoutMinutes * 60_000;
  let runStatus = created.run.status;
  let detail: RunDetail = created;
  while (!TERMINAL_RUN_STATUSES.has(runStatus)) {
    if (Date.now() > deadline) {
      await api(options.baseUrl, `/api/runs/${runId}/cancel`, { method: "POST", body: "{}" }).catch(() => undefined);
      runStatus = "timeout";
      break;
    }
    await sleep(options.pollSeconds * 1000);
    detail = await api<RunDetail>(options.baseUrl, `/api/runs/${runId}`);
    runStatus = detail.run.status;
  }

  const { gateDecisions } = await api<{ gateDecisions: Array<{ status: string }> }>(
    options.baseUrl,
    `/api/runs/${runId}/gate-decisions`
  );
  const { evidence } = await api<{ evidence: Array<{ id: string; kind: string; claim?: string }> }>(
    options.baseUrl,
    `/api/runs/${runId}/evidence`
  );
  const startedAt = detail.run.startedAt;
  const finishedAt = detail.run.finishedAt;
  const wallTimeMs =
    startedAt && finishedAt && Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(finishedAt))
      ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
      : undefined;
  const record: TrialRecord = {
    variant: variant.label,
    taskId: task.id,
    trial,
    runId,
    runStatus,
    gatePassed: runStatus === "succeeded" && gateDecisions.length > 0 && gateDecisions.every((decision) => decision.status === "passed"),
    steps: detail.steps?.map((step) => ({ status: step.status, failureKind: step.failureKind })),
    startedAt,
    finishedAt,
    wallTimeMs,
    evidence: evidence.map((item) => ({ id: item.id, kind: item.kind, claim: item.claim })),
    error: detail.run.error
  };
  console.log(`  run ${runId} finished: status=${runStatus} outcome=${classifyTrialOutcome(record)} gate=${record.gatePassed ? "passed" : "failed"}`);
  return record;
}

type StateFile = {
  config: { baseUrl: string; projectId: string; agent: string; smoke: boolean };
  variants: Array<{ label: string; path: string; sha256: string }>;
  trials: TrialRecord[];
};

async function writeReport(outDir: string, state: StateFile): Promise<string> {
  const input: ComparisonReportInput = {
    generatedAt: new Date().toISOString(),
    baseUrl: state.config.baseUrl,
    recipeId: RECIPE_ID,
    projectId: state.config.projectId,
    agent: state.config.agent,
    smoke: state.config.smoke,
    variants: state.variants,
    trials: state.trials
  };
  const reportPath = join(outDir, "comparison-report.md");
  await writeFile(reportPath, buildComparisonReport(input));
  return reportPath;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  authToken = options.token;
  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const statePath = join(outDir, "state.json");

  if (options.reportOnly) {
    const state = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
    const reportPath = await writeReport(outDir, state);
    console.log(`Report rebuilt from ${statePath}: ${reportPath}`);
    return;
  }

  const variants = await loadVariants(options);
  const tasks = await loadTasks(options);
  const trialsPerCell = options.smoke ? 1 : options.trials;
  const totalRuns = variants.length * tasks.length * trialsPerCell;

  console.log(`Matrix: ${variants.length} variants x ${tasks.length} tasks x ${trialsPerCell} trials = ${totalRuns} agent runs.`);
  console.log(`Budget note: each run launches a real "${options.agent}" agent session (typically a few cents to tens of cents and 1-10 minutes each). Use --smoke to validate cheaply first.`);
  if (options.dryRun) {
    for (const variant of variants) {
      for (const task of tasks) {
        for (let trial = 1; trial <= trialsPerCell; trial += 1) {
          console.log(`  would run: ${variant.label}/${task.id}/trial-${trial}`);
        }
      }
    }
    return;
  }

  // Fails fast with a clear message when the server is missing the recipe.
  await api(options.baseUrl, `/api/recipes/${RECIPE_ID}`);
  const projectId = await ensureProject(options);
  const state: StateFile = {
    config: { baseUrl: options.baseUrl, projectId, agent: options.agent, smoke: options.smoke },
    variants: variants.map(({ label, path, sha256 }) => ({ label, path, sha256 })),
    trials: []
  };

  // Sequential on purpose: trials share one host's agent CLI and tmux, and
  // interleaved sessions would confound the wall-time comparison.
  for (const variant of variants) {
    for (const task of tasks) {
      for (let trial = 1; trial <= trialsPerCell; trial += 1) {
        console.log(`Cell ${variant.label}/${task.id}/trial-${trial} (${state.trials.length + 1}/${totalRuns}):`);
        try {
          state.trials.push(await executeCell(options, projectId, variant, task, trial));
        } catch (error) {
          console.error(`  cell failed to execute: ${(error as Error).message}`);
          state.trials.push({
            variant: variant.label,
            taskId: task.id,
            trial,
            runId: "",
            runStatus: "driver_error",
            gatePassed: false,
            evidence: [],
            error: (error as Error).message
          });
        }
        await writeFile(statePath, JSON.stringify(state, null, 2));
      }
    }
  }

  const reportPath = await writeReport(outDir, state);
  const outcomes = state.trials.map((trial) => classifyTrialOutcome(trial));
  const passes = outcomes.filter((outcome) => outcome === "passed").length;
  const blocked = outcomes.filter((outcome) => outcome === "blocked").length;
  const scored = state.trials.length - blocked;
  console.log(`Done: ${passes}/${scored} trials passed their gate${blocked ? ` (${blocked} blocked, excluded)` : ""}.`);
  console.log(`State: ${statePath}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
