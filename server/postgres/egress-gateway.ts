import { randomUUID } from "node:crypto";
import { runCommandSafe } from "../utils.js";
import { containerHardeningArgs } from "../containers/hardening.js";
import { PostgresResearchError } from "./research-environment.js";
import type { RunCommand } from "./runtime.js";

/**
 * The restricted-egress sidecar for a scored Historical PostgreSQL trial (#197).
 *
 * ## What was missing
 *
 * `DEFAULT_RESEARCH_NETWORK` is `"none"` and `unscoredReasons()` fails any
 * other network mode, which is exactly right for a scripted agent and leaves a
 * real model-backed one with nowhere to go: a DSH agent on `--network none`
 * cannot reach any model API, and a DSH agent on `bridge` is honestly recorded
 * `scoredEligible: false` (#194/#196). So there was no configuration at all in
 * which a real LLM-driven Historical PG trial could be scored. That gap is not
 * shared with the tinytable track, where mutants are generated and private:
 * Historical PG bugs are real, public, previously-fixed PostgreSQL defects, so
 * `https://www.postgresql.org` and `https://github.com/postgres/postgres` are
 * literally the answer key, one request away from any bridged container.
 *
 * ## The shape
 *
 *   agent container ── per-trial `--internal` network ──┐
 *                                                       ├── egress-gateway
 *                          bridge (real internet) ──────┘
 *
 * The per-trial network is created with `--internal`, which means docker gives
 * it no default outbound gateway at all. That is the load-bearing part, and it
 * is *structural*: the agent container is not permitted-but-filtered, it has no
 * route to write a packet onto. No NET_ADMIN, no iptables and no policy engine
 * is involved, which matters because the agent container is `--cap-drop=ALL`
 * and could not be given NET_ADMIN without weakening it.
 *
 * This module's own container is the single exception, and only because it is
 * additionally attached to `bridge` after creation. It runs
 * docker/postgres-egress-gateway's dumb one-upstream relay: the agent is handed
 * `DEEPSEEK_BASE_URL=http://egress-gateway:<port>` and speaks plain HTTP to it
 * over the internal network, while the gateway makes the real HTTPS call. No
 * TLS is intercepted, so nothing has to trust a HoneyRail CA.
 *
 * ## Failing closed
 *
 * `--internal` is verified with `docker network inspect` before any container
 * is started, and a network that does not report `Internal=true` aborts the
 * whole call. A trial must never proceed *believing* it is egress-restricted:
 * an unverifiable restriction is indistinguishable from none, and the isolation
 * record is what a grader keys on.
 *
 * This is deliberately not a `NetworkProvider`, a proxy-policy layer, or a
 * managed-environment abstraction - it is one sidecar with one upstream,
 * shaped after `scripts/tinytable-engine-service.ts`'s private-network pattern,
 * and it must not grow into one.
 */

export const DEFAULT_EGRESS_GATEWAY_IMAGE = "honeyrail-postgres-egress-gateway:latest";

/** DNS name the agent container resolves the gateway at, once both are on the internal network. */
export const EGRESS_GATEWAY_NETWORK_ALIAS = "egress-gateway";

export const DEFAULT_EGRESS_GATEWAY_PORT = 8787;
export const DEFAULT_EGRESS_GATEWAY_MEMORY = "256m";
export const DEFAULT_EGRESS_GATEWAY_PIDS_LIMIT = 64;
export const DEFAULT_EGRESS_GATEWAY_HEALTH_TIMEOUT_MS = 20_000;

/**
 * The network the gateway is additionally attached to for its outbound leg.
 * Docker's default bridge, rather than a second user-defined network, because
 * it is guaranteed to exist on every daemon and because the gateway's outbound
 * side needs no isolation of its own - the isolation this module provides is
 * on the *agent's* side of the sidecar.
 */
export const EGRESS_GATEWAY_OUTBOUND_NETWORK = "bridge";

/** Bound on each individual docker command this module issues. */
export const EGRESS_GATEWAY_COMMAND_TIMEOUT_MS = 60_000;

export class PostgresEgressGatewayError extends PostgresResearchError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresEgressGatewayError";
  }
}

export type EgressGatewayOptions = {
  /**
   * The one destination this gateway relays to, e.g. `https://api.deepseek.com`.
   * It is a base URL, never a full request URL, and it must not carry
   * credentials: DSH sends its key as an `authorization` header, so nothing in
   * this path needs a secret in a URL - and a secret here would end up in the
   * container's `docker inspect` output and in the isolation record.
   */
  upstreamUrl: string;
  image?: string;
  /** Container-internal port; never published to the host. */
  port?: number;
  memory?: string;
  pidsLimit?: number;
  healthTimeoutMs?: number;
  runCommand?: RunCommand;
};

export type EgressGatewayHandle = {
  containerName: string;
  /** The `--internal` network the agent container must join, and its only network. */
  internalNetworkName: string;
  /** What the agent resolves the gateway at; EGRESS_GATEWAY_NETWORK_ALIAS. */
  hostname: string;
  port: number;
  /**
   * `docker network inspect` confirmed `Internal=true` on the network above.
   * Always true on a handle this module returns - startEgressGateway() throws
   * rather than returning an unverified one - and carried on the handle anyway
   * so the isolation record records a *checked* fact rather than the fact that
   * a `--internal` flag was passed.
   */
  internalVerified: boolean;
  /** Removes the container and then the network. Idempotent, and never throws. */
  stop(): Promise<void>;
};

/**
 * The upstream's hostname alone - never the full URL, never a path, never any
 * query string. This is what goes into the trial's isolation record: a reviewer
 * needs to see *which* model provider the trial was allowed to reach, and
 * nothing more of the route than that.
 */
export function egressGatewayUpstreamHost(upstreamUrl: string): string {
  return parseUpstream(upstreamUrl).hostname;
}

function parseUpstream(upstreamUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(upstreamUrl || "").trim());
  } catch {
    throw new PostgresEgressGatewayError(
      `restrictedEgress.upstreamUrl must be an absolute http(s) URL (e.g. "https://api.deepseek.com"), got ${JSON.stringify(upstreamUrl)}`
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PostgresEgressGatewayError(
      `restrictedEgress.upstreamUrl must be http: or https:, got ${parsed.protocol} in ${JSON.stringify(upstreamUrl)}`
    );
  }
  if (parsed.username || parsed.password) {
    // Rejected rather than stripped: a caller who put a credential here
    // believes it is being sent, and silently dropping it would produce a
    // confusing 401 far downstream. It also must never reach `docker run`'s
    // argv, which is world-readable in `docker inspect`.
    throw new PostgresEgressGatewayError(
      "restrictedEgress.upstreamUrl must not embed credentials - the agent's model API key travels as a request header, " +
        "not in the gateway's upstream URL"
    );
  }
  return parsed;
}

/**
 * The `docker run` argv this module uses, exposed separately so a test can
 * assert the exact flags - the internal network, the DNS alias, the shared
 * hardening set, and that no host port is ever published - without a docker
 * daemon.
 */
export function buildEgressGatewayDockerArgs(
  options: EgressGatewayOptions,
  containerName: string,
  internalNetworkName: string
): string[] {
  const port = options.port ?? DEFAULT_EGRESS_GATEWAY_PORT;
  const args = containerHardeningArgs({
    containerName,
    // The gateway starts life on the *internal* network only. Its outbound leg
    // is added afterwards with `docker network connect` - a container can only
    // be given one `--network` at `run` time, and doing it in this order means
    // a failure between the two steps leaves a gateway that cannot reach the
    // internet, never an agent-side network that can.
    network: internalNetworkName,
    memory: options.memory ?? DEFAULT_EGRESS_GATEWAY_MEMORY,
    pidsLimit: options.pidsLimit ?? DEFAULT_EGRESS_GATEWAY_PIDS_LIMIT
  });
  // Detached: the gateway outlives the `docker run` client, which is the whole
  // point - it has to still be there while the agent container runs.
  args.splice(1, 0, "-d");
  args.push(
    "--network-alias",
    EGRESS_GATEWAY_NETWORK_ALIAS,
    "--pull=never",
    "-e",
    `UPSTREAM_URL=${options.upstreamUrl}`,
    "-e",
    `PORT=${port}`,
    options.image ?? DEFAULT_EGRESS_GATEWAY_IMAGE
  );
  return args;
}

/**
 * Polls readiness with `docker exec ... node -e`, hitting the gateway's own
 * loopback from inside its own namespace, rather than `fetch()`ing it from
 * this (host) process. A host-side fetch would need a route into a docker
 * network, which exists on native Linux dockerd and does *not* on Docker
 * Desktop, where containers live inside a VM - and here it could not work at
 * all, since the only network the gateway serves on is `--internal`.
 * `docker exec` talks to the daemon API instead, so it behaves identically on
 * both. The gateway image is `FROM node:24-bookworm-slim`, so `node` is always
 * present without adding curl to it.
 */
async function waitForHealth(
  containerName: string,
  port: number,
  timeoutMs: number,
  runCommand: RunCommand
): Promise<boolean> {
  const probe =
    `require("node:http").get({host:"127.0.0.1",port:${port},path:"/health",timeout:1000},` +
    `(r)=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCommand("docker", ["exec", containerName, "node", "-e", probe], { timeout: 10_000 });
    if (result.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Creates the per-trial `--internal` network, proves it is actually internal,
 * starts the gateway on it, gives *only the gateway* an outbound path, and
 * waits until it answers `/health`.
 *
 * Every failure path cleans up whatever it already created before throwing, so
 * a caller is never left holding a half-started container or a leaked network -
 * and, more importantly for this module, never left with a network it believes
 * is restricted when the daemon said otherwise.
 */
export async function startEgressGateway(options: EgressGatewayOptions): Promise<EgressGatewayHandle> {
  // Validated first, before any daemon call: a malformed upstream is a
  // configuration error, not a trial outcome, and must have no side effects.
  parseUpstream(options.upstreamUrl);

  const runCommand = options.runCommand ?? runCommandSafe;
  const suffix = randomUUID();
  const containerName = `honeyrail-pg-egress-gateway-${suffix}`;
  const internalNetworkName = `honeyrail-pg-egress-net-${suffix}`;
  const port = options.port ?? DEFAULT_EGRESS_GATEWAY_PORT;
  const image = options.image ?? DEFAULT_EGRESS_GATEWAY_IMAGE;

  const created = await runCommand("docker", ["network", "create", "--internal", internalNetworkName], {
    timeout: EGRESS_GATEWAY_COMMAND_TIMEOUT_MS
  });
  if (!created.ok) {
    throw new PostgresEgressGatewayError(
      `Could not create the restricted-egress network ${internalNetworkName}: ${(created.stderr || created.stdout).trim()}`
    );
  }

  let containerStarted = false;
  try {
    // The fail-closed check, and the reason it is here rather than folded into
    // the create above: `docker network create --internal` succeeding does not
    // by itself prove the daemon honoured the flag (an older/patched daemon, a
    // plugin driver that ignores it, a name that collided with a pre-existing
    // non-internal network). Ask the daemon what it actually built, and refuse
    // to run a trial on anything that does not answer exactly "true".
    const inspected = await runCommand(
      "docker",
      ["network", "inspect", "--format", "{{.Internal}}", internalNetworkName],
      { timeout: EGRESS_GATEWAY_COMMAND_TIMEOUT_MS }
    );
    const internal = inspected.ok ? inspected.stdout.trim() : "";
    if (internal !== "true") {
      throw new PostgresEgressGatewayError(
        `Refusing to run a restricted-egress trial: docker reported Internal=${JSON.stringify(internal)} for network ` +
          `${internalNetworkName} (expected "true"), so the agent's egress restriction could not be proven. ` +
          `${(inspected.stderr || "").trim()}`.trim()
      );
    }

    const started = await runCommand("docker", buildEgressGatewayDockerArgs(options, containerName, internalNetworkName), {
      timeout: EGRESS_GATEWAY_COMMAND_TIMEOUT_MS
    });
    if (!started.ok) {
      throw new PostgresEgressGatewayError(
        `Could not start the egress gateway from "${image}": ${(started.stderr || started.stdout).trim()}. ` +
          `Build it first: docker build -t ${image} docker/postgres-egress-gateway.`
      );
    }
    containerStarted = true;

    // The gateway's outbound leg, and the only one in this whole arrangement.
    // It happens after the container is running, so there is no window in
    // which the agent-facing network could have inherited a route.
    const connected = await runCommand(
      "docker",
      ["network", "connect", EGRESS_GATEWAY_OUTBOUND_NETWORK, containerName],
      { timeout: EGRESS_GATEWAY_COMMAND_TIMEOUT_MS }
    );
    if (!connected.ok) {
      throw new PostgresEgressGatewayError(
        `Could not attach the egress gateway to the "${EGRESS_GATEWAY_OUTBOUND_NETWORK}" network for its outbound leg: ` +
          `${(connected.stderr || connected.stdout).trim()}`
      );
    }

    const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_EGRESS_GATEWAY_HEALTH_TIMEOUT_MS;
    if (!(await waitForHealth(containerName, port, healthTimeoutMs, runCommand))) {
      const logs = await runCommand("docker", ["logs", containerName], { timeout: EGRESS_GATEWAY_COMMAND_TIMEOUT_MS });
      // gateway.mjs never logs request or response material (see its header),
      // so including its output here cannot leak a key or a prompt.
      throw new PostgresEgressGatewayError(
        `The egress gateway ${containerName} never became healthy within ${healthTimeoutMs}ms - ` +
          `logs:\n${logs.stdout}\n${logs.stderr}`
      );
    }

    let stopped = false;
    return {
      containerName,
      internalNetworkName,
      hostname: EGRESS_GATEWAY_NETWORK_ALIAS,
      port,
      internalVerified: true,
      async stop() {
        if (stopped) return;
        stopped = true;
        await teardown(containerName, internalNetworkName, runCommand);
      }
    };
  } catch (error) {
    await teardown(containerStarted ? containerName : null, internalNetworkName, runCommand);
    throw error;
  }
}

/**
 * Removes the container, then the network. Never throws: it runs from cleanup
 * paths (including `startEgressGateway()`'s own failure path) where throwing
 * would mask the original failure - the same rule
 * `PostgresRuntimeContainer.cleanup()` and `terminateResearchContainer()`'s
 * callers follow. Failures are reported on stderr rather than swallowed
 * silently, because a leaked per-trial docker network is an operator problem
 * that leaves no other trace.
 */
async function teardown(containerName: string | null, networkName: string, runCommand: RunCommand): Promise<void> {
  if (containerName) {
    const removed = await runCommand("docker", ["rm", "-f", containerName], { timeout: EGRESS_GATEWAY_COMMAND_TIMEOUT_MS });
    if (!removed.ok && !/no such (container|object)/i.test(removed.stderr || removed.stdout)) {
      console.error(`egress-gateway: could not remove container ${containerName}: ${(removed.stderr || removed.stdout).trim()}`);
    }
  }
  // Retried, briefly: the daemon can still hold the just-removed container's
  // endpoint for a moment, and `network rm` then fails with "has active
  // endpoints" - a race, not a real failure, and one that would otherwise leak
  // a network per trial.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const removed = await runCommand("docker", ["network", "rm", networkName], { timeout: EGRESS_GATEWAY_COMMAND_TIMEOUT_MS });
    if (removed.ok || /no such network/i.test(removed.stderr || removed.stdout)) return;
    if (attempt === 2) {
      console.error(`egress-gateway: could not remove network ${networkName}: ${(removed.stderr || removed.stdout).trim()}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
