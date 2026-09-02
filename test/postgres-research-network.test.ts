import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

import { runCommandSafe } from "../server/utils.js";
import type { PostgresResearchSpec } from "../server/postgres/research-environment.js";
import {
  buildResearchContainerArgs,
  isScoredNetworkMode,
  DEFAULT_RESEARCH_IMAGE,
  DEFAULT_RESEARCH_NETWORK,
  RESEARCH_CONTAINER_PATHS
} from "../server/postgres/agent-container.js";
import { runAgentInPostgresResearchEnvironment, unscoredReasons } from "../server/postgres/research-session.js";
import { createSyntheticPostgresSourceRepo, hasFixtureToolchain, type SyntheticPostgresSourceRepo } from "./helpers/postgres-source-fixture.js";

/**
 * MUST 2 of the #182 third review: the agent must not be able to retrieve
 * grader truth over the network, and a run that *could* have must not look
 * scored.
 *
 * The distinction this file exists to enforce is that filesystem isolation
 * and network isolation are different guarantees. A container that cannot
 * read `source-manifest.json` off the host filesystem can still `GET` the
 * same fact from a HoneyRail service on the host - through
 * `host.docker.internal` on Docker Desktop, or the bridge's default gateway
 * on Linux. "The sentinel was not found in the mounted files" is therefore
 * not a network test, and the live test below is deliberately built the other
 * way round: a real HTTP server on the host really does serve the sentinel,
 * the agent really does try to fetch it by every route it can enumerate, and
 * every attempt has to fail.
 *
 * `--network none` gives the container no interface but its own loopback, so
 * there is no gateway and no `host.docker.internal` to resolve - but the test
 * still makes the agent *attempt* each one, because a test that never tried
 * proves nothing. The attempts use bash's `/dev/tcp` pseudo-device, which
 * needs no networking client installed in the image.
 */

const execFileAsync = promisify(execFile);

const SENTINEL = "HONEYRAIL-NETWORK-TRUTH-7b21e4c0";

async function researchImageAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", DEFAULT_RESEARCH_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

async function skipWithoutContainer(t: TestContext) {
  if (!(await hasFixtureToolchain())) {
    t.skip("git, make, tar or a C compiler probe is unavailable");
    return true;
  }
  const daemon = await runCommandSafe("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
  if (!daemon.ok || !daemon.stdout.trim() || !(await researchImageAvailable())) {
    t.skip(`${DEFAULT_RESEARCH_IMAGE} or a docker daemon is unavailable - see docker/postgres-research/Dockerfile`);
    return true;
  }
  return false;
}

type Fixture = { tempDir: string; repo: SyntheticPostgresSourceRepo; cacheRoot: string; viewsRoot: string };

async function withFixture(t: TestContext): Promise<Fixture> {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-pg-network-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const repo = await createSyntheticPostgresSourceRepo(join(tempDir, "repo"));
  return { tempDir, repo, cacheRoot: join(tempDir, "build-cache"), viewsRoot: join(tempDir, "build-views") };
}

function specFor(fixture: Fixture, name: string): PostgresResearchSpec {
  return {
    root: join(fixture.tempDir, "envs", name),
    privateDir: join(fixture.tempDir, "private", name),
    source: { repoPath: fixture.repo.repoPath, ref: fixture.repo.ref },
    // The synthetic fixture's "binaries" are shell scripts, and the cluster
    // runs on the host, so this has to be a host build to have a live server
    // on a non-Linux host at all. That is exactly why the session below is
    // asserted to record buildScoredEligible: false - and why the *build*
    // side of the scored path is proved separately, against real PostgreSQL,
    // in test/postgres-research-real-build.test.ts.
    build: { mode: "host" as const, cacheRoot: fixture.cacheRoot, jobs: 1 }
  };
}

async function writeAgentScript(dir: string, name: string, body: string) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `#!/bin/bash\n${body}`);
  await chmod(path, 0o755);
  return path;
}

/** Every non-loopback IPv4 the host actually has, so the probe targets real interfaces. */
function hostAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

// --- static: the default moved, and the record says so ---------------------

test("the scored default network is none, and the launcher asks docker for it", () => {
  assert.equal(DEFAULT_RESEARCH_NETWORK, "none");
  const mounts = {
    sourceDir: "/host/env/source",
    dataDir: "/host/env/pgdata",
    socketDir: "/host/sock/hrpg-abc",
    logPath: "/host/env/postgres.log",
    scratchDir: "/host/env/agent-work",
    buildViewDir: "/host/views/view-xyz/0123456789abcdef0123456789abcdef"
  };
  const args = buildResearchContainerArgs({ mounts, command: ["true"] }, "c1");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  // An explicit opt-in is still honoured - it just is not the default.
  const bridged = buildResearchContainerArgs({ mounts, command: ["true"], network: "bridge" }, "c2");
  assert.equal(bridged[bridged.indexOf("--network") + 1], "bridge");
  assert.ok(!args.includes("--network=host"));
});

test("only network: none counts as scored-eligible, and every other mode explains itself", () => {
  assert.equal(isScoredNetworkMode(undefined), true, "the default must be the scored mode");
  assert.equal(isScoredNetworkMode("none"), true);
  assert.equal(isScoredNetworkMode("bridge"), false);
  assert.equal(isScoredNetworkMode("host"), false);
  assert.equal(isScoredNetworkMode("my-custom-net"), false);

  assert.deepEqual(unscoredReasons({ networkMode: "none", buildScoredEligible: true }), []);
  const bridged = unscoredReasons({ networkMode: "bridge", buildScoredEligible: true });
  assert.equal(bridged.length, 1);
  assert.match(bridged[0], /host\.docker\.internal/);
  const both = unscoredReasons({ networkMode: "bridge", buildScoredEligible: false });
  assert.equal(both.length, 2, "a bridged run over a host build must report both reasons, not the first one");
});

// --- live: a real host HTTP sentinel the agent must not be able to fetch ----

test("an isolated agent on the scored default cannot retrieve a host HTTP sentinel, but can still query PostgreSQL", async (t) => {
  if (await skipWithoutContainer(t)) return;
  const fixture = await withFixture(t);
  const spec = specFor(fixture, "network-sentinel");

  // A real host service, bound to every interface - i.e. the worst case, not
  // just loopback. This stands in for a HoneyRail dashboard/API that would
  // happily serve grader state to anything that can route to it.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`${SENTINEL}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;

  // Confirm from the host that the sentinel really is being served, so a
  // failure inside the container means "blocked", not "nothing was there".
  const hostFetch = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(hostFetch, new RegExp(SENTINEL), "the sentinel server is not actually serving the sentinel");

  const targets = ["host.docker.internal", "gateway.docker.internal", "127.0.0.1", "localhost", "172.17.0.1", ...hostAddresses()];
  const probe = [
    "reached=0",
    "tried=0",
    // bash's /dev/tcp needs no installed client. `timeout` bounds a route
    // that black-holes rather than refuses.
    "try() {",
    '  tried=$((tried+1))',
    '  out=$(timeout 5 bash -c \'exec 3<>/dev/tcp/\'"$1"\'/\'"$2"\' && printf "GET / HTTP/1.0\\r\\nHost: %s\\r\\n\\r\\n" "$1" >&3 && cat <&3\' 2>&1)',
    '  status=$?',
    `  if printf '%s' "$out" | grep -q "$SENTINEL_PATTERN"; then`,
    '    echo "REACHED: $1:$2"; reached=$((reached+1))',
    '  else',
    '    echo "blocked: $1:$2 (exit $status) $(printf %s "$out" | head -1 | tr -d "\\r")"',
    '  fi',
    "}",
    // Split so this script, which lives in a directory the agent can read,
    // never contains the sentinel it is looking for.
    `SENTINEL_PATTERN="${SENTINEL.slice(0, 14)}""${SENTINEL.slice(14)}"`,
    ...targets.map((target) => `try "${target}" "${port}"`),
    // DNS itself: with no network namespace there is nothing to resolve
    // against either, and a resolution failure is as good as a refusal.
    'echo "dns: $(timeout 5 getent hosts host.docker.internal 2>&1 || echo unresolvable)"',
    'echo "interfaces: $(ls /sys/class/net 2>/dev/null | tr "\\n" "," )"',
    // The route tables are the load-bearing evidence, and both families are
    // checked: an IPv4-only story would leave an IPv6 path open. A fresh
    // network namespace auto-creates a handful of down, address-less tunnel
    // devices (gre0, sit0, tunl0 ...) whichever kernel modules are loaded, so
    // "only lo exists" is not a portable assertion - "nothing is routable" is.
    'echo "routes: $(cat /proc/net/route 2>/dev/null | tail -n +2 | wc -l | tr -d " ")"',
    `echo "ipv6routes: $(awk '$10 != "lo" { c++ } END { print c+0 }' /proc/net/ipv6_route 2>/dev/null)"`,
    // The one thing that must still work: the research cluster, over the
    // bind-mounted Unix socket. AF_UNIX resolves through the mount namespace,
    // so removing the network namespace costs the agent nothing it needs.
    '"$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "INSERT over-unix-socket" > /dev/null || { echo "psql-insert-failed"; exit 1; }',
    'rows=$("$HR_PG_BIN_DIR/psql" -X -h "$HR_PG_HOST" -p "$HR_PG_PORT" -U "$HR_PG_USER" -d "$HR_PG_DATABASE" -t -A -c "SELECT count(*) FROM stub;")',
    'echo "sql-rows=$rows"',
    'echo "tried=$tried reached=$reached"',
    '[ "$reached" -eq 0 ]',
    ""
  ].join("\n");

  await writeAgentScript(join(spec.root, "agent-work"), "netprobe.sh", probe);

  const session = await runAgentInPostgresResearchEnvironment(
    spec,
    { command: `${RESEARCH_CONTAINER_PATHS.scratch}/netprobe.sh`, timeoutMs: 240_000 },
    // network deliberately unset: this asserts the *default*, which is what
    // the review requires to have moved.
    { isolation: { buildViewsRoot: fixture.viewsRoot } }
  );
  t.diagnostic(session.agent.stdout);

  assert.equal(session.isolation.networkMode, "none", "the default scored network mode must be none");
  assert.equal(session.agent.ok, true, `the agent reached a host service:\n${session.agent.stdout}\n${session.agent.stderr}`);
  assert.match(session.agent.stdout, /reached=0/);
  // The attempts really were made - a test that never tried is not a pass.
  assert.match(session.agent.stdout, new RegExp(`tried=${targets.length} `));
  assert.equal(session.agent.stdout.includes("REACHED:"), false);
  assert.equal(session.agent.stdout.includes(SENTINEL), false, "the sentinel itself came back to the agent");
  // Nothing routable, in either address family, and no bridge interface.
  assert.match(session.agent.stdout, /routes: 0/, "the container has an IPv4 route out");
  assert.match(session.agent.stdout, /ipv6routes: 0/, "the container has an IPv6 route out");
  assert.match(session.agent.stdout, /interfaces: .*\blo\b/);
  assert.equal(/interfaces: .*eth0/.test(session.agent.stdout), false, "a bridge interface was attached");
  assert.match(session.agent.stdout, /dns: unresolvable|dns: $/m, "DNS resolved inside a networkless container");

  // ...and PostgreSQL is still fully reachable over the mounted socket.
  assert.match(session.agent.stdout, /sql-rows=1/, "the agent could not query the cluster over the Unix socket");

  // Cleanup still happened behind it.
  assert.equal(session.runtime.cleanup!.stopped, true);
  assert.equal(session.runtime.cleanup!.socketDirRemoved, true);
});

test("a session records its network mode and scored eligibility honestly, including when bridge is asked for", async (t) => {
  if (await skipWithoutContainer(t)) return;
  const fixture = await withFixture(t);

  const scored = await runAgentInPostgresResearchEnvironment(
    specFor(fixture, "record-default"),
    { command: "/bin/true", timeoutMs: 120_000 },
    { isolation: { buildViewsRoot: fixture.viewsRoot } }
  );
  assert.equal(scored.isolation.mode, "container");
  assert.equal(scored.isolation.isolated, true);
  assert.equal(scored.isolation.networkMode, "none");
  // Still not scored-eligible, and for a reason that is stated: the synthetic
  // fixture is a host build. Both halves have to hold for a scored trial.
  assert.equal(scored.isolation.buildScoredEligible, false);
  assert.equal(scored.isolation.scoredEligible, false);
  assert.match(scored.isolation.warning ?? "", /was not built by the pinned Linux build container/);
  assert.equal(/network/i.test(scored.isolation.warning ?? ""), false, "network must not be blamed when it was none");

  const bridged = await runAgentInPostgresResearchEnvironment(
    specFor(fixture, "record-bridge"),
    { command: "/bin/true", timeoutMs: 120_000 },
    { isolation: { buildViewsRoot: fixture.viewsRoot, network: "bridge" } }
  );
  assert.equal(bridged.isolation.networkMode, "bridge");
  assert.equal(bridged.isolation.scoredEligible, false, "a bridged run must never look scored");
  assert.match(bridged.isolation.warning ?? "", /docker network "bridge"/);
  assert.match(bridged.isolation.warning ?? "", /host\.docker\.internal/);
});

test("an unisolated development session is marked unscored on every axis", async (t) => {
  if (!(await hasFixtureToolchain())) {
    t.skip("git, make, tar or a C compiler probe is unavailable");
    return;
  }
  const fixture = await withFixture(t);
  const session = await runAgentInPostgresResearchEnvironment(
    specFor(fixture, "unisolated"),
    { command: process.execPath, args: ["-e", ""], timeoutMs: 120_000 },
    { isolation: { allowUnisolatedForDevelopment: true } }
  );
  assert.equal(session.isolation.mode, "unisolated-development");
  assert.equal(session.isolation.isolated, false);
  assert.equal(session.isolation.scoredEligible, false);
  assert.equal(session.isolation.networkMode, undefined, "an unconfined host process had the host's whole network");
  assert.match(session.isolation.warning ?? "", /not a scored trial/i);
});
