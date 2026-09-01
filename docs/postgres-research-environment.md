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
- one agent process driving that live cluster inside a container that bind-mounts only its research surface, with cleanup ordered behind it
- source/build/runtime manifests as artifacts, lifecycle facts as evidence
- deterministic cleanup on success, throw, and timeout

Out of scope (tracked elsewhere): cross-step DAG composition of a live environment (an environment lease through the orchestration kernel — see [What is *not* wired](#what-is-not-wired-cross-step-dag-composition)), the historical bug corpus ([#178](https://github.com/clemenza/honeyrail/issues/178)), the first pilot over historical PG tasks ([#180](https://github.com/clemenza/honeyrail/issues/180)), and the generic `EvalProvider` abstraction ([#172](https://github.com/clemenza/honeyrail/issues/172)).

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

An environment exposes `root`, `privateDir`, `sourceDir`, `installDir`, `dataDir`, `socketDir`, `logPath`, `port`, `binaries`, plus `start()`, `stop()`, `restart()`, `psql()`, `psqlFile()`, `exec()`, `cleanup()`, `connectionInfo()`, `agentEnvironment()`, `lifecycleEvents()` and `runtimeManifest()`.

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

### The cache entry stays grader-side

The cache root, the entry directory and the `entryId` that names it are **never** exposed to an isolated agent. The entry holds one HoneyRail-written file, `honeyrail-build-complete.json` (`{ marker, entryId, profileVersion, completedAt }`), so an interrupted build is not mistaken for a usable one; it says nothing else, and it is excluded from the view the agent sees. Full provenance lives in the `PostgresBuildManifest` the build returns, which the caller records grader-side.

An agent gets the *binaries*, at a fixed neutral path, through a per-trial view — see [Exposing the build without its identity](#exposing-the-build-without-its-identity).

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
session.isolation;         // how it was confined: mode, image, network, mounts
session.source;            // grader-side provenance the agent never saw
session.build;
```

`agent.command` is resolved **inside the container**, so it must be something the image provides or something reachable through a mount — typically a driver script the caller writes into `$HR_PG_WORK_DIR` (host: `<root>/agent-work`) beforehand. A container also inherits nothing from the host environment, so anything the agent needs (a model API key, say) has to be passed explicitly in `agent.env`.

It materializes, builds, starts PostgreSQL, spawns the agent with `agentEnvironment()` merged into its environment and its cwd inside the agent-visible root, waits for it to exit, and only then tears the environment down. The ordering is the point: an agent whose server disappears mid-experiment produces garbage evidence rather than a failed trial. It holds on all four exits —

- clean exit;
- non-zero exit (an observation, not an environment failure — the same rule `psql()` follows);
- a hang, where `agent.timeoutMs` SIGTERMs then SIGKILLs the agent's whole **process group** (an agent is usually a shell that shells out; killing only the direct child leaves a grandchild holding the pipes) and teardown waits for it to actually exit;
- an unrunnable command, which throws `PostgresResearchError` with cleanup already done.

A timeout in isolated mode `docker kill`s the container before escalating on the client process — signalling only the local `docker` client would leave the container, and therefore the agent, running.

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

Container posture comes from `containerHardeningArgs()` (shared with the exam room): `--rm`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--read-only` root, `--pids-limit`, `--memory`, `--user <host uid:gid>` (so the agent writes into its mounts without them being pre-chowned), `--tmpfs /tmp` with `HOME=/tmp`.

PostgreSQL itself keeps running as a **host** process. Containerizing the server would mean containerizing the build too, which is a much larger change (see [Platform limitation](#platform-limitation-container-architecture-must-match-the-build-host)). The agent reaches the host cluster through the bind-mounted socket directory, because AF_UNIX filesystem-path sockets are resolved through the mount namespace rather than the network namespace.

The image is `docker/postgres-research/Dockerfile` (`honeyrail-postgres-research:latest`), deliberately minimal and without an agent CLI — derive from it (`FROM honeyrail-postgres-research:latest`) and point `isolation.image` at the result.

### No silent degradation

If no docker daemon is reachable, `runAgentInPostgresResearchEnvironment()` **throws before materializing anything**. It never falls back to an unconfined host process while continuing to claim a boundary.

The escape hatch is opt-in and named for what it costs:

```ts
await runAgentInPostgresResearchEnvironment(spec, agent, {
  isolation: { allowUnisolatedForDevelopment: true }   // local dev / CI without docker
});
```

A session run that way records `isolation: { mode: "unisolated-development", isolated: false, warning: "..." }`, so output produced without a boundary is never indistinguishable from output produced with one. An isolated session instead records the image, the network, the container name and the exact `-v` specs.

### Exposing the build without its identity

The cache stays deterministic and shared grader-side: same source, same flags, same compiler → same `cacheKey` → same `entryId` → a cache hit. What the agent sees is a **per-trial hard-link view** of that entry, mounted at the fixed neutral path `/opt/honeyrail/postgres`.

Both halves are necessary:

- The fixed in-container path means the pathname, `realpath`, and every exported variable are identical across trials and carry no identity.
- The per-trial random *host* directory is needed because a bind mount publishes its source path inside the container, in `/proc/self/mountinfo`. Mounting `<cacheRoot>/<entryId>` directly puts the literal `entryId` in the container's own mount table — verified directly, which is why this is not theoretical. An agent with a bounded candidate set of refs could recompute candidate entry IDs and match. Mounting a per-trial random directory puts a random string there instead.

The view is built with hard links, so this is a second *view* of one build, not a second copy of it — no expensive build is duplicated to randomize identity. It is removed when the trial ends. The completion marker (`honeyrail-build-complete.json`, which carries the `entryId`) is deliberately excluded from the view. `HONEYRAIL_PG_BUILD_VIEWS` or `isolation.buildViewsRoot` overrides where views live; the default is a sibling of the cache root, so the cache root's own name never appears in the mount table either.

### Threat model for #180

What a scored trial's agent can and cannot do, stated exactly:

| | |
| --- | --- |
| **Inaccessible host paths** | everything not in the mount table above: `attachmentRoot` and all grader artifacts, `<privateDir>` and the build logs, the PostgreSQL source mirror and any `.git`, the build-cache root and its entries, other trials' directories, the HoneyRail checkout, the operator's home directory |
| **Accessible** | the `.git`-free snapshot (rw), PGDATA (rw), the socket directory (rw), the server log (ro), its own scratch directory (rw), the build view (ro) |
| **Network** | on by default (`network: "bridge"`) so an agent can reach its own model API. Its own network namespace means no route to the host's loopback — the cluster is reachable only through the mounted socket. Egress is otherwise **unrestricted**: an internet-connected agent can still fingerprint a PostgreSQL version against public sources. Set `isolation.network: "none"` for a trial policy that forbids that |
| **Process listing / `/proc`** | the container has its own PID namespace, so it sees only its own processes — not the host's `postgres`, not HoneyRail. `/proc/self/mountinfo` **is** readable and does disclose the *host pathnames of the six mounted directories* (this is why the build view is randomized). It does not disclose any unmounted path |
| **Concurrency** | yes. Trials get distinct ports, PGDATA, socket directories, snapshots and build views; each container is `--rm` and named per trial. `--pids-limit`/`--memory` bound one container, not the aggregate — many concurrent trials are a driver-level concern |
| **Cached binaries** | exposed through a per-trial hard-link view at a fixed neutral path, with no stable source identity in the path, in `realpath`, in the environment, in the mount table, or in any file below it |

Shared-kernel caveat, as in the exam room: this is Docker's namespace + cgroup + capability model, not gVisor or a microVM. A kernel or runtime vulnerability could in principle allow an escape. This is a boundary sized to the actual threat (an agent reading host files that a lenient in-process sandbox does not restrict), not a defense against a kernel exploit. Deployments should also run HoneyRail as a non-root user: `--user` maps the host uid, so a root host process maps to an in-container root, which weakens (though `--cap-drop=ALL` does not eliminate) the benefit of the read-only root.

### Platform limitation: container architecture must match the build host

PostgreSQL is built **natively on the host** and executed **inside a Linux container**. On a Linux host those agree and the whole path works end to end with real PostgreSQL binaries. On macOS or Windows they do not: Docker Desktop runs containers inside a Linux VM, and a natively-built Mach-O or PE binary cannot execute there. This is a genuine, unavoidable property of building natively and running in a Linux container — not a defect in the isolation, and not something a flag fixes.

Consequences, stated plainly:

- **Linux host (the expected deployment and CI target):** full end-to-end operation, real PostgreSQL binaries inside the boundary. The container image's libc must be able to run the host's build — `docker/postgres-research/Dockerfile` uses bookworm; override `isolation.image` for a different build host.
- **macOS/Windows host:** the isolation mechanism itself works and is tested (see [Testing](#testing) — the synthetic fixture's "binaries" are `#!/bin/sh` scripts, which are architecture-portable text and run correctly inside a Linux container), but a *real* PostgreSQL build made on the host cannot be executed by the agent. Use `allowUnisolatedForDevelopment` for local development against real PostgreSQL, and understand that such a run is not a scored trial.

One further limitation, stated because it is real: the snapshot is a genuine PostgreSQL tree, so it reveals the *version* under study even though it reveals nothing about the bug.

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
docker build -t honeyrail-postgres-research:latest docker/postgres-research
node --import tsx --test test/postgres-research-environment.test.ts
node --import tsx --test test/postgres-research-session.test.ts
node --import tsx --test test/postgres-research-isolation.test.ts
node --import tsx --test test/agent-task-environment.test.ts
```

The suite runs against a synthetic source fixture (`test/helpers/postgres-source-fixture.ts`): a git repository whose `configure`/`make`/`make install` install four stub binaries that emulate just enough of `initdb`/`pg_ctl`/`psql`/`postgres` to exercise the real lifecycle in seconds. That keeps the whole matrix — no-`.git` snapshots, exact-ref resolution, snapshot publication and rollback, cache-key composition, cache hits, build-environment keying, concurrent isolation, port-collision recovery, the agent execution boundary, lifecycle, restart, live agent composition, and all the cleanup paths — runnable in CI without a PostgreSQL checkout or a C toolchain, and keeps the real corpus out of committed test code. Tests skip with a clear message when `git`, `make`, `tar` or a `cc` probe is unavailable, and the container tests skip when no docker daemon or research image is present.

The stub server really does create its listening socket in the `-k` directory under the name libpq derives from the port, so a socket-host connection genuinely resolves through that directory — which is what the isolated agent's connection exercises when the directory is bind-mounted.

The three race-shaped properties (a port collision, a failed `tar`, a failed publish rename) are injected deterministically — a stubbed `runCommand`, or `materializePostgresSource`'s `publishRename` seam — rather than by hoping the OS reproduces the race.

### Isolation tests

`test/postgres-research-isolation.test.ts` tests the boundary **through the real agent launch path**, not by inspecting an environment map:

- `an isolated agent cannot read grader artifacts, the source mirror, sibling trials or the build cache` — a live containerized agent, against a live cluster, that probes every grader-private host path by name, searches the whole filesystem for grader filenames, greps for a planted private-truth sentinel, and checks the mount table. All attempts must fail.
- `an isolated agent can still read the source, drive the live cluster, read the log and record results` — the same boundary, from the other side: grep `$HR_PG_SOURCE_DIR`, run the research build's `psql` over the mounted socket, query the cluster, read the server log, and write a reproducer and a result file that come back out onto the host.
- `two trials over one cached build see the same binaries at the same neutral path and no stable host identity` — same `cacheKey`/`entryId` grader-side and a genuine cache hit, identical binaries at `/opt/honeyrail/postgres/bin`, but different mount sources and no `ref`/`resolvedCommit`/`sourceHash`/`cacheKey`/`entryId` anywhere the agent could see.
- `docker being unavailable fails loudly instead of running the agent unisolated`, plus static assertions on the exact mount list, the hardening flags, the in-container-only environment, and the marker-free build view.

Because the fixture's binaries are shell scripts, these run and enforce real container isolation on a macOS host too — docker's namespaces do not care what is inside the mount. What a macOS host *cannot* test is a real PostgreSQL build executing inside the container; see [Platform limitation](#platform-limitation-container-architecture-must-match-the-build-host).

Validating against real PostgreSQL is a manual step: populate a mirror as shown above, then drive `withPostgresResearchEnvironment()` over a pre-fix ref and its fix ref with the same build profile and the same reproducer, and confirm the two disagree. The build cache keys them apart automatically because their source hashes differ.

## Known limitations

- PostgreSQL only; local source builds only (no Docker path, no cross-compilation, no remote execution).
- One cluster per environment: no replication, no multi-node topology, no fault injection.
- The build cache is content-keyed but not garbage-collected; a corpus of many refs will grow it.
- Build-cache concurrency is safe (staged build + atomic rename) but not coordinated: two environments needing the same cold build may both build it.
- The cache key covers a declared set of build-environment variables, not a hermetic toolchain fingerprint.
- `timeoutMs` cancels the caller and tears down the cluster; it cannot abort a JavaScript `await` already in flight. For an agent, prefer `agent.timeoutMs` on the session helper, which kills the agent first and cleans up after.
- The agent boundary is a container, so it needs a docker daemon; without one, an agent session fails rather than degrading. It is shared-kernel isolation, not a microVM.
- A real PostgreSQL build can only execute inside the boundary when the container's architecture and libc match the build host — in practice, a Linux host. See [Platform limitation](#platform-limitation-container-architecture-must-match-the-build-host).
- Container egress is unrestricted by default, so an internet-connected agent can still fingerprint a PostgreSQL version against public sources. `isolation.network: "none"` closes that off if the trial policy requires it.
- The `postgres-research` executor itself does not run an agent, so nothing about it is isolated; it is a grader-side environment driver.
- Live agent research is composed by `runAgentInPostgresResearchEnvironment()`, not by the DAG; a `postgres-research` step cannot hand a running cluster to a later step.
- The agent-visible root defaults to a temp root and, like v0, keeps the source snapshot after cleanup unless `removeSourceDir` is set. Long campaigns should set it, or point `HONEYRAIL_PG_ENV_ROOT` somewhere with room.
