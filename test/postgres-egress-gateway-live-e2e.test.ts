import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { test, type TestContext } from "node:test";

import { runCommandSafe } from "../server/utils.js";
import { containerHardeningArgs } from "../server/containers/hardening.js";
import { DEFAULT_RESEARCH_IMAGE } from "../server/postgres/agent-container.js";
import {
  startEgressGateway,
  DEFAULT_EGRESS_GATEWAY_IMAGE,
  EGRESS_GATEWAY_NETWORK_ALIAS,
  type EgressGatewayHandle
} from "../server/postgres/egress-gateway.js";

/**
 * #197's required evidence, against a real docker daemon: the *composed* proof
 * that an agent container on a restricted-egress network can reach its model
 * API and nothing else.
 *
 * The daemon-free tests cannot give this. test/postgres-egress-gateway.test.ts
 * proves what argv the launcher asks docker for and what it does with each
 * failure; test/postgres-research-session.test.ts proves the wiring and the
 * isolation record. Neither one proves the thing the issue actually asks:
 *
 *   from inside a container on the gateway's network,
 *     http://egress-gateway:<port>/... reaches the configured upstream   (positive)
 *     https://www.postgresql.org/ does not                               (negative)
 *     https://github.com/postgres/postgres does not                      (negative)
 *
 * and those are the two public sources that would hand a Historical PG agent
 * the mailing-list thread and the fix commit for a real, previously-fixed
 * PostgreSQL defect.
 *
 * ## Running it
 *
 *   docker build -t honeyrail-postgres-egress-gateway:latest docker/postgres-egress-gateway
 *   docker build -t honeyrail-postgres-research:latest docker/postgres-research
 *   node --import tsx --test test/postgres-egress-gateway-live-e2e.test.ts
 *
 * The probe is the *real agent image*, launched through the same
 * `containerHardeningArgs()` the agent container uses, because this process -
 * running on the host, outside every docker network - has no standing to
 * assert reachability the agent's own container would actually have. On Docker
 * Desktop the host cannot even route into a user-defined network, and it
 * certainly cannot into an `--internal` one.
 *
 * ## No API key, and no real internet, on the positive leg
 *
 * The upstream is an in-process `node:http` stub on this host, serving one
 * canned JSON response - the shape of a model-API reply, without being one. So
 * this file needs no `DEEPSEEK_API_KEY`, spends nothing, and cannot flake on a
 * provider outage. The negative leg *does* address real public hostnames,
 * because "cannot reach the real postgresql.org" is precisely the claim.
 *
 * ## The manual smoke step this file deliberately is not
 *
 * A real DeepSeek call through a real gateway is a documented *manual* step,
 * not part of this automated file (see the non-goal above):
 *
 *   docker build -t honeyrail-postgres-egress-gateway:latest docker/postgres-egress-gateway
 *   # then, from a driver:
 *   #   startEgressGateway({ upstreamUrl: "https://api.deepseek.com" })
 *   #   runAgentInPostgresResearchEnvironment(spec, agent, {
 *   #     isolation: { restrictedEgress: {
 *   #       upstreamUrl: "https://api.deepseek.com",
 *   #       envVar: "HONEYRAIL_AGENT_LLM_BASE_URL"
 *   #     } }
 *   #   })
 *
 * `docker/postgres-research-agent-184/mini-agent.mjs` already reads
 * `HONEYRAIL_AGENT_LLM_BASE_URL` (defaulting to https://api.deepseek.com), so
 * pointing it at the gateway is the end-to-end, real-agent-shaped proof that
 * the model call itself survives the relay - the same mini-agent that produced
 * PR #194's `bridge` evidence, now on the restricted path. For DSH itself the
 * variable is `DEEPSEEK_BASE_URL`, which is `restrictedEgress`'s default.
 *
 * A skip here is not a pass: this file is #197's required negative evidence.
 */

/** A cold `docker run` per probe, plus deliberate multi-second connect timeouts. */
const PROBE_TIMEOUT_MS = 180_000;

const CANNED_RESPONSE = { id: "honeyrail-egress-canned", object: "chat.completion", choices: [] };
/** Proves the bytes came from the stub, not from a gateway-synthesized error page. */
const CANNED_SENTINEL = "HONEYRAIL-EGRESS-UPSTREAM-3f9c1ab7";

async function imageAvailable(image: string): Promise<boolean> {
  const result = await runCommandSafe("docker", ["image", "inspect", image], { timeout: 30_000 });
  return result.ok;
}

async function skipUnlessLiveEgressIsPossible(t: TestContext): Promise<boolean> {
  const daemon = await runCommandSafe("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20_000 });
  if (!daemon.ok || !daemon.stdout.trim()) {
    t.skip("no docker daemon is reachable - the --internal network, the gateway and the probe container all need one");
    return true;
  }
  for (const [image, dockerfile] of [
    [DEFAULT_EGRESS_GATEWAY_IMAGE, "docker/postgres-egress-gateway"],
    [DEFAULT_RESEARCH_IMAGE, "docker/postgres-research"]
  ] as const) {
    if (!(await imageAvailable(image))) {
      t.skip(`${image} is unavailable - build it: docker build -t ${image} ${dockerfile}`);
      return true;
    }
  }
  return false;
}

/**
 * Runs one `node -e` probe inside a throwaway container on `network`, launched
 * through the same hardening flags the agent container gets - so what this
 * proves is what the agent's own position proves, not what a privileged
 * helper container could.
 */
async function probe(network: string, script: string) {
  const args = [
    ...containerHardeningArgs({ containerName: `honeyrail-egress-probe-${randomUUID()}`, network }),
    "--pull=never",
    DEFAULT_RESEARCH_IMAGE,
    "node",
    "-e",
    script
  ];
  return runCommandSafe("docker", args, { timeout: PROBE_TIMEOUT_MS });
}

/**
 * The address a container on `bridge` can reach this host's stub server at.
 * `host.docker.internal` on Docker Desktop; the default bridge gateway or a
 * real interface address on native Linux dockerd. Probed rather than assumed,
 * because getting it wrong would look exactly like the gateway being broken.
 */
async function hostAddressReachableFromBridge(port: number): Promise<string | null> {
  const ipv4 = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  for (const candidate of ["host.docker.internal", "172.17.0.1", ...ipv4]) {
    const reach = await probe(
      "bridge",
      `require("node:http").get({host:${JSON.stringify(candidate)},port:${port},path:"/reach",timeout:5000},` +
        `(r)=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))`
    );
    if (reach.ok) return candidate;
  }
  return null;
}

/**
 * The negative probe. Every target is *attempted* - a test that never tried
 * proves nothing - and each one is reported individually so a failure says
 * which route opened. The raw TCP leg is there to distinguish "no route" from
 * "TLS/HTTP failed for some unrelated reason": on an `--internal` network,
 * docker's embedded resolver may still answer a public name, and it is the
 * missing route, not a missing DNS answer, that does the work.
 */
function unreachabilityProbe(directHost: string, directPort: number): string {
  return `
const https = require("node:https");
const net = require("node:net");
const targets = [
  { label: "https://www.postgresql.org/", host: "www.postgresql.org", path: "/" },
  { label: "https://github.com/postgres/postgres", host: "github.com", path: "/postgres/postgres" }
];
let reached = 0;
let tried = 0;
let pending = targets.length + 2;
function done() { if (--pending === 0) { console.log("tried=" + tried + " reached=" + reached); process.exit(reached === 0 ? 0 : 1); } }
function settler(label) {
  let settled = false;
  return (line) => { if (settled) return; settled = true; console.log(line); done(); };
}
for (const t of targets) {
  tried += 1;
  const settle = settler(t.label);
  const req = https.get({ host: t.host, path: t.path, timeout: 8000 }, (res) => {
    reached += 1;
    res.destroy();
    settle("REACHED " + t.label + " status=" + res.statusCode);
  });
  req.on("timeout", () => { req.destroy(); settle("blocked " + t.label + " (timeout)"); });
  req.on("error", (e) => settle("blocked " + t.label + " (" + (e.code || e.message) + ")"));
}
function tcp(label, host, port) {
  tried += 1;
  const settle = settler(label);
  const socket = net.connect({ host: host, port: port });
  socket.setTimeout(8000);
  socket.on("connect", () => { reached += 1; socket.destroy(); settle("REACHED " + label); });
  socket.on("timeout", () => { socket.destroy(); settle("blocked " + label + " (timeout)"); });
  socket.on("error", (e) => settle("blocked " + label + " (" + (e.code || e.message) + ")"));
}
tcp("tcp 1.1.1.1:443", "1.1.1.1", 443);
// The stub upstream itself, addressed directly rather than through the
// gateway: the agent must not be able to bypass the sidecar even for the one
// destination it is allowed to reach.
tcp("tcp direct-upstream", ${JSON.stringify(directHost)}, ${directPort});
`.trim();
}

test("a container on the gateway's --internal network reaches the upstream through the gateway and nothing else (#197)", async (t) => {
  if (await skipUnlessLiveEgressIsPossible(t)) return;

  // The stand-in model API: in-process, on this host, serving one canned reply.
  // Not the real internet, and no API key anywhere in this file.
  let upstreamRequests = 0;
  let sawAuthorizationHeader = false;
  const stub: Server = createServer((request, response) => {
    // `/reach` is hostAddressReachableFromBridge()'s own probe, which runs
    // before the gateway exists and is not part of the evidence.
    if (request.url !== "/reach") upstreamRequests += 1;
    if (request.headers.authorization) sawAuthorizationHeader = true;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...CANNED_RESPONSE, sentinel: CANNED_SENTINEL, path: request.url }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "0.0.0.0", resolve));
  const stubPort = (stub.address() as { port: number }).port;

  let gateway: EgressGatewayHandle | undefined;
  try {
    const hostAddress = await hostAddressReachableFromBridge(stubPort);
    if (!hostAddress) {
      t.skip(
        "no address for this host is reachable from a container on the docker bridge network (tried " +
          "host.docker.internal, 172.17.0.1 and this host's own IPv4 addresses), so the stub upstream cannot stand in " +
          "for a model API here"
      );
      return;
    }
    t.diagnostic(`stub upstream reachable from bridge at http://${hostAddress}:${stubPort}`);

    gateway = await startEgressGateway({ upstreamUrl: `http://${hostAddress}:${stubPort}` });

    // --- independent check: the network really is internal -----------------
    // Asserted straight from the daemon rather than trusting the handle's own
    // `internalVerified`, which is the thing under test.
    const inspected = await runCommandSafe(
      "docker",
      ["network", "inspect", "--format", "{{.Internal}}", gateway.internalNetworkName],
      { timeout: 30_000 }
    );
    assert.equal(inspected.ok, true, `docker network inspect failed: ${inspected.stderr}`);
    assert.equal(inspected.stdout.trim(), "true", "the per-trial network must be --internal");
    assert.equal(gateway.internalVerified, true);
    assert.equal(gateway.hostname, EGRESS_GATEWAY_NETWORK_ALIAS);

    // --- positive: the relay works end to end ------------------------------
    const relayed = await probe(
      gateway.internalNetworkName,
      `
const http = require("node:http");
http.get({
  host: ${JSON.stringify(EGRESS_GATEWAY_NETWORK_ALIAS)},
  port: ${gateway.port},
  path: "/v1/chat/completions",
  timeout: 15000,
  headers: { authorization: "Bearer not-a-real-key" }
}, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => { console.log("status=" + res.statusCode); console.log("body=" + body); process.exit(0); });
}).on("error", (e) => { console.log("error=" + (e.code || e.message)); process.exit(1); });
`.trim()
    );
    t.diagnostic(relayed.stdout);
    assert.equal(relayed.ok, true, `the agent-position container could not reach the gateway:\n${relayed.stdout}\n${relayed.stderr}`);
    assert.match(relayed.stdout, /status=200/);
    assert.match(relayed.stdout, new RegExp(CANNED_SENTINEL), "the response did not come from the stub upstream");
    // The path was relayed verbatim - the gateway interprets nothing.
    assert.match(relayed.stdout, /"path":"\/v1\/chat\/completions"/);
    assert.equal(upstreamRequests, 1, "exactly one request should have reached the stub upstream");
    assert.equal(sawAuthorizationHeader, true, "the authorization header must survive the relay - that is the API key");

    // --- negative: everything else is unreachable --------------------------
    const blocked = await probe(gateway.internalNetworkName, unreachabilityProbe(hostAddress, stubPort));
    t.diagnostic(blocked.stdout);
    assert.equal(
      blocked.ok,
      true,
      `a public destination was reachable from the agent's network:\n${blocked.stdout}\n${blocked.stderr}`
    );
    assert.match(blocked.stdout, /tried=4 reached=0/);
    assert.equal(blocked.stdout.includes("REACHED"), false);
    assert.match(blocked.stdout, /blocked https:\/\/www\.postgresql\.org\//);
    assert.match(blocked.stdout, /blocked https:\/\/github\.com\/postgres\/postgres/);
    // The stub upstream is unreachable *directly* too: the only route to it is
    // through the sidecar, which is what makes the gateway a chokepoint rather
    // than a convenience.
    assert.match(blocked.stdout, /blocked tcp direct-upstream/);
    assert.equal(upstreamRequests, 1, "the negative probe must not have reached the upstream by any route");

    // --- and the gateway itself really is the only other member ------------
    const members = await runCommandSafe(
      "docker",
      ["network", "inspect", "--format", "{{range .Containers}}{{.Name}} {{end}}", gateway.internalNetworkName],
      { timeout: 30_000 }
    );
    assert.equal(members.ok, true);
    assert.deepEqual(
      members.stdout.trim().split(/\s+/).filter(Boolean),
      [gateway.containerName],
      "nothing but the gateway may be left on the per-trial network"
    );
  } finally {
    await gateway?.stop();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
});

test("stop() removes the gateway container and its --internal network for real (#197)", async (t) => {
  if (await skipUnlessLiveEgressIsPossible(t)) return;

  // Any upstream at all: this test never sends a request, it only asserts the
  // lifecycle, and an unreachable upstream must not stop the gateway starting
  // (the gateway answers /health locally, on purpose).
  const gateway = await startEgressGateway({ upstreamUrl: "http://127.0.0.1:9/never-used" });
  let stopped = false;
  t.after(async () => {
    if (!stopped) await gateway.stop();
  });

  const running = await runCommandSafe("docker", ["inspect", "--format", "{{.State.Running}}", gateway.containerName], {
    timeout: 30_000
  });
  assert.equal(running.stdout.trim(), "true");

  await gateway.stop();
  stopped = true;

  const containerAfter = await runCommandSafe("docker", ["inspect", "--format", "{{.Id}}", gateway.containerName], {
    timeout: 30_000
  });
  assert.equal(containerAfter.ok, false, "the gateway container must be gone after stop()");
  const networkAfter = await runCommandSafe("docker", ["network", "inspect", gateway.internalNetworkName], { timeout: 30_000 });
  assert.equal(networkAfter.ok, false, "the per-trial network must be gone after stop() - one leaked network per trial otherwise");

  // Idempotent, the way every cleanup path in this codebase requires.
  await assert.doesNotReject(() => gateway.stop());
});
