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
- one agent process driving that live cluster, with cleanup ordered behind it
- a grader-private / agent-visible filesystem split that keeps ref, commit, source hash and cache key off every path the agent is handed
- source/build/runtime manifests as artifacts, lifecycle facts as evidence
- deterministic cleanup on success, throw, and timeout

Out of scope (tracked elsewhere): cross-step DAG composition of a live environment (an environment lease through the orchestration kernel — see [What is *not* wired](#what-is-not-wired-cross-step-dag-composition)), sandboxing the agent process, the historical bug corpus ([#178](https://github.com/clemenza/honeyrail/issues/178)), the first pilot over historical PG tasks ([#180](https://github.com/clemenza/honeyrail/issues/180)), and the generic `EvalProvider` abstraction ([#172](https://github.com/clemenza/honeyrail/issues/172)).

## Architecture

```text
materialize snapshot (git archive @ ref, no .git)
  -> build/reuse cache (configure + make + make install)
  -> initdb -> pg_ctl start -> readiness poll
  -> arbitrary SQL / scripts / binaries, or one agent process
  -> restart / stop
  -> artifacts + evidence
  -> guaranteed cleanup
```

Four pieces:

- `server/postgres/runtime.ts` — the low-level PostgreSQL mechanics shared with the alpha executor: `allocatePort()` (bind port 0 on loopback, read the port back), `isAddressInUseFailure()` and `waitForPostgresReady()` (poll `SELECT 1`). Extracted from `server/executors/postgres.ts`; its defaults reproduce the original behavior exactly.
- `server/postgres/research-environment.ts` — the environment itself. Store-agnostic and executor-agnostic, so it can be driven from a script, a test, or an executor.
- `server/postgres/research-session.ts` — `runAgentInPostgresResearchEnvironment()`: the one supported composition where an agent process drives a *live* cluster. See [Agent research surface](#agent-research-surface).
- `server/executors/postgres-research.ts` — the `postgres-research` executor: a thin wrapper that turns one environment into the runtime's standard Artifact/Evidence record.

## Module API

```ts
import { withPostgresResearchEnvironment } from "../server/postgres/research-environment.js";

const groupCount = await withPostgresResearchEnvironment(
  {
    root: agentVisibleDir,                              // snapshot + PGDATA + server log; agent-visible
    privateDir: graderOnlyDir,                          // build logs; defaults to `${root}-private`
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

An environment exposes `root`, `privateDir`, `sourceDir`, `installDir`, `dataDir`, `socketDir`, `logPath`, `port`, `binaries`, plus `start()`, `stop()`, `restart()`, `psql()`, `psqlFile()`, `exec()`, `cleanup()`, `connectionInfo()`, `agentEnvironment()`, `lifecycleEvents()` and `runtimeManifest()`.

`root` and `privateDir` are two different sides of the eval boundary, not two scratch directories — see [Private-truth boundary](#private-truth-boundary). `createPostgresResearchEnvironment()` refuses a `privateDir` nested inside `root`.

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

### The exact-snapshot invariant

The destination is **published, not filled in place**: the archive is extracted into a fresh sibling staging directory, checked for `.git`, and only then does the old destination get removed and the staging directory renamed over it.

That matters because `tar -x` overlays a directory rather than replacing it. Filling a non-empty destination would let a file that exists only in a *later* ref survive into a snapshot of an earlier one — and in historical mode that later file is the answer key:

```text
materialize <later ref>   -> FUTURE_FIX.txt exists
materialize <earlier ref> -> tar overlays the older tree, FUTURE_FIX.txt survives   ← the bug
```

Publishing atomically also means a failed materialization leaves either the previous snapshot intact or nothing at all — never a half-extracted tree that looks like an exact snapshot. Both properties are regression-tested (`re-materializing an earlier ref over a later snapshot leaves no file from the later ref`, `a failed materialization publishes nothing and leaves an existing snapshot untouched`).

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
| the declared build environment (below) | `CFLAGS=-O0` and `CFLAGS=-O2` are not interchangeable builds |

Configure args are hashed in the order given rather than sorted: reordering can change meaning for later-wins options, so the conservative choice is an occasional redundant rebuild rather than a possible wrong reuse. Build-environment variables *are* sorted — they are a map, and order carries no meaning.

### Build environment inputs

`configure` and `make` inherit the operator's environment, so variables in it can change the binaries without changing anything else in the key. HoneyRail therefore declares which of them are build inputs, records their values in `build-manifest.json`, and hashes them into the cache key (`BUILD_ENV_VARS` / `BUILD_ENV_PREFIXES` in `research-environment.ts`):

```text
AR  CC  CFLAGS  CPP  CPPFLAGS  CXX  CXXFLAGS  LD  LDFLAGS  LIBS
MACOSX_DEPLOYMENT_TARGET  MAKEFLAGS  NM  PKG_CONFIG  PKG_CONFIG_PATH
RANLIB  SDKROOT  STRIP        plus every  pgac_cv_*  autoconf cache override
```

`pgac_cv_*` is in the list because setting one overrides a `configure` probe outright — the Apple Silicon AVX2 workaround below is exactly that, and a build made with it is not the same build.

A spec can also declare `build.env`, which is applied to `configure`/`make` *and* hashed, so two profiles that differ only there cannot share an entry.

This is a declared pass-through, not a hermetic toolchain fingerprint. A machine-level toolchain change that none of those variables mentions (a system header update, a relinked `/usr/bin/ld`) is still invisible to the key; the compiler version and target cover the common case of that. Scope limit accepted for v0.

`configure --prefix` is the final path `cacheRoot/<entryId>`, but `make install` stages through `DESTDIR` and the finished tree is renamed into place only after the install succeeded and the completion marker was written, so an interrupted build can never be mistaken for a cache hit. `DESTDIR` rather than a staging prefix because the two are not equivalent: a PostgreSQL install is only partly relocatable — binaries find `share/` relative to `argv[0]`, but macOS bakes an absolute `install_name` for `libpq` into every client program, so a build installed under a temporary prefix and moved afterwards fails at `dyld` load time. If two environments race on the same key, the loser drops its staging copy and uses the winner's — by definition an equivalent build.

The cache root defaults to `~/.honeyrail/pg-research-build-cache`, overridable per spec or with `HONEYRAIL_PG_BUILD_CACHE`.

### The cache entry is agent-visible

`HR_PG_BIN_DIR` points inside a cache entry, so everything about that entry is readable by the agent. Two consequences are load-bearing:

- the entry directory is named by an **`entryId`** — a domain-separated one-way digest of the cache key — and never by the cache key itself, which is a stable identifier of the source under research;
- the only file HoneyRail writes into an entry is `honeyrail-build-complete.json`, holding `{ marker, entryId, profileVersion, completedAt }`. It exists so an interrupted build is not mistaken for a usable one and says nothing else. (v0 wrote `honeyrail-build.json` there, containing `sourceRef`, `sourceCommit`, `sourceHash` and `cacheKey` — `cat "$HR_PG_BIN_DIR/../honeyrail-build.json"` recovered all four. That file is gone.)

Full provenance lives in the `PostgresBuildManifest` the build returns, which the caller records grader-side.

**Apple Silicon build note:** near-HEAD PostgreSQL sources may fail `make` on arm64 macOS with `error: call to undeclared function 'x86_feature_available'`. This is a known clang cross-detection artifact — `configure`'s AVX2 attribute probe compiles and links cleanly on arm64 without ever emitting an AVX2 instruction, so it wrongly enables `USE_AVX2_WITH_RUNTIME_CHECK`, whose runtime check is x86-only. Work around it by exporting the autoconf cache variable before building: `export pgac_cv_avx2_support=no`. This does not touch PostgreSQL source and is unrelated to whatever bug is under research.

## Cluster lifecycle and isolation

Each environment gets its own:

- port — see [Port isolation](#port-isolation) below;
- `PGDATA` (`<root>/pgdata`), source snapshot (`<root>/source`), log (`<root>/postgres.log`) and build logs (`<privateDir>/build/`);
- socket directory, created with `mkdtemp` under a short-pathed temp root (`/tmp` by default, `HONEYRAIL_PG_SOCKET_ROOT` to override). Unix socket paths are limited to ~104 bytes, which an attempt directory under an attachment root exceeds on its own.

Every command against a cluster runs with the built binaries first on `PATH` and with all inherited `PG*` variables dropped, so an operator's ambient `PGHOST`/`PGPORT`/`PGDATA` cannot silently redirect an experiment at some other server.

Readiness is the same `SELECT 1` poll the alpha scenario uses (80 attempts, 125ms apart).

### Port isolation

`allocatePort()` binds port 0 on `127.0.0.1`, reads back the port the kernel assigned, and closes the listener. What that buys is a *candidate* port nothing else is currently using — not a reservation. The listener is released before PostgreSQL binds the same number, so there is a real time-of-check/time-of-use window in which another process can take it.

That window is narrow (the kernel hands out least-recently-used ephemeral ports) but it is not zero, so `start()` recovers instead of claiming it cannot happen: if `pg_ctl` fails and either its output or the tail of the server log says the address is already in use, a fresh port is allocated and the start is retried, up to `START_PORT_ATTEMPTS` (3) candidates. The retry is recorded as a `cluster.port.retry` lifecycle event. Any other startup failure is a hard failure on the first attempt — a research environment that cannot start must say so rather than thrash.

What is actually guaranteed: two environments get distinct `PGDATA`, socket directories and source trees unconditionally, and distinct ports with bounded recovery from the residual race. What is not: an OS-level port reservation. Building one was explicitly out of scope for v0.

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

An agent driving a research environment can read and grep the materialized source, write arbitrary SQL/shell repros, execute the built `postgres`/`psql`/`pg_ctl`, query the running server, and read its log. The coordinates it needs come from `PostgresResearchEnvironment.agentEnvironment()`:

| Variable | |
| --- | --- |
| `HR_PG_HOST`, `HR_PG_PORT`, `HR_PG_SOCKET_DIR`, `HR_PG_URL` | how to connect |
| `HR_PG_USER`, `HR_PG_DATABASE` | who to connect as |
| `HR_PG_BIN_DIR` | the built `psql`/`pg_ctl`/`postgres`/`initdb` |
| `HR_PG_SOURCE_DIR` | the exact `.git`-free snapshot |
| `HR_PG_DATA_DIR`, `HR_PG_LOG` | `PGDATA` and the server's own log |

Every one of those values is decided at runtime — the port, socket directory, snapshot path and install directory do not exist until the environment has been created.

### Live composition: `runAgentInPostgresResearchEnvironment()`

`server/postgres/research-session.ts` is the one supported path for an agent to drive a live cluster:

```ts
import { runAgentInPostgresResearchEnvironment } from "../server/postgres/research-session.js";

const session = await runAgentInPostgresResearchEnvironment(
  {
    root: agentVisibleDir,
    privateDir: graderOnlyDir,
    source: { repoPath: "/path/to/postgres-mirror", ref: "<exact sha>" },
    build: { jobs: 8 }
  },
  { command: "/path/to/agent-driver.sh", timeoutMs: 45 * 60 * 1000 }
);

session.agent;             // exit code, stdout/stderr, timedOut, duration
session.agentEnvironment;  // exactly what the agent process was given
session.source;            // grader-side provenance the agent never saw
session.build;
```

It materializes, builds, starts PostgreSQL, spawns the agent with `agentEnvironment()` merged into its environment and its cwd inside the agent-visible root, waits for it to exit, and only then tears the environment down. The ordering is the point: an agent whose server disappears mid-experiment produces garbage evidence rather than a failed trial. It holds on all four exits —

- clean exit;
- non-zero exit (an observation, not an environment failure — the same rule `psql()` follows);
- a hang, where `agent.timeoutMs` SIGTERMs then SIGKILLs the agent's whole **process group** (an agent is usually a shell that shells out; killing only the direct child leaves a grandchild holding the pipes) and teardown waits for it to actually exit;
- an unrunnable command, which throws `PostgresResearchError` with cleanup already done.

The agent process also gets the same `PG*` hygiene the environment applies to itself: every inherited `PG*` variable is dropped so an ambient `PGHOST`/`PGPORT` cannot redirect it at some other server, and `HR_PG_BIN_DIR` goes first on `PATH`. No path into HoneyRail's attachment tree is exported.

### What is *not* wired: cross-step DAG composition

`agent-task` has a small additive hook, `input.environment` — a flat map exported into the agent process before launch and mirrored to `$HR_STEP_DIR/environment.json`, validated at preflight (shell-safe names, no newlines/NUL):

```json
{
  "executor": "agent-task",
  "input": {
    "agent": "codex",
    "prompt": "Investigate the running PostgreSQL server.",
    "environment": { "HR_PG_HOST": "127.0.0.1", "HR_PG_PORT": "54321" }
  }
}
```

That hook is **static step input, captured at run creation**. It works for coordinates a driver already knows, and it cannot carry a research environment's port or socket directory, which only exist after `createPostgresResearchEnvironment()` has run. A `postgres-research` step is likewise self-contained — it materializes, builds, starts, experiments and tears down inside a single `start()`, leaving no window for a later step to attach.

So: **a `postgres-research` step followed by an `agent-task` step does not give the agent a live server**, and nothing in this PR claims it does. Live agent-driven research is composed through `runAgentInPostgresResearchEnvironment()`, outside the DAG. Wiring an environment lease through the orchestration kernel is deliberately not attempted here; if #180 needs it inside the DAG, that is its own change.

### Private-truth boundary

For historical rediscovery an agent must not be able to read the answer out of its own environment. The boundary is a **filesystem split**, not an omission from a variable map. Three trees exist:

```text
<root>                    agent-visible   source/, pgdata/, postgres.log
<privateDir>              grader-only     build/configure.log, make.log, make-install.log
<cacheRoot>/<entryId>     agent-visible   built binaries + completion marker
attachmentRoot/runs/...   grader-only     source/build/runtime manifests, evidence, copied logs
```

The rules that make it hold:

1. **Identity is written nowhere agent-visible.** `source.ref`, the resolved commit, the source tree hash and the cache key appear in no file and no path under `<root>` or under the cache entry. They exist only in the manifests the caller records grader-side.
2. **The cache entry is named by `entryId`, not by the cache key** (see [above](#the-cache-entry-is-agent-visible)), and holds only a completion marker.
3. **The agent-visible root is not inside the attachment tree.** The `postgres-research` executor creates it under `agentEnvRoot()` — `$HONEYRAIL_PG_ENV_ROOT`, default `<tmpdir>/honeyrail-pg-env` — precisely so that no `..` walk from `$HR_PG_SOURCE_DIR` arrives at `source-manifest.json`. The server log is *copied* into the attachment tree as an artifact rather than registered in place.
4. **The private directory may not be nested inside the agent root**; `createPostgresResearchEnvironment()` throws if a caller tries.
5. The snapshot has no `.git`, so the ref cannot be recovered from the tree either.
6. Whatever a driver puts in `input.environment` is agent-visible by construction, so it must carry coordinates only. The `harness.environment` evidence record stores key names and a content hash, not values.

This is enforced by tests that walk the trees rather than inspecting the environment map: `nothing reachable from agentEnvironment() reveals the source ref, commit, tree hash or cache key` and `the executor keeps full provenance grader-side and out of every agent-visible tree`.

**What this is not.** It is not a sandbox. An agent process with unrestricted filesystem access that knows where HoneyRail keeps its attachments can still read them — nothing here prevents that, and pretending otherwise is what the boundary is supposed to avoid. What the split guarantees is that no path HoneyRail *hands* the agent leads anywhere near the answer key, so recovering it requires deliberately going looking outside the research surface. Confining the agent process (container, sandbox, unprivileged user) is the operator's job and is not part of this primitive.

Two further limitations, stated because they are real:

- the snapshot is a genuine PostgreSQL tree, so it reveals the *version* under study even though it reveals nothing about the bug;
- the build cache is content-addressed and shared, so two trials over the same source land on the same `entryId` directory. An agent that can observe both can tell they share a build. Giving each trial its own install tree is not possible without breaking macOS's absolute `install_name` for `libpq`.

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

`experiments` is optional. Note that a step with no experiments is not a way to hand a live cluster to a later `agent-task` step — the environment is torn down when the step returns; see [What is *not* wired](#what-is-not-wired-cross-step-dag-composition). Input shape is validated in `preflight()`, so a misconfigured step is rejected at run creation, before anything is materialized or built.

The step's grader-private material (manifests, build logs, the copied server log) lands under `attachmentRoot/runs/<runId>/<stepId>/attempt-N/`; the environment's agent-visible root is created outside it, under `agentEnvRoot()`.

A failing experiment does not fail the step: the executor's job is to prove the environment worked and to record what the server returned. Deciding whether an observation is acceptable is a quality gate's job, using the `db.query.result` evidence.

The step succeeds only if the environment itself did: an unresolvable ref, a failed build, a cluster that never became ready, or a `timeoutMs` expiry all fail the step, with cleanup already done and the runtime manifest and PostgreSQL log still recorded.

### Artifacts

- `source-manifest.json` — repo path, ref, resolved commit, source hash, `gitDirPresent: false`
- `build-manifest.json` — configure args, compiler identity, declared build environment, make version, platform/arch, cache key, entry id, cache hit, install dir, binary paths, per-command durations
- `runtime-manifest.json` — ports/paths (including `root` and `privateDir`), initdb args, the full lifecycle event list, cleanup result
- `experiments.json` — the SQL that ran and what it returned
- `configure.log`, `make.log`, `make-install.log` — on a cold build
- `postgres.log` — the server's own log, copied out of the agent-visible root

All of these are grader-side. `source-manifest.json` and `build-manifest.json` in particular hold exactly the facts the agent must not see, which is why they live outside every agent-visible tree.

### Evidence

Reusing the existing `db.*` taxonomy where one fits, plus three new kinds for facts the alpha never had:

- `db.source.snapshot` — exact ref materialized, no `.git`
- `db.build` — cache key, cache hit, compiler, install dir
- `db.server.ready`, `db.query.result`, `db.restart`, `db.process.health` — as in the alpha
- `db.environment.cleanup` — what cleanup stopped and removed

## Testing

```sh
node --import tsx --test test/postgres-research-environment.test.ts
node --import tsx --test test/postgres-research-session.test.ts
node --import tsx --test test/agent-task-environment.test.ts
```

The suite runs against a synthetic source fixture (`test/helpers/postgres-source-fixture.ts`): a git repository whose `configure`/`make`/`make install` install four stub binaries that emulate just enough of `initdb`/`pg_ctl`/`psql`/`postgres` to exercise the real lifecycle in seconds. That keeps the whole matrix — no-`.git` snapshots, exact-ref resolution, snapshot republication, cache-key composition, cache hits, build-environment keying, concurrent isolation, port-collision recovery, the eval-isolation boundary, lifecycle, restart, live agent composition, and all the cleanup paths — runnable in CI without a PostgreSQL checkout or a C toolchain, and keeps the real corpus out of committed test code. Tests skip with a clear message when `git`, `make`, `tar` or a `cc` probe is unavailable.

The two race-shaped properties (a port collision, a failed `tar`) are tested with a stubbed `runCommand` that fails deterministically on the first attempt, not by hoping the OS reproduces the race.

Validating against real PostgreSQL is a manual step: populate a mirror as shown above, then drive `withPostgresResearchEnvironment()` over a pre-fix ref and its fix ref with the same build profile and the same reproducer, and confirm the two disagree. The build cache keys them apart automatically because their source hashes differ.

## Known limitations

- PostgreSQL only; local source builds only (no Docker path, no cross-compilation, no remote execution).
- One cluster per environment: no replication, no multi-node topology, no fault injection.
- The build cache is content-keyed but not garbage-collected; a corpus of many refs will grow it.
- Build-cache concurrency is safe (staged build + atomic rename) but not coordinated: two environments needing the same cold build may both build it.
- The cache key covers a declared set of build-environment variables, not a hermetic toolchain fingerprint.
- `timeoutMs` cancels the caller and tears down the cluster; it cannot abort a JavaScript `await` already in flight. For an agent, prefer `agent.timeoutMs` on the session helper, which kills the agent first and cleans up after.
- The eval boundary is a filesystem layout, not a sandbox: it keeps the answer key off every path the agent is handed, but confining the agent process is the operator's job.
- Live agent research is composed by `runAgentInPostgresResearchEnvironment()`, not by the DAG; a `postgres-research` step cannot hand a running cluster to a later step.
- The agent-visible root defaults to a temp root and, like v0, keeps the source snapshot after cleanup unless `removeSourceDir` is set. Long campaigns should set it, or point `HONEYRAIL_PG_ENV_ROOT` somewhere with room.
