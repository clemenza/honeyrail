# Egress-gateway sidecar for restricted-egress Historical PostgreSQL trials (#197).
#
# The problem this closes: the scored default for a research agent is
# `--network none` (server/postgres/agent-container.ts's
# DEFAULT_RESEARCH_NETWORK), which is exactly right for a scripted agent and
# fatal for a real model-backed one - a DSH agent with no network stack has no
# route to any model API at all, so before this image there was *no*
# configuration in which a real LLM-driven Historical PG trial could report
# `scoredEligible: true`. Simply switching the agent to `bridge` is not the
# answer either: Historical PG bugs are real, previously-fixed PostgreSQL
# defects, so unrestricted outbound access puts the mailing-list thread and the
# fix commit one `curl` away from the agent.
#
# The shape (see server/postgres/egress-gateway.ts for the launcher):
#
#   agent container ── --internal per-trial network ──┐
#                                                     ├── egress-gateway
#                       bridge (real internet) ───────┘
#
# The agent joins ONLY the `--internal` network, which docker gives no default
# outbound gateway - a structural property of the network, not a policy this
# image enforces. This container joins that same network (at the DNS alias
# `egress-gateway`) *and* `bridge`, so it is the only member with a route out.
# The agent is pointed at it with `DEEPSEEK_BASE_URL=http://egress-gateway:<port>`,
# which @deepseek-ai/dsh-llm-deepseek already honours.
#
# What this image is deliberately not: a policy engine. gateway.mjs relays every
# request verbatim to one fixed UPSTREAM_URL and interprets nothing, so there is
# no allowlist to bypass and no path-matching bug to find. It is also not a
# general proxy - no CONNECT, no second upstream, no per-request target.
#
# Node, not a stock proxy image, for two reasons: the whole program is one
# dependency-free stdlib file that a reviewer can read end to end, and the
# readiness probe (`docker exec ... node -e ...`, the Docker Desktop-safe
# pattern from scripts/tinytable-engine-service.ts) needs an interpreter in the
# image rather than an added curl.
#
# Build:
#   docker build -t honeyrail-postgres-egress-gateway:latest docker/postgres-egress-gateway

FROM node:24-bookworm-slim

# Zero npm dependencies by design - there is no package.json and no lockfile,
# because every byte of code in this container sees the agent's model-API key
# in transit. `node:24-bookworm-slim` already provides the only two modules
# gateway.mjs imports (node:http, node:https).
WORKDIR /app
COPY gateway.mjs /app/gateway.mjs

# Non-root by default. The launcher additionally passes `--user <host uid:gid>`
# via containerHardeningArgs(); this container bind-mounts nothing, so the uid
# it ends up running as only has to be able to bind a high port and read /app,
# which any uid can.
RUN useradd --create-home --uid 10003 --shell /usr/sbin/nologin egressgateway
USER egressgateway

# No EXPOSE: the port is never published to the host - it is reachable only
# from the per-trial `--internal` network. UPSTREAM_URL and PORT are supplied
# with `-e` by server/postgres/egress-gateway.ts; there is no default upstream
# baked in, and gateway.mjs exits rather than guessing one.
ENTRYPOINT ["node", "/app/gateway.mjs"]
