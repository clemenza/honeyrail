import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { PostgresResearchError, type PostgresResearchSpec } from "../server/postgres/research-environment.js";
import {
  runAgentInPostgresResearchEnvironment,
  type PostgresResearchSessionOptions
} from "../server/postgres/research-session.js";
import { createSyntheticPostgresSourceRepo, hasFixtureToolchain, type SyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

// SHOULD FIX 3 (#179 review): the one supported composition where an agent
// drives a *live* research PostgreSQL. Everything runs against the synthetic
// source fixture, and the "agent" is a shell script - what is under test is
// the lifecycle, not any real agent CLI.
//
// These tests are about lifecycle and teardown ordering, not about the
// agent-execution boundary, so they deliberately opt out of isolation with
// `allowUnisolatedForDevelopment` and run the agent as a host process. The
// boundary itself is tested through the real container launch in
// test/postgres-research-isolation.test.ts.

const DEV_MODE: PostgresResearchSessionOptions = { isolation: { allowUnisolatedForDevelopment: true } };

async function exists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

type Fixture = { tempDir: string; repo: SyntheticPostgresSourceRepo; cacheRoot: string };

async function withFixture(t: TestContext): Promise<Fixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-session-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const repo = await createSyntheticPostgresSourceRepo(join(tempDir, "repo"));
  return { tempDir, repo, cacheRoot: join(tempDir, "build-cache") };
}

function specFor(fixture: Fixture, name: string): PostgresResearchSpec {
  return {
    root: join(fixture.tempDir, "envs", name),
    privateDir: join(fixture.tempDir, "private", name),
    source: { repoPath: fixture.repo.repoPath, ref: fixture.repo.ref },
    build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1 }
  };
}

async function writeAgent(fixture: Fixture, name: string, body: string) {
  const path = join(fixture.tempDir, name);
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
  return path;
}

async function skipWithoutToolchain(t: TestContext) {
  if (await hasFixtureToolchain()) return false;
  t.skip("git, make, tar or a C compiler probe is unavailable");
  return true;
}

test("an agent process receives the dynamic coordinates and queries the live cluster before cleanup", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  // A stand-in for a real agent: it only uses what agentEnvironment() gave
  // it, and every one of those values is decided at runtime.
  const agentPath = await writeAgent(
    fixture,
    "agent-success.sh",
    [
      "set -e",
      'echo "port=$HR_PG_PORT"',
      'echo "cwd=$(pwd)"',
      '[ -f "$HR_PG_SOURCE_DIR/configure" ] || { echo "no source snapshot" >&2; exit 10; }',
      '[ -d "$HR_PG_DATA_DIR" ] || { echo "no data directory" >&2; exit 11; }',
      'grep -q "ready to accept connections" "$HR_PG_LOG" || { echo "no server log" >&2; exit 12; }',
      '"$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "INSERT from-agent"',
      'answer=$("$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "SELECT count(*) FROM stub;")',
      'echo "rows=$answer"',
      // Written last so the test can prove cleanup ran strictly afterwards.
      'date -u +%Y-%m-%dT%H:%M:%SZ > "$HR_PG_SOURCE_DIR/../agent-finished"',
      ""
    ].join("\n")
  );

  const spec = specFor(fixture, "live");
  const session = await runAgentInPostgresResearchEnvironment(spec, { command: agentPath, timeoutMs: 60_000 }, DEV_MODE);

  // 1. It ran against a live server, with runtime-only coordinates.
  assert.equal(session.agent.ok, true, `agent failed: ${session.agent.stderr}`);
  assert.equal(session.agent.exitCode, 0);
  assert.match(session.agent.stdout, new RegExp(`port=${session.connection.port}\\b`));
  assert.match(session.agent.stdout, /rows=1/);
  assert.equal(session.agentEnvironment.HR_PG_PORT, String(session.connection.port));
  assert.equal(session.agentEnvironment.HR_PG_SOURCE_DIR, join(spec.root, "source"));
  assert.equal(session.agent.cwd, spec.root, "the agent runs inside the agent-visible root by default");
  // ...and the result says plainly that this ran without a boundary.
  assert.equal(session.isolation.mode, "unisolated-development");
  assert.equal(session.isolation.isolated, false);
  assert.match(session.isolation.warning!, /not a scored trial/);

  // 2. Cleanup happened, and strictly after the agent's last action.
  const finishedAt = (await readFile(join(spec.root, "agent-finished"), "utf8")).trim();
  assert.match(finishedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(session.runtime.cleanup, "cleanup must have run");
  assert.equal(session.runtime.cleanup!.stopped, true);
  assert.ok(
    Date.parse(session.runtime.cleanup!.at) >= Date.parse(finishedAt),
    "the environment must be torn down only after the agent finished"
  );
  assert.equal(await exists(join(spec.root, "pgdata")), false, "PGDATA is removed after the agent, not before");
  assert.equal(await exists(session.connection.socketDir), false);

  // 3. The agent never saw the answer key.
  const secrets = [fixture.repo.ref, session.source.resolvedCommit, session.source.sourceHash, session.build.cacheKey];
  const exposed = JSON.stringify(session.agentEnvironment) + session.agent.stdout;
  for (const secret of secrets) assert.equal(exposed.includes(secret), false, `${secret} leaked to the agent`);
  // ...while the grader side kept it.
  assert.equal(session.source.ref, fixture.repo.ref);
  assert.match(session.build.cacheKey, /^[0-9a-f]{64}$/);
});

test("an agent that exits non-zero is an observation, and the environment is still cleaned up", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const agentPath = await writeAgent(fixture, "agent-failure.sh", ['echo "starting"', 'echo "boom" >&2', "exit 3", ""].join("\n"));

  const spec = specFor(fixture, "failing");
  const session = await runAgentInPostgresResearchEnvironment(spec, { command: agentPath, timeoutMs: 60_000 }, DEV_MODE);

  // A failed agent is a trial outcome, not an environment failure - the same
  // rule psql() follows for a failing statement.
  assert.equal(session.agent.ok, false);
  assert.equal(session.agent.exitCode, 3);
  assert.equal(session.agent.timedOut, false);
  assert.match(session.agent.stdout, /starting/);
  assert.match(session.agent.stderr, /boom/);
  assert.equal(session.runtime.cleanup!.stopped, true);
  assert.equal(await exists(join(spec.root, "pgdata")), false);
  assert.equal(await exists(session.connection.socketDir), false);
});

test("an agent that hangs is killed at its timeout and the environment is torn down after it exits", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const agentPath = await writeAgent(fixture, "agent-hang.sh", ['echo "hanging"', "sleep 60", ""].join("\n"));

  const spec = specFor(fixture, "hanging");
  const started = Date.now();
  // Wide enough that a loaded machine still schedules the agent's first echo
  // before the kill lands - the assertion below is about output survival, not
  // about how tight the timeout can be - and far below the 60s sleep.
  const session = await runAgentInPostgresResearchEnvironment(spec, { command: agentPath, timeoutMs: 5000 }, DEV_MODE);

  assert.equal(session.agent.timedOut, true);
  assert.equal(session.agent.ok, false);
  assert.ok(session.agent.durationMs < 30_000, `the agent was not killed promptly (${session.agent.durationMs}ms)`);
  assert.ok(Date.now() - started < 60_000);
  assert.match(session.agent.stdout, /hanging/, "output produced before the kill is still collected");
  // Teardown is ordered behind the kill, so nothing was still talking to the
  // server when its data directory went away.
  assert.equal(session.runtime.cleanup!.stopped, true);
  assert.equal(await exists(join(spec.root, "pgdata")), false);
  assert.equal(await exists(session.connection.socketDir), false);
});

test("an unrunnable agent command fails loudly and still cleans up", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const spec = specFor(fixture, "missing-agent");

  await assert.rejects(
    runAgentInPostgresResearchEnvironment(spec, { command: join(fixture.tempDir, "does-not-exist.sh") }, DEV_MODE),
    (error: Error) => error instanceof PostgresResearchError && /Could not run research agent/.test(error.message)
  );
  assert.equal(await exists(join(spec.root, "pgdata")), false, "cleanup runs on the error path too");

  await assert.rejects(
    runAgentInPostgresResearchEnvironment(spec, { command: "  " }, DEV_MODE),
    (error: Error) => error instanceof PostgresResearchError && /requires a command/.test(error.message)
  );
});
