# Isolated agent image for the PostgreSQL research environment (#182).
#
# The only things a research agent can see are (a) what is baked into this
# image and (b) the six paths server/postgres/agent-container.ts bind-mounts:
# the .git-free source snapshot, PGDATA, the cluster's socket directory, the
# server log, its own scratch directory, and this trial's read-only view of
# the built PostgreSQL at /opt/honeyrail/postgres. Nothing else from the host
# is ever mounted in - not HoneyRail's attachment tree, not the grader-private
# directory, not the PostgreSQL source mirror or its .git, not the shared
# build cache, not another trial's files - so none of them exist inside this
# container's mount namespace at all.
#
# Deliberately minimal, and deliberately *not* carrying an agent CLI: which
# agent runs is the driver's choice. Point `isolation.image` at a derived
# image that adds one (`FROM honeyrail-postgres-research:latest`, then install
# it) rather than growing this one.
#
# The base matters for one non-obvious reason: PostgreSQL is built natively on
# the host and executed inside this container, so the image's libc must be
# able to run those binaries. bookworm (glibc 2.36) covers a Debian/Ubuntu
# build host of the same or older vintage. A musl host, or a host with a newer
# glibc than the image, needs a matching base - override with
# `isolation.image`.
#
# Build:
#   docker build -t honeyrail-postgres-research:latest docker/postgres-research

FROM node:24-bookworm-slim

# Node is here because agent CLIs are usually Node programs and a derived
# image should not have to reinstall a runtime. The shell utilities a research
# agent actually needs to grep a source tree and drive psql (sh, grep, find,
# sed, awk, diff) are all in the base already.

# Non-root by default; the runner overrides --user to the host uid/gid that
# owns the bind-mounted trial directories, so the agent can write into its
# scratch directory and the source snapshot without them being pre-chowned.
# $HOME is also overridden per-run to a tmpfs that dies with --rm.
RUN useradd --create-home --uid 10001 --shell /bin/bash pgresearch
USER pgresearch
WORKDIR /workspace/agent

ENTRYPOINT []
