# PostgreSQL Research Environment

HoneyRail's PostgreSQL Research Environment is the reusable infrastructure primitive behind M1 (Historical PostgreSQL Discovery Foundation): given an exact PostgreSQL source ref, it materializes an immutable snapshot of that ref, builds it, stands up one isolated ephemeral cluster, lets an agent run arbitrary local experiments against it, retains logs/artifacts/evidence, and guarantees cleanup.

It is deliberately bug-agnostic. Nothing in it knows which bug is being hunted, and there is no bug-specific branch anywhere in the code path: "buggy" and "fixed" differ only by the caller's `ref`.

This is a sibling of the [Database Testing Harness Alpha](database-testing-harness-alpha.md), not a replacement. `transaction-restart-alpha` still asserts fixed expectations about a stock PostgreSQL over Docker or local binaries; this one builds an exact source ref and runs whatever the caller asks.

## Scope

In scope (this is #179):

- exact source ref -> `.git`-free snapshot
- source build with a correctly-keyed build cache
- isolated ephemeral cluster in its own runtime container: initdb / start / readiness / psql / restart / stop, driven by `docker exec` and never by a host process in the scored path
- arbitrary local SQL and shell experiments against the running cluster
- one agent process driving that live cluster from a *second* container that bind-mounts only its research surface and reaches the server over a shared Unix socket, with cleanup ordered behind it
- source/build/runtime manifests as artifacts, lifecycle facts as evidence
- deterministic cleanup on success, throw, and timeout

Out of scope (tracked elsewhere): cross-step DAG composition of a live environment (an environment lease through the orchestration kernel — see [What is *not* wired](#what-is-not-wired-cross-step-dag-composition)), the historical bug corpus ([#178](https://github.com/clemenza/honeyrail/issues/178)), the first pilot over historical PG tasks ([#180](https://github.com/clemenza/honeyrail/issues/180)), and the generic `EvalProvider` abstraction ([#172](https://github.com/clemenza/honeyrail/issues/172)).

## Architecture

```text
materialize snapshot (git archive @ ref, no .git)
  -> build in a Linux *builder* container, configure --prefix=/opt/honeyrail/postgres
     -> make install DESTDIR=<staging>, publish <staging>/opt/honeyrail/postgres
        into the content-keyed cache (or reuse an existing entry)
  -> randomized per-trial view of that cache entry
  -> start a Linux *runtime* container holding the cluster
     -> docker exec initdb -> pg_ctl start -> readiness poll
  -> arbitrary SQL / scripts / binaries (docker exec into the runtime), or one
     *agent* container with --network none and only its research surface mounted,
     reaching the server over the shared Unix-socket directory
  -> restart / stop
  -> artifacts + evidence
  -> ordered cleanup
```

Three containers, and the distinction between them is the whole architecture:

| Container | Image | What it does | What it must never see |
| --- | --- | --- | --- |
| builder | `docker/postgres-research-builder` | `configure` / `make` / `make install` with the neutral prefix | anything but the snapshot and the DESTDIR staging root |
| runtime | `docker/postgres-research-runtime` | `initdb`, the postmaster, grader-driven `psql` | the source mirror, the cache root, grader manifests, the agent's scratch |
| agent | `docker/postgres-research` | whatever the research agent is | the cache root/entry id, grader manifests, sibling trials, the mirror, any `.git` |

The runtime and the agent communicate only through the trial's Unix-socket
directory, which both bind-mount from the same host path. Nothing else is
shared, and both run on `--network none`.

**In the scored path the host executes no PostgreSQL binary at all.** It builds
images, starts containers, `docker exec`s into them and records evidence. That
is what makes macOS and Windows real scored hosts: before the runtime
container existed, a container-mode build produced Linux ELF binaries and
`start()` then tried to run them on the host kernel, which on macOS is not a
degradation but an `exec format error`. See
[Platform support](#platform-support).

The pieces:

- `server/postgres/runtime.ts` — the low-level PostgreSQL mechanics shared with the alpha executor: `allocatePort()` (bind port 0 on loopback, read the port back), `isAddressInUseFailure()` and `waitForPostgresReady()` (poll `SELECT 1`). Extracted from `server/executors/postgres.ts`; its defaults reproduce the original behavior exactly.
- `server/postgres/research-environment.ts` — the environment itself. Store-agnostic and executor-agnostic, so it can be driven from a script, a test, or an executor.
- `server/postgres/container-paths.ts` — the fixed in-container paths, and with them the single definition of `/opt/honeyrail/postgres`, which is *both* the compiled-in `configure --prefix` and the mount target the build is exposed at. A leaf module so both sides can import it without an ESM cycle. See [Why the configure prefix is a constant](#why-the-configure-prefix-is-a-constant).
- `server/postgres/build-container.ts` — the Linux build container: what a build step's `docker run` looks like, and how the builder image's identity is read back so it can key the build cache.
- `server/postgres/runtime-container.ts` — the PostgreSQL **runtime sidecar**: a long-lived container created with `docker run -d --network none`, driven with `docker exec` for `initdb`, `pg_ctl`, `psql` and health, and removed with `docker rm -f`. PostgreSQL-specific and store/executor agnostic; deliberately not a generic container/lease abstraction. See [Where the scored cluster runs](#where-the-scored-cluster-runs).
- `server/postgres/image-identity.ts` — one `docker image inspect`, for the builder, runtime and agent alike: reference, content-addressed id, registry digest (when there is one), os and architecture. A leaf module, because every container axis needs the identical fact and none may import the others. There is deliberately no implicit `docker pull`.
- `server/postgres/build-view.ts` — the randomized per-trial hard-link view of a cache entry, and the completion marker it excludes. A leaf module for the same reason: the runtime container and the agent container mount the *same* view, so both `research-environment.ts` and `agent-container.ts` import it.
- `server/postgres/research-session.ts` — `runAgentInPostgresResearchEnvironment()`: the one supported composition where an agent process drives a *live* cluster. See [Agent research surface](#agent-research-surface).
- `server/postgres/agent-container.ts` — the isolated launch path for that agent: which host paths are bind-mounted, at which in-container paths, and how the selected build is exposed without its identity. See [Agent execution boundary](#agent-execution-boundary).
- `server/executors/postgres-research.ts` — the `postgres-research` executor: a thin wrapper that turns one environment into the runtime's standard Artifact/Evidence record.

`server/containers/hardening.ts` holds the `docker run` hardening flags shared with `scripts/tinytable-exam-room.ts` (#105), so both isolated launch paths enforce the same container posture rather than two drifting copies of it.

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

An environment exposes `root`, `privateDir`, `sourceDir`, `installDir`, `dataDir`, `socketDir`, `logPath`, `port`, `binaries`, `buildView`, `runtimeMode`, `runtimeImage`, plus `start()`, `stop()`, `restart()`, `psql()`, `psqlFile()`, `exec()`, `health()`, `cleanup()`, `connectionInfo()`, `agentEnvironment()`, `runtimeIsolation()`, `lifecycleEvents()` and `runtimeManifest()`.

In the scored (`container`) mode every one of the PostgreSQL-touching methods is a `docker exec` into the runtime sidecar rather than a host process; `exec()` takes `{ inRuntime: true }` for anything that has to run against the built binaries themselves.

`root` and `privateDir` are two different sides of the eval boundary, not two scratch directories — see [Agent execution boundary](#agent-execution-boundary). `createPostgresResearchEnvironment()` refuses a `privateDir` nested inside `root`.

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

The destination is **published, not filled in place**: the archive is extracted into a fresh sibling staging directory, checked for `.git`, and only then swapped into place.

That matters because `tar -x` overlays a directory rather than replacing it. Filling a non-empty destination would let a file that exists only in a *later* ref survive into a snapshot of an earlier one — and in historical mode that later file is the answer key:

```text
materialize <later ref>   -> FUTURE_FIX.txt exists
materialize <earlier ref> -> tar overlays the older tree, FUTURE_FIX.txt survives   ← the bug
```

The swap is **rollback-safe, not atomic**. POSIX has no atomic directory replacement, so publishing is two renames, and saying otherwise would overstate it. An existing snapshot is renamed aside to a random sibling backup rather than deleted, which gives three precise guarantees:

| Failure point | Result |
| --- | --- |
| extraction or `.git` validation | nothing is touched; the previous snapshot stands, and nothing is published into a fresh destination |
| the publish rename itself | the backup is renamed back into place, so the destination is again the previous snapshot, whole |
| none (success) | the destination is an exact clean snapshot of the ref, and the backup is removed |

Staging directory, tarball and backup are cleaned up on every path, and all three are siblings of the destination so no rename crosses a filesystem. If *both* the publish and the rollback rename fail, the previous snapshot is deliberately left behind under its `.backup-<rand>` name rather than deleted — losing the only copy would be worse than leaving a stray directory.

All three rows are regression-tested (`re-materializing an earlier ref over a later snapshot leaves no file from the later ref`, `a failed extraction publishes nothing and leaves an existing snapshot untouched`, `a failure at the publish rename rolls the previous snapshot back into place`). The last one injects the failure at the rename itself through `materializePostgresSource`'s `publishRename` seam, because a mocked `tar` failure cannot reach that stage.

## Build

The default profile is `--without-readline --without-zlib --without-icu`, and only the top-level `make` target is built — no contrib, no docs.

### Where the scored build runs

`configure`, `make` and `make install` run **inside a pinned Linux container**, `docker/postgres-research-builder/Dockerfile` (`honeyrail-postgres-builder:latest`: Debian bookworm plus `build-essential`, `bison`, `flex`, `perl`). This is `build.mode: "container"`, the default and the only **scored** mode.

```sh
docker build -t honeyrail-postgres-builder:latest docker/postgres-research-builder
```

Each of the three steps is one `docker run` with:

```text
--network none              a build must not depend on, or reach, the network
--cap-drop=ALL --security-opt no-new-privileges
--user <host uid:gid>       the staged install is owned by the user that owns the cache
--tmpfs /tmp                the compiler's scratch space; the root fs is otherwise untouched
-v <snapshot>:/build/source:rw     PostgreSQL builds in-tree, so the snapshot is writable
-v <staging>:/build/staging:rw     the DESTDIR target
-e PATH=... -e HOME=/tmp -e LC_ALL=C -e LANG=C  plus the declared build variables
```

Nothing else is mounted and **nothing of the host environment is inherited** — the same discipline the agent container uses. A build that silently picked up the operator's `CFLAGS` would produce binaries the cache key does not describe. A step that fails or times out is followed by a `docker kill` on the named container, because a step timeout kills the local `docker` client and not the container behind it.

`build.mode: "host"` runs the same three steps as ordinary host processes. It exists for local development and for hosts without a docker daemon, and it is **permanently un-scored**: its manifest carries `scoredEligible: false` and an `unscoredReason`, and a session over it records `isolation.scoredEligible: false` — exactly the way `allowUnisolatedForDevelopment` marks an unisolated agent run. `HONEYRAIL_PG_BUILD_MODE=host` sets it globally for a development machine.

### Why the configure prefix is a constant

Every build, in every mode, is configured with the fixed literal:

```text
configure --prefix=/opt/honeyrail/postgres
```

That string is `RESEARCH_CONTAINER_PATHS.postgres` in `server/postgres/container-paths.ts`, imported by both the build and the agent launcher, so the compiled-in prefix and the mount target are provably the same string rather than two literals that happen to agree.

It has to be a constant because `--prefix` is **compiled into the installation**. `pg_config --bindir`, `--libdir`, `--sharedir` and `--configure` report it verbatim; it also lands in `lib/pgxs/src/Makefile.global`, in `pkg-config` metadata, and inside binaries where `strings` finds it. Earlier revisions configured with the real cache path, `<cacheRoot>/<entryId>` — so an agent recovered the deterministic entry ID by running the `pg_config` it was handed. No filesystem escape was needed, and randomizing the *mount source* could not take it back: those strings were compiled in long before the mount existed.

The cache entry still lives at `<cacheRoot>/<entryId>`. `make install DESTDIR=<staging>` is what puts the files there without the binaries ever learning about it: `DESTDIR` prepends the prefix under the staging root, so the finished tree is at `<staging>/opt/honeyrail/postgres`, and **that subtree** — not the staging root — is renamed into the cache entry. If it is missing, the build fails loudly rather than publishing a wrong tree.

Two consequences worth stating:

- PostgreSQL tolerates the resulting prefix/location mismatch because its programs locate `share/` relative to `argv[0]`, not by the compiled prefix. Shared-library lookup does *not*: `RUNPATH` (and, on macOS, libpq's baked-in `install_name`) still names the neutral prefix. Inside the agent container that simply resolves, because the build is mounted exactly there. For **host**-side execution the environment sets `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` to the cache entry's real `lib/` — see `commandEnv()` in `research-environment.ts`.
- `installPrefix` is recorded in every build manifest, so a reviewer can see the fact rather than infer it.

What `pg_config` reports inside the agent container, verbatim from `test/postgres-research-real-build.test.ts` against a real PostgreSQL 16.9 build:

```text
$ pg_config --bindir     -> /opt/honeyrail/postgres/bin
$ pg_config --libdir     -> /opt/honeyrail/postgres/lib
$ pg_config --sharedir   -> /opt/honeyrail/postgres/share
$ pg_config --configure  ->  '--prefix=/opt/honeyrail/postgres' '--without-readline' '--without-zlib' '--without-icu'
```

### Cache key

The cache key is `sha256` over a canonical JSON of:

| Component | Why |
| --- | --- |
| build profile version | changing the build recipe must invalidate every existing entry |
| source tree hash | different source must never share binaries |
| configure args (in order) | different flags produce different binaries |
| install prefix | invariant today; in the key so that the day it stops being invariant, entries do not silently mix |
| build mode (`container`/`host`) | a host build must never satisfy a container lookup |
| builder image reference **and content-addressed image ID** | `:latest` is mutable — a rebuilt builder image must invalidate what it produced, not silently serve it |
| target platform + arch | binaries are not portable across them. In container mode these are the *image's* (`linux`/`arm64`), not the host's: two different hosts driving the same builder image produce interchangeable binaries and should share one entry |
| compiler command, version string, and `-dumpmachine` target — **observed inside the build container** | once compilation moved into a container, the host's `cc` is not the compiler that produced anything |
| the declared build environment (below) | `CFLAGS=-O0` and `CFLAGS=-O2` are not interchangeable builds |

Configure args are hashed in the order given rather than sorted: reordering can change meaning for later-wins options, so the conservative choice is an occasional redundant rebuild rather than a possible wrong reuse. Build-environment variables *are* sorted — they are a map, and order carries no meaning.

### Build-image identity and cache invalidation

`resolveBuilderImageIdentity()` reads the image back from the daemon rather than trusting the tag, and **fails loudly if the image is absent** — with the `docker build` command that would create it. There is deliberately no implicit `docker pull`: a scored build must not depend on remote availability, and a pull is also exactly how a mutable tag quietly changes toolchains underneath a cache.

It records three things, and keys on two:

- `reference` — the configured tag (keyed).
- `id` — the content-addressed image config digest, always available (keyed). This is what makes a rebuilt `:latest` invalidate its own entries.
- `digest` — `RepoDigests[0]`, the registry manifest digest. **`null` for an image that was only ever built locally and never pushed**, which is the normal case for `honeyrail-postgres-builder:latest` built from this repository; the local validation run for this change recorded `digest: null` and `id: sha256:d86e4ba0…`. Recorded for reviewers and for reproducing a build elsewhere, but not keyed: keying on it would invalidate an entry the first time the same image got pushed somewhere, which is not a toolchain change.

The builder image and the agent image (`docker/postgres-research/Dockerfile`) are a **pair** — the first compiles against glibc 2.36, the second runs against glibc 2.36, and both are bookworm. Change one and change the other; the cache key notices the builder half automatically.

This is not bit-for-bit hermeticity and is not claimed as such. The build container fixes the toolchain, the locale and the environment, but the image itself is built from a Debian package index that moves, so two `docker build`s a month apart can differ — which is precisely why the image *ID* is in the key rather than only its tag.

### Build environment inputs

In `host` mode `configure` and `make` inherit the operator's environment, so variables in it can change the binaries without changing anything else in the key. HoneyRail therefore declares which of them are build inputs, records their values in `build-manifest.json`, and hashes them into the cache key (`BUILD_ENV_VARS` / `BUILD_ENV_PREFIXES` in `research-environment.ts`):

```text
AR  CC  CFLAGS  CPP  CPPFLAGS  CXX  CXXFLAGS  LD  LDFLAGS  LIBS
MACOSX_DEPLOYMENT_TARGET  MAKEFLAGS  NM  PKG_CONFIG  PKG_CONFIG_PATH
RANLIB  SDKROOT  STRIP        plus every  pgac_cv_*  autoconf cache override
```

`pgac_cv_*` is in the list because setting one overrides a `configure` probe outright — the Apple Silicon AVX2 workaround below is exactly that, and a build made with it is not the same build.

A spec can also declare `build.env`, which is applied to `configure`/`make` *and* hashed, so two profiles that differ only there cannot share an entry.

In `container` mode the picture is stronger: the build container inherits **nothing** from the host, so the same list is not a pass-through but an allow-list — those variables are the only ones passed in with `-e`, alongside a fixed `PATH`, `HOME` and `LC_ALL`/`LANG`. The "a system header update is invisible to the key" caveat that applied to host builds is covered instead by the builder image's content ID, which changes whenever the image's contents do.

The staged tree is renamed into place only after `make install` succeeded and the completion marker was written, so an interrupted build can never be mistaken for a cache hit. If two environments race on the same key, the loser drops its staging copy and uses the winner's — by definition an equivalent build.

The cache root defaults to `~/.honeyrail/pg-research-build-cache`, overridable per spec or with `HONEYRAIL_PG_BUILD_CACHE`.

### The cache entry stays grader-side

The cache root, the entry directory and the `entryId` that names it are **never** exposed to an isolated agent. The entry holds one HoneyRail-written file, `honeyrail-build-complete.json` (`{ marker, entryId, profileVersion, completedAt }`), so an interrupted build is not mistaken for a usable one; it says nothing else, and it is excluded from the view the agent sees. Full provenance lives in the `PostgresBuildManifest` the build returns, which the caller records grader-side.

An agent gets the *binaries*, at a fixed neutral path, through a per-trial view — see [Exposing the build without its identity](#exposing-the-build-without-its-identity).

**Apple Silicon build note (host mode only):** near-HEAD PostgreSQL sources may fail `make` on arm64 macOS with `error: call to undeclared function 'x86_feature_available'`. This is a known clang cross-detection artifact — `configure`'s AVX2 attribute probe compiles and links cleanly on arm64 without ever emitting an AVX2 instruction, so it wrongly enables `USE_AVX2_WITH_RUNTIME_CHECK`, whose runtime check is x86-only. Work around it by exporting the autoconf cache variable before building: `export pgac_cv_avx2_support=no`. This does not touch PostgreSQL source and is unrelated to whatever bug is under research. It does **not** apply to the default containerized build, which compiles with Debian gcc inside a Linux container regardless of the host.

## Cluster lifecycle and isolation

Each environment gets its own:

- port — see [Port isolation](#port-isolation) below;
- `PGDATA` (`<root>/pgdata`), source snapshot (`<root>/source`), log (`<root>/postgres.log`) and build logs (`<privateDir>/build/`);
- socket directory, created with `mkdtemp` under a short-pathed temp root (`/tmp` by default, `HONEYRAIL_PG_SOCKET_ROOT` to override). Unix socket paths are limited to ~104 bytes, which an attempt directory under an attachment root exceeds on its own.

Every command against a cluster runs with the built binaries first on `PATH` and with all inherited `PG*` variables dropped, so an operator's ambient `PGHOST`/`PGPORT`/`PGDATA` cannot silently redirect an experiment at some other server.

Readiness is the same `SELECT 1` poll the alpha scenario uses (80 attempts, 125ms apart).

### Where the scored cluster runs

`build.mode: "container"` (the default, and the only scored mode) runs the
cluster inside the runtime sidecar. Nothing PostgreSQL is executed by the host:

```text
docker run -d --network none ... honeyrail-postgres-runtime <inert PID 1>
docker exec <rt> /opt/honeyrail/postgres/bin/initdb  -D /runtime/pgdata ...
docker exec <rt> /opt/honeyrail/postgres/bin/pg_ctl  -D /runtime/pgdata -l /runtime/postgres.log \
                                                     -o "-p <port> -h '' -k /runtime/socket" start -w
docker exec <rt> /opt/honeyrail/postgres/bin/psql    -h /runtime/socket -p <port> ...
docker exec <rt> /opt/honeyrail/postgres/bin/pg_ctl  -D /runtime/pgdata stop -m fast -w
docker rm -f <rt>
```

The long-lived container with an inert PID 1 is load-bearing, not stylistic.
`pg_ctl start` daemonizes: the postmaster is reparented to PID 1 and outlives
the `docker exec` that launched it — but only for as long as the container
lives. A `docker run --rm` whose controlling process exits would take the
cluster down with it or orphan it, which is why the container is created once
and every lifecycle step is an `exec` into it.

Mounts, and nothing else:

```text
randomized per-trial build view -> /opt/honeyrail/postgres  ro
PGDATA                          -> /runtime/pgdata          rw
socket directory                -> /runtime/socket          rw
server log                      -> /runtime/postgres.log    rw
generated passwd / group        -> /etc/passwd, /etc/group  ro
(tmpfs)                         -> /tmp                     rw
```

Never mounted into the runtime: the source snapshot or mirror, any `.git`,
HoneyRail's attachment tree, the grader-private directory, the shared build
cache root, a sibling trial's directories, the HoneyRail checkout, the home
directory, or the docker socket.

`-h ''` is an empty `listen_addresses`: the postmaster does not listen on TCP
at all, in its own network namespace or anywhere else, and no host port is
published. The port number survives only as the socket file's name
(`.s.PGSQL.<port>`).

Both containers run as the **host** uid/gid, so `PGDATA`, the socket directory
and the log are owned by the user that has to clean them up afterwards, with
nothing pre-chowned. That creates one problem worth naming: PostgreSQL calls
`getpwuid()` on its effective uid before it does anything else, and an
arbitrary host uid has no entry in any stock image —

```text
initdb: could not look up effective user ID 71393735: user does not exist
```

— so the runner generates a two-line `passwd`/`group` pair per trial and
bind-mounts them read-only over `/etc/passwd` and `/etc/group`. They contain
the trial's own uid/gid and nothing else, they live in their own temp
directory (not under `privateDir`, so no grader path lands in the runtime's
mount table), and they are removed by cleanup. Baking a fixed user into the
image would only work for hosts that happen to share its uid. The mirror-image
case is a host running as root: PostgreSQL refuses uid 0, so the runtime runs
as a fixed non-root uid and the trial's ephemeral directories are chowned to it
first — root can still remove them afterwards.

`build.mode: "host"` keeps the original host-process lifecycle for local
development on a machine without docker. It is permanently unscored on **two**
axes now: `PostgresBuildManifest.scoredEligible` and
`PostgresRuntimeRecord.scoredEligible` are both `false`, exactly the way
`isolation.allowUnisolatedForDevelopment` marks an unisolated agent run.

### Port isolation

`allocatePort()` binds port 0 on `127.0.0.1`, reads back the port the kernel assigned, and closes the listener. What that buys is a *candidate* port nothing else is currently using — not a reservation. The listener is released before PostgreSQL binds the same number, so there is a real time-of-check/time-of-use window in which another process can take it.

That window is narrow (the kernel hands out least-recently-used ephemeral ports) but it is not zero, so `start()` recovers instead of claiming it cannot happen: if `pg_ctl` fails and either its output or the tail of the server log says the address is already in use, a fresh port is allocated and the start is retried, up to `START_PORT_ATTEMPTS` (3) candidates. The retry is recorded as a `cluster.port.retry` lifecycle event. Any other startup failure is a hard failure on the first attempt — a research environment that cannot start must say so rather than thrash.

What is actually guaranteed: two environments get distinct `PGDATA`, socket directories and source trees unconditionally, and distinct ports with bounded recovery from the residual race. What is not: an OS-level port reservation. Building one was explicitly out of scope for v0.

## Cleanup guarantees

`withPostgresResearchEnvironment()` cleans up in a `finally`, so cleanup runs after normal completion, after a thrown error, and after the optional `timeoutMs` elapses. `cleanup()` is idempotent and never throws — it is called from `finally` blocks where throwing would mask the original failure; problems are collected into the returned result instead.

Cleanup, in this order — the order is the contract, and every step runs
unconditionally so a failure earlier in the sequence cannot leak a later
resource:

```text
agent finishes, or is killed for exceeding its timeout
  -> agent container exits / is `docker kill`ed
  -> PostgreSQL `pg_ctl stop -m fast`
  -> escalate to `-m immediate` if fast did not take
  -> runtime container `docker rm -f`
  -> PGDATA (unless `retainDataDir`) and the socket directory removed
  -> the generated passwd/group identity shim removed
  -> this trial's randomized build view removed
```

- the source snapshot is removed only if `removeSourceDir` is set (it is kept by default for post-hoc inspection);
- the shared build cache is never touched — its entry, including the completion marker, survives every trial;
- the PostgreSQL log, the build logs and all manifests are kept: they are evidence.

`PostgresCleanupResult` records `runtimeContainerRemoved` and
`buildViewRemoved` alongside the existing fields, so "nothing leaked" is an
assertion a reviewer can read rather than infer.

The agent is already gone before any of this runs:
`runAgentInPostgresResearchEnvironment()` only reaches
`withPostgresResearchEnvironment()`'s `finally` after the agent process has
actually exited, including when it was killed for exceeding `agent.timeoutMs`.
An agent whose server disappears mid-experiment produces garbage evidence
rather than a failed trial, which is why the ordering is fixed rather than
merely eventual.

After cleanup the environment is closed: further `psql()`/`exec()` calls throw rather than silently targeting a dead cluster.

### Session timeout vs agent timeout (#188)

`withPostgresResearchEnvironment()`'s `body` receives an `AbortSignal` alongside `env`. When the outer `timeoutMs` elapses, that signal is aborted *before* the caller's promise rejects, and `finally` then waits - bounded by `cancelGraceMs` (default 45s) - for the body to actually settle before running `env.cleanup()`. A body that observes the signal (which `runAgentInPostgresResearchEnvironment()`'s does) settles well inside that bound, so cleanup runs immediately behind the kill rather than racing it. `cancelGraceExceeded` means the body did not settle within that bound - whether because it ignored `signal` entirely, or because it observed cancellation but whatever it was waiting on stalled past the grace period; either way, cleanup proceeded without confirmation that the body's own resources had actually stopped, and `PostgresCleanupResult.cancelGraceExceeded` records that this happened rather than hiding it.

In isolated mode, "the agent settles" specifically means `terminateResearchContainer()` (`server/postgres/agent-container.ts`) has been *awaited to completion* - and, since the third review round, that its outcome is *confirmed*, not merely requested. `docker kill` (SIGKILL by default) is followed, if it did not succeed, by `docker rm -f`, and if neither reports success, by an independent `docker inspect` before giving up: "our command failed" and "the container is still there" are different facts, and only the second is what determines the outcome. "No such container"/"No such object" is success at any step - every research container runs `--rm`, so one already gone has already been removed. Only once this has settled does `runAgentProcess()` escalate to SIGTERM/SIGKILL on the local `docker run` client process - so a client that later exits on its own is never mistaken for a container that was actually terminated by us.

`runAgentProcess()` does not resolve on child-close alone, either: the local client closing is not proof that a *requested* termination has settled - the agent can exit at the same moment as a timeout, the docker CLI can die for an unrelated reason, or the container can exit on its own while `terminateResearchContainer()` is still resolving (#188 review, second round). Once a cancellation has started, its promise - `requestCancel()`'s, shared by whichever cause started it, so agent-timeout and session-timeout still cannot double-kill - is awaited in addition to the child closing, not instead of it, regardless of which of the two actually settles last.

Two independent deadlines can therefore both want to kill the same agent: the session's `options.timeoutMs` and the agent's own `agent.timeoutMs`. Both route through the same idempotent kill sequence in `runAgentProcess()`, so **whichever fires first wins** - there is no separate precedence rule to configure - and the other is a harmless no-op against an already-killed agent, including when both fire at effectively the same moment. Which one actually fired is recorded on `PostgresResearchAgentResult.timeoutSource` (`"agent" | "session"`) when the call resolves normally (an agent-level timeout, like a non-zero exit, is an observation, not a rejection); a session-level timeout instead rejects the caller with `PostgresResearchTimeoutError`, which carries a `runtimeManifest` property (the environment's `runtimeManifest()`, including `cleanup.sessionTimedOut`) so that rejection is not evidence-free. It also carries `agentTermination` (`{ timeoutSource, terminationError?, confirmedStopped? }`) whenever an agent cancellation was observed to have started - `runAgentInPostgresResearchEnvironment()` captures it from inside the body the instant `runAgentProcess()` resolves, so a failed Docker termination request is not lost just because the timeout race discarded the agent's own full result.

**If confirmation still fails, cleanup fails closed.** A container termination that could not be confirmed - `confirmedStopped: false` - is never treated as a settled cancellation. The body calls `env.markAgentTerminationUnconfirmed()`, and `env.cleanup()` checks this *first*: PGDATA, the socket directory, the build view and the runtime container are all bind-mounted into the agent container too, so none of them are removed, and PostgreSQL is not stopped, while that container may still be alive and using them. `PostgresCleanupResult.agentTerminationUnconfirmed: true` and `stopMode: "skipped-unconfirmed-termination"` record that nothing destructive was even attempted - not that an attempt failed - and `errors` carries the explanation. The session timeout remains the primary, unmasked error either way; this is retained evidence and resources, not a silent leak.

**Timeout budget.** `terminateResearchContainer()`'s escalation is bounded by `CONTAINER_TERMINATION_WORST_CASE_MS` (`CONTAINER_TERMINATION_TIMEOUT_MS × 3` - one attempt each for kill, the `rm -f` fallback, and the `inspect` confirmation - 30s), and the local-client SIGTERM→SIGKILL escalation by `KILL_GRACE_MS` (5s); `research-session.ts`'s `MIN_AGENT_CANCEL_GRACE_MS` adds a `CANCELLATION_SAFETY_MARGIN_MS` (5s) on top of their sum, and is asserted at import time to stay at or below `DEFAULT_CANCEL_GRACE_MS` (45s). That relationship, not any single constant, is what keeps a merely-slow-but-successful cancellation from being misreported as `cancelGraceExceeded`. `runAgentInPostgresResearchEnvironment()` additionally *rejects*, before any trial side effect, a caller-supplied `cancelGraceMs` below `MIN_AGENT_CANCEL_GRACE_MS` - `withPostgresResearchEnvironment()` itself enforces no floor, since it is generic and cannot know what an arbitrary body needs, so this validation belongs in the one place that knows this path's own budget.

## Agent research surface

An agent driving a research environment can read and grep the materialized source, write arbitrary SQL/shell repros, execute the built `postgres`/`psql`/`pg_ctl`, query the running server, and read its log. The coordinates it needs are injected into its environment:

| Variable | | Isolated value |
| --- | --- | --- |
| `HR_PG_HOST`, `HR_PG_SOCKET_DIR` | how to connect | `/workspace/runtime/socket` |
| `HR_PG_PORT`, `HR_PG_URL` | | the runtime port; a socket-host URL |
| `HR_PG_USER`, `HR_PG_DATABASE` | who to connect as | `postgres` / `postgres` |
| `HR_PG_BIN_DIR` | the built `psql`/`pg_ctl`/`postgres`/`initdb` | `/opt/honeyrail/postgres/bin` |
| `HR_PG_SOURCE_DIR` | the exact `.git`-free snapshot | `/workspace/source` |
| `HR_PG_DATA_DIR`, `HR_PG_LOG` | `PGDATA` and the server's own log | `/workspace/runtime/pgdata`, `/workspace/runtime/postgres.log` |
| `HR_PG_WORK_DIR` | scratch for repros, notes and results | `/workspace/agent` |

Two variants exist, and the difference matters:

- `PostgresResearchEnvironment.agentEnvironment()` returns **host** paths and `127.0.0.1`. It is what a caller uses when it is driving the environment itself, and what the explicitly-unisolated development mode exports.
- `containerAgentEnvironment()` (`server/postgres/agent-container.ts`) returns the **in-container** paths in the table above, and is what an isolated agent gets. No host path is exported to it at all: a leaked host path would disclose HoneyRail's layout even where the agent cannot read it, and would break the moment any code used the exported value for a real filesystem operation.

`HR_PG_HOST` is the socket directory rather than a loopback address because a container has its own network namespace and therefore no route to the host's `127.0.0.1`. libpq treats a host beginning with `/` as a Unix-domain socket directory, and AF_UNIX filesystem sockets resolve through the *mount* namespace — the same mechanism that makes bind-mounting `/var/run/docker.sock` into a container work.

Every value is decided at runtime — the port, socket directory, snapshot and build view do not exist until the environment has been created.

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
  { command: "/workspace/agent/driver.sh", timeoutMs: 45 * 60 * 1000 }
);

session.agent;             // exit code, stdout/stderr, timedOut, duration
session.agentEnvironment;  // exactly what the agent process was given
session.isolation;         // mode, image, networkMode, scoredEligible, mounts
session.source;            // grader-side provenance the agent never saw
session.build;
```

`agent.command` is resolved **inside the container**, so it must be something the image provides or something reachable through a mount — typically a driver script the caller writes into `$HR_PG_WORK_DIR` (host: `<root>/agent-work`) beforehand. A container also inherits nothing from the host environment, so anything the agent needs (a model API key, say) has to be passed explicitly in `agent.env`.

It materializes, builds, starts PostgreSQL, spawns the agent with `agentEnvironment()` merged into its environment and its cwd inside the agent-visible root, waits for it to exit, and only then tears the environment down. The ordering is the point: an agent whose server disappears mid-experiment produces garbage evidence rather than a failed trial. It holds on all four exits —

- clean exit;
- non-zero exit (an observation, not an environment failure — the same rule `psql()` follows);
- a hang, where `agent.timeoutMs` SIGTERMs then SIGKILLs the agent's whole **process group** (an agent is usually a shell that shells out; killing only the direct child leaves a grandchild holding the pipes) and teardown waits for it to actually exit;
- the outer session deadline (`options.timeoutMs`) firing instead, or as well — the same kill sequence, driven by the `AbortSignal` `withPostgresResearchEnvironment()` passes to the body, rather than by `agent.timeoutMs`'s own timer; see "Session timeout vs agent timeout" above;
- an unrunnable command, which throws `PostgresResearchError` with cleanup already done.

A timeout in isolated mode awaits `docker kill`ing the container before escalating on the client process — signalling only the local `docker` client would leave the container, and therefore the agent, running, and the local client later exiting on its own is not proof that the container did. This applies equally whether `agent.timeoutMs` or the outer session deadline is what triggered it; see "Session timeout vs agent timeout" above.

`PATH` puts `HR_PG_BIN_DIR` first in both modes. In unisolated mode the agent additionally gets the `PG*` hygiene the environment applies to itself (every inherited `PGHOST`/`PGPORT`/`PGDATA` dropped, so an ambient value cannot redirect it at some other server); in isolated mode the question does not arise, because a container inherits no host environment at all.

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

## Agent execution boundary

For historical rediscovery an agent must not be able to read the answer out of its own environment. There are two distinct things going on here, and they are worth naming separately because only one of them is enforced by anything.

### 1. Path and API minimization (a design property)

HoneyRail does not *hand* the agent anything identifying. `source.ref`, the resolved commit, the source tree hash and the cache key are written into no file and no path the agent is given; the snapshot has no `.git`, so the ref cannot be recovered from the tree either; the agent-visible root lives under `agentEnvRoot()` (`$HONEYRAIL_PG_ENV_ROOT`, default `<tmpdir>/honeyrail-pg-env`) rather than inside the attachment tree; `createPostgresResearchEnvironment()` refuses a `privateDir` nested inside the agent root; and whatever a driver puts in `agent-task`'s `input.environment` must carry coordinates only (the `harness.environment` evidence record stores key names and a content hash, not values).

This is real and worth having, but on its own it is only a convention. A process running as the same OS user can look anywhere it likes. Round 1 of this work stopped here and described the result as a boundary; it was not one.

### 2. Process and filesystem isolation (enforced)

`runAgentInPostgresResearchEnvironment()` launches the agent inside a container that bind-mounts **only** its research surface, using the same mechanism `docs/tinytable-exam-room-isolation.md` (#105) established after an agent read tinytable-eval's answer key straight off the shared filesystem (#103):

```text
host                                    in container            mode
<root>/source                        -> /workspace/source        rw
<root>/pgdata                        -> /workspace/runtime/pgdata rw
<socketDir>                          -> /workspace/runtime/socket rw
<root>/postgres.log                  -> /workspace/runtime/postgres.log ro
<root>/agent-work                    -> /workspace/agent          rw
<buildViewsRoot>/view-*/<random>     -> /opt/honeyrail/postgres   ro
```

Nothing else is ever mounted. `attachmentRoot`, `<privateDir>`, the PostgreSQL source mirror and its `.git`, the shared build-cache root, and every sibling trial's directory are not "unmentioned" — they do not exist inside the container's mount namespace, so no amount of searching finds them.

Container posture comes from `containerHardeningArgs()` (shared with the exam room): `--rm`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--read-only` root, `--pids-limit`, `--memory`, `--user <host uid:gid>` (so the agent writes into its mounts without them being pre-chowned), `--tmpfs /tmp` with `HOME=/tmp`. Plus `--network none` by default — see [3. Network isolation](#3-network-isolation-a-separate-guarantee).

PostgreSQL runs in its own **runtime container** (see [Where the scored cluster runs](#where-the-scored-cluster-runs)). The agent reaches it through the socket directory both containers bind-mount from the same host path, because AF_UNIX filesystem-path sockets are resolved through the mount namespace rather than the network namespace — which is also why `--network none` costs the agent nothing it actually needs. The runtime container and the agent container share that directory and nothing else; the agent is given no way to control the server (no docker socket, no `pg_ctl` target, no runtime container name).

`PGDATA` is mounted read-write into the agent container on purpose: inspecting and perturbing a cluster's own storage is legitimate database research, and PGDATA holds nothing grader-private — the source ref, commit, tree hash and cache key are written into no file the environment creates. That is a deliberate capability, not an oversight; if a future task class needs it withheld, it becomes an opt-out and the isolation record grows a field for it rather than the default changing silently.

The image is `docker/postgres-research/Dockerfile` (`honeyrail-postgres-research:latest`), deliberately minimal and without an agent CLI — derive from it (`FROM honeyrail-postgres-research:latest`) and point `isolation.image` at the result. HoneyRail resolves that reference with `docker image inspect` before any trial work starts, records the configured reference in `isolation.image`, records the resolved `{ reference, id, digest, os, architecture, variant, platform }` in `isolation.imageIdentity`, and starts the agent container from the immutable image id with `--pull=never`. A missing local image is therefore a clear setup error, not a trial side effect that pulls new bytes. `digest: null` means Docker has no registry manifest digest for that local image, so comparisons are local-daemon comparisons by image id rather than registry comparisons. The image carries `binutils`, so an agent can `strings`/`nm`/`objdump` a binary it is researching, and so the cache-identity scan below runs in the same container the agent runs in rather than in a grader-side one.

### 3. Network isolation (a separate guarantee)

Mount isolation protects host *files*. It says nothing about what an HTTP request can retrieve. A `bridge`-networked container has a default gateway to the host on Linux and `host.docker.internal` on Docker Desktop, so an agent that cannot read `source-manifest.json` off the filesystem may still be able to `GET` the same fact from a local HoneyRail API, dashboard or artifact endpoint. "The sentinel was not found in the mounted files" is not a network test.

The scored default is therefore **`network: "none"`**: the container gets no interface but its own loopback, no default route in either address family, and no DNS to resolve `host.docker.internal` against.

| Mode | Meaning | Scored? |
| --- | --- | --- |
| `none` (default) | no network stack beyond the container's own loopback | **yes** |
| `bridge` | unrestricted Docker bridge networking, with a route to the host gateway | no |
| any other docker network name | passed through verbatim | no |

`bridge` remains available — a real research agent usually needs outbound model-API access — but it has to be asked for by name, and the resulting session is recorded `scoredEligible: false` with a warning that names the reason.

There is deliberately **no `restricted-egress` mode**. A real one means blocking RFC1918, link-local, loopback, metadata and host-gateway destinations over both IPv4 and IPv6 from inside a running container, which needs `NET_ADMIN` inside a `--cap-drop=ALL` container plus a policy engine. That is a larger and riskier change than this round, and a half-built version of it would be worse than an honest label. Until it exists, a trial that needs model-API egress is a `bridge` trial and is not scored.

### Recorded isolation and scored eligibility

Every session result carries an isolation record whose facts are separate because they fail separately:

```json
{
  "mode": "container",
  "isolated": true,
  "networkMode": "none",
  "buildScoredEligible": true,
  "runtimeScoredEligible": true,
  "scoredEligible": true,
  "image": "honeyrail-postgres-research:latest",
  "imageIdentitySchemaVersion": 1,
  "imageIdentity": {
    "reference": "honeyrail-postgres-research:latest",
    "id": "sha256:…",
    "digest": null,
    "platform": "linux/arm64",
    "os": "linux",
    "architecture": "arm64",
    "variant": null
  },
  "runtime": {
    "mode": "container",
    "scoredEligible": true,
    "image": {
      "reference": "honeyrail-postgres-runtime:latest",
      "id": "sha256:…",
      "digest": null,
      "platform": "linux/arm64",
      "os": "linux",
      "architecture": "arm64",
      "variant": null
    },
    "containerName": "honeyrail-pg-runtime-…",
    "containerId": "…",
    "networkMode": "none",
    "user": "<host uid>:<host gid>",
    "mounts": ["…:/opt/honeyrail/postgres:ro", "…:/runtime/pgdata:rw", "…"]
  }
}
```

- `isolated` — was there a filesystem boundary at all, or was this `allowUnisolatedForDevelopment`?
- `networkMode` — could the agent have reached a grader/host service?
- `buildScoredEligible` — did the pinned Linux build container produce the binaries, or was this a `host` build?
- `runtimeScoredEligible` — did the *server* run inside the pinned Linux runtime container, or as host processes?

`scoredEligible` is the conjunction of all four, and it is the single field a grader should key on. **A containerized build alone is explicitly not sufficient**: that was exactly the claim the #182 fourth review rejected, because a container-built PostgreSQL whose cluster then ran on the host either could not run at all (macOS/Windows) or ran under a different confinement story from the one the scored path describes.

Whenever `scoredEligible` is false, `warning` names every failing axis rather than the first — a `bridge` run over a host build over a host-process cluster reports three reasons. An unisolated development run records `scoredEligible: false` and no `networkMode` at all, because an unconfined host process had the host's whole network.

A `postgres-research` executor step runs no agent, so it has only two axes; it records them on a `db.runtime.isolation` evidence record with an explicit `stepScoredEligible` conjunction, and `runtimeManifest().runtime` carries the same `PostgresRuntimeRecord`.

The full scored-eligibility ledger, all of which must hold:

| Layer | Requirement | Where it is recorded |
| --- | --- | --- |
| source | history-free materialization (`git archive`, no `.git`) | `PostgresSourceManifest.gitDirPresent: false` |
| build | approved builder container + neutral prefix | `PostgresBuildManifest.scoredEligible`, `.builderImage`, `.installPrefix` |
| runtime | approved runtime container | `PostgresRuntimeRecord.scoredEligible`, `.image` |
| agent | approved agent container, no unisolated escape hatch | `isolation.isolated`, `isolation.image`, `isolation.imageIdentity` |
| network | `none`, for both runtime and agent | `isolation.networkMode`, `runtime.networkMode` |
| images | reference + content-addressed id + digest + normalized os/arch/variant resolved from the daemon | `builderImage`, `runtime.image`, `isolation.imageIdentity` |
| cleanup | auditable, ordered, complete | `PostgresCleanupResult` |

### No silent degradation

If no docker daemon is reachable, `runAgentInPostgresResearchEnvironment()` **throws before materializing anything**. It never falls back to an unconfined host process while continuing to claim a boundary.

The escape hatch is opt-in and named for what it costs:

```ts
await runAgentInPostgresResearchEnvironment(spec, agent, {
  isolation: { allowUnisolatedForDevelopment: true }   // local dev / CI without docker
});
```

A session run that way records `isolation: { mode: "unisolated-development", isolated: false, scoredEligible: false, warning: "..." }`, so output produced without a boundary is never indistinguishable from output produced with one. An isolated session instead records the image reference, the resolved image identity, the network mode, the scored-eligibility verdict, the container name and the exact `-v` specs.

The same rule applies to the build: `build.mode: "host"` never fails over from `container` silently. A missing builder image is an error naming the `docker build` that fixes it, not a quiet downgrade.

### Exposing the build without its identity

The cache stays deterministic and shared grader-side: same source, same flags, same compiler → same `cacheKey` → same `entryId` → a cache hit. What the agent sees is a **per-trial hard-link view** of that entry, mounted at the fixed neutral path `/opt/honeyrail/postgres`.

Both halves are necessary:

- The fixed in-container path means the pathname, `realpath`, and every exported variable are identical across trials and carry no identity.
- The per-trial random *host* directory is needed because a bind mount publishes its source path inside the container, in `/proc/self/mountinfo`. Mounting `<cacheRoot>/<entryId>` directly puts the literal `entryId` in the container's own mount table — verified directly, which is why this is not theoretical. An agent with a bounded candidate set of refs could recompute candidate entry IDs and match. Mounting a per-trial random directory puts a random string there instead.

Neither of them is sufficient on its own, and neither addresses what is *inside* the files — that is what the [neutral configure prefix](#why-the-configure-prefix-is-a-constant) is for. All three together are what make the claim below true.

The view is built with hard links, so this is a second *view* of one build, not a second copy of it — no expensive build is duplicated to randomize identity. It is removed when the trial ends. The completion marker (`honeyrail-build-complete.json`, which carries the `entryId`) is deliberately excluded from the view. `HONEYRAIL_PG_BUILD_VIEWS` or `isolation.buildViewsRoot` overrides where views live; the default is a sibling of the cache root, so the cache root's own name never appears in the mount table either.

### Threat model for #180

What a scored trial's agent can and cannot do, stated exactly:

| | |
| --- | --- |
| **Inaccessible host paths** | everything not in the mount table above: `attachmentRoot` and all grader artifacts, `<privateDir>` and the build logs, the PostgreSQL source mirror and any `.git`, the build-cache root and its entries, other trials' directories, the HoneyRail checkout, the operator's home directory |
| **Accessible** | the `.git`-free snapshot (rw), PGDATA (rw), the socket directory (rw), the server log (ro), its own scratch directory (rw), the build view (ro) |
| **Network (scored)** | `none` by default: no interface but loopback, no IPv4 or IPv6 route, no DNS. No host service, private address, link-local address or metadata endpoint is reachable, because there is no network stack to reach them with. Verified live against a real host HTTP server serving a sentinel — see [Network isolation test](#network-isolation-test) |
| **Network (`bridge`, opt-in)** | unrestricted egress *and* a route to the host gateway / `host.docker.internal`. Grader-side HTTP services are reachable, and an internet-connected agent can fingerprint a PostgreSQL version against public sources. Recorded `scoredEligible: false` |
| **Public-source fingerprinting** | with `none`, impossible — there is no egress. The snapshot itself is still a genuine PostgreSQL tree, so an agent can read the version out of `configure`/`PG_VERSION` offline; that is inherent to giving it the source and is not a network question |
| **Process listing / `/proc`** | the container has its own PID namespace, so it sees only its own processes — not the host's `postgres`, not HoneyRail. `/proc/self/mountinfo` **is** readable and does disclose the *host pathnames of the six mounted directories* (this is why the build view is randomized). It does not disclose any unmounted path |
| **Concurrency** | yes. Trials get distinct ports, PGDATA, socket directories, snapshots and build views; each container is `--rm` and named per trial. `--pids-limit`/`--memory` bound one container, not the aggregate — many concurrent trials are a driver-level concern |
| **Cached binaries** | exposed through a per-trial hard-link view at a fixed neutral path, with no stable source identity in the path, in `realpath`, in the environment, in the mount table, **or compiled into any installed file** — the last one verified with `pg_config`, recursive `grep -a -F` and `strings` against a real PostgreSQL build |

Shared-kernel caveat, as in the exam room: this is Docker's namespace + cgroup + capability model, not gVisor or a microVM. A kernel or runtime vulnerability could in principle allow an escape. This is a boundary sized to the actual threat (an agent reading host files that a lenient in-process sandbox does not restrict), not a defense against a kernel exploit. Deployments should also run HoneyRail as a non-root user: `--user` maps the host uid, so a root host process maps to an in-container root, which weakens (though `--cap-drop=ALL` does not eliminate) the benefit of the read-only root.

### Platform support

Containerizing the build removed the ABI dead end this section used to describe; containerizing the *server* removed the one that replaced it.

Docker Desktop's containers are a Linux VM regardless of host OS, so a build performed in the builder container is a Linux build on **every** Docker host — but until the fourth review, `PostgresResearchEnvironment.start()` still ran `initdb`/`pg_ctl`/`postgres` as *host* processes. On macOS or Windows that was not a degradation: it was `exec format error` on the first call. Every green "cluster lifecycle" run on a developer machine had in fact been the synthetic `#!/bin/sh` fixture, whose "binaries" are text and therefore execute anywhere. **Containerizing the build alone did not make the system cross-platform, and this document previously implied it did.**

With the runtime sidecar, all three stages are containers and the host runs no PostgreSQL binary at all:

| | builder container | runtime container (live cluster) | agent container |
| --- | --- | --- | --- |
| **Linux host** | ✅ | ✅ real PostgreSQL | ✅ real PostgreSQL |
| **macOS (Docker Desktop)** | ✅ | ✅ real PostgreSQL | ✅ real PostgreSQL |
| **Windows (Docker Desktop)** | ✅ | expected ✅ (same mechanism) | expected ✅ (same mechanism) |

macOS is proven, not assumed: `docs/validation/pr-182-local-integration.md` records a full local run on Apple Silicon macOS with Docker Desktop — real ref, cold containerized build, live PostgreSQL 16.9 in the runtime container, an isolated agent querying it over the shared socket, restart with data preserved, ordered cleanup, and a second run hitting the cache. The one property that had to be established empirically rather than argued is that a container can `bind()` a Unix socket in a macOS bind mount and a second container can `connect()` to it; it can, on Docker Desktop's VirtioFS.

Windows is marked *expected* rather than proven: nothing in the mechanism is macOS-specific, but no Windows host was available, so this document does not claim it.

`build.mode: "host"` still exists for a machine with no docker daemon at all. It is unscored on both the build and runtime axes. `abiHint()` survives for the one remaining way to reach a host-process cluster with container-built binaries — constructing an environment with a `container` build manifest and no runtime image — and names the mismatch instead of leaving a bare `Exec format error`.

Two further limitations, stated because they are real:

- The snapshot is a genuine PostgreSQL tree, so it reveals the *version* under study even though it reveals nothing about the bug.
- A scored trial's containers have `--network none`, so **a cloud-backed agent CLI cannot run in one**. There is no restricted-egress mode yet; see [3. Network isolation](#3-network-isolation-a-separate-guarantee). This is a blocker for [#180](https://github.com/clemenza/honeyrail/issues/180) and is tracked as its own piece of work rather than being papered over here — a `bridge` trial is honest but unscored, and a half-built egress filter would be worse than the label.

### Supplying an agent CLI and model credentials

The research image carries no agent CLI on purpose. Derive one:

```dockerfile
FROM honeyrail-postgres-research:latest
USER root
RUN npm install -g <your-agent-cli>
USER pgresearch
```

…then pass `isolation.image`. The selected agent image must be locally available and compatible with the mounted PostgreSQL build platform; a scored build for `linux/arm64`, for example, rejects an agent image whose normalized daemon-reported identity is `linux/amd64`. Credentials go in `agent.env`, which is the *only* way anything reaches the container: a container inherits nothing from the host environment, and the injected PostgreSQL coordinates are applied last so a caller cannot override them. Nothing in `agent.env` is echoed into a manifest — the isolation record stores the `-v` mount specs, the resolved image identity, the network mode and the container name, not the `-e` values.

Note the interaction with the scored network mode: an agent CLI that calls a hosted model API needs egress, and egress today means `bridge`, which means `scoredEligible: false`. A scored trial as currently defined therefore wants an agent that can work offline against the mounted source and the live cluster, or a locally hosted model reachable over a mount rather than a socket. This is the honest state of it, not a workaround.

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
        "build": { "mode": "container", "configureArgs": ["--without-readline", "--without-zlib", "--without-icu"], "jobs": 8 },
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
- `build-manifest.json` — build mode, builder image identity (reference/ID/digest), the neutral install prefix, scored eligibility, configure args, compiler identity (observed inside the build container), declared build environment, make version, target and host platform/arch, cache key, entry id, cache hit, install dir, binary paths, per-command durations
- `runtime-manifest.json` — ports/paths (including `root` and `privateDir`), initdb args, the full lifecycle event list, cleanup result
- `experiments.json` — the SQL that ran and what it returned
- `configure.log`, `make.log`, `make-install.log` — on a cold build
- `postgres.log` — the server's own log, copied out of the agent-visible root

All of these are grader-side. `source-manifest.json` and `build-manifest.json` in particular hold exactly the facts the agent must not see, which is why they live outside every agent-visible tree.

### Evidence

Reusing the existing `db.*` taxonomy where one fits, plus three new kinds for facts the alpha never had:

- `db.source.snapshot` — exact ref materialized, no `.git`
- `db.build` — build mode and scored eligibility, builder image identity, neutral install prefix, cache key, cache hit, compiler, install dir
- `db.runtime.isolation` — runtime mode, runtime image identity, container name/id, network mode, the exact runtime mounts, and the step-level `stepScoredEligible` conjunction of the build and runtime axes
- `db.server.ready`, `db.query.result`, `db.restart` — as in the alpha
- `db.process.health` — observed rather than assumed: whether the runtime container is up and what `pg_ctl status` says inside it
- `db.environment.cleanup` — what cleanup stopped and removed, including the runtime container and the build view

## Testing

```sh
docker build -t honeyrail-postgres-builder:latest  docker/postgres-research-builder
docker build -t honeyrail-postgres-runtime:latest  docker/postgres-research-runtime
docker build -t honeyrail-postgres-research:latest docker/postgres-research

node --import tsx --test test/postgres-research-environment.test.ts
node --import tsx --test test/postgres-research-runtime.test.ts
node --import tsx --test test/postgres-research-session.test.ts
node --import tsx --test test/postgres-research-isolation.test.ts
node --import tsx --test test/postgres-research-network.test.ts
node --import tsx --test test/agent-task-environment.test.ts

# real PostgreSQL, opt-in on a locally provided mirror
git clone --filter=blob:none https://github.com/postgres/postgres.git /tmp/pg-mirror
HONEYRAIL_PG_TEST_MIRROR=/tmp/pg-mirror \
  node --import tsx --test test/postgres-research-real-build.test.ts
HONEYRAIL_PG_TEST_MIRROR=/tmp/pg-mirror \
  node --import tsx --test test/postgres-research-live-e2e.test.ts
```

`.github/workflows/pg-research-integration.yml` runs the last two as a **merge gate** and fails if either reports a skipped test. That job exists because every docker/real-PostgreSQL test here skips cleanly when its images or mirror are absent — correct on a contributor's laptop, and exactly wrong for a gate.

The suite runs against a synthetic source fixture (`test/helpers/postgres-source-fixture.ts`): a git repository whose `configure`/`make`/`make install` install four stub binaries that emulate just enough of `initdb`/`pg_ctl`/`psql`/`postgres` to exercise the real lifecycle in seconds. That keeps the whole matrix — no-`.git` snapshots, exact-ref resolution, snapshot publication and rollback, cache-key composition, cache hits, build-environment keying, concurrent isolation, port-collision recovery, the agent execution boundary, lifecycle, restart, live agent composition, and all the cleanup paths — runnable in CI without a PostgreSQL checkout or a C toolchain, and keeps the real corpus out of committed test code. Tests skip with a clear message when `git`, `make`, `tar` or a `cc` probe is unavailable, and the container tests skip when no docker daemon or research image is present.

The stub server really does create its listening socket in the `-k` directory under the name libpq derives from the port, so a socket-host connection genuinely resolves through that directory — which is what the isolated agent's connection exercises when the directory is bind-mounted.

The three race-shaped properties (a port collision, a failed `tar`, a failed publish rename) are injected deterministically — a stubbed `runCommand`, or `materializePostgresSource`'s `publishRename` seam — rather than by hoping the OS reproduces the race.

### Isolation tests

`test/postgres-research-isolation.test.ts` tests the boundary **through the real agent launch path**, not by inspecting an environment map:

- `an isolated agent cannot read grader artifacts, the source mirror, sibling trials or the build cache` — a live containerized agent, against a live cluster, that probes every grader-private host path by name, searches the whole filesystem for grader filenames, greps for a planted private-truth sentinel, and checks the mount table. All attempts must fail.
- `an isolated agent can still read the source, drive the live cluster, read the log and record results` — the same boundary, from the other side: grep `$HR_PG_SOURCE_DIR`, run the research build's `psql` over the mounted socket, query the cluster, read the server log, and write a reproducer and a result file that come back out onto the host.
- `two trials over one cached build see the same binaries at the same neutral path and no stable host identity` — same `cacheKey`/`entryId` grader-side and a genuine cache hit, identical binaries at `/opt/honeyrail/postgres/bin`, but different mount sources and no `ref`/`resolvedCommit`/`sourceHash`/`cacheKey`/`entryId` anywhere the agent could see.
- `docker being unavailable fails loudly instead of running the agent unisolated`, plus static assertions on the exact mount list, the hardening flags, the in-container-only environment, and the marker-free build view.

Because the fixture's binaries are shell scripts, these run and enforce real container isolation on a macOS host too — docker's namespaces do not care what is inside the mount.

### Network isolation test

`test/postgres-research-network.test.ts` is built the other way round from a filesystem test, because "the sentinel was not found in the mounted files" proves nothing about the network:

- a **real host HTTP server** binds `0.0.0.0` on an ephemeral port and serves a unique sentinel. The test first fetches it from the host, so a later failure means "blocked", not "nothing was there";
- the agent, in the scored container with the **default** network mode, actually attempts to retrieve it from `host.docker.internal`, `gateway.docker.internal`, `127.0.0.1`, `localhost`, the Docker bridge gateway `172.17.0.1`, and every real non-loopback IPv4 the host has — using bash's `/dev/tcp` pseudo-device, so no networking client needs to be installed;
- every attempt must fail, the attempt *count* is asserted so a test that never tried cannot pass, and the sentinel must not appear anywhere in the agent's output;
- both route tables must be empty (`/proc/net/route` and `/proc/net/ipv6_route`) — an IPv4-only story would leave an IPv6 path open — and no `eth0` may be attached;
- the same container must still `INSERT` and `SELECT` against the live cluster over the bind-mounted Unix socket;
- cleanup must still have stopped the server and removed the socket directory.

It also asserts the recorded verdict directly: a default run records `networkMode: "none"`, a `bridge` run records `scoredEligible: false` with a warning naming `host.docker.internal`, and an `allowUnisolatedForDevelopment` run records `scoredEligible: false` with no `networkMode` at all.

### Real-PostgreSQL test

`test/postgres-research-real-build.test.ts` is the one thing the synthetic fixture structurally cannot cover. A `#!/bin/sh` stand-in has no `pg_config`, no `Makefile.global` and no ELF `.rodata`, so the compiled-in-prefix hole is invisible to it. This test materializes a real PostgreSQL ref from a locally provided mirror, builds it through the containerized scored path, mounts a per-trial view into the *actual* research-agent container, and from inside it runs:

```sh
pg_config --bindir / --libdir / --sharedir / --configure / --version
postgres --version ; psql --version ; initdb --version
grep -R -a -F "<cacheRoot>" /opt/honeyrail/postgres
grep -R -a -F "<entryId>"   /opt/honeyrail/postgres
grep -R -a -F "<cacheKey>"  /opt/honeyrail/postgres
strings /opt/honeyrail/postgres/bin/postgres  | grep -F "<cacheRoot>" -e "<entryId>"
strings /opt/honeyrail/postgres/bin/pg_config | grep -F "<cacheRoot>" -e "<entryId>"
```

`pg_config` must report only `/opt/honeyrail/postgres/...`, all four programs must run, and every scan must come back empty. As a control that the greps are not inert, the same `entryId` scan run host-side over the whole cache entry must find it in exactly one place — the completion marker that is deliberately withheld from the view.

Two further tests cover cache reuse and per-trial view distinctness with the real build (a second trial must be a cache hit, run no build commands, see byte-identical binaries at the same neutral path, and reach them through a *different* mount source), and that the grader-side build logs do still name the staging paths.

It is opt-in on `HONEYRAIL_PG_TEST_MIRROR` and skips with a message naming exactly what is missing (mirror, daemon, builder image, research image). **A skip does not satisfy the merge gate it exists for.**

### Runtime sidecar tests

`test/postgres-research-runtime.test.ts` needs no docker daemon, and asserts what the sidecar *asks* docker for: the exact six-entry mount list (build view ro, PGDATA rw, socket rw, log rw, generated passwd/group ro) and nothing else; `-d`, `--network none`, the shared hardening flags, no `-p`/`--publish` anywhere, and an inert PID 1; an environment with no `PG*` variable and nothing inherited from the host; `-h ''` in the postmaster options; the generated identity shim for an arbitrary host uid and the non-root fallback for a root host; a missing runtime image failing loudly with the `docker build` that fixes it; the resolved image identity coming from the daemon rather than the tag; the runtime axis in `unscoredReasons()`; and the create/cleanup failure paths (a container that cannot start is force-removed; an already-removed container is success, not a leak; cleanup is idempotent).

### Live end-to-end test

`test/postgres-research-live-e2e.test.ts` is the composed proof, and it is the one no other test in this repository can give. The real-build test proves *build → binaries execute in a probe container*; the isolation test proves *synthetic host build → stub cluster + agent container*. Neither proves what a scored trial actually is:

```text
real PostgreSQL git ref
  -> exact .git-free materialization
  -> Linux builder container -> neutral-prefix cache artifact
  -> randomized per-trial view
  -> runtime container -> real initdb -> real postmaster -> readiness
  -> isolated agent container -> real SQL over the shared Unix socket
  -> restart -> post-restart SQL proving data persisted
  -> ordered cleanup -> second run hitting the cache
```

Inside the real agent container it runs `pg_config --bindir/--configure`, `postgres --version`, `SELECT version()`, and a real `CREATE TABLE`/`INSERT`/`SELECT`, and proves the agent sees the *same server* the grader does. It also asserts no source `.git`; no cache root, key or entry id in the environment, the mount table, `pg_config` or any installed file (including `strings` on the `postgres` binary); grader filesystem sentinels inaccessible; a real host HTTP sentinel unreachable by every enumerable route, with the attempt count asserted; the server log readable; the agent's result file returning to the grader; restart preserving committed data; and `psqlFile()` streaming a grader-side script in over `docker exec -i` without mounting it.

Its negative paths are tests, not prose: a missing runtime image fails before anything is materialized and never falls back to a host cluster; an `initdb` failure removes the runtime container and the build view but not the cache; an agent timeout kills the agent, *then* stops the server, *then* removes the container, view, PGDATA and socket, with `docker ps -a` proving nothing leaked; and, separately, the outer *session* timeout (`agent.timeoutMs` left unset) does the same against a real ten-minute-sleeping agent container, finishing near its own deadline rather than the agent's, with the thrown `PostgresResearchTimeoutError`'s attached `runtimeManifest` proving `cleanup.sessionTimedOut` and an unexceeded `cancelGraceExceeded` bound (#188).

Like the real-build test it is opt-in on `HONEYRAIL_PG_TEST_MIRROR`, and **a skip does not satisfy the merge gate it exists for** — which is why `.github/workflows/pg-research-integration.yml` fails when the skipped count is not zero.

Validating a *bug* against real PostgreSQL remains a manual step on top of this: populate a mirror, then drive `withPostgresResearchEnvironment()` over a pre-fix ref and its fix ref with the same build profile and the same reproducer, and confirm the two disagree. The build cache keys them apart automatically because their source hashes differ.

## Known limitations

- If `terminateResearchContainer()`'s full escalation (`docker kill`, `docker rm -f`, then an independent `docker inspect`) still cannot confirm the agent container is gone - a sustained daemon outage, not a transient hiccup - HoneyRail does not proceed as though cancellation succeeded. It fails closed: `env.markAgentTerminationUnconfirmed()` makes `cleanup()` skip PGDATA, the socket directory, the build view and the runtime container entirely (all bind-mounted into the agent container too) rather than remove them while that container may still be alive and using them, and the outcome - `agentTermination.confirmedStopped: false`, `cleanup.agentTerminationUnconfirmed: true` - is preserved as evidence rather than silently reported as a normal, complete teardown. The local `docker run` client is still signalled regardless (SIGTERM, Docker's default `--sig-proxy` proxying it into the container, then SIGKILL on the client after `KILL_GRACE_MS`), as a best-effort nudge - but that signalling is not what cleanup's decision is based on, and a container that survives it (because its PID 1 is a shell blocked in a foreground command, which POSIX shells defer signal handling for until that command returns control) is exactly the case this fail-closed path exists for. Recovering the retained resources - or confirming by hand that the container really is gone and re-running cleanup - is an operator action once Docker is healthy again; this module does not retry on its own after returning control to the caller (#188 review, third round).
- PostgreSQL only; local source builds only (no cross-compilation, no remote execution). The build runs in a local Linux container; it is not a distributed or remote build service.
- One cluster per environment: no replication, no multi-node topology, no fault injection.
- The build cache is content-keyed but not garbage-collected; a corpus of many refs will grow it.
- Build-cache concurrency is safe (staged build + atomic rename) but not coordinated: two environments needing the same cold build may both build it.
- The cache key covers a declared set of build-environment variables, not a hermetic toolchain fingerprint.
- `timeoutMs` cancels the caller and, via the `AbortSignal` passed to the body, actively cancels the body too (#188) — cleanup then waits for the body to settle, bounded by `cancelGraceMs`. That bound exists because JavaScript still cannot force an `await` the body itself is not listening on `signal` for to abort; a body that ignores `signal` gets torn down anyway once `cancelGraceMs` elapses, with `cleanup.cancelGraceExceeded` recording it. `runAgentInPostgresResearchEnvironment()`'s body always observes it, so this bound is not reached on the supported agent path.
- The agent boundary is a container, so it needs a docker daemon; without one, an agent session fails rather than degrading. It is shared-kernel isolation, not a microVM. The same is now true of the scored *build* and of the scored *cluster*.
- The scored path needs three images present locally and never pulls them. A missing one is a loud failure naming the `docker build` that fixes it.
- The runtime container mounts a generated two-line `passwd`/`group` pair over `/etc/passwd` and `/etc/group`, because PostgreSQL calls `getpwuid()` on an effective uid that a stock image has no entry for. It is a per-trial identity shim, not research data, and it is not mounted into the agent container — but it is a mount beyond the four the architecture diagram names, and it is listed in the recorded runtime mounts for that reason.
- Windows hosts are expected to work by the same mechanism as macOS but are **not proven**: no Windows host was available for the local validation.
- There is no `restricted-egress` network mode. A trial whose agent needs a hosted model API must run on `bridge` and is recorded `scoredEligible: false`. Building a real egress policy (RFC1918/link-local/loopback/metadata/host-gateway, IPv4 **and** IPv6, from inside a `--cap-drop=ALL` container) is a separate change, and it is a **blocker for [#180](https://github.com/clemenza/honeyrail/issues/180)**: a scored trial today cannot run a cloud-backed agent CLI at all.
- The build is reproducible-ish, not hermetic: the container fixes the toolchain, locale and environment, but the builder image is itself built from a moving package index. The image's content ID is in the cache key so that a rebuilt image invalidates rather than mixes; bit-for-bit reproducibility is not claimed.
- `build.mode: "host"` still exists and still works, but nothing produced by it is scored-eligible, by construction.
- The `postgres-research` executor itself does not run an agent, so nothing about it is isolated; it is a grader-side environment driver.
- Live agent research is composed by `runAgentInPostgresResearchEnvironment()`, not by the DAG; a `postgres-research` step cannot hand a running cluster to a later step.
- The agent-visible root defaults to a temp root and, like v0, keeps the source snapshot after cleanup unless `removeSourceDir` is set. Long campaigns should set it, or point `HONEYRAIL_PG_ENV_ROOT` somewhere with room.
