# Linux *runtime* image for the PostgreSQL research environment (#182, fourth review).
#
# This is the third of three images, and the one that closes the last place
# where a scored trial still touched the host:
#
#   docker/postgres-research-builder  compiles PostgreSQL (Linux ELF, neutral prefix)
#   docker/postgres-research-runtime  runs that PostgreSQL - initdb, postmaster, psql
#   docker/postgres-research          runs the agent that investigates it
#
# Before this image existed, the build was containerized but
# PostgresResearchEnvironment still executed `initdb`/`pg_ctl`/`postgres`/`psql`
# as *host* processes. On macOS or Windows that is not a subtle inaccuracy: the
# artifact is a Linux ELF binary and the host kernel answers `exec format
# error`. Every "live cluster" test that passed on a developer machine was
# running the synthetic `#!/bin/sh` fixture, never a real server.
#
# What this image is, and is deliberately not:
#
# - It carries **no PostgreSQL**. The server under research is the exact
#   content-keyed build produced by the builder image, bind-mounted read-only
#   at /opt/honeyrail/postgres (the same neutral prefix it was configured
#   with, so RUNPATH and `pg_config` resolve without any library-path
#   override). Baking a PostgreSQL in here would mean a scored trial could
#   silently run a different server than the one it built.
# - It carries **no source mirror, no grader truth, no agent CLI**. It is a
#   server sidecar; the only thing that talks to it is the trial's Unix socket
#   directory and `docker exec` from the grader side.
# - It gets **no network** (`--network none`) and publishes **no host TCP
#   port**. The agent reaches the server exclusively through the shared
#   bind-mounted socket directory, which resolves through the mount namespace.
#
# The base matters for exactly one reason: ABI. The builder image is
# debian:bookworm (glibc 2.36) and the agent image is node:24-bookworm-slim
# (glibc 2.36), so this one is debian:bookworm-slim too. All three move
# together; server/postgres/runtime-container.ts additionally *checks* at run
# time that the runtime image's os/architecture match the build manifest's
# rather than trusting the tags to agree.
#
# Build:
#   docker build -t honeyrail-postgres-runtime:latest docker/postgres-research-runtime

FROM debian:bookworm-slim

# Nothing is installed. debian:bookworm-slim already provides everything the
# runtime needs: a shell for the inert PID 1, coreutils' `sleep`, and glibc
# plus libstdc++ for the binaries that get mounted in. The default configure
# profile is --without-readline --without-zlib --without-icu, so the mounted
# PostgreSQL has no library dependency the base image does not already
# satisfy - and an accidental new one fails loudly at ld.so time instead of
# being silently absorbed by a fatter image.
#
# Recorded in the runtime manifest and checked against the build manifest by
# server/postgres/runtime-container.ts, which reads the identity back out of
# the daemon rather than trusting this label.
LABEL org.honeyrail.role="postgres-research-runtime"

# No USER: the runner passes `--user <host uid>:<host gid>` so PGDATA, the
# socket directory and the server log are written as the host user that owns
# those bind mounts, and host-side cleanup can remove them afterwards.
#
# PostgreSQL refuses to run as root and calls getpwuid() on its effective uid
# before it does anything else, so an arbitrary host uid with no /etc/passwd
# entry fails with "could not look up effective user ID". The runner therefore
# bind-mounts a generated single-entry passwd/group pair over /etc/passwd and
# /etc/group; see runtime-container.ts's identity shim. Baking a fixed user in
# here would only work for hosts that happen to share its uid.
WORKDIR /runtime

ENTRYPOINT []
# Overridden by the runner with the inert long-running process it wants; a
# `docker run` of this image on its own should not sit there forever.
CMD ["/bin/sh", "-c", "echo 'honeyrail postgres research runtime image'; uname -m"]
