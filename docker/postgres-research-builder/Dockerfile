# Linux build image for the PostgreSQL research environment's scored build path (#182).
#
# Why the scored build runs in here rather than on the host:
#
# 1. The compiled-in prefix has to be a constant. PostgreSQL bakes
#    `configure --prefix=` into the installation - `pg_config --bindir`,
#    `--libdir`, `--sharedir` and `--configure` report it verbatim, and it
#    also lands in Makefile.global, pkg-config metadata and inside binaries
#    where `strings` finds it. HoneyRail therefore always configures with the
#    neutral literal /opt/honeyrail/postgres and stages the real files into
#    the content-keyed cache with `make install DESTDIR=...`. That part is
#    build-mode independent; see server/postgres/container-paths.ts.
#
# 2. The binaries have to be runnable inside the research-agent container.
#    Building natively on the host produced Mach-O/PE binaries on
#    macOS/Windows, which a Linux container cannot execute - the ABI dead end
#    documented in docs/postgres-research-environment.md before this change.
#    Docker Desktop's containers are a Linux VM regardless of host OS, so a
#    build performed *in here* is a Linux build on every Docker host, and the
#    same installation the builder produced is what
#    docker/postgres-research/Dockerfile's container runs.
#
# The libc pairing is the reason both images are bookworm: this image builds
# against glibc 2.36 and the agent image (node:24-bookworm-slim) runs against
# glibc 2.36. Changing one without the other breaks the handoff, so the pair
# is versioned together through BUILD_PROFILE_VERSION and through the image
# identity that participates in the build cache key.
#
# Build:
#   docker build -t honeyrail-postgres-builder:latest docker/postgres-research-builder
#
# The runner (server/postgres/build-container.ts) invokes this image three
# times per cold build - configure, make, make install - with only the source
# snapshot and a staging directory bind-mounted, --network none, --cap-drop=ALL
# and an explicitly constructed environment. Nothing of the host environment
# is inherited.

FROM debian:bookworm-slim

# PostgreSQL's documented build requirements for a source tarball/checkout:
# a C compiler and make (build-essential), plus bison and flex, which a git
# checkout needs because the pre-generated gram.c/scan.c that ship in a
# release tarball are not in the repository. perl is required by a git
# checkout too (genbki.pl and friends run from the tree). ca-certificates is
# not installed and no network is available at build time - the source is
# bind-mounted in, never fetched.
#
# Deliberately *not* installed: libreadline-dev, zlib1g-dev, libicu-dev. The
# default profile is --without-readline --without-zlib --without-icu, so
# leaving them out keeps the image small and makes an accidental dependency
# on them fail loudly at configure time rather than silently change the
# binaries a cache entry holds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        bison \
        flex \
        perl \
        make \
    && rm -rf /var/lib/apt/lists/*

# Recorded in the build manifest and hashed into the cache key by
# server/postgres/build-container.ts, which reads it back out of a container
# started from this image rather than trusting this label.
LABEL org.honeyrail.role="postgres-research-builder"

# No USER here: the runner passes --user <host uid>:<host gid> so the staged
# installation is owned by the host user that owns the cache, and nothing
# needs chowning afterwards. $HOME is set to the per-run tmpfs.
WORKDIR /build/source

ENTRYPOINT []
CMD ["/bin/sh", "-c", "cc --version"]
