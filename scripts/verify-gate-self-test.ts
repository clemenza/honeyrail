/**
 * #72 verify-gate self-test: "We previously found an example recipe's
 * verify step was effectively a no-op - a step with no artifact and no
 * test command still passed. The gate itself needs to be tested first, or
 * pass rate numbers are meaningless."
 *
 * Runs every built-in, agent-driven recipe (and every task in the
 * eval-instruction-ab-trial task suite) once with the #71 `null` agent -
 * which does no real work by construction - and asserts each run's gate
 * FAILS. A run that SUCCEEDS with a null agent means its verify step is a
 * false-pass: it would score a genuinely broken agent as having completed
 * the task, making any pass-rate comparison built on top of it meaningless.
 *
 * Usage (HoneyRail server already running):
 *   node --import tsx scripts/verify-gate-self-test.ts --seed-into ~/verify-gate-seed
 *   node --import tsx scripts/verify-gate-self-test.ts --project-id proj_abc123
 *   node --import tsx scripts/verify-gate-self-test.ts --dry-run
 *
 * Options:
 *   --base-url <url>            HoneyRail API base (default http://127.0.0.1:4178)
 *   --token <token>             Bearer token for auth (default: $HONEYRAIL_TOKEN)
 *   --project-id <id>           Existing project to run against
 *   --seed-into <dir>           Create the seed repo fixture there and register it as a project
 *   --poll-seconds <n>          Poll interval while a run executes (default 5)
 *   --run-timeout-minutes <n>   Per-run timeout before treating it as a defect (default 10)
 *   --out <dir>                 Output directory for results.json (default ./verify-gate-self-test-report)
 *   --dry-run                   Print the target list, launch nothing
 *
 * Exit code is 1 if any target is a defect (null agent passed, or a run
 * never reached a terminal state) or 0 if every target correctly failed -
 * suitable for a CI job (see .github/workflows/verify-gate-self-test.yml).
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { classifySelfTestOutcome, type SelfTestOutcome } from "../server/evals/verify-gate.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(__dirname, "..", "examples", "harness-ab-eval");

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "blocked", "cancelled"]);

let authToken: string | undefined;

type CliOptions = {
  baseUrl: string;
  token?: string;
  projectId?: string;
  seedInto?: string;
  pollSeconds: number;
  runTimeoutMinutes: number;
  out: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    baseUrl: "http://127.0.0.1:4178",
    token: process.env.HONEYRAIL_TOKEN || undefined,
    pollSeconds: 5,
    runTimeoutMinutes: 10,
    out: "./verify-gate-self-test-report",
    dryRun: false
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
      case "--poll-seconds": options.pollSeconds = Number(next()); break;
      case "--run-timeout-minutes": options.runTimeoutMinutes = Number(next()); break;
      case "--out": options.out = next(); break;
      case "--dry-run": options.dryRun = true; break;
      case "--help":
      case "-h":
        console.log("See the header comment of scripts/verify-gate-self-test.ts for usage.");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
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
  await execFileAsync("cp", ["-r", join(fixtureRoot, "seed-repo") + "/.", target]);
  await git(target, ["init", "-b", "main"]);
  await git(target, ["add", "-A"]);
  await git(target, ["-c", "user.name=verify-gate-self-test", "-c", "user.email=verify-gate-self-test@localhost", "commit", "-m", "Seed verify-gate self-test fixture"]);
  const { project } = await api<{ project: { id: string } }>(options.baseUrl, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ repoPath: target, name: basename(target), defaultBranch: "main" })
  });
  console.log(`Registered seed project ${project.id} at ${target}`);
  return project.id;
}

type SelfTestTarget = {
  recipeId: string;
  label: string;
  parameters: Record<string, unknown>;
};

type SkippedTarget = {
  recipeId: string;
  reason: string;
};

async function loadTargets(): Promise<SelfTestTarget[]> {
  const raw = await readFile(join(fixtureRoot, "tasks.json"), "utf8");
  const tasks = (JSON.parse(raw) as { tasks: Array<{ id: string; title: string; prompt: string; checkCommand: string }> }).tasks;
  const abTrialTargets = tasks.map((task) => ({
    recipeId: "eval-instruction-ab-trial",
    label: `eval-instruction-ab-trial / ${task.id}`,
    parameters: {
      agent: "null",
      title: task.title,
      prompt: task.prompt,
      checkCommand: task.checkCommand
    }
  }));
  return [
    ...abTrialTargets,
    {
      recipeId: "implement-check-gate-approve",
      label: "implement-check-gate-approve / default (fizzbuzz)",
      // gateOnFail forced to "fail" (its default is "wait_approval") so a
      // failing null-agent run reaches a clean terminal "failed" state
      // instead of parking in "waiting_approval" - a self-test needs a
      // definite terminal verdict, not a human sitting in the loop.
      parameters: { agent: "null", gateOnFail: "fail" }
    }
  ];
}

// Recipes with no agent-task step have nothing for a null agent to replace
// - "does the gate correctly reject a null agent" doesn't apply to them.
// Listed explicitly (not silently omitted) so the report accounts for
// every built-in recipe.
const SKIPPED_TARGETS: SkippedTarget[] = [
  { recipeId: "postgres-transaction-restart", reason: "no agent-task step - verifies PostgreSQL behavior directly, not an agent's work" }
];

type RunDetail = { run: { id: string; status: string; startedAt?: string; finishedAt?: string; error?: string } };

type SelfTestResult = {
  target: SelfTestTarget;
  runId?: string;
  runStatus?: string;
  outcome: SelfTestOutcome;
  error?: string;
};

async function runTarget(options: CliOptions, projectId: string, target: SelfTestTarget): Promise<SelfTestResult> {
  console.log(`Running ${target.label} ...`);
  let created: RunDetail;
  try {
    created = await api<RunDetail>(options.baseUrl, `/api/recipes/${target.recipeId}/runs`, {
      method: "POST",
      body: JSON.stringify({ projectId, goal: `verify-gate-self-test: ${target.label}`, parameters: target.parameters })
    });
  } catch (error) {
    return { target, outcome: "driver_error", error: (error as Error).message };
  }
  const runId = created.run.id;
  console.log(`  launched run ${runId}`);

  const deadline = Date.now() + options.runTimeoutMinutes * 60_000;
  let runStatus = created.run.status;
  while (!TERMINAL_RUN_STATUSES.has(runStatus)) {
    if (Date.now() > deadline) {
      await api(options.baseUrl, `/api/runs/${runId}/cancel`, { method: "POST", body: "{}" }).catch(() => undefined);
      const outcome = classifySelfTestOutcome(undefined);
      console.log(`  run ${runId} never reached a terminal state within ${options.runTimeoutMinutes}m -> ${outcome.toUpperCase()}`);
      return { target, runId, runStatus: "timeout", outcome };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, options.pollSeconds * 1000));
    const detail = await api<RunDetail>(options.baseUrl, `/api/runs/${runId}`);
    runStatus = detail.run.status;
  }

  const outcome = classifySelfTestOutcome(runStatus);
  console.log(`  run ${runId} finished: status=${runStatus} -> ${outcome.toUpperCase()}`);
  return { target, runId, runStatus, outcome };
}

function printSummary(results: SelfTestResult[]): boolean {
  const lines: string[] = [];
  lines.push("");
  lines.push("Verify-gate self-test summary");
  lines.push("==============================");
  for (const result of results) {
    const marker = result.outcome === "ok" ? "PASS" : result.outcome.toUpperCase();
    lines.push(`[${marker}] ${result.target.label}${result.runId ? ` (${result.runId}, ${result.runStatus})` : ""}${result.error ? ` - ${result.error}` : ""}`);
  }
  for (const skipped of SKIPPED_TARGETS) {
    lines.push(`[SKIP] ${skipped.recipeId} - ${skipped.reason}`);
  }
  const defects = results.filter((result) => result.outcome !== "ok");
  lines.push("");
  if (defects.length) {
    lines.push(`${defects.length} of ${results.length} target(s) are verify-gate defects: a null agent that did no real work did not fail the gate as expected.`);
  } else {
    lines.push(`All ${results.length} target(s) correctly rejected the null agent.`);
  }
  console.log(lines.join("\n"));
  return defects.length === 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  authToken = options.token;
  const targets = await loadTargets();

  if (options.dryRun) {
    console.log(`${targets.length} target(s):`);
    for (const target of targets) console.log(`  would run: ${target.label}`);
    for (const skipped of SKIPPED_TARGETS) console.log(`  would skip: ${skipped.recipeId} (${skipped.reason})`);
    return;
  }

  const outDir = resolve(options.out);
  await mkdir(outDir, { recursive: true });

  const projectId = await ensureProject(options);
  const results: SelfTestResult[] = [];
  // Sequential on purpose, same reasoning as evals-ab-demo.ts: trials share
  // one host's tmux, and interleaved sessions would confound debugging a
  // failure.
  for (const target of targets) {
    results.push(await runTarget(options, projectId, target));
  }

  await writeFile(join(outDir, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), projectId, results, skipped: SKIPPED_TARGETS }, null, 2));
  const ok = printSummary(results);
  console.log(`\nReport: ${join(outDir, "results.json")}`);
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
