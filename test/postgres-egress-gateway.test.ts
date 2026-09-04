import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { test } from "node:test";

import {
  buildEgressGatewayDockerArgs,
  egressGatewayUpstreamHost,
  startEgressGateway,
  DEFAULT_EGRESS_GATEWAY_IMAGE,
  DEFAULT_EGRESS_GATEWAY_PORT,
  EGRESS_GATEWAY_NETWORK_ALIAS,
  EGRESS_GATEWAY_OUTBOUND_NETWORK,
  PostgresEgressGatewayError
} from "../server/postgres/egress-gateway.js";
import type { RunCommand } from "../server/postgres/runtime.js";

/**
 * #197: the restricted-egress sidecar, proved without a docker daemon.
 *
 * Two halves, mirroring test/tinytable-engine-service.test.ts's split between
 * "what argv does this ask docker for" and "what does the lifecycle do":
 *
 * - `buildEgressGatewayDockerArgs()` is pure, so the exact flags are asserted
 *   directly - the internal network, the DNS alias the agent resolves, the
 *   shared hardening set, the two `-e` variables, and the absence of any
 *   published host port.
 * - `startEgressGateway()` takes an injectable `RunCommand`, so the whole
 *   create/verify/run/connect/health sequence - including every failure path's
 *   cleanup - is exercised against a scripted daemon rather than a real one.
 *
 * The fail-closed case is the one this file exists for. A network that does not
 * report `Internal=true` must abort the call before any container starts:
 * inability to *prove* egress restriction has to mean no trial, not a trial
 * that quietly reports itself scored.
 *
 * The real end-to-end proof (a probe container on the internal network reaching
 * a stub upstream through the gateway, and failing to reach
 * https://www.postgresql.org) lives in test/postgres-egress-gateway-live-e2e.ts
 * and needs a real daemon.
 */

const OK = { ok: true as const, stdout: "", stderr: "", code: 0 };

/** A scripted daemon: every step succeeds, and every invocation is recorded. */
function fakeDaemon(overrides: (args: string[]) => Awaited<ReturnType<RunCommand>> | undefined = () => undefined) {
  const calls: string[][] = [];
  const runCommand: RunCommand = async (command, args = []) => {
    calls.push([command, ...args]);
    const override = overrides(args);
    if (override) return override;
    if (args[0] === "network" && args[1] === "inspect") return { ...OK, stdout: "true\n" };
    if (args[0] === "run") return { ...OK, stdout: `${"a".repeat(64)}\n` };
    return OK;
  };
  return { calls, runCommand };
}

/** The docker subcommand shape of each recorded call, for order assertions. */
function shapes(calls: string[][]): string[] {
  return calls.map((call) => {
    const args = call.slice(1);
    if (args[0] === "network") return `network ${args[1]}`;
    if (args[0] === "exec") return "exec";
    return String(args[0]);
  });
}

// --- the argv, asserted exactly -------------------------------------------

test("buildEgressGatewayDockerArgs joins the given internal network at the alias the agent resolves", () => {
  const args = buildEgressGatewayDockerArgs({ upstreamUrl: "https://api.deepseek.com" }, "gw-container", "trial-internal-net");

  assert.equal(args[args.indexOf("--network") + 1], "trial-internal-net");
  assert.equal(args[args.indexOf("--network-alias") + 1], EGRESS_GATEWAY_NETWORK_ALIAS);
  assert.equal(args[args.indexOf("--name") + 1], "gw-container");
  assert.equal(args[0], "run");
  assert.equal(args[1], "-d", "the gateway must outlive the docker run client - it has to still be there while the agent runs");
});

test("buildEgressGatewayDockerArgs passes UPSTREAM_URL and PORT, and never publishes a host port", () => {
  const args = buildEgressGatewayDockerArgs(
    { upstreamUrl: "https://api.deepseek.com", port: 9911 },
    "gw-container",
    "trial-internal-net"
  );

  const envSpecs = args.filter((_value, index) => args[index - 1] === "-e");
  assert.ok(envSpecs.includes("UPSTREAM_URL=https://api.deepseek.com"));
  assert.ok(envSpecs.includes("PORT=9911"));
  assert.ok(!args.includes("-p"), "the gateway is reachable only over the per-trial internal network");
  assert.ok(!args.includes("--publish"));
  assert.ok(!args.includes("--publish-all"));
  assert.ok(!args.some((arg) => arg.startsWith("-p") && arg.length > 2));

  const defaults = buildEgressGatewayDockerArgs({ upstreamUrl: "http://stub.test" }, "c", "n");
  assert.ok(defaults.filter((_v, i) => defaults[i - 1] === "-e").includes(`PORT=${DEFAULT_EGRESS_GATEWAY_PORT}`));
});

test("buildEgressGatewayDockerArgs mounts nothing at all", () => {
  const args = buildEgressGatewayDockerArgs({ upstreamUrl: "https://api.deepseek.com" }, "gw", "net");

  // The gateway sees no host path whatsoever: it relays bytes and holds no
  // trial state, so a bind mount could only ever be a way to leak one.
  assert.deepEqual(args.filter((_value, index) => args[index - 1] === "-v"), []);
  assert.ok(!args.includes("--mount"));
});

test("buildEgressGatewayDockerArgs reuses the shared container hardening flags", () => {
  const { uid, gid } = userInfo();
  const args = buildEgressGatewayDockerArgs({ upstreamUrl: "https://api.deepseek.com" }, "gw", "net");

  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("--memory"));
  assert.equal(args[args.indexOf("--user") + 1], `${uid}:${gid}`);
  assert.equal(args[args.indexOf("--tmpfs") + 1].startsWith("/tmp:size="), true);
  // No NET_ADMIN and no iptables: the boundary is the --internal network, not
  // a capability granted back to a --cap-drop=ALL container.
  assert.ok(!args.some((arg) => /NET_ADMIN/i.test(arg)));
  assert.ok(!args.includes("--privileged"));
});

test("buildEgressGatewayDockerArgs ends at the image, never pulls, and honours overrides", () => {
  const args = buildEgressGatewayDockerArgs({ upstreamUrl: "https://api.deepseek.com" }, "gw", "net");
  assert.equal(args[args.length - 1], DEFAULT_EGRESS_GATEWAY_IMAGE, "the image is last - gateway.mjs takes no arguments");
  assert.ok(args.includes("--pull=never"), "a scored trial must not depend on a remote registry");

  const custom = buildEgressGatewayDockerArgs(
    { upstreamUrl: "https://api.deepseek.com", image: "custom-gateway:tag", memory: "128m", pidsLimit: 16 },
    "gw",
    "net"
  );
  assert.equal(custom[custom.length - 1], "custom-gateway:tag");
  assert.equal(custom[custom.indexOf("--memory") + 1], "128m");
  assert.equal(custom[custom.indexOf("--pids-limit") + 1], "16");
});

// --- the upstream host recorded in the isolation record --------------------

test("egressGatewayUpstreamHost records the hostname only, and rejects anything that could carry a secret", () => {
  assert.equal(egressGatewayUpstreamHost("https://api.deepseek.com"), "api.deepseek.com");
  assert.equal(egressGatewayUpstreamHost("https://api.deepseek.com/v1/beta?k=1"), "api.deepseek.com");
  assert.equal(egressGatewayUpstreamHost("http://host.docker.internal:8080/"), "host.docker.internal");

  assert.throws(
    () => egressGatewayUpstreamHost("https://user:sk-secret@api.deepseek.com"),
    (error: Error) => error instanceof PostgresEgressGatewayError && /must not embed credentials/.test(error.message)
  );
  assert.throws(
    () => egressGatewayUpstreamHost("api.deepseek.com"),
    (error: Error) => error instanceof PostgresEgressGatewayError && /absolute http\(s\) URL/.test(error.message)
  );
  assert.throws(
    () => egressGatewayUpstreamHost("file:///etc/passwd"),
    (error: Error) => error instanceof PostgresEgressGatewayError && /must be http: or https:/.test(error.message)
  );
});

// --- the lifecycle, against a scripted daemon ------------------------------

test("startEgressGateway creates an internal network, verifies it, starts the gateway, and only then gives it an outbound leg", async () => {
  const { calls, runCommand } = fakeDaemon();

  const handle = await startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand });

  assert.equal(handle.hostname, EGRESS_GATEWAY_NETWORK_ALIAS);
  assert.equal(handle.port, DEFAULT_EGRESS_GATEWAY_PORT);
  assert.equal(handle.internalVerified, true);
  assert.ok(handle.containerName.startsWith("honeyrail-pg-egress-gateway-"));
  assert.ok(handle.internalNetworkName.startsWith("honeyrail-pg-egress-net-"));

  assert.deepEqual(shapes(calls), ["network create", "network inspect", "run", "network connect", "exec"]);
  assert.deepEqual(calls[0], ["docker", "network", "create", "--internal", handle.internalNetworkName]);
  assert.deepEqual(calls[1], ["docker", "network", "inspect", "--format", "{{.Internal}}", handle.internalNetworkName]);
  // The outbound leg is added after the container is already running on the
  // internal network, so there is no window in which the agent-facing network
  // could have inherited a route.
  assert.deepEqual(calls[3], ["docker", "network", "connect", EGRESS_GATEWAY_OUTBOUND_NETWORK, handle.containerName]);
  assert.equal(calls[2][calls[2].indexOf("--network") + 1], handle.internalNetworkName);
  // Readiness is proved from inside the container's own namespace - a host
  // fetch could not reach an --internal network at all.
  assert.equal(calls[4][2], handle.containerName);
  assert.equal(calls[4][3], "node");
});

test("startEgressGateway fails closed when docker does not report the network as internal, and starts no container", async () => {
  const { calls, runCommand } = fakeDaemon((args) =>
    args[0] === "network" && args[1] === "inspect" ? { ...OK, stdout: "false\n" } : undefined
  );

  await assert.rejects(
    startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand }),
    (error: Error) =>
      error instanceof PostgresEgressGatewayError &&
      /Refusing to run a restricted-egress trial/.test(error.message) &&
      /Internal="false"/.test(error.message)
  );

  // The whole point: no gateway, no agent, and no leaked network.
  assert.equal(shapes(calls).includes("run"), false, "no container may start on a network that was not proven internal");
  assert.deepEqual(shapes(calls), ["network create", "network inspect", "network rm"]);
});

test("startEgressGateway also fails closed when the inspect itself fails, rather than assuming the flag took", async () => {
  const { calls, runCommand } = fakeDaemon((args) =>
    args[0] === "network" && args[1] === "inspect"
      ? { ok: false as const, stdout: "", stderr: "Error: No such network", code: 1 }
      : undefined
  );

  await assert.rejects(
    startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand }),
    (error: Error) => error instanceof PostgresEgressGatewayError && /could not be proven/.test(error.message)
  );
  assert.equal(shapes(calls).includes("run"), false);
});

test("startEgressGateway validates the upstream before touching the daemon at all", async () => {
  const { calls, runCommand } = fakeDaemon();

  await assert.rejects(
    startEgressGateway({ upstreamUrl: "not-a-url", runCommand }),
    (error: Error) => error instanceof PostgresEgressGatewayError && /absolute http\(s\) URL/.test(error.message)
  );
  assert.deepEqual(calls, [], "a malformed upstream is a configuration error and must have no side effects");
});

test("startEgressGateway cleans up the network when the container cannot start, and names the build that fixes it", async () => {
  const { calls, runCommand } = fakeDaemon((args) =>
    args[0] === "run" ? { ok: false as const, stdout: "", stderr: "Unable to find image locally", code: 125 } : undefined
  );

  await assert.rejects(
    startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand }),
    (error: Error) =>
      error instanceof PostgresEgressGatewayError &&
      /Could not start the egress gateway/.test(error.message) &&
      /docker build -t honeyrail-postgres-egress-gateway:latest docker\/postgres-egress-gateway/.test(error.message)
  );
  assert.deepEqual(shapes(calls), ["network create", "network inspect", "run", "network rm"]);
});

test("startEgressGateway removes the container and the network when the outbound leg cannot be attached", async () => {
  const { calls, runCommand } = fakeDaemon((args) =>
    args[0] === "network" && args[1] === "connect"
      ? { ok: false as const, stdout: "", stderr: "Error response from daemon: network bridge not found", code: 1 }
      : undefined
  );

  await assert.rejects(
    startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand }),
    (error: Error) => error instanceof PostgresEgressGatewayError && /outbound leg/.test(error.message)
  );
  assert.deepEqual(shapes(calls), ["network create", "network inspect", "run", "network connect", "rm", "network rm"]);
});

test("startEgressGateway reports the gateway's own logs when it never becomes healthy, and cleans up", async () => {
  const { calls, runCommand } = fakeDaemon((args) => {
    if (args[0] === "exec") return { ok: false as const, stdout: "", stderr: "", code: 1 };
    if (args[0] === "logs") return { ...OK, stdout: "egress-gateway: UPSTREAM_URL is required\n" };
    return undefined;
  });

  await assert.rejects(
    startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand, healthTimeoutMs: 50 }),
    (error: Error) =>
      error instanceof PostgresEgressGatewayError &&
      /never became healthy within 50ms/.test(error.message) &&
      /UPSTREAM_URL is required/.test(error.message)
  );
  const seen = shapes(calls);
  assert.equal(seen[seen.length - 2], "rm");
  assert.equal(seen[seen.length - 1], "network rm");
});

test("stop() removes the container then the network, and a second call is a no-op", async () => {
  const { calls, runCommand } = fakeDaemon();
  const handle = await startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand });
  const beforeStop = calls.length;

  await handle.stop();
  assert.deepEqual(
    calls.slice(beforeStop),
    [
      ["docker", "rm", "-f", handle.containerName],
      ["docker", "network", "rm", handle.internalNetworkName]
    ],
    "the container has to go first - a network with an attached endpoint cannot be removed"
  );

  await handle.stop();
  assert.equal(calls.length, beforeStop + 2, "stop() must be idempotent - cleanup paths call it more than once");
});

test("stop() never throws, even when the daemon refuses every removal", async () => {
  const { runCommand } = fakeDaemon((args) =>
    args[0] === "rm" || (args[0] === "network" && args[1] === "rm")
      ? { ok: false as const, stdout: "", stderr: "Error response from daemon: daemon unavailable", code: 1 }
      : undefined
  );
  const handle = await startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand });

  // Cleanup runs from paths where throwing would mask the original failure -
  // the same rule PostgresRuntimeContainer.cleanup() follows. The failure is
  // reported on stderr instead, which the session's own retention message
  // complements.
  await assert.doesNotReject(() => handle.stop());
});

test("stop() retries the network removal past the daemon's endpoint-release race", async () => {
  let networkRmAttempts = 0;
  const { runCommand } = fakeDaemon((args) => {
    if (args[0] === "network" && args[1] === "rm") {
      networkRmAttempts += 1;
      if (networkRmAttempts === 1) {
        return { ok: false as const, stdout: "", stderr: "error while removing network: has active endpoints", code: 1 };
      }
    }
    return undefined;
  });
  const handle = await startEgressGateway({ upstreamUrl: "https://api.deepseek.com", runCommand });

  await handle.stop();
  assert.equal(networkRmAttempts, 2, "a transient 'has active endpoints' must be retried, not left as a leaked network");
});
