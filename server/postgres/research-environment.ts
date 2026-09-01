import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, homedir, platform, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { nowIso, runCommandSafe } from "../utils.js";
import { allocatePort, psqlArgs, waitForPostgresReady, type PostgresReadiness, type RunCommand } from "./runtime.js";

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
 */

/** Bumped when the build recipe itself changes; participates in the cache key. */
export const BUILD_PROFILE_VERSION = "pg-research-env-v0";

/**
 * Minimal profile: no readline (interactive niceties), no zlib (compression),
 * no ICU (a heavyweight external build dependency). contrib and docs are not
 * built at all - `make` at the top level builds the server plus the standard
 * client programs, which is everything a repro needs.
 */
export const DEFAULT_CONFIGURE_ARGS = ["--without-readline", "--without-zlib", "--without-icu"] as const;

export const DEFAULT_INITDB_ARGS = ["-A", "trust", "-U", "postgres", "--no-locale"] as const;

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
  /** Defaults to DEFAULT_CONFIGURE_ARGS. Order is significant to the cache key. */
  configureArgs?: readonly string[];
  jobs?: number;
  /** Shared across environments; defaults to ~/.honeyrail/pg-research-build-cache. */
  cacheRoot?: string;
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
  /** Directory this environment owns: snapshot, PGDATA, logs, build logs. */
  root: string;
  source: PostgresSourceSpec;
  build?: PostgresBuildSpec;
  initdbArgs?: readonly string[];
  runCommand?: RunCommand;
  timeouts?: Partial<PostgresResearchTimeouts>;
  /** Free-form label carried into manifests, e.g. a trial id. Never a bug identity. */
  label?: string;
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
  platform: string;
  arch: string;
  compiler: PostgresCompilerIdentity;
  profileVersion?: string;
};

export type PostgresBuildCommandRecord = {
  name: string;
  command: string;
  args: string[];
  durationMs: number;
  logName?: string;
};

export type PostgresBuildManifest = {
  sourceRef: string;
  sourceCommit: string;
  sourceHash: string;
  configureArgs: string[];
  compiler: PostgresCompilerIdentity;
  /** Informational, not part of the cache key: which make drove the build. */
  make: string;
  platform: string;
  arch: string;
  profileVersion: string;
  cacheKey: string;
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
  constructor(message: string) {
    super(message);
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

async function pathExists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

/**
 * Cache key composition. A hit must never serve binaries built from
 * different source, different configure flags, a different machine
 * architecture or a different compiler, so all four are inputs - plus the
 * build profile version, so changing the recipe below invalidates every
 * existing entry.
 *
 * configureArgs is hashed in the order given (not sorted): reordering flags
 * can change their meaning for later-wins options, so the conservative
 * choice is an occasional redundant rebuild rather than a possible wrong
 * reuse.
 */
export function computeBuildCacheKey(input: BuildCacheKeyInput): string {
  const canonical = JSON.stringify({
    profileVersion: input.profileVersion ?? BUILD_PROFILE_VERSION,
    sourceHash: input.sourceHash,
    configureArgs: [...input.configureArgs],
    platform: input.platform,
    arch: input.arch,
    compiler: {
      command: input.compiler.command,
      version: input.compiler.version,
      target: input.compiler.target
    }
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Materializes the snapshot with `git archive`, which writes the tree of one
 * commit and nothing else: no `.git`, no reflog, no branches, and no history
 * after (or before) the ref. There is intentionally no "keep the git
 * directory" option - in historical mode that would hand the agent the fix
 * commit.
 */
export async function materializePostgresSource(
  spec: PostgresSourceSpec,
  destDir: string,
  options: { runCommand?: RunCommand; timeout?: number } = {}
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

  await mkdir(destDir, { recursive: true });
  const tarPath = `${destDir}.tar`;
  const archive = await runCommand("git", ["-C", repoPath, "archive", "--format=tar", "-o", tarPath, resolvedCommit], {
    timeout,
    maxBuffer: 1024 * 1024 * 8
  });
  if (!archive.ok) {
    await rm(tarPath, { force: true });
    throw new PostgresResearchError(`git archive failed for ${resolvedCommit}: ${archive.stderr || archive.stdout}`);
  }
  const extract = await runCommand("tar", ["-xf", tarPath, "-C", destDir], { timeout, maxBuffer: 1024 * 1024 * 8 });
  await rm(tarPath, { force: true });
  if (!extract.ok) {
    throw new PostgresResearchError(`Extracting source snapshot failed: ${extract.stderr || extract.stdout}`);
  }

  // Assertion, not a cleanup step: `git archive` cannot emit a .git, so a
  // hit here means an assumption broke and the snapshot must not be used.
  if (await pathExists(join(destDir, ".git"))) {
    throw new PostgresResearchError(`Materialized source snapshot unexpectedly contains a .git directory: ${destDir}`);
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

export async function detectCompilerIdentity(options: { runCommand?: RunCommand } = {}): Promise<PostgresCompilerIdentity> {
  const runCommand = options.runCommand ?? runCommandSafe;
  const command = process.env.CC || "cc";
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
 * computeBuildCacheKey().
 *
 * The install is staged through DESTDIR and renamed into place only once
 * `make install` succeeded and the manifest marker was written, so an
 * interrupted build can never be mistaken for a cache hit. DESTDIR rather
 * than a staging --prefix because the two are not equivalent: a PostgreSQL
 * install is only partly relocatable (binaries find share/ relative to
 * argv[0], but macOS bakes an absolute install_name for libpq into every
 * client program), so --prefix must already be the final path.
 */
export async function buildPostgres(input: BuildPostgresInput): Promise<PostgresBuildManifest> {
  const runCommand = input.runCommand ?? runCommandSafe;
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  const startedAt = Date.now();
  const configureArgs = [...(input.build?.configureArgs ?? DEFAULT_CONFIGURE_ARGS)];
  const cacheRoot = input.build?.cacheRoot || defaultCacheRoot();
  const jobs = Math.max(1, input.build?.jobs ?? Math.min(8, cpus().length || 1));
  const compiler = await detectCompilerIdentity({ runCommand });
  const makeVersion = await runCommand("make", ["--version"], { timeout: 15000 });
  const cacheKey = computeBuildCacheKey({
    sourceHash: input.source.sourceHash,
    configureArgs,
    platform: platform(),
    arch: arch(),
    compiler
  });
  const installDir = join(cacheRoot, cacheKey);
  const markerPath = join(installDir, "honeyrail-build.json");
  const base = {
    sourceRef: input.source.ref,
    sourceCommit: input.source.resolvedCommit,
    sourceHash: input.source.sourceHash,
    configureArgs,
    compiler,
    make: firstLine(makeVersion.stdout),
    platform: platform(),
    arch: arch(),
    profileVersion: BUILD_PROFILE_VERSION,
    cacheKey,
    cacheRoot,
    installDir,
    jobs
  };

  const cached = await readFile(markerPath, "utf8").catch(() => "");
  if (cached) {
    const marker = JSON.parse(cached) as { cacheKey?: string };
    if (marker.cacheKey === cacheKey) {
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
  const commands: PostgresBuildCommandRecord[] = [];

  async function step(name: string, command: string, args: string[], timeout: number, logName: string) {
    const stepStarted = Date.now();
    const result = await runCommand(command, args, {
      cwd: input.source.sourceDir,
      timeout,
      maxBuffer: 1024 * 1024 * 64
    });
    const durationMs = Date.now() - stepStarted;
    await writeFile(join(input.logDir, logName), `$ ${command} ${args.join(" ")}\n\n${result.stdout}\n${result.stderr}\n`);
    commands.push({ name, command, args, durationMs, logName });
    if (!result.ok) {
      throw new PostgresResearchError(
        `PostgreSQL ${name} failed (see ${logName}): ${(result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n")}`
      );
    }
  }

  // DESTDIR prepends the (absolute) prefix inside the staging root, so the
  // finished tree sits at staging + installDir and one rename publishes it.
  const stagedInstall = join(staging, installDir);
  try {
    await step(
      "configure",
      join(input.source.sourceDir, "configure"),
      [`--prefix=${installDir}`, ...configureArgs],
      timeouts.configure,
      "configure.log"
    );
    await step("make", "make", [`-j${jobs}`], timeouts.make, "make.log");
    await step("make install", "make", ["install", `DESTDIR=${staging}`], timeouts.install, "make-install.log");
    await writeFile(join(stagedInstall, "honeyrail-build.json"), JSON.stringify({ ...base, builtAt: nowIso() }, null, 2));
    try {
      await rename(stagedInstall, installDir);
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      // Another environment finished the identical build first. Its entry is
      // by definition equivalent (same cache key), so drop ours and use it.
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
  readonly root: string;
  readonly sourceDir: string;
  readonly installDir: string;
  readonly binDir: string;
  readonly dataDir: string;
  readonly socketDir: string;
  readonly logPath: string;
  readonly buildLogDir: string;
  readonly port: number;
  readonly host = "127.0.0.1";
  readonly user = "postgres";
  readonly database = "postgres";
  readonly label?: string;
  readonly sourceManifest: PostgresSourceManifest;
  readonly buildManifest: PostgresBuildManifest;
  readonly binaries: PostgresBinaries;

  private readonly runCommand: RunCommand;
  private readonly timeouts: PostgresResearchTimeouts;
  private readonly initdbArgs: string[];
  private readonly events: PostgresLifecycleEvent[] = [];
  private initialized = false;
  private running = false;
  private closed = false;
  private cleanupResult: PostgresCleanupResult | null = null;

  constructor(input: {
    root: string;
    sourceManifest: PostgresSourceManifest;
    buildManifest: PostgresBuildManifest;
    port: number;
    socketDir: string;
    runCommand: RunCommand;
    timeouts: PostgresResearchTimeouts;
    initdbArgs: string[];
    label?: string;
    events?: PostgresLifecycleEvent[];
  }) {
    this.root = input.root;
    this.sourceManifest = input.sourceManifest;
    this.buildManifest = input.buildManifest;
    this.sourceDir = input.sourceManifest.sourceDir;
    this.installDir = input.buildManifest.installDir;
    this.binaries = input.buildManifest.binaries;
    this.binDir = join(this.installDir, "bin");
    this.dataDir = join(input.root, "pgdata");
    this.socketDir = input.socketDir;
    this.logPath = join(input.root, "postgres.log");
    this.buildLogDir = join(input.root, "build");
    this.port = input.port;
    this.runCommand = input.runCommand;
    this.timeouts = input.timeouts;
    this.initdbArgs = input.initdbArgs;
    this.label = input.label;
    for (const event of input.events ?? []) this.events.push(event);
  }

  /**
   * Environment every command against this cluster runs under: the built
   * binaries first on PATH, and every inherited PG* variable dropped so an
   * operator's ambient PGHOST/PGPORT/PGDATA cannot silently redirect a
   * research experiment at some other server.
   */
  private commandEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("PG")) continue;
      env[key] = value;
    }
    env.PATH = `${this.binDir}:${process.env.PATH ?? ""}`;
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

  connectionInfo(): PostgresConnectionInfo {
    return {
      host: this.host,
      port: this.port,
      socketDir: this.socketDir,
      user: this.user,
      database: this.database,
      binDir: this.binDir,
      sourceDir: this.sourceDir,
      dataDir: this.dataDir,
      logPath: this.logPath,
      url: `postgresql://${this.user}@${this.host}:${this.port}/${this.database}`
    };
  }

  /**
   * Flat KEY=value view of connectionInfo() for handing to a subprocess (see
   * the agent-task `input.environment` hook). Carries connection and
   * filesystem coordinates only - never ref, commit, source hash or cache
   * key, which are exactly the things a historical-rediscovery agent must
   * not be able to read out of its own environment.
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
      lifecycle: this.lifecycleEvents(),
      cleanup: this.cleanupResult
    };
  }

  private async initdb() {
    if (this.initialized) return;
    const started = Date.now();
    const result = await this.runCommand(this.binaries.initdb, ["-D", this.dataDir, ...this.initdbArgs], {
      cwd: this.root,
      timeout: this.timeouts.initdb,
      env: this.commandEnv(),
      maxBuffer: 1024 * 1024 * 8
    });
    if (!result.ok) {
      throw new PostgresResearchError(`initdb failed: ${result.stderr || result.stdout}`);
    }
    this.initialized = true;
    this.record("cluster.initdb", { dataDir: this.dataDir, args: this.initdbArgs }, Date.now() - started);
  }

  private pgCtlOptions() {
    return `-p ${this.port} -h ${this.host} -k ${this.socketDir}`;
  }

  /** initdb (once) + pg_ctl start + readiness poll. */
  async start(): Promise<PostgresReadiness> {
    this.assertOpen();
    if (this.running) return { ready: true, latencyMs: 0 };
    await this.initdb();
    const started = Date.now();
    const result = await this.runCommand(
      this.binaries.pg_ctl,
      ["-D", this.dataDir, "-l", this.logPath, "-o", this.pgCtlOptions(), "start", "-w"],
      { cwd: this.root, timeout: this.timeouts.control, env: this.commandEnv(), maxBuffer: 1024 * 1024 * 8 }
    );
    if (!result.ok) {
      throw new PostgresResearchError(`pg_ctl start failed: ${result.stderr || result.stdout}`);
    }
    this.running = true;
    this.record("cluster.started", { port: this.port, socketDir: this.socketDir }, Date.now() - started);
    return this.waitReady();
  }

  private async waitReady(): Promise<PostgresReadiness> {
    const readiness = await waitForPostgresReady({
      runCommand: this.runCommand,
      cwd: this.root,
      psql: this.binaries.psql,
      port: this.port,
      host: this.host,
      user: this.user,
      database: this.database,
      env: this.commandEnv()
    });
    this.record("cluster.ready", { port: this.port, latencyMs: readiness.latencyMs });
    return readiness;
  }

  async restart(): Promise<PostgresReadiness> {
    this.assertOpen();
    if (!this.running) return this.start();
    const started = Date.now();
    const result = await this.runCommand(
      this.binaries.pg_ctl,
      ["-D", this.dataDir, "restart", "-m", "fast", "-w", "-l", this.logPath, "-o", this.pgCtlOptions()],
      { cwd: this.root, timeout: this.timeouts.control, env: this.commandEnv(), maxBuffer: 1024 * 1024 * 8 }
    );
    if (!result.ok) {
      throw new PostgresResearchError(`pg_ctl restart failed: ${result.stderr || result.stdout}`);
    }
    this.record("cluster.restarted", { port: this.port }, Date.now() - started);
    return this.waitReady();
  }

  async stop(mode: "fast" | "immediate" = "fast"): Promise<boolean> {
    if (!this.running) return true;
    const started = Date.now();
    const result = await this.runCommand(this.binaries.pg_ctl, ["-D", this.dataDir, "stop", "-m", mode, "-w"], {
      cwd: this.root,
      timeout: this.timeouts.control,
      env: this.commandEnv(),
      maxBuffer: 1024 * 1024 * 8
    });
    if (result.ok) this.running = false;
    this.record("cluster.stopped", { mode, ok: result.ok }, Date.now() - started);
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

  /** Same, for a SQL script an agent (or driver) wrote to disk. */
  async psqlFile(path: string): Promise<PostgresQueryResult> {
    this.assertOpen();
    if (!isAbsolute(path)) throw new PostgresResearchError(`psqlFile requires an absolute path, got "${path}"`);
    return this.runPsql(`\\i ${path}`, ["-v", "ON_ERROR_STOP=1", "-f", path]);
  }

  private async runPsql(sql: string, tail: string[]): Promise<PostgresQueryResult> {
    const started = Date.now();
    const result = await this.runCommand(
      this.binaries.psql,
      psqlArgs({ host: this.host, port: this.port, user: this.user, database: this.database }, tail),
      { cwd: this.root, timeout: this.timeouts.psql, env: this.commandEnv(), maxBuffer: 1024 * 1024 * 32 }
    );
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
   */
  async exec(command: string, args: string[] = [], options: { cwd?: string; timeout?: number } = {}) {
    this.assertOpen();
    return this.runCommand(command, args, {
      cwd: options.cwd ?? this.root,
      timeout: options.timeout ?? this.timeouts.psql,
      env: this.commandEnv(),
      maxBuffer: 1024 * 1024 * 32
    });
  }

  /**
   * Idempotent and non-throwing: cleanup runs from `finally` blocks where
   * throwing would mask the original failure. Stops the server (escalating
   * to immediate), then removes the ephemeral runtime state. The log file,
   * build logs and manifests stay behind as evidence; the shared build cache
   * is never touched.
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

    this.cleanupResult = {
      stopped,
      stopMode,
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
  await mkdir(spec.root, { recursive: true });

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
    logDir: join(spec.root, "build"),
    runCommand,
    timeouts
  });
  events.push({
    phase: "build.completed",
    at: buildManifest.builtAt,
    durationMs: buildManifest.durationMs,
    detail: { cacheKey: buildManifest.cacheKey, cacheHit: buildManifest.cacheHit, installDir: buildManifest.installDir }
  });

  await mkdir(socketRoot(), { recursive: true }).catch(() => {});
  const socketDir = await mkdtemp(join(socketRoot(), "hrpg-"));
  const port = await allocatePort();

  return new PostgresResearchEnvironment({
    root: spec.root,
    sourceManifest,
    buildManifest,
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
