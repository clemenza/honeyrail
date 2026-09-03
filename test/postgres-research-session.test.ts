import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { PostgresResearchError, PostgresResearchTimeoutError, type PostgresResearchSpec } from "../server/postgres/research-environment.js";
import {
  DEFAULT_RESEARCH_IMAGE,
  PostgresResearchAgentContainerError,
  resolveResearchAgentImageIdentity
} from "../server/postgres/agent-container.js";
import {
  assertResearchAgentImageCompatible,
  runAgentInPostgresResearchEnvironment,
  runAgentProcess,
  type PostgresResearchSessionOptions
} from "../server/postgres/research-session.js";
import type { PostgresBuildManifest } from "../server/postgres/research-environment.js";
import type { RunCommand } from "../server/postgres/runtime.js";
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

// #188: runAgentProcess() is the single place both `agent.timeoutMs` and the
// session's outer AbortSignal fund the same kill sequence. These tests are
// deterministic and need neither a research environment nor a docker daemon
// - they spawn a plain shell process directly, the same way unisolatedLaunch()
// does (detached: true, so killTree()'s process-group signal reaches a
// grandchild like `sleep` directly rather than only the wrapper shell - a
// non-interactive shell blocked on a foreground command can defer acting on
// its own SIGTERM until that command exits on its own, so `detached: false`
// here would make these tests flaky-slow rather than deterministic) - so they
// exercise the cancellation semantics in isolation from materialize/build/start
// and from any container boundary.
async function withShellScript(t: TestContext, body: string) {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-agent-process-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "script.sh");
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
  return { command: path, args: [] as string[], cwd: dir, env: process.env, detached: true };
}

test("the session AbortSignal kills the agent and records timeoutSource \"session\", even without agent.timeoutMs", async (t) => {
  const launch = await withShellScript(t, "sleep 5\n");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);

  const started = Date.now();
  const result = await runAgentProcess({ reported: launch, spawn: launch }, { command: launch.command }, controller.signal);

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSource, "session");
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 4000, `the session signal must kill the agent promptly, not wait for its 5s sleep (${result.durationMs}ms)`);
});

test("agent.timeoutMs kills the agent and records timeoutSource \"agent\" ahead of a later session signal", async (t) => {
  const launch = await withShellScript(t, "sleep 5\n");
  const controller = new AbortController();

  const result = await runAgentProcess({ reported: launch, spawn: launch }, { command: launch.command, timeoutMs: 100 }, controller.signal);

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSource, "agent");
  assert.equal(result.ok, false);

  // A session timeout arriving after the agent has already exited must be
  // harmless: no throw, no double-kill, no listener left registered.
  assert.doesNotThrow(() => controller.abort());
});

test("a normal fast exit is not marked timed out even when the session signal aborts moments later", async (t) => {
  const launch = await withShellScript(t, "exit 0\n");
  const controller = new AbortController();

  const result = await runAgentProcess({ reported: launch, spawn: launch }, { command: launch.command }, controller.signal);

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.timeoutSource, undefined);
  // Its abort listener must already be detached by the time the process has
  // closed, so a late abort is a plain no-op rather than an error.
  assert.doesNotThrow(() => controller.abort());
});

test("a signal already aborted before the agent is launched kills it immediately, ahead of agent.timeoutMs - repeated cancellation is harmless", async (t) => {
  const launch = await withShellScript(t, "sleep 5\n");
  const controller = new AbortController();
  controller.abort();

  const started = Date.now();
  // agent.timeoutMs is deliberately shorter still (1ms): if both causes ever
  // fired, "session" must win because it is observed synchronously at launch,
  // and the agent-timeout timer firing moments later must be a harmless no-op
  // rather than a second kill or a crash.
  const result = await runAgentProcess({ reported: launch, spawn: launch }, { command: launch.command, timeoutMs: 1 }, controller.signal);

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSource, "session");
  assert.ok(Date.now() - started < 3000, `a pre-aborted signal must kill immediately, not wait out the 5s sleep (${result.durationMs}ms)`);
});

test("a throwing/rejecting stop() is recorded as terminationError, not swallowed, and still does not prevent the kill sequence (#188)", async (t) => {
  const launch = await withShellScript(t, "sleep 5\n");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  const result = await runAgentProcess(
    { reported: launch, spawn: launch, stop: async () => { throw new Error("docker kill failed: no such container"); } },
    { command: launch.command },
    controller.signal
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSource, "session");
  assert.equal(result.ok, false);
  assert.match(
    result.terminationError ?? "",
    /docker kill failed/,
    "a failed termination request must be recorded, not indistinguishable from a successful one"
  );
});

test("runAgentProcess does not resolve while an async termination operation is still pending, and resolves once it settles (#188)", async (t) => {
  const launch = await withShellScript(t, "sleep 30\n");
  const controller = new AbortController();

  let stopCalled = false;
  let resolveTermination!: () => void;
  const terminationGate = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });

  const resultPromise = runAgentProcess(
    {
      reported: launch,
      spawn: launch,
      stop: async () => {
        stopCalled = true;
        // Deliberately left unresolved until the test resolves it below -
        // simulating a still-in-flight `docker kill` (or an async
        // terminate() the reviewer's minimal-design alternatives suggest).
        await terminationGate;
      }
    },
    { command: launch.command },
    controller.signal
  );

  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stopCalled, true, "cancellation must call stop() promptly once the signal aborts");

  // The core assertion: with termination still pending, the local child has
  // not been signalled yet (cancel() awaits stop() before escalating), so
  // runAgentProcess must not have resolved either. An implementation that
  // merely waits for the local docker-run client - without gating on the
  // termination operation itself - would fail this by resolving early.
  const settledWhilePending = await Promise.race([
    resultPromise.then(() => "settled" as const),
    new Promise<"still-pending">((resolve) => setTimeout(() => resolve("still-pending"), 500))
  ]);
  assert.equal(
    settledWhilePending,
    "still-pending",
    "runAgentProcess must not resolve while agent-container termination is still pending"
  );

  resolveTermination();
  const result = await resultPromise;

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutSource, "session");
  assert.equal(result.terminationError, undefined, "a termination that eventually succeeds must not be recorded as an error");
});

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

test("the outer session timeout kills a hanging agent ahead of an unset agent.timeoutMs, and cleanup waits for it (#188)", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const agentPath = await writeAgent(fixture, "agent-hang-session.sh", ['echo "hanging"', "sleep 600", ""].join("\n"));

  const spec = specFor(fixture, "session-timeout");
  const started = Date.now();
  // agent.timeoutMs is deliberately unset: only the session backstop
  // (options.timeoutMs) should be what kills this agent.
  let caught: unknown;
  try {
    await runAgentInPostgresResearchEnvironment(spec, { command: agentPath }, { ...DEV_MODE, timeoutMs: 5000 });
    assert.fail("expected the session timeout to reject the call");
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof PostgresResearchTimeoutError, `expected PostgresResearchTimeoutError, got ${caught}`);
  assert.ok(Date.now() - started < 30_000, "the session must finish near its deadline, not wait out the agent's 600s sleep");
  // A session timeout must not be an evidence-free rejection: the
  // environment's own runtime manifest is attached to the thrown error.
  const manifest = (caught as PostgresResearchTimeoutError).runtimeManifest as { cleanup?: Record<string, unknown> } | undefined;
  assert.ok(manifest, "the thrown timeout must carry the environment's runtime manifest");
  assert.equal(manifest!.cleanup?.stopped, true);
  assert.equal(manifest!.cleanup?.sessionTimedOut, true);
  assert.equal(manifest!.cleanup?.cancelGraceExceeded, false, "a conforming agent kill settles well inside the grace bound");
  // Teardown only happened after the agent was actually killed, the same
  // ordering guarantee agent.timeoutMs already gives.
  assert.equal(await exists(join(spec.root, "pgdata")), false);
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

test("the research agent image resolver records immutable identity fields for a mutable tag", async () => {
  const answers: Record<string, string> = {
    "{{.Id}}": `sha256:${"c".repeat(64)}`,
    "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}":
      `example.test/honeyrail/postgres-research@sha256:${"d".repeat(64)}`,
    "{{.Os}}": "linux",
    "{{.Architecture}}": "arm64",
    "{{if .Variant}}{{.Variant}}{{end}}": ""
  };
  const runCommand: RunCommand = async (_command, args = []) => ({
    ok: true,
    stdout: `${answers[args[3]] ?? ""}\n`,
    stderr: "",
    code: 0
  });

  const identity = await resolveResearchAgentImageIdentity("honeyrail-postgres-research:latest", runCommand);

  assert.deepEqual(identity, {
    reference: "honeyrail-postgres-research:latest",
    id: `sha256:${"c".repeat(64)}`,
    digest: `example.test/honeyrail/postgres-research@sha256:${"d".repeat(64)}`,
    platform: "linux/arm64",
    os: "linux",
    architecture: "arm64",
    variant: null
  });
  assert.deepEqual(JSON.parse(JSON.stringify(identity)), identity, "identity evidence must serialize without losing fields");
});

test("a missing research agent image fails before source materialization and never pulls", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-missing-agent-image-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const calls: string[][] = [];
  const runCommand: RunCommand = async (command, args = []) => {
    calls.push([command, ...args]);
    if (command === "docker" && args[0] === "version") return { ok: true, stdout: "25.0.0\n", stderr: "", code: 0 };
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") {
      return { ok: false, stdout: "", stderr: "Error: No such image", code: 1 };
    }
    throw new Error(`unexpected command: ${[command, ...args].join(" ")}`);
  };
  const spec: PostgresResearchSpec = {
    root: join(tempDir, "env"),
    privateDir: join(tempDir, "private"),
    source: { repoPath: join(tempDir, "repo"), ref: "HEAD" },
    build: { mode: "host", cacheRoot: join(tempDir, "cache"), jobs: 1 },
    runCommand
  };

  await assert.rejects(
    runAgentInPostgresResearchEnvironment(
      spec,
      { command: "/bin/true" },
      { isolation: { image: "honeyrail-postgres-research:definitely-not-present" } }
    ),
    (error: Error) =>
      error instanceof PostgresResearchError &&
      error instanceof PostgresResearchAgentContainerError &&
      error.cause instanceof Error &&
      /is not available to the docker daemon/.test(error.message) &&
      /docker build -t honeyrail-postgres-research:definitely-not-present docker\/postgres-research/.test(error.message)
  );

  assert.deepEqual(calls, [
    ["docker", "version", "--format", "{{.Server.Version}}"],
    [
      "docker",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      "honeyrail-postgres-research:definitely-not-present"
    ]
  ]);
  assert.equal(await exists(spec.root), false, "a missing agent image must fail before materializing source");
});

test("a scored build rejects an agent image for the wrong platform", () => {
  const build = {
    scoredEligible: true,
    platform: "linux",
    arch: "arm64"
  } as PostgresBuildManifest;

  assert.doesNotThrow(() =>
    assertResearchAgentImageCompatible({
      agentImage: {
        reference: DEFAULT_RESEARCH_IMAGE,
        id: `sha256:${"1".repeat(64)}`,
        digest: null,
        platform: "linux/arm64",
        os: "linux",
        architecture: "arm64",
        variant: null
      },
      build
    })
  );

  assert.doesNotThrow(() =>
    assertResearchAgentImageCompatible({
      agentImage: {
        reference: DEFAULT_RESEARCH_IMAGE,
        id: `sha256:${"4".repeat(64)}`,
        digest: null,
        platform: "linux/arm64/v8",
        os: "linux",
        architecture: "aarch64",
        variant: "8"
      },
      build
    })
  );

  assert.doesNotThrow(() =>
    assertResearchAgentImageCompatible({
      agentImage: {
        reference: DEFAULT_RESEARCH_IMAGE,
        id: `sha256:${"5".repeat(64)}`,
        digest: null,
        platform: "linux/amd64",
        os: "linux",
        architecture: "amd64",
        variant: null
      },
      build: { ...build, scoredEligible: false, arch: "arm64" }
    })
  );

  assert.throws(
    () =>
      assertResearchAgentImageCompatible({
        agentImage: {
          reference: DEFAULT_RESEARCH_IMAGE,
          id: `sha256:${"2".repeat(64)}`,
          digest: null,
          platform: "linux/amd64",
          os: "linux",
          architecture: "amd64",
          variant: null
        },
        build
      }),
    (error: Error) =>
      error instanceof PostgresResearchError &&
      /targets linux\/amd64/.test(error.message) &&
      /artifacts target linux\/arm64/.test(error.message)
  );

  assert.throws(
    () =>
      assertResearchAgentImageCompatible({
        agentImage: {
          reference: DEFAULT_RESEARCH_IMAGE,
          id: `sha256:${"3".repeat(64)}`,
          digest: null,
          platform: "darwin/arm64",
          os: "darwin",
          architecture: "arm64",
          variant: null
        },
        build
      }),
    (error: Error) => error instanceof PostgresResearchError && /must run on Linux/.test(error.message)
  );
});
