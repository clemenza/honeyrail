/**
 * The fixed, neutral in-container paths shared by the PostgreSQL research
 * *build* container and the research *agent* container (#182).
 *
 * This is a leaf module on purpose. `RESEARCH_CONTAINER_PATHS.postgres` is
 * two things at once:
 *
 *   1. the `configure --prefix=` the scored build is compiled with
 *      (server/postgres/research-environment.ts), and
 *   2. the mount target the finished build is exposed at inside the agent
 *      container (server/postgres/agent-container.ts).
 *
 * Those two must be the *same string*, not two string literals that happen to
 * agree - if they ever drift, `pg_config` inside the agent container starts
 * reporting a path that does not exist there, and `LD_LIBRARY_PATH`/RUNPATH
 * resolution silently changes. Defining it once and importing it from both
 * sides makes that a compile-time fact.
 *
 * It lives here rather than in agent-container.ts because agent-container.ts
 * already imports from research-environment.ts. Importing the constant back
 * the other way would close an ESM cycle, and a `const` read at module scope
 * across a cycle is a temporal-dead-zone crash that depends on which module
 * the process happened to load first. A leaf module has no cycle to be in.
 */

/** Fixed, neutral in-container paths. These, not host paths, are what the agent is told. */
export const RESEARCH_CONTAINER_PATHS = {
  workspace: "/workspace",
  source: "/workspace/source",
  runtime: "/workspace/runtime",
  data: "/workspace/runtime/pgdata",
  socket: "/workspace/runtime/socket",
  log: "/workspace/runtime/postgres.log",
  scratch: "/workspace/agent",
  postgres: "/opt/honeyrail/postgres",
  bin: "/opt/honeyrail/postgres/bin",
  lib: "/opt/honeyrail/postgres/lib"
} as const;

/**
 * The prefix every PostgreSQL build is configured with, in every build mode.
 *
 * PostgreSQL bakes this string into the installation: `pg_config --bindir`,
 * `--libdir`, `--sharedir` and `--configure` report it verbatim, and it also
 * turns up in `Makefile.global`, `pkg-config` metadata, and inside compiled
 * binaries where `strings` finds it. Configuring with the real cache path
 * (`<cacheRoot>/<entryId>`) therefore handed a deterministic, recomputable
 * source identity to any agent that could run the `pg_config` it was given -
 * no filesystem escape required. Randomizing the *mount source* (see
 * agent-container.ts's createBuildView()) hides the cache path from
 * `/proc/self/mountinfo`; it cannot rewrite strings compiled in before the
 * mount ever existed.
 *
 * So the prefix is a constant that identifies nothing. The cache entry's real
 * host directory is still `<cacheRoot>/<entryId>`; `make install DESTDIR=...`
 * is what puts the files there without the binaries ever learning about it.
 */
export const NEUTRAL_INSTALL_PREFIX = RESEARCH_CONTAINER_PATHS.postgres;

/**
 * Where the PostgreSQL *runtime* sidecar sees the cluster it is running
 * (#182, fourth review). Same discipline as the other two: the server never
 * learns a host path, so nothing a host path could identify can end up in
 * PGDATA's `postgresql.conf`, in the server log, or in a `SHOW data_directory`
 * an agent runs.
 *
 * `postgres` is deliberately the *same* constant the build is compiled with
 * and the agent container mounts, so the binaries' RUNPATH resolves in the
 * runtime container with no library-path override at all - the runtime is
 * running the artifact at exactly the prefix it was configured for.
 *
 * `passwd`/`group` are the identity shim, not research data: PostgreSQL calls
 * getpwuid() on its effective uid before it does anything else, and an
 * arbitrary host uid (this repository's own developer machine reports
 * 71393735) has no entry in any stock image. The runner generates a
 * single-entry pair per trial and mounts them read-only. They contain the
 * trial's own uid/gid and nothing else; the agent container never sees them.
 */
export const RUNTIME_CONTAINER_PATHS = {
  runtime: "/runtime",
  data: "/runtime/pgdata",
  socket: "/runtime/socket",
  log: "/runtime/postgres.log",
  postgres: RESEARCH_CONTAINER_PATHS.postgres,
  bin: RESEARCH_CONTAINER_PATHS.bin,
  lib: RESEARCH_CONTAINER_PATHS.lib,
  passwd: "/etc/passwd",
  group: "/etc/group"
} as const;

/**
 * Where the build container sees its inputs and outputs. Neutral for the same
 * reason as the prefix: `configure` records its own path and its build
 * directory in `config.log`, `Makefile.global` and (for some paths) the
 * binaries, so the host's snapshot directory must not be what it sees.
 */
export const BUILDER_CONTAINER_PATHS = {
  /** The `.git`-free source snapshot, bind-mounted read-write (PostgreSQL builds in-tree). */
  source: "/build/source",
  /** `make install DESTDIR=` target: the finished tree lands at `<staging>/opt/honeyrail/postgres`. */
  staging: "/build/staging"
} as const;
