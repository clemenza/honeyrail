import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { createDefaultExecutorRegistry } from "../server/executors/index.js";
import { EventBus } from "../server/events.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import {
  BUILD_PROFILE_VERSION,
  computeBuildCacheKey,
  createPostgresResearchEnvironment,
  materializePostgresSource,
  PostgresResearchError,
  PostgresResearchTimeoutError,
  withPostgresResearchEnvironment,
  type PostgresResearchEnvironment,
  type PostgresResearchSpec
} from "../server/postgres/research-environment.js";
import { JsonStore } from "../server/store.js";
import { runCommandSafe } from "../server/utils.js";
import { createSyntheticPostgresSourceRepo, hasFixtureToolchain, type SyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

// PostgreSQL research environment (#179). Everything here runs against the
// synthetic source fixture in test/helpers/postgres-source-fixture.ts: the
// real Historical PostgreSQL corpus (which refs, which bugs) must never
// appear in committed test code, and a real PostgreSQL source build is far
// too slow and toolchain-dependent for the default suite. The end-to-end
// proof against upstream PostgreSQL is a documented manual validation.

async function exists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

type Fixture = { tempDir: string; repo: SyntheticPostgresSourceRepo; cacheRoot: string };

async function withFixture(t: TestContext): Promise<Fixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-research-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const repo = await createSyntheticPostgresSourceRepo(join(tempDir, "repo"));
  return { tempDir, repo, cacheRoot: join(tempDir, "build-cache") };
}

function specFor(fixture: Fixture, name: string, overrides: Partial<PostgresResearchSpec> = {}): PostgresResearchSpec {
  return {
    root: join(fixture.tempDir, name),
    source: { repoPath: fixture.repo.repoPath, ref: fixture.repo.ref },
    build: { cacheRoot: fixture.cacheRoot, jobs: 1 },
    ...overrides
  };
}

async function skipWithoutToolchain(t: TestContext) {
  if (await hasFixtureToolchain()) return false;
  t.skip("git, make, tar or a C compiler probe is unavailable");
  return true;
}

test("materialized source snapshot carries no .git and no history past the ref", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const dest = join(fixture.tempDir, "snapshot");

  const manifest = await materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.ref }, dest);

  assert.equal(await exists(join(dest, ".git")), false, "snapshot must not contain a .git directory");
  assert.equal(manifest.gitDirPresent, false);
  assert.equal(await exists(join(dest, "configure")), true);
  // The fixture's second commit must be unreachable from a snapshot of the
  // first: in historical mode that later history is the answer key.
  assert.equal(await exists(join(dest, fixture.repo.laterFile)), false);
  assert.equal(manifest.ref, fixture.repo.ref);
  assert.equal(manifest.resolvedCommit, fixture.repo.ref);
  assert.match(manifest.sourceHash, /^[0-9a-f]{40}$/);
  assert.notEqual(manifest.sourceHash, manifest.resolvedCommit);
});

test("an unresolvable ref throws and never silently falls back to HEAD", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const dest = join(fixture.tempDir, "bad-snapshot");

  await assert.rejects(
    materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: "refs/heads/does-not-exist" }, dest),
    (error: Error) => error instanceof PostgresResearchError && /Cannot resolve PostgreSQL source ref/.test(error.message)
  );
  assert.equal(await exists(join(dest, "configure")), false, "nothing may be materialized from an unresolved ref");

  await assert.rejects(
    materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: "  " }, dest),
    PostgresResearchError
  );
  await assert.rejects(
    materializePostgresSource({ repoPath: join(fixture.tempDir, "missing-repo"), ref: fixture.repo.ref }, dest),
    PostgresResearchError
  );
});

test("build cache key changes with source hash, configure args, platform, arch, and compiler identity", () => {
  const compiler = { command: "cc", version: "Apple clang version 17.0.0", target: "arm64-apple-darwin25.0.0" };
  const base = {
    sourceHash: "a".repeat(40),
    configureArgs: ["--without-readline", "--without-zlib", "--without-icu"],
    platform: "darwin",
    arch: "arm64",
    compiler
  };
  const key = computeBuildCacheKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(computeBuildCacheKey({ ...base }), key, "identical inputs must produce an identical key");

  const variants = [
    { ...base, sourceHash: "b".repeat(40) },
    { ...base, configureArgs: ["--without-readline", "--without-zlib"] },
    { ...base, configureArgs: ["--without-zlib", "--without-readline", "--without-icu"] },
    { ...base, platform: "linux" },
    { ...base, arch: "x64" },
    { ...base, compiler: { ...compiler, version: "gcc (Debian 12.2.0-14) 12.2.0" } },
    { ...base, compiler: { ...compiler, target: "x86_64-pc-linux-gnu" } },
    { ...base, compiler: { ...compiler, command: "clang" } },
    { ...base, profileVersion: `${BUILD_PROFILE_VERSION}-next` }
  ];
  for (const variant of variants) {
    assert.notEqual(computeBuildCacheKey(variant), key, `cache key must change for ${JSON.stringify(variant)}`);
  }
});

test("an identical build hits the cache and a different configure profile does not", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);

  const first = await createPostgresResearchEnvironment(specFor(fixture, "cache-a"));
  t.after(async () => first.cleanup());
  assert.equal(first.buildManifest.cacheHit, false);
  assert.ok(first.buildManifest.commands.length >= 3, "a cold build runs configure, make and make install");
  assert.equal(await exists(join(first.installDir, "bin", "initdb")), true);

  const second = await createPostgresResearchEnvironment(specFor(fixture, "cache-b"));
  t.after(async () => second.cleanup());
  assert.equal(second.buildManifest.cacheHit, true, "identical source/config/toolchain must reuse the cached build");
  assert.equal(second.buildManifest.cacheKey, first.buildManifest.cacheKey);
  assert.equal(second.installDir, first.installDir);
  assert.deepEqual(second.buildManifest.commands, [], "a cache hit must not rerun configure or make");

  const third = await createPostgresResearchEnvironment(
    specFor(fixture, "cache-c", { build: { cacheRoot: fixture.cacheRoot, jobs: 1, configureArgs: ["--without-readline"] } })
  );
  t.after(async () => third.cleanup());
  assert.equal(third.buildManifest.cacheHit, false, "a different configure profile must not reuse another build");
  assert.notEqual(third.buildManifest.cacheKey, first.buildManifest.cacheKey);
  assert.notEqual(third.installDir, first.installDir);
  assert.equal(
    (await readFile(join(third.installDir, "configure-args.txt"), "utf8")).trim(),
    "--without-readline",
    "each cache entry must hold the binaries built from its own configure args"
  );
});

test("concurrent environments get isolated ports, data directories and socket directories", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);

  const [left, right] = await Promise.all([
    createPostgresResearchEnvironment(specFor(fixture, "concurrent-a")),
    createPostgresResearchEnvironment(specFor(fixture, "concurrent-b"))
  ]);
  t.after(async () => {
    await left.cleanup();
    await right.cleanup();
  });

  assert.notEqual(left.port, right.port);
  assert.notEqual(left.dataDir, right.dataDir);
  assert.notEqual(left.socketDir, right.socketDir);
  assert.notEqual(left.sourceDir, right.sourceDir);
  // Same source, same config: the shared build cache is the one thing they
  // are supposed to have in common.
  assert.equal(left.installDir, right.installDir);

  await Promise.all([left.start(), right.start()]);
  const answers = await Promise.all([left.psql("SELECT 1;"), right.psql("SELECT 1;")]);
  assert.deepEqual(answers.map((item) => item.stdout), ["1", "1"]);
});

test("cluster lifecycle: initdb, start, readiness, psql, stop", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const env = await createPostgresResearchEnvironment(specFor(fixture, "lifecycle"));
  t.after(async () => env.cleanup());

  const readiness = await env.start();
  assert.equal(readiness.ready, true);
  assert.equal(env.isRunning(), true);
  assert.equal(await exists(join(env.dataDir, "PG_VERSION")), true);

  assert.equal((await env.psql("SELECT 1;")).stdout, "1");
  assert.equal((await env.psql("INSERT alpha")).ok, true);
  assert.equal((await env.psql("SELECT count(*) FROM stub;")).stdout, "1");

  // A failing statement is an observation, not an exception: research means
  // watching what the server actually does.
  const failure = await env.psql("NOT VALID SQL");
  assert.equal(failure.ok, false);
  assert.match(failure.stderr, /syntax error/);

  // Arbitrary local experiments run with the built binaries on PATH.
  const scriptPath = join(env.root, "repro.sql");
  await writeFile(scriptPath, "INSERT beta\nSELECT 1;\n");
  assert.equal((await env.psqlFile(scriptPath)).ok, true);
  assert.equal((await env.psql("SELECT count(*) FROM stub;")).stdout, "2");
  const version = await env.exec(env.binaries.postgres, ["--version"]);
  assert.match(version.stdout, /PostgreSQL/);

  assert.equal(await env.stop(), true);
  assert.equal(env.isRunning(), false);
  assert.equal((await env.psql("SELECT 1;")).ok, false, "a stopped cluster must stop answering");
  assert.match(await readFile(env.logPath, "utf8"), /database system is ready to accept connections/);
  assert.deepEqual(
    env.lifecycleEvents().map((event) => event.phase).filter((phase) => phase.startsWith("cluster.")).slice(0, 3),
    ["cluster.initdb", "cluster.started", "cluster.ready"]
  );
});

test("restart brings the cluster back and preserves committed state", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const env = await createPostgresResearchEnvironment(specFor(fixture, "restart"));
  t.after(async () => env.cleanup());

  await env.start();
  await env.psql("INSERT before-restart");
  const readiness = await env.restart();

  assert.equal(readiness.ready, true);
  assert.equal(env.isRunning(), true);
  assert.equal((await env.psql("SELECT count(*) FROM stub;")).stdout, "1");
  assert.ok(env.lifecycleEvents().some((event) => event.phase === "cluster.restarted"));
});

test("cleanup runs after success, after a thrown error, and after a timeout", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);

  let succeeded: PostgresResearchEnvironment | undefined;
  const value = await withPostgresResearchEnvironment(specFor(fixture, "cleanup-success"), async (env) => {
    succeeded = env;
    await env.start();
    return (await env.psql("SELECT 1;")).stdout;
  });
  assert.equal(value, "1");
  assert.equal(succeeded!.isRunning(), false);
  assert.equal(await exists(succeeded!.dataDir), false, "PGDATA must be removed after a successful run");
  assert.equal(await exists(succeeded!.socketDir), false, "the socket directory must be removed after a successful run");
  assert.equal(await exists(succeeded!.logPath), true, "the PostgreSQL log is evidence and must survive cleanup");
  assert.equal(succeeded!.runtimeManifest().cleanup?.stopped, true);

  let failed: PostgresResearchEnvironment | undefined;
  await assert.rejects(
    withPostgresResearchEnvironment(specFor(fixture, "cleanup-error"), async (env) => {
      failed = env;
      await env.start();
      throw new Error("experiment blew up");
    }),
    /experiment blew up/
  );
  assert.equal(failed!.isRunning(), false);
  assert.equal(await exists(failed!.dataDir), false, "PGDATA must be removed after a thrown error");
  assert.equal(await exists(failed!.socketDir), false);

  let timedOut: PostgresResearchEnvironment | undefined;
  await assert.rejects(
    withPostgresResearchEnvironment(
      specFor(fixture, "cleanup-timeout"),
      async (env) => {
        timedOut = env;
        await env.start();
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      },
      { timeoutMs: 250 }
    ),
    PostgresResearchTimeoutError
  );
  assert.equal(timedOut!.isRunning(), false);
  assert.equal(await exists(timedOut!.dataDir), false, "PGDATA must be removed after a timeout");
  assert.equal(await exists(timedOut!.socketDir), false);
  assert.equal(timedOut!.runtimeManifest().cleanup?.stopped, true);
});

test("the postgres-research executor records source, build and runtime manifests as artifacts and evidence", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const store = new JsonStore(join(fixture.tempDir, "store.json"));
  const service = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: { listSessions: async () => [], startSession: async () => {}, killSession: async () => {}, capture: async () => "", sendInput: async () => {} } as any,
    worktrees: { create: async () => ({}), runChecks: async () => ({ ok: true, runs: [] }) } as any,
    runCommand: runCommandSafe,
    sessionLogRoot: join(fixture.tempDir, "sessions"),
    attachmentRoot: join(fixture.tempDir, "attachments"),
    executors: createDefaultExecutorRegistry()
  });
  const project = await store.createProject({
    name: "pg-research",
    repoPath: fixture.tempDir,
    defaultBranch: "main",
    defaultAgent: "shell",
    testCommands: [],
    runCommands: []
  });

  const result = await service.createRun({
    projectId: project.id,
    goal: "postgres research environment",
    steps: [
      {
        id: "research",
        name: "PostgreSQL research environment",
        executor: "postgres-research",
        input: {
          source: { repoPath: fixture.repo.repoPath, ref: fixture.repo.ref },
          build: { cacheRoot: fixture.cacheRoot, jobs: 1 },
          restart: true,
          experiments: [
            { name: "seed", sql: "INSERT observed" },
            { name: "count", sql: "SELECT count(*) FROM stub;" }
          ]
        }
      }
    ]
  });

  assert.equal(result.run.status, "succeeded");
  const step = (await store.getStep(result.run.id, "research"))!;
  assert.equal(step.status, "succeeded");
  assert.equal(step.output?.databaseReady, true);
  assert.equal(step.output?.cacheHit, false);
  assert.match(String(step.output?.cacheKey), /^[0-9a-f]{64}$/);

  const artifacts = await store.listArtifacts(result.run.id, "research");
  const names = artifacts.map((item) => item.name);
  for (const expected of ["source-manifest.json", "build-manifest.json", "runtime-manifest.json", "experiments.json", "postgres.log", "configure.log", "make.log"]) {
    assert.ok(names.includes(expected), `expected artifact ${expected}, got ${names.join(", ")}`);
  }
  const sourceManifest = JSON.parse(
    await readFile(String(artifacts.find((item) => item.name === "source-manifest.json")!.path), "utf8")
  );
  assert.equal(sourceManifest.ref, fixture.repo.ref);
  assert.equal(sourceManifest.gitDirPresent, false);
  const buildManifest = JSON.parse(
    await readFile(String(artifacts.find((item) => item.name === "build-manifest.json")!.path), "utf8")
  );
  assert.match(String(buildManifest.cacheKey), /^[0-9a-f]{64}$/);
  assert.ok(buildManifest.compiler.version, "the build manifest records compiler identity");

  const evidence = await store.listEvidence(result.run.id, "research");
  const kinds = evidence.map((item) => item.kind);
  for (const expected of ["db.source.snapshot", "db.build", "db.server.ready", "db.query.result", "db.restart", "db.environment.cleanup"]) {
    assert.ok(kinds.includes(expected), `expected evidence ${expected}, got ${kinds.join(", ")}`);
  }
  const cleanup = evidence.find((item) => item.kind === "db.environment.cleanup")!;
  assert.equal((cleanup.value as Record<string, unknown>).stopped, true);
  const experiments = evidence.filter((item) => item.kind === "db.query.result");
  assert.equal(experiments.length, 2);
  assert.equal((experiments[1].value as Record<string, unknown>).stdout, "1");
});

test("the postgres-research executor rejects malformed input before anything is built", async (t) => {
  const fixture = await withFixture(t);
  const store = new JsonStore(join(fixture.tempDir, "preflight-store.json"));
  const service = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: { listSessions: async () => [], startSession: async () => {}, killSession: async () => {}, capture: async () => "", sendInput: async () => {} } as any,
    worktrees: { create: async () => ({}), runChecks: async () => ({ ok: true, runs: [] }) } as any,
    runCommand: runCommandSafe,
    sessionLogRoot: join(fixture.tempDir, "sessions"),
    attachmentRoot: join(fixture.tempDir, "attachments"),
    executors: createDefaultExecutorRegistry()
  });
  const project = await store.createProject({
    name: "pg-research-preflight",
    repoPath: fixture.tempDir,
    defaultBranch: "main",
    defaultAgent: "shell",
    testCommands: [],
    runCommands: []
  });

  await assert.rejects(
    service.createRun({
      projectId: project.id,
      goal: "missing ref",
      steps: [{ id: "research", name: "research", executor: "postgres-research", input: { source: { repoPath: fixture.repo.repoPath } } }]
    }),
    /requires a non-empty ref/
  );
});
