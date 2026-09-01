import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

import { PostgresResearchError, type PostgresResearchSpec } from "../server/postgres/research-environment.js";
import {
  buildResearchContainerArgs,
  containerAgentEnvironment,
  createBuildView,
  DEFAULT_RESEARCH_IMAGE,
  RESEARCH_CONTAINER_PATHS
} from "../server/postgres/agent-container.js";
import { runAgentInPostgresResearchEnvironment } from "../server/postgres/research-session.js";
import { createSyntheticPostgresSourceRepo, hasFixtureToolchain, type SyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

/**
 * MUST 1 / MUST 2 of the #182 second review: the agent-execution boundary is
 * a container's mount namespace, not a path convention, and the build the
 * agent is handed carries no deterministic source identity.
 *
 * The container-backed tests here are the real thing: they launch the same
 * isolated process a scored trial launches, against a live cluster, and then
 * try to read grader truth from inside it. They run against the synthetic
 * source fixture, whose "PostgreSQL binaries" are `#!/bin/sh` scripts - text,
 * not compiled objects - so they execute inside a Linux container regardless
 * of the host's OS and architecture. What is under test is docker's
 * namespace enforcement, which does not care what is inside the mount.
 */

const execFileAsync = promisify(execFile);

const SENTINEL = "HONEYRAIL-PRIVATE-TRUTH-3f9c1a";

async function exists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

type Fixture = {
  tempDir: string;
  repo: SyntheticPostgresSourceRepo;
  cacheRoot: string;
  viewsRoot: string;
  attachmentRoot: string;
  siblingTrialDir: string;
};

async function withFixture(t: TestContext): Promise<Fixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-isolation-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const repo = await createSyntheticPostgresSourceRepo(join(tempDir, "repo"));

  // Grader truth, planted where a curious agent would go looking for it.
  await writeFile(join(repo.repoPath, "MIRROR-ANSWER.txt"), `${SENTINEL} source mirror\n`);
  const attachmentRoot = join(tempDir, "attachments");
  await mkdir(attachmentRoot, { recursive: true });
  await writeFile(join(attachmentRoot, "source-manifest.json"), JSON.stringify({ note: `${SENTINEL} attachment` }));
  const siblingTrialDir = join(tempDir, "envs", "sibling-trial");
  await mkdir(siblingTrialDir, { recursive: true });
  await writeFile(join(siblingTrialDir, "findings.json"), `${SENTINEL} sibling trial\n`);

  return {
    tempDir,
    repo,
    cacheRoot: join(tempDir, "build-cache"),
    viewsRoot: join(tempDir, "build-views"),
    attachmentRoot,
    siblingTrialDir
  };
}

function specFor(fixture: Fixture, name: string): PostgresResearchSpec {
  return {
    root: join(fixture.tempDir, "envs", name),
    privateDir: join(fixture.tempDir, "private", name),
    source: { repoPath: fixture.repo.repoPath, ref: fixture.repo.ref },
    build: { cacheRoot: fixture.cacheRoot, jobs: 1 }
  };
}

async function writeAgentScript(dir: string, name: string, body: string) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o755);
  return path;
}

async function skipWithoutToolchain(t: TestContext) {
  if (await hasFixtureToolchain()) return false;
  t.skip("git, make, tar or a C compiler probe is unavailable");
  return true;
}

/**
 * The container tests need a docker daemon *and* the research image. Without
 * either they skip cleanly, so `npm test` still passes on a host without
 * docker - the same contract test/tinytable-exam-room.test.ts uses. Opt in:
 *   docker build -t honeyrail-postgres-research:latest docker/postgres-research
 */
async function researchImageAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", DEFAULT_RESEARCH_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

async function skipWithoutContainer(t: TestContext) {
  if (await skipWithoutToolchain(t)) return true;
  if (!(await researchImageAvailable())) {
    t.skip(`${DEFAULT_RESEARCH_IMAGE} or a docker daemon is unavailable - see docker/postgres-research/Dockerfile`);
    return true;
  }
  return false;
}

// --- MUST 1/2, statically: what the launcher actually asks docker for -------

const MOUNTS = {
  sourceDir: "/host/env/source",
  dataDir: "/host/env/pgdata",
  socketDir: "/host/sock/hrpg-abc",
  logPath: "/host/env/postgres.log",
  scratchDir: "/host/env/agent-work",
  buildViewDir: "/host/views/view-xyz/0123456789abcdef0123456789abcdef"
};

test("buildResearchContainerArgs mounts the research surface and nothing else", () => {
  const args = buildResearchContainerArgs({ mounts: MOUNTS, command: ["true"] }, "c1");
  const mounts = args.filter((_value, index) => args[index - 1] === "-v");

  assert.deepEqual(mounts, [
    `${MOUNTS.sourceDir}:/workspace/source:rw`,
    `${MOUNTS.dataDir}:/workspace/runtime/pgdata:rw`,
    `${MOUNTS.socketDir}:/workspace/runtime/socket:rw`,
    `${MOUNTS.logPath}:/workspace/runtime/postgres.log:ro`,
    `${MOUNTS.scratchDir}:/workspace/agent:rw`,
    `${MOUNTS.buildViewDir}:/opt/honeyrail/postgres:ro`
  ]);
  // No attachment root, no private directory, no source mirror, no cache root.
  assert.equal(mounts.length, 6);
  assert.ok(!args.includes("--network=host"));
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
});

test("buildResearchContainerArgs hardens the container with the same flags as the exam room", () => {
  const args = buildResearchContainerArgs({ mounts: MOUNTS, command: ["true"] }, "c2");

  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("--user"));
  assert.equal(args[args.indexOf("--tmpfs") + 1].startsWith("/tmp:size="), true);
  assert.equal(args[args.indexOf("--name") + 1], "c2");
  assert.equal(args[args.length - 1], "true");
  assert.equal(args[args.length - 2], DEFAULT_RESEARCH_IMAGE);
});

test("the containerized agent environment exports in-container paths only, never host paths", () => {
  const injected = containerAgentEnvironment({
    host: "127.0.0.1",
    port: 54321,
    socketDir: "/host/sock/hrpg-abc",
    user: "postgres",
    database: "postgres",
    binDir: "/host/cache/0123456789abcdef0123456789abcdef/bin",
    sourceDir: "/host/env/source",
    dataDir: "/host/env/pgdata",
    logPath: "/host/env/postgres.log",
    url: "postgresql://postgres@127.0.0.1:54321/postgres"
  });

  assert.equal(injected.HR_PG_SOURCE_DIR, RESEARCH_CONTAINER_PATHS.source);
  assert.equal(injected.HR_PG_BIN_DIR, RESEARCH_CONTAINER_PATHS.bin);
  assert.equal(injected.HR_PG_DATA_DIR, RESEARCH_CONTAINER_PATHS.data);
  assert.equal(injected.HR_PG_LOG, RESEARCH_CONTAINER_PATHS.log);
  // A container has no route to the host's loopback, so the connection surface
  // is the bind-mounted socket directory rather than 127.0.0.1.
  assert.equal(injected.HR_PG_HOST, RESEARCH_CONTAINER_PATHS.socket);
  assert.match(injected.HR_PG_URL, /host=\/workspace\/runtime\/socket/);

  const exported = JSON.stringify(injected);
  assert.equal(exported.includes("/host/"), false, "a host path leaked into the agent's environment");
  assert.equal(exported.includes("0123456789abcdef"), false, "the cache entry id leaked into the agent's environment");
  for (const value of Object.values(injected)) {
    if (value.startsWith("/")) {
      assert.ok(
        value.startsWith("/workspace/") || value.startsWith("/opt/honeyrail/"),
        `${value} is not an in-container research path`
      );
    }
  }
});

test("docker being unavailable fails loudly instead of running the agent unisolated", async (t) => {
  if (await skipWithoutToolchain(t)) return;
  const fixture = await withFixture(t);
  const spec = specFor(fixture, "no-docker");
  // The probe runs before anything is materialized, so a host without docker
  // never even reaches a build - it just refuses.
  const previous = process.env.PATH;
  const emptyBin = join(fixture.tempDir, "empty-bin");
  await mkdir(emptyBin, { recursive: true });
  process.env.PATH = emptyBin;
  t.after(() => {
    process.env.PATH = previous;
  });

  await assert.rejects(
    runAgentInPostgresResearchEnvironment(spec, { command: "/bin/true" }),
    (error: Error) =>
      error instanceof PostgresResearchError &&
      /cannot be isolated/.test(error.message) &&
      /allowUnisolatedForDevelopment/.test(error.message)
  );
  assert.equal(await exists(spec.root), false, "nothing is materialized when the boundary cannot be established");
});

test("a per-trial build view exposes the binaries without the cache entry's completion marker", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-view-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const installDir = join(dir, "cafebabe0123456789abcdef01234567");
  await mkdir(join(installDir, "bin"), { recursive: true });
  await writeFile(join(installDir, "bin", "psql"), "#!/bin/sh\necho hi\n");
  await writeFile(join(installDir, "honeyrail-build-complete.json"), JSON.stringify({ entryId: "cafebabe0123456789abcdef01234567" }));

  const first = await createBuildView(installDir, join(dir, "views"));
  const second = await createBuildView(installDir, join(dir, "views"));

  assert.notEqual(first.dir, second.dir, "two trials must not share a build-view path");
  assert.deepEqual(await readdir(first.dir), ["bin"], "the completion marker carries the entryId and must stay out of the view");
  assert.equal(await readFile(join(first.dir, "bin", "psql"), "utf8"), "#!/bin/sh\necho hi\n");
  // A view, not a copy: same inode, so cache reuse is not paid for twice.
  const original = await stat(join(installDir, "bin", "psql"));
  const linked = await stat(join(first.dir, "bin", "psql"));
  assert.equal(linked.ino, original.ino);
});

// --- MUST 1, live: the malicious-reader trial ------------------------------

test("an isolated agent cannot read grader artifacts, the source mirror, sibling trials or the build cache", async (t) => {
  if (await skipWithoutContainer(t)) return;
  const fixture = await withFixture(t);
  const spec = specFor(fixture, "malicious-reader");

  // The agent binary has to live somewhere the container can see it, so it
  // goes in the scratch directory the launcher mounts at /workspace/agent.
  const probe = [
    "leaks=0",
    'report() { echo "LEAK: $1"; leaks=$((leaks+1)); }',
    // 1. Every grader-private host path, by absolute path.
    `for p in ${[
      fixture.attachmentRoot,
      join(fixture.attachmentRoot, "source-manifest.json"),
      fixture.repo.repoPath,
      join(fixture.repo.repoPath, ".git"),
      join(fixture.repo.repoPath, "MIRROR-ANSWER.txt"),
      fixture.siblingTrialDir,
      join(fixture.siblingTrialDir, "findings.json"),
      fixture.cacheRoot,
      join(fixture.tempDir, "private", "malicious-reader")
    ].join(" ")}; do`,
    '  [ -e "$p" ] && report "$p exists"',
    "done",
    // 2. Search outwards rather than trusting the handed-out paths: the whole
    //    filesystem by name, and everything writable/readable by content.
    'find / -path /proc -prune -o -path /sys -prune -o \\( -name ".git" -o -name "source-manifest.json" -o -name "build-manifest.json" -o -name "MIRROR-ANSWER.txt" -o -name "findings.json" -o -name "honeyrail-build-complete.json" \\) -print 2>/dev/null | grep . && report "found grader files by name"',
    // Assembled from two halves so the probe script - which lives in the
    // agent's own mounted scratch directory - does not match itself.
    `sentinel="${SENTINEL.slice(0, 12)}""${SENTINEL.slice(12)}"`,
    'grep -rl "$sentinel" /workspace /opt /etc /home /root /tmp /var /usr 2>/dev/null | grep . && report "found the private-truth sentinel"',
    // 3. Nothing in the mount table names a grader path either.
    `grep -E "${[fixture.attachmentRoot, fixture.repo.repoPath, fixture.cacheRoot].join("|")}" /proc/self/mountinfo && report "a grader path is in the mount table"`,
    // 4. What the workspace does contain, for the record.
    'echo "workspace=$(ls /workspace | sort | tr "\\n" ",")"',
    'echo "leaks=$leaks"',
    '[ "$leaks" -eq 0 ]',
    ""
  ].join("\n");

  const scratch = join(spec.root, "agent-work");
  await writeAgentScript(scratch, "probe.sh", probe);

  const session = await runAgentInPostgresResearchEnvironment(
    spec,
    { command: `${RESEARCH_CONTAINER_PATHS.scratch}/probe.sh`, timeoutMs: 180_000 },
    { isolation: { buildViewsRoot: fixture.viewsRoot, network: "none" } }
  );

  assert.equal(session.isolation.mode, "container");
  assert.equal(session.isolation.isolated, true);
  assert.equal(
    session.agent.ok,
    true,
    `the agent reached grader-private state:\n${session.agent.stdout}\n${session.agent.stderr}`
  );
  assert.match(session.agent.stdout, /leaks=0/);
  assert.match(session.agent.stdout, /workspace=agent,runtime,source,/, "the workspace holds only the research surface");
  // The grader side still has all of it.
  assert.equal(session.source.ref, fixture.repo.ref);
  assert.match(session.build.cacheKey, /^[0-9a-f]{64}$/);
});

test("an isolated agent can still read the source, drive the live cluster, read the log and record results", async (t) => {
  if (await skipWithoutContainer(t)) return;
  const fixture = await withFixture(t);
  const spec = specFor(fixture, "investigator");

  const investigate = [
    "set -e",
    // Read and grep the snapshot.
    'grep -q "prefix is required" "$HR_PG_SOURCE_DIR/configure"',
    'echo "source-ok"',
    // Invoke the research build's own psql, over the bind-mounted socket.
    '"$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "INSERT from-container" > /dev/null',
    'rows=$("$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "SELECT count(*) FROM stub;")',
    'echo "rows=$rows"',
    // Read the server's own log.
    'grep -q "ready to accept connections" "$HR_PG_LOG"',
    'echo "log-ok"',
    // And leave a reproducer/result behind in the allowed workspace.
    'printf "SELECT count(*) FROM stub;\\n" > "$HR_PG_WORK_DIR/repro.sql"',
    'printf "%s\\n" "$rows" > "$HR_PG_WORK_DIR/result.txt"',
    'echo "wrote-results"',
    ""
  ].join("\n");

  const scratch = join(spec.root, "agent-work");
  await writeAgentScript(scratch, "investigate.sh", investigate);

  const session = await runAgentInPostgresResearchEnvironment(
    spec,
    { command: `${RESEARCH_CONTAINER_PATHS.scratch}/investigate.sh`, timeoutMs: 180_000 },
    { isolation: { buildViewsRoot: fixture.viewsRoot, network: "none" } }
  );

  assert.equal(session.agent.ok, true, `stdout=${session.agent.stdout}\nstderr=${session.agent.stderr}`);
  assert.match(session.agent.stdout, /source-ok/);
  assert.match(session.agent.stdout, /rows=1/, "the agent queried the live cluster through the mounted socket");
  assert.match(session.agent.stdout, /log-ok/);
  // The results came back out onto the host, where a grader can read them.
  assert.equal((await readFile(join(scratch, "result.txt"), "utf8")).trim(), "1");
  assert.ok(await exists(join(scratch, "repro.sql")));
  // Teardown still happened behind the agent.
  assert.equal(session.runtime.cleanup!.stopped, true);
  assert.equal(await exists(join(spec.root, "pgdata")), false);
});

// --- MUST 2, live: no deterministic build identity reaches the agent -------

test("two trials over one cached build see the same binaries at the same neutral path and no stable host identity", async (t) => {
  if (await skipWithoutContainer(t)) return;
  const fixture = await withFixture(t);

  const report = [
    "set -e",
    'echo "bin=$HR_PG_BIN_DIR"',
    // realpath must not lead anywhere outside the neutral path...
    'echo "real=$(readlink -f "$HR_PG_BIN_DIR")"',
    // ...and neither must the mount table entry behind it, whose 4th field is
    // the mount source's path on the host.
    'echo "mountline=$(grep " /opt/honeyrail/postgres " /proc/self/mountinfo | head -1)"',
    'echo "psqlsum=$(cksum "$HR_PG_BIN_DIR/psql" | cut -d" " -f1)"',
    // Nothing below the agent-visible surface names the build either.
    'echo "markers=$(find /opt/honeyrail /workspace/source -name "honeyrail-build*" 2>/dev/null | wc -l | tr -d " ")"',
    ""
  ].join("\n");

  const results = [];
  for (const name of ["trial-a", "trial-b"]) {
    const spec = specFor(fixture, name);
    await writeAgentScript(join(spec.root, "agent-work"), "report.sh", report);
    results.push(
      await runAgentInPostgresResearchEnvironment(
        spec,
        { command: `${RESEARCH_CONTAINER_PATHS.scratch}/report.sh`, timeoutMs: 180_000 },
        { isolation: { buildViewsRoot: fixture.viewsRoot, network: "none" } }
      )
    );
  }
  const [a, b] = results;
  const field = (out: string, key: string) => out.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";

  // 4. Cache reuse still works grader-side.
  assert.equal(a.build.cacheKey, b.build.cacheKey);
  assert.equal(a.build.entryId, b.build.entryId);
  assert.equal(b.build.cacheHit, true, "the second trial must reuse the first trial's build");

  // 1. Same functional binaries, same neutral path...
  assert.equal(field(a.agent.stdout, "bin"), RESEARCH_CONTAINER_PATHS.bin);
  assert.equal(field(b.agent.stdout, "bin"), RESEARCH_CONTAINER_PATHS.bin);
  assert.equal(field(a.agent.stdout, "psqlsum"), field(b.agent.stdout, "psqlsum"));

  // 2. ...but no stable identifying host path, in the pathname, via realpath,
  //    or through the mount table - which is where a bind mount would
  //    otherwise publish its source directory verbatim.
  assert.equal(field(a.agent.stdout, "real"), RESEARCH_CONTAINER_PATHS.bin);
  const mountSource = (out: string) => field(out, "mountline").split(/\s+/)[3] ?? "";
  const mountA = mountSource(a.agent.stdout);
  const mountB = mountSource(b.agent.stdout);
  assert.notEqual(mountA, "", "expected a mount-table entry for the build");
  assert.notEqual(mountA, mountB, "the build's mounted host path must not be stable across trials");
  for (const source of [mountA, mountB]) {
    assert.equal(source.includes(a.build.entryId), false, "the cache entry id is visible in the container's mount table");
  }
  assert.notEqual(a.isolation.buildViewDir, b.isolation.buildViewDir);

  // 3. And none of the grader-side identifiers appear anywhere the agent saw.
  for (const session of results) {
    const seen = session.agent.stdout + JSON.stringify(session.agentEnvironment);
    for (const secret of [
      session.build.entryId,
      session.build.cacheKey,
      session.build.installDir,
      session.build.cacheRoot,
      session.source.ref,
      session.source.resolvedCommit,
      session.source.sourceHash
    ]) {
      assert.equal(seen.includes(secret), false, `${secret} reached the agent`);
    }
    assert.equal(field(session.agent.stdout, "markers"), "0", "no build marker is readable below the agent-visible paths");
  }
});
