/**
 * The egress-gateway sidecar's whole program (#197).
 *
 * It is a *dumb* reverse proxy pinned to exactly one upstream, and the
 * dumbness is the security argument rather than a shortcut. It does not parse
 * paths, does not maintain an allowlist, does not implement CONNECT, and has
 * no configuration beyond `UPSTREAM_URL`: there is therefore no rule to get
 * wrong and no way to talk it into relaying somewhere else. The thing that
 * actually withholds the public internet from the agent is the `--internal`
 * docker network it shares with this container (see
 * server/postgres/egress-gateway.ts) - this process only decides *what the one
 * permitted destination is*, and "one, fixed, from an env var" is the smallest
 * decision that can be audited by reading forty lines.
 *
 * Consequences of that shape, deliberately:
 *
 * - The agent speaks plain HTTP to this container over the internal network,
 *   and this container speaks real HTTPS to the upstream. No TLS is terminated
 *   or forged in the agent's own trust store, so nothing has to be told to
 *   trust a HoneyRail CA and no certificate material exists anywhere in this
 *   path. The plaintext leg never leaves an `--internal` docker network.
 * - `/health` is answered locally, without touching the upstream: readiness
 *   polling must not depend on (or bill for) the model API being up, and must
 *   not fire a request at it every 200ms while the container starts.
 * - Nothing about a request or a response is logged. The `authorization`
 *   header on the relayed request is the agent's real model-API key, and a
 *   request body is the trial's prompt; both are exactly the material that
 *   must not end up in `docker logs`. Only startup and transport-level failure
 *   codes are printed.
 *
 * Zero npm dependencies, `node:http`/`node:https` only, so this file is the
 * complete audit surface - there is no lockfile and no transitive package that
 * could see the key in transit.
 */

import http from "node:http";
import https from "node:https";

const rawUpstream = String(process.env.UPSTREAM_URL || "").trim();
if (!rawUpstream) {
  console.error("egress-gateway: UPSTREAM_URL is required (e.g. https://api.deepseek.com)");
  process.exit(1);
}

let upstream;
try {
  upstream = new URL(rawUpstream);
} catch {
  console.error("egress-gateway: UPSTREAM_URL is not a valid absolute URL");
  process.exit(1);
}
if (upstream.protocol !== "https:" && upstream.protocol !== "http:") {
  console.error(`egress-gateway: UPSTREAM_URL must be http: or https:, got ${upstream.protocol}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 8787);
const transport = upstream.protocol === "https:" ? https : http;
const upstreamPort = upstream.port || (upstream.protocol === "https:" ? "443" : "80");
/**
 * A base path on the upstream is honoured by prefixing, so an upstream of
 * `https://example.test/v1` relays `/chat/completions` to `/v1/chat/completions`.
 * This is string concatenation, not routing: the incoming `req.url` is never
 * inspected, normalized or rewritten.
 */
const basePath = upstream.pathname === "/" ? "" : upstream.pathname.replace(/\/+$/, "");

const server = http.createServer((req, res) => {
  // Compared against the path only, so a `/health?x=1` probe still works while
  // a request whose path merely *contains* "health" is relayed like any other.
  const path = String(req.url ?? "/");
  if (path === "/health" || path.startsWith("/health?")) {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, upstreamHost: upstream.hostname }));
    return;
  }

  // Verbatim, minus `host`: the agent addressed *this* container by its
  // network alias, and that name means nothing to the upstream. Every other
  // header - `authorization`, `content-type`, `content-length` - is passed
  // through untouched and unread.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.Host;

  const proxied = transport.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstreamPort,
      method: req.method,
      path: `${basePath}${path}`,
      headers: { ...headers, host: upstream.host }
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  proxied.on("error", (error) => {
    // The error *code* only (ENOTFOUND, ECONNREFUSED, ...): enough to tell a
    // misconfigured upstream from a blocked one, and carrying nothing from the
    // request itself.
    console.error(`egress-gateway: upstream request failed (${error.code ?? "UNKNOWN"})`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "egress-gateway: upstream request failed", code: error.code ?? null }));
    req.resume();
  });

  // A client that hangs up must not leave an upstream request (and its billed
  // completion) running unattended.
  res.on("close", () => proxied.destroy());

  req.pipe(proxied);
});

server.listen(port, "0.0.0.0", () => {
  console.error(`egress-gateway: listening on 0.0.0.0:${port}, relaying to ${upstream.protocol}//${upstream.host}${basePath}`);
});
