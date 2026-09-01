# PostgreSQL Research Environment

HoneyRail's PostgreSQL Research Environment is the reusable infrastructure primitive behind M1 (Historical PostgreSQL Discovery Foundation): given an exact PostgreSQL source ref, it materializes an immutable snapshot of that ref, builds it, stands up one isolated ephemeral cluster, lets an agent run arbitrary local experiments against it, retains logs/artifacts/evidence, and guarantees cleanup.

It is deliberately bug-agnostic. Nothing in it knows which bug is being hunted, and there is no bug-specific branch anywhere in the code path: "buggy" and "fixed" differ only by the caller's `ref`.

This is a sibling of the [Database Testing Harness Alpha](database-testing-harness-alpha.md), not a replacement. `transaction-restart-alpha` still asserts fixed expectations about a stock PostgreSQL over Docker or local binaries; this one builds an exact source ref and runs whatever the caller asks.

## Scope

In scope (this is #179):

- exact source ref -> `.git`-free snapshot
- source build with a correctly-keyed build cache
- isolated ephemeral cluster: initdb / start / readiness / psql / restart / stop
- arbitrary local SQL and shell experiments against the running cluster
- source/build/runtime manifests as artifacts, lifecycle facts as evidence
- deterministic cleanup on success, throw, and timeout

Out of scope (tracked elsewhere): the historical bug corpus ([#178](https://github.com/clemenza/honeyrail/issues/178)), the first pilot over historical PG tasks ([#180](https://github.com/clemenza/honeyrail/issues/180)), and the generic `EvalProvider` abstraction ([#172](https://github.com/clemenza/honeyrail/issues/172)).

## Architecture

```text
materialize snapshot (git archive @ ref, no .git)
  -> build/reuse cache (configure + make + make install)
  -> initdb -> pg_ctl start -> readiness poll
  -> arbitrary SQL / scripts / binaries
  -> restart / stop
  -> artifacts + evidence
  -> guaranteed cleanup
```

Three pieces:

- `server/postgres/runtime.ts` — the low-level PostgreSQL mechanics shared with the alpha executor: `allocatePort()` (bind port 0 on loopback, read the port back) and `waitForPostgresReady()` (poll `SELECT 1`). Extracted from `server/executors/postgres.ts`; its defaults reproduce the original behavior exactly.
- `server/postgres/research-environment.ts` — the environment itself. Store-agnostic and executor-agnostic, so it can be driven from a script, a test, or an executor.
- `server/executors/postgres-research.ts` — the `postgres-research` executor: a thin wrapper that turns one environment into the runtime's standard Artifact/Evidence record.

## Module API

```ts
import { withPostgresResearchEnvironment } from "../server/postgres/research-environment.js";

const groupCount = await withPostgresResearchEnvironment(
  {
    root: attemptDir,                                   // this environment's private directory
    source: { repoPath: "/path/to/postgres-mirror", ref: "<exact sha>" },
    build: { configureArgs: ["--without-readline", "--without-zlib", "--without-icu"], jobs: 8 }
  },
  async (env) => {
    await env.start();                                  // initdb + pg_ctl start + readiness
    const result = await env.psqlFile("/tmp/repro.sql");
    return result.stdout;
  },
  { timeoutMs: 20 * 60 * 1000 }
);
```

`createPostgresResearchEnvironment(spec)` is available if a caller needs the environment without the `try/finally`, but `withPostgresResearchEnvironment()` is the intended entry point: cleanup is the default rather than caller discipline.

An environment exposes `sourceDir`, `installDir`, `dataDir`, `socketDir`, `logPath`, `port`, `binaries`, plus `start()`, `stop()`, `restart()`, `psql()`, `psqlFile()`, `exec()`, `cleanup()`, `connectionInfo()`, `agentEnvironment()`, `lifecycleEvents()` and `runtimeManifest()`.

`psql()` does not throw on SQL errors. A research environment exists to observe what the server actually does, including failures, so the caller decides what counts as a problem.

## Source materialization

The source comes from an explicit local repository or mirror path plus an exact ref. The module never fetches over the network: a scored trial must not depend on remote availability, and a fetch is also the easiest way to accidentally pull history past the ref. Populating that mirror is the driver's job.

```sh
git init --bare /var/cache/honeyrail/pg-mirror
git -C /var/cache/honeyrail/pg-mirror remote add origin https://github.com/postgres/postgres.git
git -C /var/cache/honeyrail/pg-mirror fetch --depth 1 origin <sha> [<sha> ...]
```

Materialization uses `git archive`, which writes the tree of one commit and nothing else:

- no `.git` directory, no reflog, no branches, no remotes;
- no history after the ref (in historical mode, later history *is* the answer key);
- the tree is then asserted to contain no `.git`, and materialization fails if it somehow does.

There is intentionally no "keep the git directory" option.

The ref is resolved once with `git rev-parse --verify <ref>^{commit}`. An unresolvable ref throws; it never falls back to `HEAD`. The recorded source hash is the commit's git **tree** object id, i.e. a content hash of exactly what was materialized.

## Build and cache key

The default profile is `--without-readline --without-zlib --without-icu`, and only the top-level `make` target is built — no contrib, no docs.

The cache key is `sha256` over a canonical JSON of:

| Component | Why |
| --- | --- |
| build profile version | changing the build recipe must invalidate every existing entry |
| source tree hash | different source must never share binaries |
| configure args (in order) | different flags produce different binaries |
| platform + arch | binaries are not portable across them |
| compiler command, version string, and `-dumpmachine` target | a different compiler produces different binaries |

Configure args are hashed in the order given rather than sorted: reordering can change meaning for later-wins options, so the conservative choice is an occasional redundant rebuild rather than a possible wrong reuse. This is a correctness property, not an optimization — a hit must never serve binaries built from different inputs.

`configure --prefix` is the final path `cacheRoot/<cacheKey>`, but `make install` stages through `DESTDIR` and the finished tree is renamed into place only after the install succeeded and the marker manifest was written, so an interrupted build can never be mistaken for a cache hit. `DESTDIR` rather than a staging prefix because the two are not equivalent: a PostgreSQL install is only partly relocatable — binaries find `share/` relative to `argv[0]`, but macOS bakes an absolute `install_name` for `libpq` into every client program, so a build installed under a temporary prefix and moved afterwards fails at `dyld` load time. If two environments race on the same key, the loser drops its staging copy and uses the winner's — by definition an equivalent build.

The cache root defaults to `~/.honeyrail/pg-research-build-cache`, overridable per spec or with `HONEYRAIL_PG_BUILD_CACHE`.

**Apple Silicon build note:** near-HEAD PostgreSQL sources may fail `make` on arm64 macOS with `error: call to undeclared function 'x86_feature_available'`. This is a known clang cross-detection artifact — `configure`'s AVX2 attribute probe compiles and links cleanly on arm64 without ever emitting an AVX2 instruction, so it wrongly enables `USE_AVX2_WITH_RUNTIME_CHECK`, whose runtime check is x86-only. Work around it by exporting the autoconf cache variable before building: `export pgac_cv_avx2_support=no`. This does not touch PostgreSQL source and is unrelated to whatever bug is under research.

## Cluster lifecycle and isolation

Each environment gets its own:

- port, from `allocatePort()` — bind port 0 on `127.0.0.1` and read the port back, so two environments created concurrently cannot collide;
- `PGDATA` (`<root>/pgdata`), source snapshot (`<root>/source`), log (`<root>/postgres.log`) and build logs (`<root>/build/`);
- socket directory, created with `mkdtemp` under a short-pathed temp root (`/tmp` by default, `HONEYRAIL_PG_SOCKET_ROOT` to override). Unix socket paths are limited to ~104 bytes, which an attempt directory under an attachment root exceeds on its own.

Every command against a cluster runs with the built binaries first on `PATH` and with all inherited `PG*` variables dropped, so an operator's ambient `PGHOST`/`PGPORT`/`PGDATA` cannot silently redirect an experiment at some other server.

Readiness is the same `SELECT 1` poll the alpha scenario uses (80 attempts, 125ms apart).

## Cleanup guarantees

`withPostgresResearchEnvironment()` cleans up in a `finally`, so cleanup runs after normal completion, after a thrown error, and after the optional `timeoutMs` elapses. `cleanup()` is idempotent and never throws — it is called from `finally` blocks where throwing would mask the original failure; problems are collected into the returned result instead.

Cleanup:

- stops the server with `pg_ctl stop -m fast`, escalating to `-m immediate`;
- removes `PGDATA` (unless `retainDataDir`) and the socket directory;
- removes the source snapshot only if `removeSourceDir` is set (it is kept by default for post-hoc inspection);
- never touches the shared build cache;
- keeps the PostgreSQL log, the build logs and all manifests — those are evidence.

After cleanup the environment is closed: further `psql()`/`exec()` calls throw rather than silently targeting a dead cluster.

A timeout rejects the caller and tears the cluster down immediately. JavaScript cannot abort the body's own in-flight `await`s, but with the cluster stopped anything still running fails fast instead of continuing unobserved.

## Agent research surface

An agent launched by `agent-task` against a research environment can read and grep the materialized source, write arbitrary SQL/shell repros, execute the built `postgres`/`psql`/`pg_ctl`, and inspect the PostgreSQL log and query output.

The connection surface is handed over through one small additive hook on `agent-task`: `input.environment`, a flat map of variables exported into the agent process before launch and mirrored to `$HR_STEP_DIR/environment.json`.

```json
{
  "executor": "agent-task",
  "input": {
    "agent": "codex",
    "prompt": "Investigate the running PostgreSQL server.",
    "environment": {
      "HR_PG_HOST": "127.0.0.1",
      "HR_PG_PORT": "54321",
      "HR_PG_SOURCE_DIR": "/.../pg-env/source",
      "HR_PG_BIN_DIR": "/.../pg-research-build-cache/<cacheKey>/bin"
    }
  }
}
```

`PostgresResearchEnvironment.agentEnvironment()` produces exactly that map.

This is deliberately the smallest possible seam rather than a generic "environment plugin" abstraction: a driver that stood up an environment already knows the coordinates, and the only thing `agent-task` was missing was a way to hand a subprocess *any* extra variables. `agent-task` itself stays ignorant of PostgreSQL, and the same hook serves any future environment kind. Values are validated (shell-safe names, no newlines/NUL) at preflight, so a malformed declaration is rejected before a run starts.

### Private-truth boundary

For historical rediscovery, an agent must not be able to read the answer out of its own environment. Two properties enforce that:

1. `agentEnvironment()` carries connection and filesystem coordinates only — **no ref, commit, source hash, or cache key** — and the snapshot it points at has no `.git`, so the ref cannot be recovered from the tree either.
2. Everything the executor records (source manifest, build manifest, runtime manifest, logs, evidence) lands under `attachmentRoot`, which is operator/grader side. It is never written into the agent's worktree or step directory.

Whatever a driver puts in `input.environment` is agent-visible by construction, so a driver must keep bug identity, fixed ref and canonical reproducers out of it. The `harness.environment` evidence record stores key names and a content hash, not values.

Known limitation: the snapshot is a real PostgreSQL tree, so it reveals the *version* under study even though it reveals nothing about the bug.

## Executor

`postgres-research` runs one environment and records the result.

```json
{
  "projectId": "proj_...",
  "goal": "PostgreSQL research environment",
  "steps": [
    {
      "id": "research",
      "name": "PostgreSQL research environment",
      "executor": "postgres-research",
      "input": {
        "source": { "repoPath": "/var/cache/honeyrail/pg-mirror", "ref": "<exact sha>" },
        "build": { "configureArgs": ["--without-readline", "--without-zlib", "--without-icu"], "jobs": 8 },
        "restart": true,
        "timeoutMs": 1800000,
        "experiments": [
          { "name": "repro", "sql": "SELECT count(*) FROM ..." }
        ]
      }
    }
  ]
}
```

`experiments` is optional; a step may start an environment purely so an agent can drive it. Input shape is validated in `preflight()`, so a misconfigured step is rejected at run creation, before anything is materialized or built.

A failing experiment does not fail the step: the executor's job is to prove the environment worked and to record what the server returned. Deciding whether an observation is acceptable is a quality gate's job, using the `db.query.result` evidence.

The step succeeds only if the environment itself did: an unresolvable ref, a failed build, a cluster that never became ready, or a `timeoutMs` expiry all fail the step, with cleanup already done and the runtime manifest and PostgreSQL log still recorded.

### Artifacts

- `source-manifest.json` — repo path, ref, resolved commit, source hash, `gitDirPresent: false`
- `build-manifest.json` — configure args, compiler identity, make version, platform/arch, cache key, cache hit, install dir, binary paths, per-command durations
- `runtime-manifest.json` — ports/paths, initdb args, the full lifecycle event list, cleanup result
- `experiments.json` — the SQL that ran and what it returned
- `configure.log`, `make.log`, `make-install.log` — on a cold build
- `postgres.log` — the server's own log

### Evidence

Reusing the existing `db.*` taxonomy where one fits, plus three new kinds for facts the alpha never had:

- `db.source.snapshot` — exact ref materialized, no `.git`
- `db.build` — cache key, cache hit, compiler, install dir
- `db.server.ready`, `db.query.result`, `db.restart`, `db.process.health` — as in the alpha
- `db.environment.cleanup` — what cleanup stopped and removed

## Testing

```sh
node --import tsx --test test/postgres-research-environment.test.ts
node --import tsx --test test/agent-task-environment.test.ts
```

The suite runs against a synthetic source fixture (`test/helpers/postgres-source-fixture.ts`): a git repository whose `configure`/`make`/`make install` install four stub binaries that emulate just enough of `initdb`/`pg_ctl`/`psql`/`postgres` to exercise the real lifecycle in seconds. That keeps the whole matrix — no-`.git` snapshots, exact-ref resolution, cache-key composition, cache hits, concurrent isolation, lifecycle, restart, and all three cleanup paths — runnable in CI without a PostgreSQL checkout or a C toolchain, and keeps the real corpus out of committed test code. Tests skip with a clear message when `git`, `make`, `tar` or a `cc` probe is unavailable.

Validating against real PostgreSQL is a manual step: populate a mirror as shown above, then drive `withPostgresResearchEnvironment()` over a pre-fix ref and its fix ref with the same build profile and the same reproducer, and confirm the two disagree. The build cache keys them apart automatically because their source hashes differ.

## Known limitations

- PostgreSQL only; local source builds only (no Docker path, no cross-compilation, no remote execution).
- One cluster per environment: no replication, no multi-node topology, no fault injection.
- The build cache is content-keyed but not garbage-collected; a corpus of many refs will grow it.
- Build-cache concurrency is safe (staged build + atomic rename) but not coordinated: two environments needing the same cold build may both build it.
- `timeoutMs` cancels the caller and tears down the cluster; it cannot abort a JavaScript `await` already in flight.
