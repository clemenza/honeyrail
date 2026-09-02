import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

import { runCommandSafe } from "../server/utils.js";
import {
  buildPostgres,
  materializePostgresSource,
  BUILD_COMPLETE_MARKER,
  type PostgresBuildManifest,
  type PostgresSourceManifest
} from "../server/postgres/research-environment.js";
import { NEUTRAL_INSTALL_PREFIX } from "../server/postgres/container-paths.js";
import {
  buildResearchContainerArgs,
  createBuildView,
  removeBuildView,
  DEFAULT_RESEARCH_IMAGE,
  RESEARCH_CONTAINER_PATHS,
  type BuildView
} from "../server/postgres/agent-container.js";
import { DEFAULT_BUILDER_IMAGE } from "../server/postgres/build-container.js";

/**
 * MUST 1 of the #182 third review, against **real PostgreSQL**.
 *
 * The synthetic fixture the rest of the suite runs on cannot test this
 * property at all: its "binaries" are `#!/bin/sh` scripts, so there is no
 * `pg_config` reporting a compiled-in prefix, no `Makefile.global`, and no
 * ELF `.rodata` for `strings` to find a path in. The hole the third review
 * found - `configure --prefix=<cacheRoot>/<entryId>` compiling the
 * deterministic cache entry id into `pg_config --configure` and into the
 * installed tree, where an isolated agent reads it by simply running the
 * binary it was handed - is invisible to a shell-script stand-in and needs a
 * genuine build to prove closed.
 *
 * So this test does the real thing: it materializes a real PostgreSQL ref
 * from a locally provided mirror, builds it through the containerized scored
 * path, mounts a per-trial view of the result into the *actual*
 * research-agent container, and runs `pg_config`, a recursive binary-safe
 * grep and `strings` from inside it. The assertions are the review's
 * acceptance conditions verbatim.
 *
 * ## Running it
 *
 * It is opt-in on the mirror, because a PostgreSQL checkout is not something
 * a CI runner has lying around and this repository must not name the corpus
 * it researches:
 *
 *   git clone --filter=blob:none https://github.com/postgres/postgres.git /tmp/pg-mirror
 *   docker build -t honeyrail-postgres-builder:latest docker/postgres-research-builder
 *   docker build -t honeyrail-postgres-research:latest docker/postgres-research
 *   HONEYRAIL_PG_TEST_MIRROR=/tmp/pg-mirror \
 *     node --import tsx --test test/postgres-research-real-build.test.ts
 *
 * `HONEYRAIL_PG_TEST_REF` overrides the ref (default: a recent release tag).
 * Any resolvable ref works - nothing here depends on a particular one, and
 * deliberately so.
 *
 * Without the mirror, docker, or either image it skips with a message naming
 * exactly what is missing, following the same convention as
 * test/postgres-research-isolation.test.ts and test/tinytable-exam-room.test.ts.
 * A skip is **not** a pass for the merge gate this test exists to satisfy.
 */

const execFileAsync = promisify(execFile);

/**
 * Any real, buildable PostgreSQL tree proves the property; a release tag is
 * chosen only because it is stable and cheap to resolve. Nothing about the
 * historical corpus is referenced here or anywhere else in this repository.
 */
const DEFAULT_TEST_REF = "REL_16_9";

/** A cold real build plus three container launches; generous rather than flaky. */
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;

type RealBuildFixture = {
  tempDir: string;
  cacheRoot: string;
  viewsRoot: string;
  source: PostgresSourceManifest;
};

async function imageAvailable(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", image]);
    return true;
  } catch {
    return false;
  }
}

async function skipUnlessRealBuildIsPossible(t: TestContext): Promise<string | null> {
  const mirror = String(process.env.HONEYRAIL_PG_TEST_MIRROR || "").trim();
  if (!mirror) {
    t.skip(
      "HONEYRAIL_PG_TEST_MIRROR is not set - point it at a local PostgreSQL git mirror to run the real-build " +
        "cache-identity scan (see the header of this file). This test is a merge gate for #182 MUST 1; a skip " +
        "does not satisfy it."
    );
    return null;
  }
  if (!(await stat(mirror).catch(() => null))) {
    t.skip(`HONEYRAIL_PG_TEST_MIRROR=${mirror} does not exist`);
    return null;
  }
  const daemon = await runCommandSafe("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
  if (!daemon.ok || !daemon.stdout.trim()) {
    t.skip("no docker daemon is reachable - the scored build path and the agent boundary both need one");
    return null;
  }
  for (const [image, dockerfile] of [
    [DEFAULT_BUILDER_IMAGE, "docker/postgres-research-builder"],
    [DEFAULT_RESEARCH_IMAGE, "docker/postgres-research"]
  ] as const) {
    if (!(await imageAvailable(image))) {
      t.skip(`${image} is unavailable - build it: docker build -t ${image} ${dockerfile}`);
      return null;
    }
  }
  return mirror;
}

/**
 * Materializes and builds once per test. The build cache is shared across
 * tests in this file through HONEYRAIL_PG_TEST_CACHE (default: a stable
 * directory under the system temp root), because a cold real PostgreSQL
 * build is minutes and every test here wants the same one - which also makes
 * the cache-reuse assertion below load-bearing rather than decorative.
 */
async function realBuild(
  t: TestContext,
  mirror: string,
  options: { coldCache?: boolean } = {}
): Promise<{ fixture: RealBuildFixture; build: PostgresBuildManifest }> {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-real-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  // `coldCache` forces a real configure/make/install rather than a hit, for
  // the one test whose subject is the build itself.
  const cacheRoot = options.coldCache
    ? join(tempDir, "cold-cache")
    : process.env.HONEYRAIL_PG_TEST_CACHE || join(tmpdir(), "honeyrail-pg-real-build-cache");
  const source = await materializePostgresSource(
    { repoPath: mirror, ref: process.env.HONEYRAIL_PG_TEST_REF || DEFAULT_TEST_REF },
    join(tempDir, "source")
  );
  const build = await buildPostgres({ source, build: { cacheRoot }, logDir: join(tempDir, "build-logs") });
  return { fixture: { tempDir, cacheRoot, viewsRoot: join(tempDir, "views"), source }, build };
}

/**
 * Runs a probe script inside the real research-agent container, against a
 * per-trial view of the build - i.e. through exactly the argv
 * runAgentInPostgresResearchEnvironment() constructs, minus the live cluster.
 *
 * The cluster is left out on purpose. It runs as a *host* process, and a
 * containerized build produces Linux binaries that a macOS or Windows host
 * cannot execute; requiring one here would make this test Linux-only and
 * therefore skipped exactly where the ABI question is most interesting. What
 * is under test - what a real installed PostgreSQL tree discloses about the
 * grader's cache - needs no server, only the tree and the boundary.
 * test/postgres-research-isolation.test.ts covers the live-cluster path.
 */
async function probeInAgentContainer(
  fixture: RealBuildFixture,
  installDir: string,
  script: string
): Promise<{ ok: boolean; stdout: string; stderr: string; view: BuildView }> {
  const view = await createBuildView(installDir, fixture.viewsRoot);
  const emptyDir = await mkdtemp(join(fixture.tempDir, "mount-"));
  const logFile = join(emptyDir, "postgres.log");
  await (await import("node:fs/promises")).writeFile(logFile, "");
  const args = buildResearchContainerArgs(
    {
      mounts: {
        sourceDir: emptyDir,
        dataDir: emptyDir,
        socketDir: emptyDir,
        logPath: logFile,
        scratchDir: emptyDir,
        buildViewDir: view.dir
      },
      command: ["/bin/sh", "-c", script]
    },
    `honeyrail-pg-realscan-${Math.random().toString(16).slice(2)}`
  );
  const result = await runCommandSafe("docker", args, { timeout: 300_000, maxBuffer: 1024 * 1024 * 64 });
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, view };
}

test("a real containerized PostgreSQL build compiles in the neutral prefix and no grader cache identity", async (t) => {
  const mirror = await skipUnlessRealBuildIsPossible(t);
  if (!mirror) return;
  t.diagnostic(`building real PostgreSQL from ${mirror}`);

  const { fixture, build } = await realBuild(t, mirror);

  // The grader side still knows everything.
  assert.equal(build.buildMode, "container");
  assert.equal(build.scoredEligible, true);
  assert.equal(build.installPrefix, NEUTRAL_INSTALL_PREFIX);
  assert.equal(build.platform, "linux", "a containerized build targets Linux regardless of host OS");
  assert.ok(build.builderImage, "a container build must record which image produced it");
  assert.match(build.builderImage!.id, /^sha256:[0-9a-f]{64}$/);
  assert.match(build.cacheKey, /^[0-9a-f]{64}$/);
  assert.match(build.entryId, /^[0-9a-f]{32}$/);
  assert.equal(build.installDir, join(build.cacheRoot, build.entryId));

  // ...and the cache entry really is a PostgreSQL installation, not a stub.
  for (const relative of ["bin/postgres", "bin/psql", "bin/pg_config", "bin/initdb", "lib/libpq.so.5"]) {
    assert.ok(await stat(join(build.installDir, relative)).catch(() => null), `real build is missing ${relative}`);
  }

  const bin = RESEARCH_CONTAINER_PATHS.bin;
  const root = RESEARCH_CONTAINER_PATHS.postgres;
  // Everything the review asks for, run by the agent, inside the agent's own
  // container, against the tree the agent is actually handed. `grep -a -F`
  // and `strings` are both here because they fail differently: grep -a walks
  // every installed file including Makefile.global and pkg-config metadata,
  // strings looks inside the compiled `postgres` binary specifically.
  const probe = [
    "set -u",
    `echo "== pg_config --bindir";   "${bin}/pg_config" --bindir`,
    `echo "== pg_config --libdir";   "${bin}/pg_config" --libdir`,
    `echo "== pg_config --sharedir"; "${bin}/pg_config" --sharedir`,
    `echo "== pg_config --configure"; "${bin}/pg_config" --configure`,
    `echo "== pg_config --version";  "${bin}/pg_config" --version`,
    `echo "== postgres --version";   "${bin}/postgres" --version`,
    `echo "== psql --version";       "${bin}/psql" --version`,
    `echo "== initdb --version";     "${bin}/initdb" --version`,
    `echo "== grep cacheRoot"; grep -R -a -F "${build.cacheRoot}" ${root} && echo "HIT-CACHEROOT" || echo "clean"`,
    `echo "== grep entryId";   grep -R -a -F "${build.entryId}" ${root} && echo "HIT-ENTRYID" || echo "clean"`,
    `echo "== grep cacheKey";  grep -R -a -F "${build.cacheKey}" ${root} && echo "HIT-CACHEKEY" || echo "clean"`,
    `echo "== grep viewDir";   grep -R -a -F "${fixture.viewsRoot}" ${root} && echo "HIT-VIEWROOT" || echo "clean"`,
    `echo "== strings postgres"; strings ${bin}/postgres | grep -F -e "${build.cacheRoot}" -e "${build.entryId}" && echo "HIT-STRINGS" || echo "clean"`,
    `echo "== strings pg_config"; strings ${bin}/pg_config | grep -F -e "${build.cacheRoot}" -e "${build.entryId}" && echo "HIT-STRINGS" || echo "clean"`,
    `echo "== marker"; find ${root} -name "honeyrail-build*" | wc -l`,
    ""
  ].join("\n");

  const scan = await probeInAgentContainer(fixture, build.installDir, probe);
  t.after(async () => removeBuildView(scan.view));
  t.diagnostic(scan.stdout);
  assert.equal(scan.ok, true, `the real binaries did not run inside the agent container:\n${scan.stderr}`);

  const field = (key: string) => scan.stdout.split(`== ${key}\n`)[1]?.split("\n== ")[0]?.trim() ?? "";

  // 1. pg_config reports the neutral prefix and nothing else. This is the
  //    assertion the whole change exists for: before it, --configure read
  //    back `--prefix=<cacheRoot>/<entryId>` verbatim.
  assert.equal(field("pg_config --bindir"), bin);
  assert.equal(field("pg_config --libdir"), RESEARCH_CONTAINER_PATHS.lib);
  assert.equal(field("pg_config --sharedir"), `${root}/share`);
  assert.match(field("pg_config --configure"), new RegExp(`'--prefix=${root}'`));
  assert.equal(
    field("pg_config --configure").includes(build.cacheRoot),
    false,
    "pg_config --configure still reports the grader's build cache root"
  );

  // 2. Real PostgreSQL executes inside the research-agent container. Note
  //    pg_config prints "PostgreSQL 16.9" while the others print
  //    "<program> (PostgreSQL) 16.9" - both forms, one pattern.
  for (const program of ["postgres", "psql", "initdb", "pg_config"]) {
    assert.match(field(`${program} --version`), /PostgreSQL\)? \d+\./, `${program} did not run inside the container`);
  }

  // 3. No grader identity anywhere in the agent-visible installed tree.
  for (const key of ["grep cacheRoot", "grep entryId", "grep cacheKey", "grep viewDir", "strings postgres", "strings pg_config"]) {
    assert.equal(field(key), "clean", `${key} found grader cache identity in the installed tree`);
  }
  assert.equal(field("marker"), "0", "the build completion marker (which carries entryId) reached the agent");

  // 4. Belt and braces: the same scan from the host, over the whole cache
  //    entry rather than the marker-free view, must find the identity in
  //    exactly one place - the marker file that is deliberately withheld.
  const hostScan = await runCommandSafe("grep", ["-R", "-a", "-l", "-F", build.entryId, build.installDir], { timeout: 120_000 });
  const hits = hostScan.stdout.split("\n").filter(Boolean);
  assert.deepEqual(hits, [join(build.installDir, BUILD_COMPLETE_MARKER)], `unexpected entryId occurrences: ${hits.join(", ")}`);
});

test("a second real trial reuses the cached build and sees it at the same neutral path through a different view", async (t) => {
  const mirror = await skipUnlessRealBuildIsPossible(t);
  if (!mirror) return;

  // Two independent materializations of the same ref, each with its own
  // snapshot directory, sharing one cache root. The second must hit.
  const first = await realBuild(t, mirror);
  const second = await realBuild(t, mirror);

  assert.equal(first.build.cacheKey, second.build.cacheKey);
  assert.equal(first.build.entryId, second.build.entryId);
  assert.equal(second.build.cacheHit, true, "the second real build must reuse the first one's cache entry");
  assert.deepEqual(second.build.commands, [], "a cache hit must not run configure/make at all");

  const probe = [
    `echo "== bin"; "${RESEARCH_CONTAINER_PATHS.bin}/pg_config" --bindir`,
    `echo "== real"; readlink -f "${RESEARCH_CONTAINER_PATHS.bin}"`,
    `echo "== mount"; grep " ${RESEARCH_CONTAINER_PATHS.postgres} " /proc/self/mountinfo | head -1`,
    `echo "== sum"; cksum "${RESEARCH_CONTAINER_PATHS.bin}/postgres" | cut -d" " -f1`,
    ""
  ].join("\n");

  const a = await probeInAgentContainer(first.fixture, first.build.installDir, probe);
  const b = await probeInAgentContainer(second.fixture, second.build.installDir, probe);
  t.after(async () => {
    await removeBuildView(a.view);
    await removeBuildView(b.view);
  });
  assert.equal(a.ok, true, a.stderr);
  assert.equal(b.ok, true, b.stderr);

  const field = (out: string, key: string) => out.split(`== ${key}\n`)[1]?.split("\n== ")[0]?.trim() ?? "";

  // Identical binaries at an identical neutral path...
  assert.equal(field(a.stdout, "bin"), RESEARCH_CONTAINER_PATHS.bin);
  assert.equal(field(b.stdout, "bin"), RESEARCH_CONTAINER_PATHS.bin);
  assert.equal(field(a.stdout, "real"), RESEARCH_CONTAINER_PATHS.bin);
  assert.equal(field(a.stdout, "sum"), field(b.stdout, "sum"));

  // ...reached through different, non-identifying host paths.
  const mountSource = (out: string) => field(out, "mount").split(/\s+/)[3] ?? "";
  assert.notEqual(mountSource(a.stdout), "", "expected a mount-table entry for the build");
  assert.notEqual(mountSource(a.stdout), mountSource(b.stdout), "the mounted host path must not be stable across trials");
  for (const source of [mountSource(a.stdout), mountSource(b.stdout)]) {
    assert.equal(source.includes(first.build.entryId), false, "the cache entry id is visible in the mount table");
    assert.equal(source.includes(first.build.cacheRoot), false, "the cache root is visible in the mount table");
  }
});

test("a cold real build configures with the neutral prefix, stages through DESTDIR, and bakes only the prefix into pgxs", async (t) => {
  const mirror = await skipUnlessRealBuildIsPossible(t);
  if (!mirror) return;
  // Its own cache root, so this is always a genuine configure/make/install
  // rather than a hit off a sibling test - the build is the subject here.
  const { fixture, build } = await realBuild(t, mirror, { coldCache: true });
  assert.equal(build.cacheHit, false);

  const configureLog = await readFile(join(fixture.tempDir, "build-logs", "configure.log"), "utf8");
  assert.match(configureLog, new RegExp(`--prefix=${NEUTRAL_INSTALL_PREFIX}`));
  const installLog = await readFile(join(fixture.tempDir, "build-logs", "make-install.log"), "utf8");
  assert.ok(installLog.includes("/build/staging"), "make install must stage through the container's DESTDIR mount");

  // `lib/pgxs/src/Makefile.global` is where PostgreSQL writes its own idea of
  // where it lives, for extensions to build against. It is a plain text file
  // in the tree the agent is handed, and under the old scheme it carried
  // `<cacheRoot>/<entryId>` in half a dozen variables - the most readable
  // copy of the grader's cache identity in the whole installation.
  const makefileGlobal = await readFile(join(build.installDir, "lib", "pgxs", "src", "Makefile.global"), "utf8");
  assert.match(makefileGlobal, new RegExp(`prefix := ${NEUTRAL_INSTALL_PREFIX}`));
  assert.equal(makefileGlobal.includes(build.cacheRoot), false, "Makefile.global names the grader's cache root");
  assert.equal(makefileGlobal.includes(build.entryId), false, "Makefile.global names the cache entry id");
  // A second, unlooked-for benefit of building in a container: `configure`
  // also records where it *built*, and in container mode that is the neutral
  // /build/source rather than the host's snapshot directory. A host build
  // would write the real host path here.
  assert.match(makefileGlobal, /abs_top_srcdir = \/build\/source/);
  assert.equal(
    makefileGlobal.includes(fixture.source.sourceDir),
    false,
    "Makefile.global names the host snapshot directory"
  );

  // The build logs themselves *are* grader-private - they live under
  // privateDir, which is never mounted - and are allowed to say anything.
  assert.equal(await stat(join(fixture.tempDir, "build-logs")).then((s) => s.isDirectory()), true);
});
