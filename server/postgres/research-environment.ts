import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, homedir, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { nowIso, runCommandSafe } from "../utils.js";
import {
  DEFAULT_BUILDER_IMAGE,
  probeBuildContainerToolchain,
  resolveBuilderImageIdentity,
  runBuildContainerStep,
  type BuilderImageIdentity
} from "./build-container.js";
import { BUILDER_CONTAINER_PATHS, NEUTRAL_INSTALL_PREFIX } from "./container-paths.js";
import {
  BUILD_COMPLETE_MARKER,
  BUILD_COMPLETE_MARKER_ID,
  createBuildView,
  defaultBuildViewsRoot,
  removeBuildView,
  type BuildView
} from "./build-view.js";
import {
  alignRuntimeOwnership,
  resolveRuntimeImageIdentity,
  runtimeUserIds,
  writeRuntimeIdentityFiles,
  HOST_RUNTIME_UNSCORED_REASON,
  PostgresRuntimeContainer,
  type PostgresRuntimeRecord
} from "./runtime-container.js";
import type { ContainerImageIdentity } from "./image-identity.js";
import {
  allocatePort,
  isAddressInUseFailure,
  psqlArgs,
  waitForPostgresReady,
  type PostgresReadiness,
  type RunCommand
} from "./runtime.js";

/**
 * PostgreSQL research environment (#179).
 *
 * Given an exact PostgreSQL source ref in a local repository/mirror, this
 * materializes an immutable `.git`-free snapshot of that ref, builds it into
 * a correctly-keyed shared build cache, and stands up one isolated ephemeral
 * cluster (own port, own PGDATA, own socket dir, own log) that an agent - or
 * the caller - can run arbitrary SQL and shell experiments against, with
 * cleanup guaranteed on success, throw, or timeout.
 *
 * It is deliberately bug-agnostic: nothing here knows which bug is being
 * hunted, and nothing that identifies a bug (real identity, fixed ref,
 * canonical reproducer) is ever derived from or written by this module. The
 * only thing that varies between "buggy" and "fixed" is the caller's `ref`.
 *
 * This module lays out the trees; it does not confine anything:
 *
 *   <root>                  research surface: source/, pgdata/, postgres.log
 *   <root>-private          grader-only: build logs (configure/make)
 *   <cacheRoot>/<entryId>   grader-only: built binaries plus a completion
 *                           marker; an agent is shown a per-trial view of it
 *
 * Source ref, resolved commit, source tree hash and build cache key are
 * written into none of those. They live only in the manifests
 * materializePostgresSource()/buildPostgres() return, which the caller
 * records on the grader side.
 *
 * That is minimization, not enforcement: a process running as the same OS
 * user could read any of it. The boundary that actually holds is the
 * container ./agent-container.ts launches an agent in, which bind-mounts the
 * research surface and nothing else. Callers driving this module directly
 * (the `postgres-research` executor, tests, scripts) are grader-side code and
 * are trusted with all of it.
 *
 * ## Where the server runs (#182, fourth review)
 *
 * In the scored path - `build.mode: "container"` - nothing PostgreSQL is
 * executed by the host at all. The build happens in the builder container and
 * the *cluster* happens in a runtime sidecar container
 * (./runtime-container.ts): `initdb`, `pg_ctl`, the postmaster and the
 * grader's own `psql` are all `docker exec`s into it, and the agent container
 * reaches the same server over the socket directory both bind-mount from the
 * same host path. This class orchestrates docker and records evidence; it
 * executes no Linux ELF binary on a macOS or Windows host, which is what made
 * the previous round's "live cluster" claims untrue off Linux.
 *
 * `build.mode: "host"` keeps the original host-process lifecycle for local
 * development on a machine without docker. It is permanently un-scored, on
 * both axes: `PostgresBuildManifest.scoredEligible` and
 * `PostgresRuntimeRecord.scoredEligible` are both false.
 */

/**
 * Bumped when the build recipe itself changes; participates in the cache key.
 *
 * v2: the neutral `--prefix=/opt/honeyrail/postgres` plus DESTDIR-subtree
 * publication, and the containerized build mode. Every v1 entry was compiled
 * with its own cache path as the prefix and must never be reused.
 */
export const BUILD_PROFILE_VERSION = "pg-research-env-v2";

/**
 * Where `configure`/`make`/`make install` run.
 *
 * - `container` (default, and the only **scored** mode): inside the pinned
 *   Linux build image, `docker/postgres-research-builder/Dockerfile`. This is
 *   what makes the produced binaries executable inside the research-agent
 *   container on any Docker host - including macOS and Windows, where Docker
 *   Desktop's containers are a Linux VM and a natively built Mach-O/PE binary
 *   could not run at all.
 * - `host`: `configure`/`make` run as ordinary host processes, as v0 did.
 *   Kept for local development and for hosts without a docker daemon. It is
 *   **permanently un-scored**: a manifest produced this way carries
 *   `scoredEligible: false`, exactly the way
 *   `isolation.allowUnisolatedForDevelopment` marks an unisolated agent run.
 */
export type PostgresBuildMode = "container" | "host";

export const DEFAULT_BUILD_MODE: PostgresBuildMode = "container";

export const HOST_BUILD_UNSCORED_REASON =
  'This build ran as a host process (build.mode: "host"). Its binaries carry the host toolchain and ABI ' +
  "rather than the pinned Linux build image's, so they are not the artifact a scored trial's agent container " +
  "executes. Development only - not a scored trial.";

function defaultBuildMode(): PostgresBuildMode {
  const raw = String(process.env.HONEYRAIL_PG_BUILD_MODE || "").trim();
  return raw === "host" || raw === "container" ? raw : DEFAULT_BUILD_MODE;
}

/**
 * The completion marker (and the per-trial build view that deliberately
 * excludes it) live in ./build-view.ts, which both this module and
 * agent-container.ts import. Re-exported here because this is where callers
 * have always imported it from.
 */
export { BUILD_COMPLETE_MARKER, BUILD_COMPLETE_MARKER_ID } from "./build-view.js";

/**
 * How many candidate ports a single start() will try. Bounded recovery from
 * the allocatePort() TOCTOU window, not a reservation subsystem: three
 * consecutive collisions on kernel-assigned ephemeral ports means something
 * is wrong that retrying will not fix.
 */
export const START_PORT_ATTEMPTS = 3;

/**
 * Minimal profile: no readline (interactive niceties), no zlib (compression),
 * no ICU (a heavyweight external build dependency). contrib and docs are not
 * built at all - `make` at the top level builds the server plus the standard
 * client programs, which is everything a repro needs.
 */
export const DEFAULT_CONFIGURE_ARGS = ["--without-readline", "--without-zlib", "--without-icu"] as const;

export const DEFAULT_INITDB_ARGS = ["-A", "trust", "-U", "postgres", "--no-locale"] as const;

/**
 * The ambient variables HoneyRail intentionally lets through into
 * `configure`/`make` - and therefore has to hash into the cache key, because
 * every one of them changes the binaries that come out (`CFLAGS=-O0` and
 * `CFLAGS=-O2` are not interchangeable builds).
 *
 * This is a declared pass-through list, not a hermetic toolchain
 * fingerprint: the build still inherits the rest of the operator's
 * environment (PATH above all), so a machine-level toolchain change that
 * none of these variables mentions is still invisible to the key. The
 * compiler identity in the key covers the common case of that.
 */
export const BUILD_ENV_VARS = [
  "AR",
  "CC",
  "CFLAGS",
  "CPP",
  "CPPFLAGS",
  "CXX",
  "CXXFLAGS",
  "LD",
  "LDFLAGS",
  "LIBS",
  "MACOSX_DEPLOYMENT_TARGET",
  "MAKEFLAGS",
  "NM",
  "PKG_CONFIG",
  "PKG_CONFIG_PATH",
  "RANLIB",
  "SDKROOT",
  "STRIP"
] as const;

/**
 * Prefixes whose every ambient variable is passed through and hashed.
 * `pgac_cv_*` is autoconf's result cache: setting one (e.g. the documented
 * `pgac_cv_avx2_support=no` workaround) overrides a configure probe and
 * genuinely changes the resulting binaries, so it must key the cache too.
 */
export const BUILD_ENV_PREFIXES = ["pgac_cv_"] as const;

/**
 * The subset of `ambient` (plus explicit `overrides`) that participates in
 * the build: recorded in the build manifest and hashed into the cache key.
 * Empty values are dropped so "unset" and "set to empty" key identically,
 * which is what configure sees anyway.
 */
export function resolveBuildEnv(
  ambient: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {}
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const take = (key: string, value: string | undefined) => {
    const text = String(value ?? "");
    if (text) resolved[key] = text;
  };
  for (const key of BUILD_ENV_VARS) take(key, ambient[key]);
  for (const [key, value] of Object.entries(ambient)) {
    if (BUILD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) take(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) take(key, value);
  return Object.fromEntries(Object.entries(resolved).sort(([left], [right]) => left.localeCompare(right)));
}

export type PostgresSourceSpec = {
  /**
   * Path of a local PostgreSQL git repository or mirror the driver has
   * already populated. This module never fetches over the network: a scored
   * trial must not depend on remote availability, and a fetch is also the
   * easiest way to accidentally pull history past the ref.
   */
  repoPath: string;
  /** Exact ref (commit sha, tag, or branch). Resolved once, recorded, never guessed. */
  ref: string;
};

export type PostgresBuildSpec = {
  /**
   * Where the build runs. Defaults to `container` (the scored path), or to
   * `HONEYRAIL_PG_BUILD_MODE` when it names a valid mode. See
   * PostgresBuildMode.
   */
  mode?: PostgresBuildMode;
  /** Build image for `mode: "container"`. Defaults to DEFAULT_BUILDER_IMAGE. */
  builderImage?: string;
  /** `--memory` for the build container. */
  builderMemory?: string;
  /** Defaults to DEFAULT_CONFIGURE_ARGS. Order is significant to the cache key. */
  configureArgs?: readonly string[];
  jobs?: number;
  /** Shared across environments; defaults to ~/.honeyrail/pg-research-build-cache. */
  cacheRoot?: string;
  /**
   * Explicit build-environment overrides layered on top of the ambient
   * BUILD_ENV_VARS pass-through. Applied to configure/make *and* hashed into
   * the cache key, so two profiles that differ only here cannot share a
   * cache entry.
   */
  env?: Record<string, string>;
  /** Where configure/make logs are written. Grader-private; never inside the agent-visible root. */
  logDir?: string;
};

export type PostgresResearchTimeouts = {
  git: number;
  configure: number;
  make: number;
  install: number;
  initdb: number;
  control: number;
  psql: number;
};

export const DEFAULT_TIMEOUTS: PostgresResearchTimeouts = {
  git: 600_000,
  configure: 900_000,
  make: 3_600_000,
  install: 600_000,
  initdb: 120_000,
  control: 120_000,
  psql: 120_000
};

export type PostgresResearchSpec = {
  /**
   * The environment's agent-visible root: the snapshot (`source/`), PGDATA
   * (`pgdata/`) and the server log (`postgres.log`) live here and nothing
   * else does. Every path `agentEnvironment()` hands out is inside it.
   *
   * HoneyRail writes no source/build identity anywhere in this tree, and the
   * caller must not put grader-private material in it or in its parent - see
   * the eval-isolation contract on `agentEnvironment()`.
   */
  root: string;
  /**
   * Grader-private directory for this environment's build logs. Must be
   * outside `root`; defaults to `<root>-private`.
   */
  privateDir?: string;
  source: PostgresSourceSpec;
  build?: PostgresBuildSpec;
  /**
   * The PostgreSQL runtime sidecar. Only consulted in `build.mode:
   * "container"`; a host build keeps the host-process lifecycle, which has no
   * runtime image.
   */
  runtime?: PostgresRuntimeSpec;
  /**
   * Where this trial's randomized view of the cached build is created. The
   * *same* view is mounted read-only into the runtime container and into the
   * agent container, so neither ever sees `<cacheRoot>/<entryId>` in its own
   * mount table. Defaults next to the build cache.
   */
  buildViewsRoot?: string;
  initdbArgs?: readonly string[];
  runCommand?: RunCommand;
  timeouts?: Partial<PostgresResearchTimeouts>;
  /** Free-form label carried into manifests, e.g. a trial id. Never a bug identity. */
  label?: string;
};

export type PostgresRuntimeSpec = {
  /** Runtime image for the PostgreSQL sidecar. Defaults to DEFAULT_RUNTIME_IMAGE. */
  image?: string;
  memory?: string;
  pidsLimit?: number;
  tmpfsSize?: string;
};

export type PostgresSourceManifest = {
  repoPath: string;
  ref: string;
  resolvedCommit: string;
  /** git tree object id of the snapshot - a content hash of exactly what was materialized. */
  sourceHash: string;
  sourceDir: string;
  /** Always false: the invariant this environment exists to guarantee. */
  gitDirPresent: boolean;
  materializedAt: string;
  durationMs: number;
};

export type PostgresCompilerIdentity = {
  command: string;
  version: string;
  target: string;
};

export type BuildCacheKeyInput = {
  sourceHash: string;
  configureArgs: readonly string[];
  /**
   * The platform/arch the build **targets**, not necessarily the host's. In
   * `container` mode these are the build image's (`linux`/`arm64`), because
   * that is what the binaries are for: two different hosts driving the same
   * builder image produce interchangeable binaries and must share one cache
   * entry. In `host` mode they are the host's, as before.
   */
  platform: string;
  arch: string;
  /** Observed inside the build container in `container` mode; on the host in `host` mode. */
  compiler: PostgresCompilerIdentity;
  /** Resolved BUILD_ENV_VARS pass-through; see resolveBuildEnv(). */
  buildEnv?: Record<string, string>;
  profileVersion?: string;
  /** Which build mode produced the entry. A host build must never satisfy a container lookup. */
  mode?: PostgresBuildMode;
  /**
   * The build image's configured reference and content-addressed id, in
   * `container` mode. The id is what stops a mutable `:latest` from silently
   * serving a cache entry that a different toolchain produced.
   */
  builderImage?: { reference: string; id: string } | null;
};

export type PostgresBuildCommandRecord = {
  name: string;
  command: string;
  args: string[];
  /** Where this step ran. In `container` mode `command`/`args` are the in-container argv. */
  mode: PostgresBuildMode;
  durationMs: number;
  logName?: string;
};

export type PostgresBuildManifest = {
  sourceRef: string;
  sourceCommit: string;
  sourceHash: string;
  configureArgs: string[];
  /**
   * Always NEUTRAL_INSTALL_PREFIX (`/opt/honeyrail/postgres`), in every build
   * mode. Recorded explicitly because it is the fact MUST 1 of the #182 third
   * review turns on: what `pg_config` reports and what `strings` finds inside
   * the binaries is this, never `installDir`.
   */
  installPrefix: string;
  buildMode: PostgresBuildMode;
  /** Present in `container` mode: exactly which image produced these binaries. */
  builderImage: BuilderImageIdentity | null;
  /**
   * False for a `host` build. The scored path is a containerized build whose
   * output the agent container can actually execute; a host build is a
   * development convenience and its evidence must not be mistaken for a
   * scored trial's. See also PostgresResearchIsolationRecord.scoredEligible,
   * which folds this together with the agent-side network/filesystem facts.
   */
  scoredEligible: boolean;
  /** Present, and loud, whenever `scoredEligible` is false. */
  unscoredReason?: string;
  compiler: PostgresCompilerIdentity;
  /** Informational, not part of the cache key: which make drove the build. */
  make: string;
  /** The platform/arch the binaries target - the build image's in `container` mode. */
  platform: string;
  arch: string;
  /** The machine that drove the build. Informational; deliberately not in the cache key. */
  hostPlatform: string;
  hostArch: string;
  buildEnv: Record<string, string>;
  profileVersion: string;
  /** Grader-private: identifies the source. Never written into the cache tree. */
  cacheKey: string;
  /** The cache entry's on-disk directory name: a one-way digest of cacheKey. */
  entryId: string;
  cacheHit: boolean;
  cacheRoot: string;
  installDir: string;
  jobs: number;
  binaries: PostgresBinaries;
  commands: PostgresBuildCommandRecord[];
  builtAt: string;
  durationMs: number;
};

export type PostgresBinaries = {
  initdb: string;
  pg_ctl: string;
  psql: string;
  postgres: string;
};

export type PostgresLifecycleEvent = {
  phase: string;
  at: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
};

export type PostgresQueryResult = {
  sql: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | string;
  durationMs: number;
};

export type PostgresCleanupResult = {
  stopped: boolean;
  stopMode: "fast" | "immediate" | "already-stopped";
  /** True when there was no runtime container, or when `docker rm -f` removed it. */
  runtimeContainerRemoved: boolean;
  /** True once this trial's randomized build view has been removed. */
  buildViewRemoved: boolean;
  dataDirRemoved: boolean;
  socketDirRemoved: boolean;
  sourceDirRemoved: boolean;
  errors: string[];
  at: string;
};

/**
 * The connection surface handed to an agent. Deliberately carries no ref, no
 * commit, no source hash and no cache key: an agent researching a historical
 * bug must not be able to read the answer out of its own environment. The
 * snapshot it points at has no `.git`, so the ref cannot be recovered from
 * the tree either.
 */
export type PostgresConnectionInfo = {
  host: string;
  port: number;
  socketDir: string;
  user: string;
  database: string;
  binDir: string;
  sourceDir: string;
  dataDir: string;
  logPath: string;
  url: string;
};

export class PostgresResearchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostgresResearchError";
  }
}

export class PostgresResearchTimeoutError extends PostgresResearchError {
  constructor(message: string) {
    super(message);
    this.name = "PostgresResearchTimeoutError";
  }
}

function firstLine(value: string) {
  return value.split("\n")[0]?.trim() ?? "";
}

function defaultCacheRoot() {
  return process.env.HONEYRAIL_PG_BUILD_CACHE || join(homedir(), ".honeyrail", "pg-research-build-cache");
}

/**
 * Unix domain socket paths are limited to ~104 bytes including the
 * ".s.PGSQL.<port>" suffix, and an attempt directory under an attachment
 * root blows through that on its own. Socket directories therefore live in a
 * short-pathed temp root and are removed by cleanup().
 */
function socketRoot() {
  return process.env.HONEYRAIL_PG_SOCKET_ROOT || (platform() === "win32" ? tmpdir() : "/tmp");
}

/**
 * Default parent directory for agent-visible environment roots, and the
 * reason it is not the run's attachment directory: everything HoneyRail
 * records about a research step (source manifest, build manifest, runtime
 * manifest) lands under `attachmentRoot`, so an environment root nested in
 * there would put the answer key one or two `..` hops from
 * `$HR_PG_SOURCE_DIR`. Rooting agent-visible state in its own tree keeps the
 * two hierarchies disjoint; siblings under here are other environments,
 * which are identity-free for the same reason.
 *
 * Override with HONEYRAIL_PG_ENV_ROOT (e.g. onto a larger volume - snapshots
 * of a real PostgreSQL tree are not small).
 */
export function agentEnvRoot() {
  return process.env.HONEYRAIL_PG_ENV_ROOT || join(tmpdir(), "honeyrail-pg-env");
}

/** Creates a fresh agent-visible root under agentEnvRoot(). */
export async function createAgentEnvRoot(prefix = "env-"): Promise<string> {
  const parent = agentEnvRoot();
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, prefix));
}

async function pathExists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

/**
 * Cache key composition. A hit must never serve binaries built from
 * different source, different configure flags, a different declared build
 * environment, a different machine architecture or a different compiler, so
 * all of those are inputs - plus the build profile version, so changing the
 * recipe below invalidates every existing entry.
 *
 * configureArgs is hashed in the order given (not sorted): reordering flags
 * can change their meaning for later-wins options, so the conservative
 * choice is an occasional redundant rebuild rather than a possible wrong
 * reuse. buildEnv *is* sorted - it is a map, and order carries no meaning.
 *
 * The key is grader-private. It is a stable identifier of the source under
 * research, so it never appears on any path or in any file the agent can
 * read; the on-disk cache entry is named by computeBuildEntryId() instead.
 */
export function computeBuildCacheKey(input: BuildCacheKeyInput): string {
  const buildEnv = input.buildEnv ?? {};
  const mode = input.mode ?? DEFAULT_BUILD_MODE;
  const canonical = JSON.stringify({
    profileVersion: input.profileVersion ?? BUILD_PROFILE_VERSION,
    sourceHash: input.sourceHash,
    configureArgs: [...input.configureArgs],
    // The prefix is invariant across every entry, so it carries no
    // information - but it is in the key anyway, because the day it stops
    // being invariant is the day entries built with two different prefixes
    // must not be interchangeable.
    installPrefix: NEUTRAL_INSTALL_PREFIX,
    buildMode: mode,
    // Not just the image reference: `:latest` is mutable, and the whole point
    // is that rebuilding the builder image invalidates what it produced.
    builderImage: input.builderImage ? { reference: input.builderImage.reference, id: input.builderImage.id } : null,
    platform: input.platform,
    arch: input.arch,
    compiler: {
      command: input.compiler.command,
      version: input.compiler.version,
      target: input.compiler.target
    },
    buildEnv: Object.fromEntries(Object.entries(buildEnv).sort(([left], [right]) => left.localeCompare(right)))
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The cache entry's directory name: a domain-separated one-way digest of the
 * cache key rather than the key itself, so a grader-side directory listing
 * does not double as a list of the sources under research.
 *
 * It is deterministic and unkeyed, and therefore *not* a secret: an agent
 * with a bounded candidate set of refs could recompute candidate entry ids
 * and match one. That is why it is never exposed to an agent at all - not on
 * a path, not in the environment, and not through the container's mount
 * table; see agent-container.ts's createBuildView(). Hashing it again would
 * not have helped.
 */
export function computeBuildEntryId(cacheKey: string): string {
  return createHash("sha256").update(`honeyrail-pg-build-entry ${cacheKey}`).digest("hex").slice(0, 32);
}

/**
 * Materializes the snapshot with `git archive`, which writes the tree of one
 * commit and nothing else: no `.git`, no reflog, no branches, and no history
 * after (or before) the ref. There is intentionally no "keep the git
 * directory" option - in historical mode that would hand the agent the fix
 * commit.
 *
 * `destDir` is *published*, not filled in place: the tree is extracted into
 * a fresh sibling staging directory, checked, and only then swapped into
 * place. `tar -x` overlays rather than replaces, so extracting into a
 * non-empty destination would let a file that exists only in a later ref (in
 * historical mode: the fix) survive into a snapshot of an earlier one.
 *
 * The swap is rollback-safe rather than atomic - POSIX has no atomic
 * directory replacement, and claiming one would be a lie. An existing
 * snapshot is renamed aside to a random sibling backup first, so the failure
 * modes are:
 *
 *   extraction/validation fails -> nothing is touched; the old snapshot stands
 *   publish rename fails        -> the backup is renamed back into place
 *   publish rename succeeds     -> the backup is removed
 *
 * Staging directory, tarball and backup are cleaned up on every path. All
 * three are siblings of `destDir`, so no rename ever crosses a filesystem.
 */
export async function materializePostgresSource(
  spec: PostgresSourceSpec,
  destDir: string,
  options: {
    runCommand?: RunCommand;
    timeout?: number;
    /**
     * Test seam: the filesystem primitive the publish/rollback sequence uses.
     * Overridden only to inject a deterministic failure at the rename itself,
     * which is otherwise unreachable from a test.
     */
    publishRename?: typeof rename;
  } = {}
): Promise<PostgresSourceManifest> {
  const runCommand = options.runCommand ?? runCommandSafe;
  const timeout = options.timeout ?? DEFAULT_TIMEOUTS.git;
  const startedAt = Date.now();
  const repoPath = String(spec.repoPath || "").trim();
  const ref = String(spec.ref || "").trim();
  if (!repoPath) throw new PostgresResearchError("PostgreSQL source spec requires a repoPath");
  if (!ref) throw new PostgresResearchError("PostgreSQL source spec requires an exact ref");
  if (!(await pathExists(repoPath))) {
    throw new PostgresResearchError(`PostgreSQL source repoPath does not exist: ${repoPath}`);
  }

  const resolved = await runCommand("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { timeout });
  const resolvedCommit = resolved.stdout.trim();
  if (!resolved.ok || !/^[0-9a-f]{40}$/.test(resolvedCommit)) {
    // Loud failure, never a fallback to HEAD: silently researching the wrong
    // commit would invalidate every result derived from this environment.
    throw new PostgresResearchError(
      `Cannot resolve PostgreSQL source ref "${ref}" in ${repoPath}${resolved.stderr.trim() ? `: ${resolved.stderr.trim()}` : ""}`
    );
  }
  const treeResult = await runCommand("git", ["-C", repoPath, "rev-parse", "--verify", `${resolvedCommit}^{tree}`], { timeout });
  const sourceHash = treeResult.stdout.trim();
  if (!treeResult.ok || !/^[0-9a-f]{40}$/.test(sourceHash)) {
    throw new PostgresResearchError(`Cannot resolve source tree for commit ${resolvedCommit} in ${repoPath}`);
  }

  await mkdir(dirname(destDir), { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const staging = `${destDir}.staging-${suffix}`;
  const tarPath = `${destDir}.tar-${suffix}`;
  const backup = `${destDir}.backup-${suffix}`;
  const publishRename = options.publishRename ?? rename;
  let backedUp = false;
  let keepBackup = false;
  try {
    await mkdir(staging, { recursive: true });
    const archive = await runCommand("git", ["-C", repoPath, "archive", "--format=tar", "-o", tarPath, resolvedCommit], {
      timeout,
      maxBuffer: 1024 * 1024 * 8
    });
    if (!archive.ok) {
      throw new PostgresResearchError(`git archive failed for ${resolvedCommit}: ${archive.stderr || archive.stdout}`);
    }
    const extract = await runCommand("tar", ["-xf", tarPath, "-C", staging], { timeout, maxBuffer: 1024 * 1024 * 8 });
    if (!extract.ok) {
      throw new PostgresResearchError(`Extracting source snapshot failed: ${extract.stderr || extract.stdout}`);
    }

    // Assertion, not a cleanup step: `git archive` cannot emit a .git, so a
    // hit here means an assumption broke and the snapshot must not be used.
    if (await pathExists(join(staging, ".git"))) {
      throw new PostgresResearchError(`Materialized source snapshot unexpectedly contains a .git directory: ${destDir}`);
    }

    // Publish. rename() onto a non-empty directory fails, so any existing
    // snapshot has to move out of the way first - moved aside, not deleted,
    // so the window between the two steps is recoverable.
    if (await pathExists(destDir)) {
      await publishRename(destDir, backup);
      backedUp = true;
    }
    try {
      await publishRename(staging, destDir);
    } catch (error) {
      if (backedUp) {
        try {
          await publishRename(backup, destDir);
          backedUp = false;
        } catch {
          // Both renames failed: the previous snapshot is still intact under
          // `backup`, so keep it rather than deleting the only copy.
          keepBackup = true;
        }
      }
      throw error;
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(tarPath, { force: true });
    if (backedUp && !keepBackup) await rm(backup, { recursive: true, force: true });
  }

  return {
    repoPath,
    ref,
    resolvedCommit,
    sourceHash,
    sourceDir: destDir,
    gitDirPresent: false,
    materializedAt: nowIso(),
    durationMs: Date.now() - startedAt
  };
}

export async function detectCompilerIdentity(
  options: { runCommand?: RunCommand; buildEnv?: Record<string, string> } = {}
): Promise<PostgresCompilerIdentity> {
  const runCommand = options.runCommand ?? runCommandSafe;
  const command = options.buildEnv?.CC || process.env.CC || "cc";
  const version = await runCommand(command, ["--version"], { timeout: 15000 });
  if (!version.ok) {
    throw new PostgresResearchError(`No usable C compiler: ${command} --version failed (${version.stderr || version.code})`);
  }
  const target = await runCommand(command, ["-dumpmachine"], { timeout: 15000 });
  return {
    command,
    version: firstLine(version.stdout) || firstLine(version.stderr),
    target: target.ok ? target.stdout.trim() : "unknown"
  };
}

function binariesIn(installDir: string): PostgresBinaries {
  return {
    initdb: join(installDir, "bin", "initdb"),
    pg_ctl: join(installDir, "bin", "pg_ctl"),
    psql: join(installDir, "bin", "psql"),
    postgres: join(installDir, "bin", "postgres")
  };
}

async function assertBinaries(installDir: string) {
  const binaries = binariesIn(installDir);
  for (const [name, path] of Object.entries(binaries)) {
    if (!(await pathExists(path))) {
      throw new PostgresResearchError(`Build did not produce ${name} at ${path}`);
    }
  }
  return binaries;
}

export type BuildPostgresInput = {
  source: PostgresSourceManifest;
  build?: PostgresBuildSpec;
  /** Where configure/make output is written. */
  logDir: string;
  runCommand?: RunCommand;
  timeouts?: Partial<PostgresResearchTimeouts>;
};

/**
 * configure + make + make install into a cache entry named by
 * computeBuildEntryId(computeBuildCacheKey(...)).
 *
 * ## The prefix is a constant, and that is the point
 *
 * `configure --prefix=` is compiled *into* the installation. `pg_config
 * --bindir/--libdir/--sharedir/--configure` report it verbatim, and it also
 * lands in `lib/pgxs/src/Makefile.global`, in pkg-config metadata, and inside
 * binaries where `strings` finds it. v0/v1 passed the real cache entry path,
 * `<cacheRoot>/<entryId>`, which handed the deterministic entry id straight to
 * any agent that ran the `pg_config` it was given - no filesystem escape
 * needed, and no amount of randomizing the *mount* could take it back, because
 * those strings were compiled in long before the mount existed.
 *
 * So the prefix is now always the neutral literal `/opt/honeyrail/postgres`
 * (NEUTRAL_INSTALL_PREFIX - the same constant agent-container.ts mounts the
 * build at, imported rather than repeated), and `make install DESTDIR=` puts
 * the files where the cache actually keeps them. DESTDIR prepends the prefix
 * under the staging root, so the finished tree is at
 * `<staging>/opt/honeyrail/postgres`, and *that subtree* - not the staging
 * root - is what gets renamed into `<cacheRoot>/<entryId>`.
 *
 * PostgreSQL tolerates the resulting prefix/location mismatch because its
 * programs locate `share/` relative to `argv[0]` rather than by the compiled
 * prefix. Shared-library lookup does not: RUNPATH still names the neutral
 * prefix. The agent container mounts the build there so it simply resolves;
 * host-side execution gets LD_LIBRARY_PATH/DYLD_LIBRARY_PATH pointed at the
 * real lib directory instead (see commandEnv()).
 *
 * Staging is also what keeps an interrupted build from being mistaken for a
 * usable one: the rename happens only after `make install` succeeded and the
 * completion marker was written.
 *
 * ## Where it runs
 *
 * `build.mode: "container"` (the default, and the only scored mode) runs all
 * three steps inside the pinned Linux build image, with only the source
 * snapshot and the staging directory mounted and no host environment
 * inherited. `"host"` runs them as host processes and marks the manifest
 * `scoredEligible: false`.
 *
 * Nothing identifying is written into the cache tree: the entry directory is
 * named by the one-way entry id and the marker file says only "this build
 * finished". The full provenance lives in the manifest this returns, which
 * the caller records grader-side. The tree itself stays grader-side; an agent
 * is shown a per-trial view of it (see agent-container.ts).
 */
export async function buildPostgres(input: BuildPostgresInput): Promise<PostgresBuildManifest> {
  const runCommand = input.runCommand ?? runCommandSafe;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  const startedAt = Date.now();
  const configureArgs = [...(input.build?.configureArgs ?? DEFAULT_CONFIGURE_ARGS)];
  const cacheRoot = input.build?.cacheRoot || defaultCacheRoot();
  const jobs = Math.max(1, input.build?.jobs ?? Math.min(8, cpus().length || 1));
  const buildEnv = resolveBuildEnv(process.env, input.build?.env ?? {});
  const mode = input.build?.mode ?? defaultBuildMode();
  const builderImageRef = input.build?.builderImage ?? DEFAULT_BUILDER_IMAGE;

  // In container mode every identity input is read back out of the image and
  // out of a container started from it, never assumed from the host: the host
  // compiler is not the compiler, and the host arch is not the target.
  const builderImage = mode === "container" ? await resolveBuilderImageIdentity(builderImageRef, runCommand) : null;
  const toolchain =
    mode === "container"
      ? await probeBuildContainerToolchain({ image: builderImageRef, runCommand, buildEnv })
      : {
          compiler: await detectCompilerIdentity({ runCommand, buildEnv }),
          make: firstLine((await runCommand("make", ["--version"], { timeout: 15000 })).stdout)
        };
  const compiler = toolchain.compiler;
  const targetPlatform = builderImage ? builderImage.os : platform();
  const targetArch = builderImage ? builderImage.architecture : arch();

  const cacheKey = computeBuildCacheKey({
    sourceHash: input.source.sourceHash,
    configureArgs,
    platform: targetPlatform,
    arch: targetArch,
    compiler,
    buildEnv,
    mode,
    builderImage: builderImage && { reference: builderImage.reference, id: builderImage.id }
  });
  const entryId = computeBuildEntryId(cacheKey);
  const installDir = join(cacheRoot, entryId);
  const markerPath = join(installDir, BUILD_COMPLETE_MARKER);
  const base = {
    sourceRef: input.source.ref,
    sourceCommit: input.source.resolvedCommit,
    sourceHash: input.source.sourceHash,
    configureArgs,
    installPrefix: NEUTRAL_INSTALL_PREFIX,
    buildMode: mode,
    builderImage,
    scoredEligible: mode === "container",
    ...(mode === "container" ? {} : { unscoredReason: HOST_BUILD_UNSCORED_REASON }),
    compiler,
    make: toolchain.make,
    platform: targetPlatform,
    arch: targetArch,
    hostPlatform: platform(),
    hostArch: arch(),
    buildEnv,
    profileVersion: BUILD_PROFILE_VERSION,
    cacheKey,
    entryId,
    cacheRoot,
    installDir,
    jobs
  };
  // Host mode only: the build steps see the ambient environment plus the
  // declared overrides, and every variable that can change the output is in
  // `buildEnv`, hence in the cache key above. A build *container* inherits
  // nothing and is passed `buildEnv` explicitly.
  const commandEnv: NodeJS.ProcessEnv = { ...process.env, ...(input.build?.env ?? {}) };

  const cached = await readFile(markerPath, "utf8").catch(() => "");
  if (cached) {
    const marker = JSON.parse(cached) as { marker?: string; entryId?: string };
    if (marker.marker === BUILD_COMPLETE_MARKER_ID && marker.entryId === entryId) {
      return {
        ...base,
        cacheHit: true,
        binaries: await assertBinaries(installDir),
        commands: [],
        builtAt: nowIso(),
        durationMs: Date.now() - startedAt
      };
    }
  }

  await mkdir(cacheRoot, { recursive: true });
  await mkdir(input.logDir, { recursive: true });
  const staging = join(cacheRoot, `.staging-${randomBytes(8).toString("hex")}`);
  // Docker creates a missing bind source itself, but as a directory owned by
  // whoever the daemon runs as; create it first so the staged install is
  // owned by the user that owns the cache.
  await mkdir(staging, { recursive: true });
  const commands: PostgresBuildCommandRecord[] = [];

  /**
   * One build step, in whichever mode is active. `argv` is the logical
   * command: in host mode it is run directly with cwd = the snapshot, in
   * container mode it is run inside the build image with the snapshot mounted
   * at BUILDER_CONTAINER_PATHS.source and that as the working directory. The
   * recorded command is the logical one either way, so the manifest reads the
   * same in both modes.
   */
  async function step(name: string, argv: string[], timeout: number, logName: string) {
    const stepStarted = Date.now();
    const result =
      mode === "container"
        ? await runBuildContainerStep(
            {
              sourceDir: input.source.sourceDir,
              stagingDir: staging,
              image: builderImageRef,
              command: argv,
              buildEnv,
              memory: input.build?.builderMemory
            },
            { runCommand, timeout }
          )
        : await runCommand(argv[0], argv.slice(1), {
            cwd: input.source.sourceDir,
            timeout,
            env: commandEnv,
            maxBuffer: 1024 * 1024 * 64
          });
    const durationMs = Date.now() - stepStarted;
    await writeFile(join(input.logDir, logName), `$ ${argv.join(" ")}\n\n${result.stdout}\n${result.stderr}\n`);
    commands.push({ name, command: argv[0], args: argv.slice(1), mode, durationMs, logName });
    if (!result.ok) {
      throw new PostgresResearchError(
        `PostgreSQL ${name} failed (see ${logName}): ${(result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n")}`
      );
    }
  }

  // DESTDIR prepends the (absolute, and now neutral) prefix under the staging
  // root, so the finished tree sits at `<staging>/opt/honeyrail/postgres` and
  // *that* subtree is what one rename publishes as the cache entry.
  const stagedInstall = join(staging, NEUTRAL_INSTALL_PREFIX);
  const configurePath = mode === "container" ? `${BUILDER_CONTAINER_PATHS.source}/configure` : join(input.source.sourceDir, "configure");
  const destdir = mode === "container" ? BUILDER_CONTAINER_PATHS.staging : staging;
  try {
    await step("configure", [configurePath, `--prefix=${NEUTRAL_INSTALL_PREFIX}`, ...configureArgs], timeouts.configure, "configure.log");
    await step("make", ["make", `-j${jobs}`], timeouts.make, "make.log");
    await step("make install", ["make", "install", `DESTDIR=${destdir}`], timeouts.install, "make-install.log");
    if (!(await pathExists(stagedInstall))) {
      throw new PostgresResearchError(
        `make install did not populate ${NEUTRAL_INSTALL_PREFIX} under the staging root - ` +
          `expected ${stagedInstall}. The build did not honour DESTDIR, or configure used a different prefix.`
      );
    }
    // Completion marker only. Source ref, commit, tree hash and cache key
    // stay out of the cache tree - see the module header on the eval
    // boundary; the caller records them grader-side from the returned
    // manifest.
    await writeFile(
      join(stagedInstall, BUILD_COMPLETE_MARKER),
      JSON.stringify({ marker: BUILD_COMPLETE_MARKER_ID, entryId, profileVersion: BUILD_PROFILE_VERSION, completedAt: nowIso() }, null, 2)
    );
    try {
      await rename(stagedInstall, installDir);
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      // Another environment finished the identical build first. Its entry is
      // by definition equivalent (same entry id), so drop ours and use it.
      if (!(await pathExists(markerPath))) throw error;
      await rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    ...base,
    cacheHit: false,
    binaries: await assertBinaries(installDir),
    commands,
    builtAt: nowIso(),
    durationMs: Date.now() - startedAt
  };
}

export class PostgresResearchEnvironment {
  /**
   * The research surface: `source/`, `pgdata/`, `postgres.log`, and the
   * agent's own `agent-work/` scratch directory. These are the only host
   * directories an isolated agent ever gets mounted (plus its socket
   * directory and a view of the build).
   */
  readonly root: string;
  /** Grader-private sibling of `root`: build logs. Never handed to an agent. */
  readonly privateDir: string;
  readonly sourceDir: string;
  readonly installDir: string;
  readonly binDir: string;
  readonly dataDir: string;
  readonly socketDir: string;
  readonly logPath: string;
  readonly buildLogDir: string;
  readonly host = "127.0.0.1";
  readonly user = "postgres";
  readonly database = "postgres";
  readonly label?: string;
  readonly sourceManifest: PostgresSourceManifest;
  readonly buildManifest: PostgresBuildManifest;
  readonly binaries: PostgresBinaries;
  /**
   * This trial's randomized view of the cached build. Mounted read-only into
   * the runtime container (here) and into the agent container
   * (research-session.ts) - the *same* view, so the two containers run
   * literally the same files and neither mount table names the cache entry.
   */
  readonly buildView: BuildView;
  /**
   * `container` in the scored path: the cluster lives in a runtime sidecar and
   * this process only orchestrates docker. `host-process` is the un-scored
   * development lifecycle that runs `initdb`/`pg_ctl`/`psql` as host children.
   */
  readonly runtimeMode: "container" | "host-process";
  /** The resolved runtime image, in container mode. Recorded, never assumed from a tag. */
  readonly runtimeImage: ContainerImageIdentity | null;

  private readonly runCommand: RunCommand;
  private readonly timeouts: PostgresResearchTimeouts;
  private readonly initdbArgs: string[];
  private readonly events: PostgresLifecycleEvent[] = [];
  private readonly runtimeSpec: PostgresRuntimeSpec;
  /** Host paths of the generated /etc/passwd and /etc/group identity shim; container mode only. */
  private readonly identityDir: string | null;
  private runtime: PostgresRuntimeContainer | null = null;
  private runtimeRecord: PostgresRuntimeRecord;
  private currentPort: number;
  private initialized = false;
  private running = false;
  private closed = false;
  private cleanupResult: PostgresCleanupResult | null = null;

  constructor(input: {
    root: string;
    privateDir: string;
    buildLogDir?: string;
    sourceManifest: PostgresSourceManifest;
    buildManifest: PostgresBuildManifest;
    buildView: BuildView;
    runtimeImage: ContainerImageIdentity | null;
    runtimeSpec?: PostgresRuntimeSpec;
    identityDir?: string | null;
    port: number;
    socketDir: string;
    runCommand: RunCommand;
    timeouts: PostgresResearchTimeouts;
    initdbArgs: string[];
    label?: string;
    events?: PostgresLifecycleEvent[];
  }) {
    this.root = input.root;
    this.privateDir = input.privateDir;
    this.sourceManifest = input.sourceManifest;
    this.buildManifest = input.buildManifest;
    this.sourceDir = input.sourceManifest.sourceDir;
    this.installDir = input.buildManifest.installDir;
    this.binaries = input.buildManifest.binaries;
    this.binDir = join(this.installDir, "bin");
    this.dataDir = join(input.root, "pgdata");
    this.socketDir = input.socketDir;
    this.logPath = join(input.root, "postgres.log");
    this.buildLogDir = input.buildLogDir ?? join(input.privateDir, "build");
    this.buildView = input.buildView;
    this.runtimeImage = input.runtimeImage;
    this.runtimeSpec = input.runtimeSpec ?? {};
    this.identityDir = input.identityDir ?? null;
    this.runtimeMode = input.runtimeImage ? "container" : "host-process";
    this.runtimeRecord =
      this.runtimeMode === "container"
        ? { mode: "container", scoredEligible: true }
        : { mode: "host-process", scoredEligible: false, unscoredReason: HOST_RUNTIME_UNSCORED_REASON };
    this.currentPort = input.port;
    this.runCommand = input.runCommand;
    this.timeouts = input.timeouts;
    this.initdbArgs = input.initdbArgs;
    this.label = input.label;
    for (const event of input.events ?? []) this.events.push(event);
  }

  /**
   * The port this cluster is on (or will next try). Not readonly: start()
   * re-allocates on a bind collision, because allocatePort() hands out a
   * candidate rather than a reservation - see START_PORT_ATTEMPTS.
   */
  get port(): number {
    return this.currentPort;
  }

  /**
   * Environment every command against this cluster runs under: the built
   * binaries first on PATH, and every inherited PG* variable dropped so an
   * operator's ambient PGHOST/PGPORT/PGDATA cannot silently redirect a
   * research experiment at some other server.
   *
   * The library-path variables are the host-side counterpart of the neutral
   * `--prefix=/opt/honeyrail/postgres` every build is now configured with:
   * the binaries' RUNPATH (and, on macOS, libpq's baked-in `install_name`)
   * names that prefix, which on the host is not where the files are. Both
   * loaders search these variables ahead of the recorded path, so pointing
   * them at the cache entry's real `lib/` is what makes a host-run `psql`
   * resolve libpq. The agent container needs no equivalent - it mounts the
   * build at exactly the prefix it was compiled with.
   */
  private commandEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("PG")) continue;
      env[key] = value;
    }
    env.PATH = `${this.binDir}:${process.env.PATH ?? ""}`;
    const libDir = join(this.installDir, "lib");
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libDir}:${env.LD_LIBRARY_PATH}` : libDir;
    env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${libDir}:${env.DYLD_LIBRARY_PATH}` : libDir;
    return env;
  }

  private record(phase: string, detail?: Record<string, unknown>, durationMs?: number) {
    const event: PostgresLifecycleEvent = { phase, at: nowIso(), durationMs, detail };
    this.events.push(event);
    return event;
  }

  private assertOpen() {
    if (this.closed) throw new PostgresResearchError("PostgreSQL research environment has already been cleaned up");
  }

  lifecycleEvents(): PostgresLifecycleEvent[] {
    return [...this.events];
  }

  isRunning() {
    return this.running;
  }

  /**
   * How a client on *this* side reaches the cluster.
   *
   * In container mode there is no TCP listener at all - the postmaster is
   * started with `-h ''` and its container has no network - so the honest
   * answer is the socket directory, which libpq accepts as a host because it
   * begins with "/". Claiming 127.0.0.1 there would be a connection string
   * that cannot connect.
   */
  private connectHost(): string {
    return this.runtimeMode === "container" ? this.socketDir : this.host;
  }

  connectionInfo(): PostgresConnectionInfo {
    return {
      host: this.connectHost(),
      port: this.port,
      socketDir: this.socketDir,
      user: this.user,
      database: this.database,
      binDir: this.binDir,
      sourceDir: this.sourceDir,
      dataDir: this.dataDir,
      logPath: this.logPath,
      url:
        this.runtimeMode === "container"
          ? `postgresql://${this.user}@/${this.database}?host=${this.socketDir}&port=${this.port}`
          : `postgresql://${this.user}@${this.host}:${this.port}/${this.database}`
    };
  }

  /**
   * Flat KEY=value view of connectionInfo(), in **host** paths.
   *
   * This is the map for a caller driving the environment itself, and the one
   * the explicitly-unisolated development mode exports. It carries no ref, no
   * commit, no source hash and no cache key, and the snapshot it points at
   * has no `.git` - but every value is a real host path, so it is not what an
   * isolated agent gets. That is agent-container.ts's
   * containerAgentEnvironment(), which returns the in-container paths.
   *
   * Handing these values to an unconfined process is minimization, not a
   * boundary: such a process can read anything its OS user can.
   */
  agentEnvironment(prefix = "HR_PG"): Record<string, string> {
    const info = this.connectionInfo();
    return {
      [`${prefix}_HOST`]: info.host,
      [`${prefix}_PORT`]: String(info.port),
      [`${prefix}_SOCKET_DIR`]: info.socketDir,
      [`${prefix}_USER`]: info.user,
      [`${prefix}_DATABASE`]: info.database,
      [`${prefix}_URL`]: info.url,
      [`${prefix}_BIN_DIR`]: info.binDir,
      [`${prefix}_SOURCE_DIR`]: info.sourceDir,
      [`${prefix}_DATA_DIR`]: info.dataDir,
      [`${prefix}_LOG`]: info.logPath
    };
  }

  runtimeManifest() {
    return {
      label: this.label,
      root: this.root,
      privateDir: this.privateDir,
      sourceDir: this.sourceDir,
      installDir: this.installDir,
      binDir: this.binDir,
      dataDir: this.dataDir,
      socketDir: this.socketDir,
      logPath: this.logPath,
      port: this.port,
      host: this.host,
      user: this.user,
      database: this.database,
      initdbArgs: this.initdbArgs,
      binaries: this.binaries,
      /**
       * Which of the three scored axes this environment is responsible for.
       * Recorded on the runtime manifest itself, not only folded into the
       * session verdict, so a `postgres-research` step that runs no agent
       * still carries the fact that its server was (or was not) contained.
       */
      runtime: this.runtimeRecord,
      buildViewDir: this.buildView.dir,
      lifecycle: this.lifecycleEvents(),
      cleanup: this.cleanupResult
    };
  }

  /** The scored/un-scored runtime axis; see PostgresRuntimeRecord. */
  runtimeIsolation(): PostgresRuntimeRecord {
    return this.runtime ? { ...this.runtime.record() } : { ...this.runtimeRecord };
  }

  /**
   * Is the server actually alive? In container mode this is two facts (the
   * sidecar container, and pg_ctl's view of the postmaster inside it); in host
   * mode it is what this class last observed.
   */
  async health(): Promise<{ containerRunning: boolean; serverRunning: boolean; detail: string }> {
    if (!this.runtime) {
      return { containerRunning: false, serverRunning: this.running, detail: "host-process cluster" };
    }
    return this.runtime.health();
  }

  /**
   * The one failure mode a containerized build introduces if the runtime
   * sidecar is ever bypassed, named rather than left as a bare "Exec format
   * error".
   *
   * In the scored path this is unreachable: `container` builds run in the
   * runtime container, which is Linux on every Docker host. It survives for
   * the case an operator constructs an environment with a `container` build
   * manifest and no runtime image (host-process lifecycle) on macOS/Windows,
   * where the host kernel simply cannot execute the artifact.
   */
  private abiHint(detail: string): string {
    const abiFailure = /Exec format error|cannot execute binary file|ENOEXEC/i.test(detail);
    if (!abiFailure || this.buildManifest.buildMode !== "container" || platform() === "linux") return "";
    return (
      `\n\nThis environment's binaries were built for ${this.buildManifest.platform}/${this.buildManifest.arch} inside ` +
      `${this.buildManifest.builderImage?.reference ?? "the build container"}, and this host is ${platform()}/${arch()}, ` +
      "which cannot execute them. The scored path never asks it to: a container build runs its cluster inside the " +
      "PostgreSQL runtime sidecar (docker/postgres-research-runtime). This environment has no runtime container, so it " +
      'fell back to the host-process lifecycle. Build the runtime image, or use build.mode: "host" for local ' +
      "development against real PostgreSQL sources - an explicitly un-scored build."
    );
  }

  /**
   * Creates the runtime sidecar, once, before anything PostgreSQL runs.
   * Container mode only; a host build has no runtime image and keeps the
   * host-process lifecycle.
   */
  private async ensureRuntime(): Promise<PostgresRuntimeContainer | null> {
    if (!this.runtimeImage) return null;
    if (this.runtime) return this.runtime;
    const identity = this.identityDir;
    if (!identity) {
      throw new PostgresResearchError("A containerized PostgreSQL runtime needs its generated passwd/group identity files");
    }
    const started = Date.now();
    const runtime = new PostgresRuntimeContainer({
      image: this.runtimeImage,
      runCommand: this.runCommand,
      mounts: {
        buildViewDir: this.buildView.dir,
        dataDir: this.dataDir,
        socketDir: this.socketDir,
        logPath: this.logPath,
        passwdPath: join(identity, "passwd"),
        groupPath: join(identity, "group")
      },
      memory: this.runtimeSpec.memory,
      pidsLimit: this.runtimeSpec.pidsLimit,
      tmpfsSize: this.runtimeSpec.tmpfsSize
    });
    await runtime.create({ timeout: this.timeouts.control });
    this.runtime = runtime;
    this.runtimeRecord = runtime.record();
    this.record(
      "runtime.container.created",
      {
        containerName: runtime.containerName,
        image: this.runtimeImage.reference,
        imageId: this.runtimeImage.id,
        platform: this.runtimeImage.platform,
        networkMode: runtime.networkMode,
        user: runtime.user,
        mounts: this.runtimeRecord.mounts
      },
      Date.now() - started
    );
    return runtime;
  }

  private async initdb() {
    if (this.initialized) return;
    const started = Date.now();
    const runtime = await this.ensureRuntime();
    if (runtime) {
      await runtime.initdb(this.initdbArgs, { timeout: this.timeouts.initdb });
    } else {
      const result = await this.runCommand(this.binaries.initdb, ["-D", this.dataDir, ...this.initdbArgs], {
        cwd: this.root,
        timeout: this.timeouts.initdb,
        env: this.commandEnv(),
        maxBuffer: 1024 * 1024 * 8
      });
      if (!result.ok) {
        throw new PostgresResearchError(`initdb failed: ${result.stderr || result.stdout}${this.abiHint(result.stderr || result.stdout)}`);
      }
    }
    this.initialized = true;
    this.record("cluster.initdb", { dataDir: this.dataDir, args: this.initdbArgs, mode: this.runtimeMode }, Date.now() - started);
  }

  private pgCtlOptions() {
    return `-p ${this.port} -h ${this.host} -k ${this.socketDir}`;
  }

  /**
   * initdb (once) + pg_ctl start + readiness poll.
   *
   * allocatePort() releases its candidate port before PostgreSQL binds it,
   * so a concurrent process can take it in between. That window is narrow
   * but real, so a start that fails specifically on a bind collision is
   * retried on a freshly allocated port a bounded number of times. Every
   * other startup failure stays a hard failure on the first attempt: a
   * research environment that cannot start must say so rather than thrash.
   */
  async start(): Promise<PostgresReadiness> {
    this.assertOpen();
    if (this.running) return { ready: true, latencyMs: 0 };
    await this.initdb();
    const started = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      const result = this.runtime
        ? await this.runtime.start(this.port, { timeout: this.timeouts.control })
        : await this.runCommand(
            this.binaries.pg_ctl,
            ["-D", this.dataDir, "-l", this.logPath, "-o", this.pgCtlOptions(), "start", "-w"],
            { cwd: this.root, timeout: this.timeouts.control, env: this.commandEnv(), maxBuffer: 1024 * 1024 * 8 }
          );
      if (result.ok) break;
      // PostgreSQL reports the bind failure in the server log pg_ctl was
      // pointed at, not necessarily on pg_ctl's own stderr, so both count.
      const logTail = await readFile(this.logPath, "utf8").catch(() => "");
      const detail = `${result.stderr}\n${result.stdout}\n${logTail.slice(-4096)}`;
      if (attempt >= START_PORT_ATTEMPTS || !isAddressInUseFailure(detail)) {
        throw new PostgresResearchError(`pg_ctl start failed: ${result.stderr || result.stdout}`);
      }
      const previous = this.currentPort;
      this.currentPort = await allocatePort();
      this.record("cluster.port.retry", { attempt, previousPort: previous, port: this.currentPort });
    }
    this.running = true;
    this.record(
      "cluster.started",
      {
        port: this.port,
        socketDir: this.socketDir,
        mode: this.runtimeMode,
        ...(this.runtime ? { containerName: this.runtime.containerName, listen: "unix-socket-only" } : {})
      },
      Date.now() - started
    );
    if (this.closed) {
      // cleanup() ran while this start was still in flight - the session
      // timeout arm does exactly that. Its data directory is already gone, so
      // the server that just came up would be orphaned against a deleted
      // PGDATA; stop it and fail rather than report a ready cluster.
      await this.stop("immediate").catch(() => {});
      this.running = false;
      throw new PostgresResearchError("PostgreSQL research environment was cleaned up while it was starting");
    }
    return this.waitReady();
  }

  private async waitReady(): Promise<PostgresReadiness> {
    const readiness = this.runtime
      ? await this.runtime.waitReady({ port: this.port, user: this.user, database: this.database })
      : await waitForPostgresReady({
          runCommand: this.runCommand,
          cwd: this.root,
          psql: this.binaries.psql,
          port: this.port,
          host: this.host,
          user: this.user,
          database: this.database,
          env: this.commandEnv()
        });
    this.record("cluster.ready", { port: this.port, latencyMs: readiness.latencyMs, mode: this.runtimeMode });
    return readiness;
  }

  async restart(): Promise<PostgresReadiness> {
    this.assertOpen();
    if (!this.running) return this.start();
    const started = Date.now();
    const result = this.runtime
      ? await this.runtime.restart(this.port, { timeout: this.timeouts.control })
      : await this.runCommand(
          this.binaries.pg_ctl,
          ["-D", this.dataDir, "restart", "-m", "fast", "-w", "-l", this.logPath, "-o", this.pgCtlOptions()],
          { cwd: this.root, timeout: this.timeouts.control, env: this.commandEnv(), maxBuffer: 1024 * 1024 * 8 }
        );
    if (!result.ok) {
      throw new PostgresResearchError(`pg_ctl restart failed: ${result.stderr || result.stdout}`);
    }
    this.record("cluster.restarted", { port: this.port, mode: this.runtimeMode }, Date.now() - started);
    return this.waitReady();
  }

  async stop(mode: "fast" | "immediate" = "fast"): Promise<boolean> {
    if (!this.running) return true;
    const started = Date.now();
    const result = this.runtime
      ? await this.runtime.stop(mode, { timeout: this.timeouts.control })
      : await this.runCommand(this.binaries.pg_ctl, ["-D", this.dataDir, "stop", "-m", mode, "-w"], {
          cwd: this.root,
          timeout: this.timeouts.control,
          env: this.commandEnv(),
          maxBuffer: 1024 * 1024 * 8
        });
    if (result.ok) this.running = false;
    this.record("cluster.stopped", { mode, ok: result.ok, runtimeMode: this.runtimeMode }, Date.now() - started);
    return result.ok;
  }

  /**
   * Runs arbitrary SQL. Does not throw on SQL errors: a research environment
   * exists to observe what the server actually does, including failures, so
   * the caller decides what counts as a problem.
   */
  async psql(sql: string): Promise<PostgresQueryResult> {
    this.assertOpen();
    return this.runPsql(sql, ["-v", "ON_ERROR_STOP=1", "-c", sql]);
  }

  /**
   * Same, for a SQL script an agent (or driver) wrote to disk.
   *
   * `path` is a **host** path. In container mode the runtime sidecar cannot
   * see it - deliberately, since it could be anywhere, including under the
   * grader-private tree - so the file is staged onto the container's own
   * tmpfs with `docker cp` rather than by adding a bind mount for it.
   */
  async psqlFile(path: string): Promise<PostgresQueryResult> {
    this.assertOpen();
    if (!isAbsolute(path)) throw new PostgresResearchError(`psqlFile requires an absolute path, got "${path}"`);
    if (this.runtime) {
      const started = Date.now();
      const result = await this.runtime.psqlFile(
        { port: this.port, user: this.user, database: this.database },
        path,
        { timeout: this.timeouts.psql, maxBuffer: 1024 * 1024 * 32 }
      );
      return this.observe(`\\i ${path}`, result, started);
    }
    return this.runPsql(`\\i ${path}`, ["-v", "ON_ERROR_STOP=1", "-f", path]);
  }

  private async runPsql(sql: string, tail: string[]): Promise<PostgresQueryResult> {
    const started = Date.now();
    const result = this.runtime
      ? await this.runtime.psql({ port: this.port, user: this.user, database: this.database }, tail, {
          timeout: this.timeouts.psql,
          maxBuffer: 1024 * 1024 * 32
        })
      : await this.runCommand(
          this.binaries.psql,
          psqlArgs({ host: this.host, port: this.port, user: this.user, database: this.database }, tail),
          { cwd: this.root, timeout: this.timeouts.psql, env: this.commandEnv(), maxBuffer: 1024 * 1024 * 32 }
        );
    return this.observe(sql, result, started);
  }

  private observe(sql: string, result: { ok: boolean; stdout: string; stderr: string; code?: number | string }, started: number) {
    const observation: PostgresQueryResult = {
      sql,
      ok: result.ok,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      exitCode: result.code,
      durationMs: Date.now() - started
    };
    this.record("cluster.query", { ok: observation.ok, durationMs: observation.durationMs });
    return observation;
  }

  /**
   * Escape hatch for experiments the environment itself has no opinion about
   * - grepping the snapshot, running a shell repro, invoking a built binary
   * directly - with PATH and the PG* hygiene above already applied.
   *
   * `inRuntime` runs the command inside the runtime sidecar instead, which is
   * what a caller wants for anything that touches the *built PostgreSQL* in
   * container mode: those are Linux binaries and the host may not be Linux.
   * It is an error to ask for it when there is no runtime container, rather
   * than silently running on the host and producing an `exec format error`
   * that looks like the experiment failed.
   */
  async exec(
    command: string,
    args: string[] = [],
    options: { cwd?: string; timeout?: number; inRuntime?: boolean } = {}
  ) {
    this.assertOpen();
    if (options.inRuntime) {
      const runtime = await this.ensureRuntime();
      if (!runtime) {
        throw new PostgresResearchError(
          'exec({ inRuntime: true }) needs a containerized cluster; this environment is build.mode: "host"'
        );
      }
      return runtime.exec([command, ...args], { timeout: options.timeout ?? this.timeouts.psql, maxBuffer: 1024 * 1024 * 32 });
    }
    return this.runCommand(command, args, {
      cwd: options.cwd ?? this.root,
      timeout: options.timeout ?? this.timeouts.psql,
      env: this.commandEnv(),
      maxBuffer: 1024 * 1024 * 32
    });
  }

  /**
   * Idempotent and non-throwing: cleanup runs from `finally` blocks where
   * throwing would mask the original failure.
   *
   * The order is the contract (MUST 4 of the #182 fourth review), and every
   * step is unconditional so a failure earlier in the sequence cannot leak a
   * later resource:
   *
   *   PostgreSQL fast stop
   *     -> immediate stop if fast did not take
   *     -> runtime container removed
   *     -> PGDATA / socket directory removed per the retention policy
   *     -> the identity shim removed
   *     -> this trial's randomized build view removed
   *
   * The agent is already gone by the time this runs: research-session.ts only
   * reaches `withPostgresResearchEnvironment`'s finally after the agent
   * process has exited, including when it was killed for exceeding its
   * timeout. The server log, the build logs and the manifests stay behind as
   * evidence, and the shared build cache is never touched.
   */
  async cleanup(options: { retainDataDir?: boolean; removeSourceDir?: boolean } = {}): Promise<PostgresCleanupResult> {
    if (this.cleanupResult) return this.cleanupResult;
    const errors: string[] = [];
    let stopMode: PostgresCleanupResult["stopMode"] = "already-stopped";
    let stopped = !this.running;
    if (this.running) {
      try {
        stopped = await this.stop("fast");
        stopMode = "fast";
        if (!stopped) {
          stopped = await this.stop("immediate");
          stopMode = "immediate";
        }
      } catch (error) {
        errors.push(`stop: ${(error as Error).message}`);
      }
    }
    this.closed = true;

    // The container goes away whether or not the stop above succeeded - a
    // wedged postmaster must not keep a container (and its write handles on
    // the directories below) alive past the trial.
    let runtimeRemoved = true;
    if (this.runtime) {
      try {
        runtimeRemoved = await this.runtime.cleanup();
        if (!runtimeRemoved) errors.push(`runtime container ${this.runtime.containerName} could not be removed`);
      } catch (error) {
        runtimeRemoved = false;
        errors.push(`runtime container: ${(error as Error).message}`);
      }
      this.runtimeRecord = this.runtime.record();
    }

    async function remove(path: string, label: string) {
      try {
        await rm(path, { recursive: true, force: true });
        return true;
      } catch (error) {
        errors.push(`${label}: ${(error as Error).message}`);
        return false;
      }
    }

    const dataDirRemoved = options.retainDataDir ? false : await remove(this.dataDir, "pgdata");
    const socketDirRemoved = await remove(this.socketDir, "socket");
    const sourceDirRemoved = options.removeSourceDir ? await remove(this.sourceDir, "source") : false;
    if (this.identityDir) await remove(this.identityDir, "runtime-identity");
    // Per-trial artifact of the boundary, not part of the shared cache: it
    // goes away with the trial, on every exit path.
    await removeBuildView(this.buildView);

    this.cleanupResult = {
      stopped,
      stopMode,
      runtimeContainerRemoved: runtimeRemoved,
      buildViewRemoved: true,
      dataDirRemoved,
      socketDirRemoved,
      sourceDirRemoved,
      errors,
      at: nowIso()
    };
    this.record("cleanup.completed", { ...this.cleanupResult });
    return this.cleanupResult;
  }
}

/**
 * Materialize + build. The cluster is not started yet - call start() (or use
 * withPostgresResearchEnvironment below, which guarantees cleanup).
 */
export async function createPostgresResearchEnvironment(spec: PostgresResearchSpec): Promise<PostgresResearchEnvironment> {
  const runCommand = spec.runCommand ?? runCommandSafe;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...spec.timeouts };
  const events: PostgresLifecycleEvent[] = [];
  const privateDir = spec.privateDir ?? `${spec.root}-private`;
  if (privateDir === spec.root || privateDir.startsWith(`${spec.root}/`)) {
    // The whole point of the private directory is that no agent-visible path
    // leads to it; nesting it under the agent root would silently undo that.
    throw new PostgresResearchError(`privateDir must live outside the agent-visible root, got ${privateDir}`);
  }
  // Grader-private: configure/make logs quote the source path and every
  // build flag, so they stay out of the agent-visible root.
  const buildLogDir = spec.build?.logDir ?? join(privateDir, "build");

  // Resolved *first*, before anything is materialized or built: a missing
  // runtime image must fail in seconds rather than after a cold PostgreSQL
  // build. There is deliberately no fallback to the host lifecycle - a scored
  // trial that quietly ran its server on the host would be exactly the
  // untruth this round exists to remove.
  const mode = spec.build?.mode ?? defaultBuildMode();
  const runtimeImage = mode === "container" ? await resolveRuntimeImageIdentity(spec.runtime?.image, runCommand) : null;

  await mkdir(spec.root, { recursive: true });
  await mkdir(privateDir, { recursive: true });

  const sourceManifest = await materializePostgresSource(spec.source, join(spec.root, "source"), {
    runCommand,
    timeout: timeouts.git
  });
  events.push({
    phase: "source.materialized",
    at: sourceManifest.materializedAt,
    durationMs: sourceManifest.durationMs,
    detail: { ref: sourceManifest.ref, commit: sourceManifest.resolvedCommit, sourceHash: sourceManifest.sourceHash, gitDirPresent: false }
  });

  const buildManifest = await buildPostgres({
    source: sourceManifest,
    build: spec.build,
    logDir: buildLogDir,
    runCommand,
    timeouts
  });
  events.push({
    phase: "build.completed",
    at: buildManifest.builtAt,
    durationMs: buildManifest.durationMs,
    detail: { cacheKey: buildManifest.cacheKey, cacheHit: buildManifest.cacheHit, installDir: buildManifest.installDir }
  });

  if (runtimeImage && (runtimeImage.os !== buildManifest.platform || runtimeImage.architecture !== buildManifest.arch)) {
    // Tags agreeing is not the same as images agreeing. Caught here rather
    // than as a loader error inside the container, where it would look like a
    // PostgreSQL failure instead of an image-pairing mistake.
    throw new PostgresResearchError(
      `The PostgreSQL runtime image ${runtimeImage.reference} is ${runtimeImage.platform}, but this build targets ` +
        `${buildManifest.platform}/${buildManifest.arch} (built in ${buildManifest.builderImage?.reference ?? "the build container"}). ` +
        "The builder and runtime images must be rebuilt together."
    );
  }

  // One view, mounted read-only into both containers. Created here rather
  // than by the agent launcher because the *runtime* needs it first: the
  // server binaries themselves are what it runs.
  const buildView = await createBuildView(
    buildManifest.installDir,
    spec.buildViewsRoot ?? defaultBuildViewsRoot(buildManifest.cacheRoot)
  );
  events.push({ phase: "build.view.created", at: nowIso(), detail: { viewDir: buildView.dir } });

  await mkdir(socketRoot(), { recursive: true }).catch(() => {});
  const socketDir = await mkdtemp(join(socketRoot(), "hrpg-"));
  const port = await allocatePort();
  const dataDir = join(spec.root, "pgdata");
  const logPath = join(spec.root, "postgres.log");
  await mkdir(dataDir, { recursive: true });
  // Docker creates a *directory* for a bind source that does not exist, which
  // would make `pg_ctl -l` fail inside the runtime container.
  await writeFile(logPath, "", { flag: "a" });

  let identityDir: string | null = null;
  if (runtimeImage) {
    // Its own temp directory, not a subdirectory of privateDir: the two files
    // are bind-mounted into the runtime container, and a mount whose source
    // path is inside the grader-private tree would publish that tree's
    // location in the container's own mount table for no reason. It holds
    // nothing but the generated uid/gid entries and is removed by cleanup().
    identityDir = await mkdtemp(join(socketRoot(), "hrpg-id-"));
    await writeRuntimeIdentityFiles(identityDir, runtimeUserIds());
    // No-op unless the host user is root, in which case the runtime runs as a
    // non-root uid (PostgreSQL refuses uid 0) that has to own these first.
    await alignRuntimeOwnership([dataDir, socketDir, logPath]);
  }

  return new PostgresResearchEnvironment({
    root: spec.root,
    privateDir,
    buildLogDir,
    sourceManifest,
    buildManifest,
    buildView,
    runtimeImage,
    runtimeSpec: spec.runtime,
    identityDir,
    port,
    socketDir,
    runCommand,
    timeouts,
    initdbArgs: [...(spec.initdbArgs ?? DEFAULT_INITDB_ARGS)],
    label: spec.label,
    events
  });
}

export type WithPostgresResearchEnvironmentOptions = {
  /** Fails the body (and still cleans up) if it has not settled in time. */
  timeoutMs?: number;
  cleanup?: { retainDataDir?: boolean; removeSourceDir?: boolean };
};

/**
 * The intended entry point: cleanup is the default rather than caller
 * discipline. The cluster is stopped and its ephemeral state removed on
 * normal completion, on a thrown error, and on timeout - the same
 * `try { ... } finally { stop }` guarantee transaction-restart-alpha uses,
 * with the timeout arm added because an agent-driven research step can hang
 * rather than fail.
 */
export async function withPostgresResearchEnvironment<T>(
  spec: PostgresResearchSpec,
  body: (env: PostgresResearchEnvironment) => Promise<T>,
  options: WithPostgresResearchEnvironmentOptions = {}
): Promise<T> {
  const env = await createPostgresResearchEnvironment(spec);
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = body(env);
    if (!options.timeoutMs) return await work;
    // The rejected race arm cannot abort the body's own awaits, but cleanup
    // below tears the cluster down immediately, so anything still in flight
    // fails fast against a stopped server instead of running unobserved.
    work.catch(() => {});
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new PostgresResearchTimeoutError(`PostgreSQL research environment timed out after ${options.timeoutMs}ms`)),
          options.timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await env.cleanup(options.cleanup);
  }
}
