import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { runCommandSafe } from "../server/utils.js";
import {
  createPostgresResearchEnvironment,
  withPostgresResearchEnvironment,
  BUILD_COMPLETE_MARKER,
  PostgresResearchError,
  type PostgresResearchSpec
} from "../server/postgres/research-environment.js";
import {
  buildResearchContainerArgs,
  containerAgentEnvironment,
  createAgentScratchDir,
  DEFAULT_RESEARCH_IMAGE,
  RESEARCH_CONTAINER_PATHS
} from "../server/postgres/agent-container.js";
import { DEFAULT_BUILDER_IMAGE } from "../server/postgres/build-container.js";
import { DEFAULT_RUNTIME_IMAGE, PostgresRuntimeContainerError } from "../server/postgres/runtime-container.js";
import { runAgentInPostgresResearchEnvironment } from "../server/postgres/research-session.js";

/**
 * MUST 5 of the #182 fourth review: the *composed* proof, against real
 * PostgreSQL, that no other test in this repository can give.
 *
 * The existing suite proves two disjoint halves:
 *
 *   test/postgres-research-real-build.test.ts   real Linux build -> binaries
 *                                               execute in a probe container
 *   test/postgres-research-isolation.test.ts    synthetic host build -> stub
 *                                               cluster + agent container
 *
 * Neither proves the thing a scored trial actually is:
 *
 *   real Linux build -> real live PostgreSQL -> isolated agent -> cleanup
 *
 * and until the runtime sidecar existed it *could not be proved*, because the
 * cluster ran as host processes and a Linux ELF binary cannot execute on a
 * macOS or Windows kernel. Every green "cluster lifecycle" run on a developer
 * machine was the synthetic `#!/bin/sh` fixture. This file is the test that
 * closes that gap, and it deliberately uses no stand-ins: a real git ref, a
 * real containerized build, a real `initdb`, a real postmaster, a real `psql`
 * from inside the real agent container, a real restart, and a real teardown.
 *
 * ## Running it
 *
 *   docker build -t honeyrail-postgres-builder:latest docker/postgres-research-builder
 *   docker build -t honeyrail-postgres-runtime:latest docker/postgres-research-runtime
 *   docker build -t honeyrail-postgres-research:latest docker/postgres-research
 *   git clone --filter=blob:none https://github.com/postgres/postgres.git /tmp/pg-mirror
 *   HONEYRAIL_PG_TEST_MIRROR=/tmp/pg-mirror \
 *     node --import tsx --test test/postgres-research-live-e2e.test.ts
 *
 * `HONEYRAIL_PG_TEST_REF` overrides the ref. Any resolvable ref works and
 * nothing here depends on a particular one - this repository must not name the
 * corpus it researches.
 *
 * A skip is **not** a pass. This is the merge gate for the fourth review, and
 * the review says so in as many words: "a required validation that skips is a
 * failure".
 */

const DEFAULT_TEST_REF = "REL_16_9";

/** A cold real build plus several container lifecycles; generous rather than flaky. */
const E2E_TIMEOUT_MS = 60 * 60 * 1000;

const FS_SENTINEL = "HONEYRAIL-GRADER-TRUTH-4e17ba9c";
const HTTP_SENTINEL = "HONEYRAIL-HOST-HTTP-TRUTH-90b3fd12";

type LiveFixture = {
  /** Holds the trial roots, the grader-private trees, and a filesystem sentinel. */
  tempDir: string;
  mirror: string;
  /** Shared on purpose: it is what makes the cache-hit assertion mean something. */
  cacheRoot: string;
  viewsRoot: string;
};

async function exists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

async function imageAvailable(image: string): Promise<boolean> {
  const result = await runCommandSafe("docker", ["image", "inspect", image], { timeout: 30_000 });
  return result.ok;
}

/**
 * The preconditions, each named individually so a skip says exactly what is
 * missing rather than "environment not suitable".
 */
async function skipUnlessLiveE2EIsPossible(t: TestContext): Promise<string | null> {
  const mirror = String(process.env.HONEYRAIL_PG_TEST_MIRROR || "").trim();
  if (!mirror) {
    t.skip(
      "HONEYRAIL_PG_TEST_MIRROR is not set - point it at a local PostgreSQL git mirror to run the real live-cluster " +
        "end-to-end test (see the header of this file). This test is the merge gate for #182 MUST 5; a skip does not " +
        "satisfy it."
    );
    return null;
  }
  if (!(await exists(mirror))) {
    t.skip(`HONEYRAIL_PG_TEST_MIRROR=${mirror} does not exist`);
    return null;
  }
  const daemon = await runCommandSafe("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
  if (!daemon.ok || !daemon.stdout.trim()) {
    t.skip("no docker daemon is reachable - the build, the runtime cluster and the agent boundary all need one");
    return null;
  }
  for (const [image, dockerfile] of [
    [DEFAULT_BUILDER_IMAGE, "docker/postgres-research-builder"],
    [DEFAULT_RUNTIME_IMAGE, "docker/postgres-research-runtime"],
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
 * The build cache is shared across this file (and with
 * test/postgres-research-real-build.test.ts) through HONEYRAIL_PG_TEST_CACHE,
 * because a cold real PostgreSQL build is minutes - which is also what makes
 * the cache-reuse assertion load-bearing rather than decorative.
 */
async function withLiveFixture(t: TestContext, mirror: string): Promise<LiveFixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-e2e-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const cacheRoot = process.env.HONEYRAIL_PG_TEST_CACHE || join(tmpdir(), "honeyrail-pg-real-build-cache");
  // Grader truth, planted where a curious agent would go looking for it.
  await writeFile(join(tempDir, "MIRROR-ANSWER.txt"), `${FS_SENTINEL} grader tree\n`);
  return { tempDir, mirror, cacheRoot, viewsRoot: join(tempDir, "build-views") };
}

function specFor(fixture: LiveFixture, name: string): PostgresResearchSpec {
  return {
    root: join(fixture.tempDir, "envs", name),
    privateDir: join(fixture.tempDir, "private", name),
    source: { repoPath: fixture.mirror, ref: process.env.HONEYRAIL_PG_TEST_REF || DEFAULT_TEST_REF },
    // No build.mode: this is the *scored default*, and the point of the test
    // is that the default now works end to end on this host.
    build: { cacheRoot: fixture.cacheRoot },
    buildViewsRoot: fixture.viewsRoot
  };
}

async function writeAgentScript(dir: string, name: string, body: string) {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/bash\n${body}`);
  await chmod(path, 0o755);
  return path;
}

/** Every non-loopback IPv4 the host actually has, so the sentinel probe targets real interfaces. */
function hostAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

/** `docker ps -a` filtered to one container name; empty output means it is really gone. */
async function containerExists(name: string): Promise<boolean> {
  const result = await runCommandSafe("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
    timeout: 30_000
  });
  return result.stdout.split("\n").map((line) => line.trim()).includes(name);
}

test(
  "the scored pipeline: real ref -> builder container -> runtime container -> live PostgreSQL -> isolated agent -> restart -> ordered cleanup",
  { timeout: E2E_TIMEOUT_MS },
  async (t) => {
    const mirror = await skipUnlessLiveE2EIsPossible(t);
    if (!mirror) return;
    const fixture = await withLiveFixture(t, mirror);
    const spec = specFor(fixture, "live");

    // A real host HTTP service serving grader truth to anything that can route
    // to it - the worst case, not just loopback. Confirmed reachable from the
    // host first, so a failure inside the container means "blocked" rather
    // than "nothing was listening".
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`${HTTP_SENTINEL}\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const sentinelPort = (server.address() as { port: number }).port;
    assert.match(
      await fetch(`http://127.0.0.1:${sentinelPort}/`).then((response) => response.text()),
      new RegExp(HTTP_SENTINEL),
      "the host sentinel server is not actually serving the sentinel"
    );

    let runtimeContainerName = "";
    let agentContainerName = "";
    let buildViewDir = "";
    let socketDir = "";
    let dataDir = "";
    let installDir = "";
    let entryId = "";
    let cacheRoot = "";
    let agentStdout = "";
    let scratchDir = "";

    const outcome = await withPostgresResearchEnvironment(spec, async (env) => {
      installDir = env.installDir;
      entryId = env.buildManifest.entryId;
      cacheRoot = env.buildManifest.cacheRoot;
      buildViewDir = env.buildView.dir;
      socketDir = env.socketDir;
      dataDir = env.dataDir;

      // 1. The build really is the containerized, neutral-prefix Linux one.
      assert.equal(env.buildManifest.buildMode, "container");
      assert.equal(env.buildManifest.scoredEligible, true);
      assert.equal(env.buildManifest.platform, "linux");
      assert.equal(env.buildManifest.installPrefix, RESEARCH_CONTAINER_PATHS.postgres);
      assert.match(env.buildManifest.builderImage!.id, /^sha256:[0-9a-f]{64}$/);
      // ...and the snapshot it was built from has no history at all.
      assert.equal(await exists(join(env.sourceDir, ".git")), false, "the agent-visible snapshot carries a .git");
      assert.equal(env.sourceManifest.gitDirPresent, false);

      // 2. A real cluster, in a real runtime container. This is the assertion
      //    the whole round exists for: before the sidecar, start() on this
      //    host died with `exec format error`.
      const readiness = await env.start();
      assert.equal(readiness.ready, true, "real PostgreSQL did not become ready inside the runtime container");
      assert.equal(env.runtimeMode, "container");

      const runtime = env.runtimeIsolation();
      runtimeContainerName = runtime.containerName!;
      assert.equal(runtime.mode, "container");
      assert.equal(runtime.scoredEligible, true);
      assert.equal(runtime.networkMode, "none");
      assert.match(runtime.image!.id, /^sha256:[0-9a-f]{64}$/);
      assert.equal(runtime.image!.os, "linux");
      assert.equal(runtime.image!.architecture, env.buildManifest.arch);
      // The mount list is the security argument; assert it rather than trust it.
      assert.equal(runtime.mounts!.length, 6);
      assert.ok(runtime.mounts!.some((mount) => mount.endsWith(":/opt/honeyrail/postgres:ro")));
      assert.equal(
        runtime.mounts!.some((mount) => mount.includes(mirror) || mount.includes(cacheRoot) || mount.includes(spec.privateDir!)),
        false,
        "the runtime container mounts the mirror, the cache root or the grader-private directory"
      );
      // The postmaster is really inside that container, and really alive.
      const health = await env.health();
      assert.deepEqual(
        { containerRunning: health.containerRunning, serverRunning: health.serverRunning },
        { containerRunning: true, serverRunning: true }
      );

      // 3. Grader-side SQL through the runtime container - real server, real
      //    version string, not a stub's "PostgreSQL 0.0".
      const version = await env.psql("SELECT version();");
      assert.equal(version.ok, true, version.stderr);
      assert.match(version.stdout, /^PostgreSQL \d+\.\d+ on .*linux/, `unexpected server version: ${version.stdout}`);
      t.diagnostic(`server: ${version.stdout}`);

      const seeded = await env.psql("CREATE TABLE hr_e2e(id int primary key, note text); INSERT INTO hr_e2e VALUES (1, 'grader');");
      assert.equal(seeded.ok, true, seeded.stderr);

      // 4. The isolated agent, in its own container, over the shared socket.
      scratchDir = await createAgentScratchDir(env.root);
      const injected = containerAgentEnvironment(env.connectionInfo());
      const bin = RESEARCH_CONTAINER_PATHS.bin;
      const psql = `"${bin}/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A`;
      const targets = [
        "host.docker.internal",
        "gateway.docker.internal",
        "127.0.0.1",
        "localhost",
        "172.17.0.1",
        ...hostAddresses()
      ];
      const probe = [
        "set -u",
        "leaks=0",
        'report() { echo "LEAK: $1"; leaks=$((leaks+1)); }',

        // (a) The review's required in-container commands, verbatim.
        `echo "== pg_config"; "$HR_PG_BIN_DIR/pg_config" --bindir`,
        `echo "== pg_config_configure"; "$HR_PG_BIN_DIR/pg_config" --configure`,
        `echo "== postgres_version"; "$HR_PG_BIN_DIR/postgres" --version`,
        `echo "== sql_version"; ${psql} -c 'SELECT version();'`,
        `echo "== sql_rw"; ${psql} -c "CREATE TABLE hr_agent(id int primary key, note text); INSERT INTO hr_agent VALUES (1, 'from-agent'); SELECT count(*) FROM hr_agent;"`,
        `echo "== sql_sees_grader_row"; ${psql} -c "SELECT note FROM hr_e2e WHERE id = 1;"`,

        // (b) No source history, and no grader identity anywhere the agent looks.
        'echo "== git"; [ -e "$HR_PG_SOURCE_DIR/.git" ] && report "source .git exists"; echo done',
        `echo "== env_scan"; env | grep -F -e "${entryId}" -e "${cacheRoot}" && report "cache identity in the environment"; echo done`,
        `echo "== mount_scan"; grep -F -e "${entryId}" -e "${cacheRoot}" -e "${mirror}" /proc/self/mountinfo && report "grader path in the mount table"; echo done`,
        `echo "== tree_scan"; grep -R -a -F -e "${entryId}" -e "${cacheRoot}" ${RESEARCH_CONTAINER_PATHS.postgres} && report "cache identity in the installed tree"; echo done`,
        `echo "== strings_scan"; strings "$HR_PG_BIN_DIR/postgres" | grep -F -e "${entryId}" -e "${cacheRoot}" && report "cache identity inside the postgres binary"; echo done`,
        `echo "== marker"; find ${RESEARCH_CONTAINER_PATHS.postgres} -name "honeyrail-build*" | wc -l | tr -d " "`,

        // (c) Grader filesystem sentinels: by absolute path, and by search.
        `for p in ${[fixture.tempDir, join(fixture.tempDir, "MIRROR-ANSWER.txt"), mirror, join(mirror, ".git"), cacheRoot, installDir, spec.privateDir!].join(" ")}; do`,
        '  [ -e "$p" ] && report "$p exists"',
        "done",
        `fs_sentinel="${FS_SENTINEL.slice(0, 12)}""${FS_SENTINEL.slice(12)}"`,
        'echo "== fs_sentinel"; grep -rl "$fs_sentinel" /workspace /opt /etc /home /root /tmp /var /usr 2>/dev/null | grep . && report "grader filesystem sentinel readable"; echo done',

        // (d) The host HTTP sentinel: attempted by every route, all must fail.
        "reached=0",
        "tried=0",
        `http_sentinel="${HTTP_SENTINEL.slice(0, 14)}""${HTTP_SENTINEL.slice(14)}"`,
        "try() {",
        "  tried=$((tried+1))",
        '  out=$(timeout 5 bash -c \'exec 3<>/dev/tcp/\'"$1"\'/\'"$2"\' && printf "GET / HTTP/1.0\\r\\nHost: %s\\r\\n\\r\\n" "$1" >&3 && cat <&3\' 2>&1)',
        '  if printf "%s" "$out" | grep -q "$http_sentinel"; then echo "REACHED: $1:$2"; reached=$((reached+1)); fi',
        "}",
        ...targets.map((target) => `try "${target}" "${sentinelPort}"`),
        'echo "== http"; echo "tried=$tried reached=$reached"',
        '[ "$reached" -eq 0 ] || report "host HTTP sentinel retrieved"',

        // (e) The server's own log is readable evidence...
        'echo "== log"; grep -c "ready to accept connections" "$HR_PG_LOG"',
        // ...and results come back out to the grader.
        'printf "agent-result-ok\\n" > "$HR_PG_WORK_DIR/result.txt"',
        `${psql} -c "SELECT count(*) FROM hr_agent;" > "$HR_PG_WORK_DIR/rows.txt"`,

        'echo "== leaks"; echo "leaks=$leaks"',
        '[ "$leaks" -eq 0 ]',
        ""
      ].join("\n");
      await writeAgentScript(scratchDir, "e2e.sh", probe);

      agentContainerName = `honeyrail-pg-e2e-${Date.now().toString(36)}`;
      const agentArgs = buildResearchContainerArgs(
        {
          mounts: {
            sourceDir: env.sourceDir,
            dataDir: env.dataDir,
            socketDir: env.socketDir,
            logPath: env.logPath,
            scratchDir,
            // The very same view the runtime container is executing.
            buildViewDir: env.buildView.dir
          },
          command: [`${RESEARCH_CONTAINER_PATHS.scratch}/e2e.sh`],
          env: injected
        },
        agentContainerName
      );
      const agent = await runCommandSafe("docker", agentArgs, { timeout: 900_000, maxBuffer: 1024 * 1024 * 64 });
      agentStdout = agent.stdout;
      t.diagnostic(agent.stdout);
      assert.equal(agent.ok, true, `the isolated agent failed:\n${agent.stdout}\n${agent.stderr}`);

      // 5. Restart, and prove the data the agent wrote survived it.
      const restarted = await env.restart();
      assert.equal(restarted.ready, true, "the cluster did not come back after a restart");
      const afterRestart = await env.psql("SELECT note FROM hr_agent WHERE id = 1;");
      assert.equal(afterRestart.ok, true, afterRestart.stderr);
      assert.equal(afterRestart.stdout, "from-agent", "the agent's committed row did not survive the restart");
      const graderRow = await env.psql("SELECT note FROM hr_e2e WHERE id = 1;");
      assert.equal(graderRow.stdout, "grader");

      // 6. A grader-side SQL script. The file lives on the host, which the
      //    runtime container deliberately cannot see; psqlFile() streams it in
      //    on `docker exec -i`'s stdin rather than mounting or copying it.
      //    (`docker cp` is refused outright by a --read-only container.)
      const scriptPath = join(fixture.tempDir, "repro.sql");
      await writeFile(scriptPath, "SELECT count(*) FROM hr_agent;\nSELECT note FROM hr_e2e WHERE id = 1;\n");
      const scripted = await env.psqlFile(scriptPath);
      assert.equal(scripted.ok, true, scripted.stderr);
      assert.equal(scripted.stdout, "1\ngrader");

      return { version: version.stdout, agentStdout: agent.stdout, cleanupPending: true };
    });

    // --- what the agent actually observed, asserted grader-side -------------
    const field = (key: string) => agentStdout.split(`== ${key}\n`)[1]?.split("\n== ")[0]?.trim() ?? "";

    assert.equal(field("pg_config"), RESEARCH_CONTAINER_PATHS.bin);
    assert.match(field("pg_config_configure"), new RegExp(`'--prefix=${RESEARCH_CONTAINER_PATHS.postgres}'`));
    assert.equal(field("pg_config_configure").includes(cacheRoot), false, "pg_config --configure names the grader's cache root");
    assert.match(field("postgres_version"), /postgres \(PostgreSQL\) \d+\./);
    assert.match(field("sql_version"), /^PostgreSQL \d+\.\d+ on .*linux/, "the agent did not query a real live server");
    assert.equal(field("sql_rw").split("\n").at(-1), "1", "the agent could not create, insert and select over the socket");
    assert.equal(field("sql_sees_grader_row"), "grader", "agent and grader are not talking to the same server");
    assert.equal(field("marker"), "0", "the build completion marker (which carries entryId) reached the agent");
    assert.match(field("http"), /tried=\d+ reached=0/);
    assert.notEqual(field("http"), "tried=0 reached=0", "a sentinel test that never tried proves nothing");
    assert.ok(Number(field("log")) >= 1, "the agent could not read the server log");
    assert.equal(field("leaks"), "leaks=0");
    assert.equal(agentStdout.includes(FS_SENTINEL), false, "the grader filesystem sentinel came back to the agent");
    assert.equal(agentStdout.includes(HTTP_SENTINEL), false, "the host HTTP sentinel came back to the agent");
    assert.equal(agentStdout.includes(entryId), false, "the cache entry id reached the agent");

    // The agent's artifact came back out onto the host, where a grader reads it.
    assert.equal((await readFile(join(scratchDir, "result.txt"), "utf8")).trim(), "agent-result-ok");
    assert.equal((await readFile(join(scratchDir, "rows.txt"), "utf8")).trim(), "1");
    assert.equal(outcome.version, field("sql_version"), "grader and agent saw different servers");

    // --- ordered cleanup: nothing ephemeral survives, the cache does --------
    assert.equal(await containerExists(runtimeContainerName), false, "the runtime container leaked");
    assert.equal(await containerExists(agentContainerName), false, "the agent container leaked");
    assert.equal(await exists(dataDir), false, "PGDATA leaked");
    assert.equal(await exists(socketDir), false, "the socket directory leaked");
    assert.equal(await exists(buildViewDir), false, "this trial's build view leaked");
    // ...and the deterministic cache is untouched, marker included.
    assert.equal(await exists(join(installDir, "bin", "postgres")), true, "cleanup damaged the shared build cache");
    assert.equal(await exists(join(installDir, BUILD_COMPLETE_MARKER)), true);
  }
);

test(
  "the supported composed session records every scored axis, and a second real trial reuses the cached build",
  { timeout: E2E_TIMEOUT_MS },
  async (t) => {
    const mirror = await skipUnlessLiveE2EIsPossible(t);
    if (!mirror) return;
    const fixture = await withLiveFixture(t, mirror);

    const sessions = [];
    for (const name of ["session-a", "session-b"]) {
      const spec = specFor(fixture, name);
      const scratch = join(spec.root, "agent-work");
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
      await (await import("node:fs/promises")).mkdir(scratch, { recursive: true });
      await writeAgentScript(
        scratch,
        "session.sh",
        [
          "set -e",
          'echo "bin=$("$HR_PG_BIN_DIR/pg_config" --bindir)"',
          '"$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "CREATE TABLE s(id int); INSERT INTO s VALUES (1);" > /dev/null',
          'rows=$("$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "SELECT count(*) FROM s;")',
          'echo "rows=$rows"',
          'echo "mount=$(grep " /opt/honeyrail/postgres " /proc/self/mountinfo | head -1 | cut -d" " -f4)"',
          ""
        ].join("\n")
      );

      sessions.push(
        await runAgentInPostgresResearchEnvironment(
          spec,
          { command: `${RESEARCH_CONTAINER_PATHS.scratch}/session.sh`, timeoutMs: 900_000 },
          { isolation: { buildViewsRoot: fixture.viewsRoot } }
        )
      );
    }
    const [first, second] = sessions;
    const field = (out: string, key: string) => out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";

    for (const session of sessions) {
      assert.equal(session.agent.ok, true, `${session.agent.stdout}\n${session.agent.stderr}`);
      assert.equal(field(session.agent.stdout, "rows"), "1", "the agent did not query a live server");
      // MUST 3: every axis, and the conjunction, recorded truthfully.
      assert.equal(session.isolation.isolated, true);
      assert.equal(session.isolation.networkMode, "none");
      assert.equal(session.isolation.buildScoredEligible, true);
      assert.equal(session.isolation.runtimeScoredEligible, true);
      assert.equal(session.isolation.scoredEligible, true, session.isolation.warning ?? "not scored-eligible");
      assert.equal(session.isolation.warning, undefined);
      assert.equal(session.isolation.runtime!.mode, "container");
      assert.match(session.isolation.runtime!.image!.id, /^sha256:[0-9a-f]{64}$/);
      // Ordered teardown, recorded.
      assert.equal(session.runtime.cleanup!.stopped, true);
      assert.equal(session.runtime.cleanup!.runtimeContainerRemoved, true);
      assert.equal(session.runtime.cleanup!.buildViewRemoved, true);
      assert.equal(session.runtime.cleanup!.socketDirRemoved, true);
      assert.equal(session.runtime.cleanup!.dataDirRemoved, true);
      assert.deepEqual(session.runtime.cleanup!.errors, []);
      assert.equal(await containerExists(session.isolation.runtime!.containerName!), false);
      assert.equal(await containerExists(session.isolation.containerName!), false);
    }

    // The second real trial reuses the first one's cache entry...
    assert.equal(first.build.entryId, second.build.entryId);
    assert.equal(second.build.cacheHit, true, "the second real trial must reuse the cached build");
    assert.deepEqual(second.build.commands, [], "a cache hit must not run configure/make at all");
    // ...through a different, non-identifying host path.
    const mountA = field(first.agent.stdout, "mount");
    const mountB = field(second.agent.stdout, "mount");
    assert.notEqual(mountA, "");
    assert.notEqual(mountA, mountB, "the mounted host path must not be stable across trials");
    for (const source of [mountA, mountB]) {
      assert.equal(source.includes(first.build.entryId), false);
      assert.equal(source.includes(first.build.cacheRoot), false);
    }
  }
);

// --- negative paths: loud failure, and nothing left behind -------------------

test("a missing runtime image fails loudly before anything is materialized or built", { timeout: 300_000 }, async (t) => {
  const mirror = await skipUnlessLiveE2EIsPossible(t);
  if (!mirror) return;
  const fixture = await withLiveFixture(t, mirror);
  const spec = { ...specFor(fixture, "missing-runtime"), runtime: { image: "honeyrail-postgres-runtime:definitely-not-present" } };

  await assert.rejects(
    createPostgresResearchEnvironment(spec),
    (error: Error) =>
      error instanceof PostgresRuntimeContainerError &&
      /is not available to the docker daemon/.test(error.message) &&
      /docker build -t honeyrail-postgres-runtime:definitely-not-present docker\/postgres-research-runtime/.test(error.message)
  );
  // The expensive work never started, and there was no silent fall back to a
  // host-process cluster.
  assert.equal(await exists(join(spec.root, "source")), false, "a missing runtime image must fail before materialization");
});

test("an initdb failure tears the runtime container down and leaves no view behind", { timeout: E2E_TIMEOUT_MS }, async (t) => {
  const mirror = await skipUnlessLiveE2EIsPossible(t);
  if (!mirror) return;
  const fixture = await withLiveFixture(t, mirror);
  const spec = { ...specFor(fixture, "initdb-fail"), initdbArgs: ["--definitely-not-an-initdb-flag"] };

  const env = await createPostgresResearchEnvironment(spec);
  await assert.rejects(env.start(), (error: Error) => /initdb failed inside the runtime container/.test(error.message));

  const runtimeName = env.runtimeIsolation().containerName!;
  assert.equal(await containerExists(runtimeName), true, "the container is still there until cleanup runs - that is the ordering");
  const cleanup = await env.cleanup();

  assert.equal(cleanup.runtimeContainerRemoved, true);
  assert.equal(await containerExists(runtimeName), false, "a failed initdb leaked its runtime container");
  assert.equal(await exists(env.buildView.dir), false, "a failed initdb leaked its build view");
  assert.equal(await exists(env.socketDir), false);
  // The shared cache is not collateral damage.
  assert.equal(await exists(join(env.installDir, "bin", "initdb")), true);
});

test("a real trial's containers, view and ephemeral directories are all gone afterwards", { timeout: E2E_TIMEOUT_MS }, async (t) => {
  const mirror = await skipUnlessLiveE2EIsPossible(t);
  if (!mirror) return;
  const fixture = await withLiveFixture(t, mirror);

  // The timeout arm: the session backstop fires while the agent is still
  // running, and teardown must still be complete and ordered afterwards.
  const spec = specFor(fixture, "timeout");
  const scratch = join(spec.root, "agent-work");
  await (await import("node:fs/promises")).mkdir(scratch, { recursive: true });
  await writeAgentScript(scratch, "sleep.sh", "sleep 600\n");

  const session = await runAgentInPostgresResearchEnvironment(
    spec,
    { command: `${RESEARCH_CONTAINER_PATHS.scratch}/sleep.sh`, timeoutMs: 15_000 },
    { isolation: { buildViewsRoot: fixture.viewsRoot } }
  );

  assert.equal(session.agent.timedOut, true, "the agent should have been killed for exceeding its timeout");
  assert.equal(session.agent.ok, false);
  // The server was still up while the agent was being killed - the ordering
  // this whole path exists to guarantee - and only then torn down.
  assert.equal(session.runtime.cleanup!.stopped, true);
  assert.equal(session.runtime.cleanup!.runtimeContainerRemoved, true);
  assert.equal(await containerExists(session.isolation.runtime!.containerName!), false);
  assert.equal(await containerExists(session.isolation.containerName!), false);
  assert.equal(await exists(session.isolation.buildViewDir!), false);
  assert.equal(await exists(session.connection.socketDir), false);
  assert.equal(await exists(session.connection.dataDir), false);
  // Nothing of this repository's own validation containers survives either.
  const leaked = await runCommandSafe("docker", ["ps", "-a", "--filter", "name=honeyrail-pg-", "--format", "{{.Names}}"], {
    timeout: 30_000
  });
  assert.deepEqual(leaked.stdout.split("\n").filter(Boolean), [], `leaked containers: ${leaked.stdout}`);
  assert.deepEqual(await readdir(fixture.viewsRoot).catch(() => []), [], "a build view survived the trial");
});
