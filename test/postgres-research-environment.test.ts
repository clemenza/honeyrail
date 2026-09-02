import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { createDefaultExecutorRegistry } from "../server/executors/index.js";
import { EventBus } from "../server/events.js";
import { OrchestrationService } from "../server/orchestration/service.js";
import {
  BUILD_COMPLETE_MARKER,
  BUILD_PROFILE_VERSION,
  DEFAULT_CONFIGURE_ARGS,
  computeBuildCacheKey,
  computeBuildEntryId,
  createPostgresResearchEnvironment,
  materializePostgresSource,
  PostgresResearchError,
  PostgresResearchTimeoutError,
  resolveBuildEnv,
  withPostgresResearchEnvironment,
  type PostgresResearchEnvironment,
  type PostgresResearchSpec
} from "../server/postgres/research-environment.js";
import {
  buildContainerStepArgs,
  resolveBuilderImageIdentity,
  BUILDER_CONTAINER_PATH,
  DEFAULT_BUILDER_IMAGE,
  PostgresBuildContainerError
} from "../server/postgres/build-container.js";
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
    build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1 },
    ...overrides
  };
}

async function skipWithoutToolchain(t: TestContext) {
  if (await hasFixtureToolchain()) return false;
  t.skip("git, make, tar or a C compiler probe is unavailable");
  return true;
}

/** Every file under `root`, as [relative path, contents] pairs. */
async function walkFiles(root: string, prefix = ""): Promise<Array<[string, string]>> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: Array<[string, string]> = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(full, rel)));
    } else if (entry.isFile()) {
      files.push([rel, await readFile(full, "utf8").catch(() => "")]);
    }
  }
  return files;
}

/**
 * Fails if any private fact appears in a path or in a file's bytes anywhere
 * under `root`. This is the eval-isolation assertion the whole boundary
 * rests on, so it reads the trees rather than trusting the environment map.
 */
async function assertNoSecretsUnder(root: string, secrets: Record<string, string>, label: string) {
  for (const [path, content] of await walkFiles(root)) {
    for (const [name, secret] of Object.entries(secrets)) {
      assert.equal(path.includes(secret), false, `${label}: ${name} appears in the path ${path}`);
      assert.equal(content.includes(secret), false, `${label}: ${name} appears inside ${path}`);
    }
  }
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

test("build cache key separates build modes and builder images, not just host toolchains", () => {
  // Once compilation moved into a container (#182 third review), the host's
  // compiler is no longer what produced the binaries. What must key them
  // apart instead is the build mode and the image's *content* identity - a
  // mutable `:latest` that got rebuilt must not serve entries produced by
  // its predecessor.
  const compiler = { command: "cc", version: "cc (Debian 12.2.0-14+deb12u1) 12.2.0", target: "aarch64-linux-gnu" };
  const image = { reference: "honeyrail-postgres-builder:latest", id: `sha256:${"a".repeat(64)}` };
  const base = {
    sourceHash: "c".repeat(40),
    configureArgs: [...DEFAULT_CONFIGURE_ARGS],
    platform: "linux",
    arch: "arm64",
    compiler,
    mode: "container" as const,
    builderImage: image
  };
  const key = computeBuildCacheKey(base);
  assert.equal(computeBuildCacheKey({ ...base }), key);

  for (const variant of [
    { ...base, mode: "host" as const, builderImage: null },
    { ...base, builderImage: { ...image, id: `sha256:${"b".repeat(64)}` } },
    { ...base, builderImage: { ...image, reference: "honeyrail-postgres-builder:pinned" } },
    { ...base, builderImage: null },
    { ...base, compiler: { ...compiler, version: "cc (Debian 12.2.0-15) 12.2.1" } }
  ]) {
    assert.notEqual(computeBuildCacheKey(variant), key, `cache key must change for ${JSON.stringify(variant)}`);
  }

  // A host build on a machine that merely *happens* to look like the
  // container must not collide with a container build.
  assert.notEqual(
    computeBuildCacheKey({ ...base, mode: "host", builderImage: null }),
    computeBuildCacheKey({ ...base, mode: "container", builderImage: null })
  );
});

test("a build container mounts only the snapshot and the staging root, and inherits no host environment", () => {
  const args = buildContainerStepArgs({
    sourceDir: "/host/env/source",
    stagingDir: "/host/cache/.staging-abc",
    image: DEFAULT_BUILDER_IMAGE,
    command: ["make", "-j4"],
    buildEnv: { CFLAGS: "-O0" },
    containerName: "b1"
  });

  const mounts = args.filter((_value, index) => args[index - 1] === "-v");
  assert.deepEqual(mounts, ["/host/env/source:/build/source:rw", "/host/cache/.staging-abc:/build/staging:rw"]);
  // Not mounted: the cache root itself, the source mirror, the private dir.
  assert.equal(mounts.length, 2);

  assert.equal(args[args.indexOf("--network") + 1], "none", "a build must not need the network");
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--rm"));
  assert.equal(args[args.indexOf("-w") + 1], "/build/source");
  assert.equal(args[args.length - 3], DEFAULT_BUILDER_IMAGE);
  assert.deepEqual(args.slice(-2), ["make", "-j4"]);

  // Exactly the declared variables, plus the fixed ones. In particular no
  // ambient PATH, HOME or locale from the operator's shell.
  const env = args.filter((_value, index) => args[index - 1] === "-e");
  assert.deepEqual(env.sort(), ["CFLAGS=-O0", "HOME=/tmp", "LANG=C", "LC_ALL=C", `PATH=${BUILDER_CONTAINER_PATH}`].sort());
});

test("the containerized build mode is the default, publishes a usable cache entry, and reuses it", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const daemon = await runCommandSafe("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
  const image = await runCommandSafe("docker", ["image", "inspect", DEFAULT_BUILDER_IMAGE], { timeout: 30_000 });
  if (!daemon.ok || !daemon.stdout.trim() || !image.ok) {
    t.skip(`${DEFAULT_BUILDER_IMAGE} or a docker daemon is unavailable - docker build -t ${DEFAULT_BUILDER_IMAGE} docker/postgres-research-builder`);
    return;
  }
  const fixture = await withFixture(t);

  // No build.mode here: this asserts the *default* is the containerized
  // scored path. The rest of this file pins mode: "host" so it stays
  // runnable without a docker daemon; the real-PostgreSQL end of container
  // mode is test/postgres-research-real-build.test.ts.
  const spec = specFor(fixture, "container-build", { build: { cacheRoot: fixture.cacheRoot, jobs: 1 } });
  const first = await createPostgresResearchEnvironment(spec);
  t.after(async () => first.cleanup());

  assert.equal(first.buildManifest.buildMode, "container");
  assert.equal(first.buildManifest.scoredEligible, true);
  assert.equal(first.buildManifest.unscoredReason, undefined);
  assert.equal(first.buildManifest.installPrefix, "/opt/honeyrail/postgres");
  assert.equal(first.buildManifest.platform, "linux", "a containerized build targets the image, not the host");
  assert.equal(first.buildManifest.hostPlatform, process.platform, "the host is still recorded, separately");
  assert.match(first.buildManifest.builderImage!.id, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.buildManifest.compiler.version, /./, "the compiler must be probed inside the build container");
  assert.deepEqual(
    first.buildManifest.commands.map((command) => [command.name, command.mode]),
    [
      ["configure", "container"],
      ["make", "container"],
      ["make install", "container"]
    ]
  );
  // configure ran with the neutral prefix and the install came out of the
  // DESTDIR subtree, not the staging root.
  assert.ok(first.buildManifest.commands[0].args.includes("--prefix=/opt/honeyrail/postgres"));
  assert.ok(first.buildManifest.commands[2].args.includes("DESTDIR=/build/staging"));
  assert.equal(await exists(join(first.installDir, "bin", "initdb")), true);
  assert.equal(await exists(join(first.installDir, "opt")), false, "the staging root must not be published as the entry");

  // A host build of the same source must land in a *different* entry.
  const hostBuilt = await createPostgresResearchEnvironment(specFor(fixture, "host-build"));
  t.after(async () => hostBuilt.cleanup());
  assert.equal(hostBuilt.buildManifest.buildMode, "host");
  assert.equal(hostBuilt.buildManifest.scoredEligible, false);
  assert.match(hostBuilt.buildManifest.unscoredReason ?? "", /not a scored trial/i);
  assert.notEqual(hostBuilt.buildManifest.entryId, first.buildManifest.entryId);

  // ...and a second container build reuses the first one's entry.
  const second = await createPostgresResearchEnvironment(
    specFor(fixture, "container-build-2", { build: { cacheRoot: fixture.cacheRoot, jobs: 1 } })
  );
  t.after(async () => second.cleanup());
  assert.equal(second.buildManifest.cacheHit, true);
  assert.equal(second.buildManifest.entryId, first.buildManifest.entryId);
  assert.deepEqual(second.buildManifest.commands, []);
});

test("a missing build image fails loudly with the command that would create it", async () => {
  await assert.rejects(
    resolveBuilderImageIdentity("honeyrail-postgres-builder:definitely-not-present", async () => ({
      ok: false,
      stdout: "",
      stderr: "Error: No such image",
      code: 1
    })),
    (error: Error) =>
      error instanceof PostgresBuildContainerError &&
      /is not available to the docker daemon/.test(error.message) &&
      /docker build -t honeyrail-postgres-builder:definitely-not-present docker\/postgres-research-builder/.test(error.message)
  );
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
    specFor(fixture, "cache-c", { build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1, configureArgs: ["--without-readline"] } })
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
          build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1 },
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

// --- MUST FIX 1: the agent-visible / grader-private filesystem boundary ----

test("nothing reachable from agentEnvironment() reveals the source ref, commit, tree hash or cache key", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  // Both trees live under one directory so the walk below covers the
  // agent-visible root *and* its grader-private sibling.
  const area = join(fixture.tempDir, "isolation");
  const env = await createPostgresResearchEnvironment(
    specFor(fixture, "unused", { root: join(area, "env"), privateDir: join(area, "env-private") })
  );
  t.after(async () => env.cleanup());
  await env.start();
  await env.psql("SELECT 1;");

  const secrets = {
    "source.ref": fixture.repo.ref,
    resolvedCommit: env.sourceManifest.resolvedCommit,
    sourceHash: env.sourceManifest.sourceHash,
    cacheKey: env.buildManifest.cacheKey
  };

  // 1. The map itself.
  const surface = env.agentEnvironment();
  for (const [key, value] of Object.entries(surface)) {
    for (const [name, secret] of Object.entries(secrets)) {
      assert.equal(`${key}=${value}`.includes(secret), false, `${name} must not appear in ${key}`);
    }
  }

  // 2. Every filesystem tree those values can reach: the environment root
  //    with its grader-private sibling, and the shared build cache including
  //    every other entry in it.
  await assertNoSecretsUnder(area, secrets, "agent-visible environment tree");
  await assertNoSecretsUnder(fixture.cacheRoot, secrets, "shared build cache");

  // 3. The specific v0 leak: the cache entry's marker carried all four, and
  //    the entry directory was named by the cache key itself.
  const marker = JSON.parse(await readFile(join(env.installDir, BUILD_COMPLETE_MARKER), "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), ["completedAt", "entryId", "marker", "profileVersion"]);
  assert.equal(env.buildManifest.entryId, computeBuildEntryId(env.buildManifest.cacheKey));
  assert.equal(env.installDir, join(fixture.cacheRoot, env.buildManifest.entryId));
  assert.equal(await exists(join(env.installDir, "honeyrail-build.json")), false, "the v0 identity manifest must be gone");

  // 4. No exported path leads into the grader-private tree.
  assert.equal(env.privateDir.startsWith(`${env.root}/`), false);
  for (const value of Object.values(surface)) {
    if (!value.startsWith("/")) continue;
    assert.equal(value.startsWith(env.privateDir), false, `${value} must not lead into the grader-private tree`);
  }

  // 5. The grader side still has everything.
  assert.equal(env.sourceManifest.ref, fixture.repo.ref);
  assert.match(env.sourceManifest.sourceHash, /^[0-9a-f]{40}$/);
  assert.match(env.buildManifest.cacheKey, /^[0-9a-f]{64}$/);
  assert.equal(env.buildManifest.sourceCommit, env.sourceManifest.resolvedCommit);
});

test("the executor keeps full provenance grader-side and out of every agent-visible tree", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const envRootParent = join(fixture.tempDir, "agent-envs");
  const previous = process.env.HONEYRAIL_PG_ENV_ROOT;
  process.env.HONEYRAIL_PG_ENV_ROOT = envRootParent;
  t.after(() => {
    if (previous === undefined) delete process.env.HONEYRAIL_PG_ENV_ROOT;
    else process.env.HONEYRAIL_PG_ENV_ROOT = previous;
  });

  const attachmentRoot = join(fixture.tempDir, "attachments-isolation");
  const store = new JsonStore(join(fixture.tempDir, "isolation-store.json"));
  const service = new OrchestrationService({
    store,
    bus: new EventBus(),
    tmux: { listSessions: async () => [], startSession: async () => {}, killSession: async () => {}, capture: async () => "", sendInput: async () => {} } as any,
    worktrees: { create: async () => ({}), runChecks: async () => ({ ok: true, runs: [] }) } as any,
    runCommand: runCommandSafe,
    sessionLogRoot: join(fixture.tempDir, "isolation-sessions"),
    attachmentRoot,
    executors: createDefaultExecutorRegistry()
  });
  const project = await store.createProject({
    name: "pg-research-isolation",
    repoPath: fixture.tempDir,
    defaultBranch: "main",
    defaultAgent: "shell",
    testCommands: [],
    runCommands: []
  });

  const result = await service.createRun({
    projectId: project.id,
    goal: "isolation",
    steps: [
      {
        id: "research",
        name: "research",
        executor: "postgres-research",
        input: {
          source: { repoPath: fixture.repo.repoPath, ref: fixture.repo.ref },
          build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1 },
          experiments: [{ name: "probe", sql: "SELECT 1;" }]
        }
      }
    ]
  });
  assert.equal(result.run.status, "succeeded");

  const artifacts = await store.listArtifacts(result.run.id, "research");
  const sourceManifest = JSON.parse(await readFile(String(artifacts.find((item) => item.name === "source-manifest.json")!.path), "utf8"));
  const buildManifest = JSON.parse(await readFile(String(artifacts.find((item) => item.name === "build-manifest.json")!.path), "utf8"));
  const runtimeManifest = JSON.parse(await readFile(String(artifacts.find((item) => item.name === "runtime-manifest.json")!.path), "utf8"));

  // Grader side: complete provenance, as required for scoring a trial.
  assert.equal(sourceManifest.ref, fixture.repo.ref);
  assert.equal(buildManifest.sourceCommit, sourceManifest.resolvedCommit);
  assert.match(String(buildManifest.cacheKey), /^[0-9a-f]{64}$/);
  assert.ok(artifacts.some((item) => item.name === "postgres.log"), "the server log is copied grader-side");

  // Agent side: the environment root is not inside the attachment tree, so no
  // number of `..` hops from HR_PG_SOURCE_DIR arrives at those manifests.
  const agentRoot = String(runtimeManifest.root);
  assert.equal(agentRoot.startsWith(attachmentRoot), false, "the agent-visible root must live outside attachmentRoot");
  assert.equal(agentRoot.startsWith(envRootParent), true);
  assert.equal(String(runtimeManifest.privateDir).startsWith(attachmentRoot), true, "build logs stay grader-side");
  await assertNoSecretsUnder(
    envRootParent,
    {
      "source.ref": fixture.repo.ref,
      resolvedCommit: sourceManifest.resolvedCommit,
      sourceHash: sourceManifest.sourceHash,
      cacheKey: buildManifest.cacheKey
    },
    "executor agent-env root"
  );
});

// --- MUST FIX 2: materialization publishes an exact, clean snapshot -------

test("re-materializing an earlier ref over a later snapshot leaves no file from the later ref", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const dest = join(fixture.tempDir, "reused-snapshot");

  const later = await materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.laterRef }, dest);
  assert.equal(await exists(join(dest, fixture.repo.laterFile)), true, "the later ref does contain the future file");

  const earlier = await materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.ref }, dest);

  // The invariant: a snapshot of the earlier ref must not carry a file that
  // exists only in later history - in historical mode that file is the answer.
  assert.equal(await exists(join(dest, fixture.repo.laterFile)), false, "a stale future file survived materialization");
  assert.equal(await exists(join(dest, "configure")), true);
  assert.notEqual(earlier.sourceHash, later.sourceHash);
  assert.equal(earlier.resolvedCommit, fixture.repo.ref);
  const leftovers = (await readdir(fixture.tempDir)).filter((name) => name.startsWith("reused-snapshot."));
  assert.deepEqual(leftovers, [], "staging directories and tarballs must not survive a successful publish");
});

test("a failed extraction publishes nothing and leaves an existing snapshot untouched", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const brokenTar: typeof runCommandSafe = async (command, args, options) => {
    if (command === "tar") return { ok: false, stdout: "", stderr: "tar: unexpected end of file", code: 2 };
    return runCommandSafe(command, args, options);
  };

  // Into a fresh destination: nothing may be published at all.
  const fresh = join(fixture.tempDir, "fresh-snapshot");
  await assert.rejects(
    materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.ref }, fresh, { runCommand: brokenTar }),
    (error: Error) => error instanceof PostgresResearchError && /Extracting source snapshot failed/.test(error.message)
  );
  assert.equal(await exists(fresh), false, "a failed materialization must not publish a destination");
  assert.deepEqual(
    (await readdir(fixture.tempDir)).filter((name) => name.startsWith("fresh-snapshot")),
    [],
    "no staging directory or tarball may survive a failure"
  );

  // Over an existing snapshot: the previous exact tree survives intact rather
  // than becoming a half-extracted mix of the two.
  const existing = join(fixture.tempDir, "existing-snapshot");
  const before = await materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.laterRef }, existing);
  await assert.rejects(
    materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.ref }, existing, { runCommand: brokenTar }),
    PostgresResearchError
  );
  assert.equal(await exists(join(existing, fixture.repo.laterFile)), true, "the previous snapshot must be left intact");
  assert.equal(before.sourceDir, existing);
});

test("a failure at the publish rename rolls the previous snapshot back into place", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const dest = join(fixture.tempDir, "rollback-snapshot");

  const before = await materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.laterRef }, dest);
  assert.equal(await exists(join(dest, fixture.repo.laterFile)), true);

  // The stage the extraction test cannot reach: the swap itself. Publishing a
  // directory is two renames, not one atomic operation, so the interesting
  // failure is the one that happens after the old snapshot has moved aside.
  const failingPublish: typeof rename = async (from, to) => {
    if (String(to) === dest && String(from).includes(".staging-")) throw new Error("injected publish failure");
    return rename(from, to);
  };

  await assert.rejects(
    materializePostgresSource({ repoPath: fixture.repo.repoPath, ref: fixture.repo.ref }, dest, {
      publishRename: failingPublish
    }),
    /injected publish failure/
  );

  // Rolled back, not lost: the destination is the previous snapshot, whole.
  assert.equal(await exists(join(dest, fixture.repo.laterFile)), true, "the previous snapshot was not restored");
  assert.equal(await exists(join(dest, "configure")), true);
  assert.equal(before.sourceDir, dest);
  const leftovers = (await readdir(fixture.tempDir)).filter((name) => name.startsWith("rollback-snapshot."));
  assert.deepEqual(leftovers, [], "staging, tarball and backup paths must not survive a failed publish");
});

// --- SHOULD FIX 4: bounded recovery from the allocatePort() TOCTOU window --

test("a port collision at startup is retried on a freshly allocated port", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  // Deterministic stand-in for the race: the first pg_ctl start fails the way
  // PostgreSQL fails when something else took the port between allocatePort()
  // closing its probe socket and the server binding it.
  let collisions = 0;
  const collidingStart: typeof runCommandSafe = async (command, args, options) => {
    if (command.endsWith("pg_ctl") && (args ?? []).includes("start") && collisions === 0) {
      collisions += 1;
      return {
        ok: false,
        stdout: "",
        stderr: 'pg_ctl: could not start server\nLOG:  could not bind IPv4 address "127.0.0.1": Address already in use',
        code: 1
      };
    }
    return runCommandSafe(command, args, options);
  };

  const env = await createPostgresResearchEnvironment(specFor(fixture, "port-retry", { runCommand: collidingStart }));
  t.after(async () => env.cleanup());
  const candidate = env.port;

  const readiness = await env.start();

  assert.equal(collisions, 1);
  assert.equal(readiness.ready, true);
  assert.notEqual(env.port, candidate, "the retry must use a newly allocated port");
  const retry = env.lifecycleEvents().find((event) => event.phase === "cluster.port.retry")!;
  assert.ok(retry, "the retry must be recorded as a lifecycle event");
  assert.equal(retry.detail?.previousPort, candidate);
  assert.equal(retry.detail?.port, env.port);
  assert.equal((await env.psql("SELECT 1;")).stdout, "1", "the cluster must be usable on the retried port");

  const cleanup = await env.cleanup();
  assert.equal(cleanup.stopped, true);
  assert.equal(await exists(env.dataDir), false);
});

test("a startup failure that is not a port collision fails immediately", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  let attempts = 0;
  const brokenStart: typeof runCommandSafe = async (command, args, options) => {
    if (command.endsWith("pg_ctl") && (args ?? []).includes("start")) {
      attempts += 1;
      return { ok: false, stdout: "", stderr: "pg_ctl: directory is not a database cluster directory", code: 1 };
    }
    return runCommandSafe(command, args, options);
  };

  const env = await createPostgresResearchEnvironment(specFor(fixture, "port-hard-fail", { runCommand: brokenStart }));
  t.after(async () => env.cleanup());
  const candidate = env.port;

  await assert.rejects(env.start(), (error: Error) => error instanceof PostgresResearchError && /pg_ctl start failed/.test(error.message));
  assert.equal(attempts, 1, "only a bind collision may be retried");
  assert.equal(env.port, candidate);
});

// --- SHOULD FIX 5: the build cache key covers the build environment -------

test("the build cache key covers the declared build environment", () => {
  const compiler = { command: "cc", version: "Apple clang version 17.0.0", target: "arm64-apple-darwin25.0.0" };
  const base = {
    sourceHash: "a".repeat(40),
    configureArgs: ["--without-readline"],
    platform: "darwin",
    arch: "arm64",
    compiler
  };
  const unoptimized = computeBuildCacheKey({ ...base, buildEnv: { CFLAGS: "-O0" } });
  const optimized = computeBuildCacheKey({ ...base, buildEnv: { CFLAGS: "-O2" } });
  assert.notEqual(unoptimized, optimized, "CFLAGS=-O0 and CFLAGS=-O2 are not interchangeable builds");
  assert.equal(computeBuildCacheKey({ ...base, buildEnv: { CFLAGS: "-O0" } }), unoptimized);

  const variants: Array<Record<string, string>> = [
    { CC: "clang" },
    { CPPFLAGS: "-DDEBUG" },
    { LDFLAGS: "-L/opt/lib" },
    { PKG_CONFIG_PATH: "/opt/lib/pkgconfig" },
    { pgac_cv_avx2_support: "no" }
  ];
  for (const buildEnv of variants) {
    assert.notEqual(
      computeBuildCacheKey({ ...base, buildEnv }),
      computeBuildCacheKey(base),
      `${JSON.stringify(buildEnv)} must change the key`
    );
  }
  // Key order is not an input; the values are.
  assert.equal(
    computeBuildCacheKey({ ...base, buildEnv: { CFLAGS: "-O2", CC: "clang" } }),
    computeBuildCacheKey({ ...base, buildEnv: { CC: "clang", CFLAGS: "-O2" } })
  );

  // resolveBuildEnv() picks up exactly the declared pass-through plus the
  // pgac_cv_* autoconf overrides, and drops empties and everything else.
  assert.deepEqual(
    resolveBuildEnv(
      { CFLAGS: "-O0", LDFLAGS: "", HOME: "/home/nobody", pgac_cv_avx2_support: "no", UNRELATED: "x" },
      { CC: "clang" }
    ),
    { CC: "clang", CFLAGS: "-O0", pgac_cv_avx2_support: "no" }
  );
});

test("a different CFLAGS cannot reuse another profile's cached build", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);

  const unoptimized = await createPostgresResearchEnvironment(
    specFor(fixture, "cflags-o0", { build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1, env: { CFLAGS: "-O0" } } })
  );
  t.after(async () => unoptimized.cleanup());
  const optimized = await createPostgresResearchEnvironment(
    specFor(fixture, "cflags-o2", { build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1, env: { CFLAGS: "-O2" } } })
  );
  t.after(async () => optimized.cleanup());

  assert.equal(unoptimized.buildManifest.cacheHit, false);
  assert.equal(optimized.buildManifest.cacheHit, false, "a different CFLAGS must not hit the -O0 entry");
  assert.notEqual(optimized.buildManifest.cacheKey, unoptimized.buildManifest.cacheKey);
  assert.notEqual(optimized.installDir, unoptimized.installDir);
  assert.equal(unoptimized.buildManifest.buildEnv.CFLAGS, "-O0");
  assert.equal(optimized.buildManifest.buildEnv.CFLAGS, "-O2");

  // ...and an identical declared environment still hits.
  const again = await createPostgresResearchEnvironment(
    specFor(fixture, "cflags-o2-again", { build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1, env: { CFLAGS: "-O2" } } })
  );
  t.after(async () => again.cleanup());
  assert.equal(again.buildManifest.cacheHit, true);
  assert.equal(again.installDir, optimized.installDir);
});
