#!/usr/bin/env -S node --import tsx
/**
 * One-off real-agent evidence run for #197 round 2's third requested change:
 * a real DSH agent, making a real DeepSeek API call, against a real
 * containerized PostgreSQL cluster, restricted to the gateway's egress path -
 * not the mini-agent.mjs stand-in, and not a stub upstream.
 *
 * This is deliberately a throwaway driver, not a HoneyRail subsystem: it
 * exists to produce one piece of evidence for the PR, the same way #194's
 * "Real-agent evidence" section did with mini-agent.mjs. It is not wired into
 * any task contract, grader, or recipe, and nothing here is scored.
 *
 * Prerequisites:
 *   docker build -t honeyrail-postgres-builder:latest docker/postgres-research-builder
 *   docker build -t honeyrail-postgres-runtime:latest docker/postgres-research-runtime
 *   docker build -t honeyrail-postgres-research:latest docker/postgres-research
 *   docker build -t honeyrail-postgres-egress-gateway:latest docker/postgres-egress-gateway
 *   docker build -t honeyrail-postgres-research-agent-dsh:latest docker/postgres-research-agent-dsh
 *   git clone --filter=blob:none --no-checkout https://github.com/postgres/postgres.git /tmp/pg-mirror
 *
 * Run:
 *   DEEPSEEK_API_KEY=... node --import tsx scripts/postgres-egress-dsh-smoke.ts \
 *     --mirror /tmp/pg-mirror --ref REL_16_9
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgentInPostgresResearchEnvironment } from "../server/postgres/research-session.js";
import type { PostgresResearchSpec } from "../server/postgres/research-environment.js";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

const PROMPT = [
  "You are working inside an isolated PostgreSQL research container.",
  "",
  "Do exactly two things, in order, and report the exact result of each:",
  "",
  "1. Run this shell command and report its exact output verbatim:",
  '   psql "$HR_PG_URL" -c "SELECT version();"',
  "",
  "2. Determine whether this container can reach the public internet host",
  "   www.postgresql.org. You may use any tool available to you, for example:",
  "   node -e \"require('https').get('https://www.postgresql.org/', r => { console.log('STATUS', r.statusCode); process.exit(0); }).on('error', e => { console.log('UNREACHABLE:', e.message); process.exit(0); })\"",
  "   Report the exact result of this attempt too - whether it succeeded or failed, and the exact error if it failed.",
  "",
  "Do not modify any files. Do not attempt anything beyond these two steps. Report both results clearly."
].join("\n");

async function main() {
  const mirror = arg("mirror", process.env.HONEYRAIL_PG_TEST_MIRROR);
  const ref = arg("ref", process.env.HONEYRAIL_PG_TEST_REF || "REL_16_9")!;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!mirror) throw new Error("--mirror <path-to-postgres-git-mirror> is required (or set HONEYRAIL_PG_TEST_MIRROR)");
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY must be set in the launching environment");

  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-197-dsh-smoke-"));
  const cacheRoot = process.env.HONEYRAIL_PG_TEST_CACHE || join(tmpdir(), "honeyrail-pg-real-build-cache");

  const spec: PostgresResearchSpec = {
    root: join(tempDir, "env"),
    privateDir: join(tempDir, "private"),
    source: { repoPath: mirror, ref },
    build: { cacheRoot },
    buildViewsRoot: join(tempDir, "build-views")
  };

  console.error(`[smoke] source ref=${ref} mirror=${mirror}`);
  console.error(`[smoke] build cache=${cacheRoot} (reused if present - a cold build is several minutes)`);
  console.error(`[smoke] starting: real containerized PostgreSQL + real DSH through the restricted-egress gateway...`);

  const started = Date.now();
  try {
    const session = await runAgentInPostgresResearchEnvironment(
      spec,
      {
        command: "dsh",
        args: ["--profile", "headless", PROMPT],
        env: {
          DEEPSEEK_API_KEY: apiKey,
          DSH_PERMISSION_MODE: "danger-full-access"
        },
        timeoutMs: 5 * 60 * 1000
      },
      {
        isolation: {
          image: "honeyrail-postgres-research-agent-dsh:latest",
          restrictedEgress: { upstreamUrl: "https://api.deepseek.com" }
        },
        timeoutMs: 30 * 60 * 1000
      }
    );

    const durationMs = Date.now() - started;
    const evidence = {
      durationMs,
      networkMode: session.isolation.networkMode,
      restrictedEgressVerified: session.isolation.mode === "container" ? session.isolation.restrictedEgressVerified : undefined,
      egressGateway: session.isolation.mode === "container" ? session.isolation.egressGateway : undefined,
      scoredEligible: session.isolation.scoredEligible,
      warning: session.isolation.mode === "container" ? session.isolation.warning : undefined,
      agentOk: session.agent.ok,
      agentExitCode: session.agent.exitCode,
      agentTimedOut: session.agent.timedOut,
      agentStdout: session.agent.stdout,
      agentStderr: session.agent.stderr
    };

    const evidencePath = join(tempDir, "evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    console.error(`[smoke] evidence written to ${evidencePath} (this tempDir is not auto-removed)`);
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(`[smoke] FAILED after ${Date.now() - started}ms:`, error);
    process.exitCode = 1;
  }
}

main();
