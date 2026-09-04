# Real-DSH derived research-agent image (#197 round-2 evidence).
#
# docker/postgres-research/Dockerfile deliberately ships no agent CLI - "which
# agent runs is the driver's choice". docker/postgres-research-agent-184 added
# mini-agent.mjs, a small stand-in that speaks an OpenAI-compatible API
# directly. This image instead installs the real thing HoneyRail is meant to
# run against a scored Historical PG trial: `@deepseek-ai/dsh`, pinned to the
# exact build docs/dsh-adapter-notes.md's spike verified (0.1.0-rc.7) and
# docker/tinytable-exam-room already ships for the tinytable track. Everything
# about the container boundary (mounts, non-root user, no baked network
# access beyond what isolation.restrictedEgress wires in) is unchanged from
# the base image.
#
# Build:
#   docker build -t honeyrail-postgres-research-agent-dsh:latest docker/postgres-research-agent-dsh

FROM honeyrail-postgres-research:latest

USER root

# Same undocumented-but-load-bearing check docker/tinytable-exam-room's
# Dockerfile runs: dsh 0.1.0-rc.7 fails to boot under a Node build that lacks
# zlib.createZstdDecompress (gained in newer Node builds; see
# docs/dsh-adapter-notes.md). The base image is already node:24-bookworm-slim,
# so this should always pass - it is here so a future base-image bump that
# regresses this fails at build time with a clear message, not at agent
# runtime with an opaque cordis plugin-load stack trace.
RUN node -e "if (typeof require('zlib').createZstdDecompress !== 'function') { throw new Error('Node build lacks zlib.createZstdDecompress - dsh will fail to boot, see docs/dsh-adapter-notes.md'); }"

ARG DSH_VERSION=0.1.0-rc.7
RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

# dsh 0.1.0-rc.7's composed `headless` profile loads a cordis-plugin-hmr entry
# that throws "--expose-internals is required for HMR service" unless the node
# process itself was launched with that flag - the installed `dsh` bin shim
# does not pass it and it cannot be set via NODE_OPTIONS. Same fix
# docker/tinytable-exam-room/Dockerfile already carries.
RUN dsh_entry="$(readlink -f /usr/local/bin/dsh)" \
    && rm /usr/local/bin/dsh \
    && printf '#!/bin/sh\nexec node --expose-internals "%s" "$@"\n' "$dsh_entry" > /usr/local/bin/dsh \
    && chmod +x /usr/local/bin/dsh \
    && dsh --version

USER pgresearch
WORKDIR /workspace/agent

ENTRYPOINT []
