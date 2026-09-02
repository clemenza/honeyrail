# PR #182 — local integration validation (fourth review)

Local, end-to-end validation of the PostgreSQL Research Environment's **scored**
path on a real developer machine, with real Docker and real PostgreSQL.

It exists because the third review's evidence proved two disjoint halves —
*real Linux build → binaries execute in a probe container*, and *synthetic host
build → stub cluster + agent container* — and never the thing a scored trial
actually is. This run closes that: a real PostgreSQL git ref, built in the
builder container, started as a **live server inside a runtime container**,
queried by an **isolated agent container** over a shared Unix socket,
restarted, and torn down.

Every item below is labelled **PASS**, **FAIL**, **SKIPPED**, **NOT TESTED** or
**KNOWN LIMITATION**. Host-path segments are the real ones except where a
personal directory name would add nothing; no secrets, tokens or registry
credentials are recorded.

Validated at commit `85ba9e5` on branch `claude/pg-research-environment-179`
(PR #182), on top of `dbec0bf`.

---

## 1. Environment facts — PASS

```text
$ uname -a
Darwin MacBook-Pro-M3.local 25.5.0 Darwin Kernel Version 25.5.0:
  Mon Apr 27 20:41:06 PDT 2026; root:xnu-12377.121.6~2/RELEASE_ARM64_T6030 x86_64

$ uname -m
x86_64

$ sw_vers
ProductName:     macOS
ProductVersion:  26.5.1
BuildVersion:    25F80

$ sysctl -n machdep.cpu.brand_string
Apple M3 Pro

$ sysctl -n sysctl.proc_translated
1

$ node -p "[process.platform, process.arch, process.version].join(' ')"
darwin arm64 v23.4.0

$ node --version
v23.4.0
$ npm --version
10.9.2
```

Reality, reported rather than assumed: this is an **Apple Silicon (M3 Pro)
macOS 26.5.1** machine. `uname` says `x86_64` because the *shell* is running
under Rosetta 2 (`sysctl.proc_translated = 1`); Node itself is a native
`arm64` binary and Docker is `darwin/arm64` → `linux/aarch64`. This is exactly
the sort of host/target confusion the build manifest is designed to survive:
the cache key uses the *builder image's* `linux/arm64`, not the host's, and
records `hostPlatform`/`hostArch` separately.

```text
$ docker version
Client:  Version 27.4.0, API 1.47, OS/Arch darwin/arm64, Context desktop-linux
Server:  Docker Desktop 4.37.2 (179585)
  Engine:     Version 27.4.0, API 1.47 (min 1.24), OS/Arch linux/arm64
  containerd: 1.7.21
  runc:       1.1.13
  docker-init 0.19.0

$ docker info --format '{{.OSType}}/{{.Architecture}} server={{.ServerVersion}} driver={{.Driver}} cpus={{.NCPU}} mem={{.MemTotal}}'
linux/aarch64 server=27.4.0 driver=overlay2 cpus=12 mem=12529209344

$ docker buildx version
github.com/docker/buildx v0.19.2-desktop.1 412cbb151f1be3f8a94dc4eb03cd1b67f261dec5

$ df -h / /System/Volumes/Data
Filesystem       Size   Used  Avail Capacity  Mounted on
/dev/disk3s1s1  460Gi   16Gi   55Gi    23%    /
/dev/disk3s5    460Gi  357Gi   55Gi    87%    /System/Volumes/Data
```

Host uid/gid, which matters for the runtime container's identity shim:

```text
$ id -u; id -g
71393735
1085706827
```

That uid has no `/etc/passwd` entry in any stock image, which is precisely the
case the review asked to be proven rather than assumed:

```text
$ docker run --rm --network none --user 71393735:1085706827 debian:bookworm-slim whoami
whoami: cannot find name for user ID 71393735   (exit 1)
```

## 2. Freshly built, uniquely tagged images — PASS

```sh
docker build -t honeyrail-postgres-builder:pr182-r4-validation  -t honeyrail-postgres-builder:latest  docker/postgres-research-builder
docker build -t honeyrail-postgres-runtime:pr182-r4-validation  -t honeyrail-postgres-runtime:latest  docker/postgres-research-runtime
docker build -t honeyrail-postgres-research:pr182-r4-validation -t honeyrail-postgres-research:latest docker/postgres-research
```

```text
$ docker image inspect --format '{{.RepoTags}} id={{.Id}} os={{.Os}} arch={{.Architecture}} created={{.Created}}' \
    honeyrail-postgres-builder:pr182-r4-validation \
    honeyrail-postgres-runtime:pr182-r4-validation \
    honeyrail-postgres-research:pr182-r4-validation

[honeyrail-postgres-builder:latest honeyrail-postgres-builder:pr182-r4-validation]
  id=sha256:f964f19cbcbfc2eed5d6dedcd26581d5743f1d5037e7e854b8e952257dbd7ffe os=linux arch=arm64 created=2026-09-02T03:09:20.150455136Z
[honeyrail-postgres-runtime:latest honeyrail-postgres-runtime:pr182-r4-validation honeyrail-postgres-runtime:prewarm]
  id=sha256:8d590fde3567ddeea732e011e959af6d3ffc426543f405a02b63de7bd38b0522 os=linux arch=arm64 created=2026-09-02T07:30:37.170682378Z
[honeyrail-postgres-research:latest honeyrail-postgres-research:pr182-r4-validation]
  id=sha256:142143e1effab2e9a3ccbf74c8af438b455f6d8252f983f14b53d277ea1873fd os=linux arch=arm64 created=2026-09-02T03:38:48.233655051Z
```

ABI compatibility: builder = `debian:bookworm-slim` (glibc 2.36), runtime =
`debian:bookworm-slim` (glibc 2.36), agent = `node:24-bookworm-slim` (glibc
2.36); all three `linux/arm64`, matching the daemon's `linux/aarch64`. The
runner does not trust that pairing — `createPostgresResearchEnvironment()`
compares the resolved runtime image's `os`/`architecture` against the build
manifest's target and fails loudly on a mismatch.

No image is ever pulled implicitly. A missing one is a loud failure (§6).

## 3. Pinned real PostgreSQL ref — PASS

```text
mirror path      /tmp/pg-research-validation/pg-mirror
remote           https://github.com/postgres/postgres.git
partial clone    blob:none
requested ref    REL_16_9
resolved commit  6e4ab1b69197e2756192a1019439aebacdea5497
tree hash        7f2990057ec4fee1c9c14df7f6b95a89dc8882d8
```

The ref is arbitrary and disposable: any resolvable ref proves the property,
and nothing in this repository names, or may name, the historical corpus. The
mirror is **never** mounted into any container — the environment materializes
a `.git`-free snapshot from it with `git archive` and mounts that.

## 4. Cold build and cache validation — PASS

Cold, into an empty cache root:

```text
### cold: source
repoPath=/tmp/pg-research-validation/pg-mirror
ref=REL_16_9
resolvedCommit=6e4ab1b69197e2756192a1019439aebacdea5497
sourceTreeHash=7f2990057ec4fee1c9c14df7f6b95a89dc8882d8
gitDirPresent=false

### cold: build
buildMode=container
scoredEligible=true
installPrefix=/opt/honeyrail/postgres
builderImage=honeyrail-postgres-builder:latest id=sha256:f964f19cbcbfc2eed5d6dedcd26581d5743f1d5037e7e854b8e952257dbd7ffe platform=linux/arm64
compiler=cc cc (Debian 12.2.0-14+deb12u1) 12.2.0 target=aarch64-linux-gnu
make=GNU Make 4.3
targetPlatform=linux/arm64 hostPlatform=darwin/arm64
cacheKey=76ea147896ebab371c0edcd4561e089438effaaad688a773b99d603164512a56
entryId=253f0de09f20e8868279432bd7f81bd2
cacheRoot=/tmp/pg-research-validation/build-cache-r4cold
installDir=/tmp/pg-research-validation/build-cache-r4cold/253f0de09f20e8868279432bd7f81bd2
cacheHit=false
jobs=8
wallClockMs=48851
commands=[["configure","container","4617ms"],["make","container","40613ms"],["make install","container","2950ms"]]
  argv: /build/source/configure --prefix=/opt/honeyrail/postgres --without-readline --without-zlib --without-icu
  argv: make -j8
  argv: make install DESTDIR=/build/staging
```

`file(1)` on the published artifact — Linux ELF, built on a macOS host:

```text
.../253f0de09f20e8868279432bd7f81bd2/bin/postgres:   ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, BuildID[sha1]=156ba8c345f8cfccd05933924fa82b84b89e3670, for GNU/Linux 3.7.0, not stripped
.../253f0de09f20e8868279432bd7f81bd2/bin/psql:       ELF 64-bit LSB pie executable, ARM aarch64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-linux-aarch64.so.1, BuildID[sha1]=98d3ec3dea48ad51a0af1ffd6a0f1688909638a4, for GNU/Linux 3.7.0, not stripped
.../253f0de09f20e8868279432bd7f81bd2/lib/libpq.so.5: ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV), dynamically linked, BuildID[sha1]=b78d1acf2c1e13e3171e7f4f3ea6cc491e7b1ca4, not stripped
```

Observed **inside the agent container**, against this trial's randomized view
of the entry (i.e. exactly what an agent is handed):

```text
-- uname
Linux aarch64
-- pg_config --bindir
/opt/honeyrail/postgres/bin
-- pg_config --libdir
/opt/honeyrail/postgres/lib
-- pg_config --sharedir
/opt/honeyrail/postgres/share
-- pg_config --configure
 '--prefix=/opt/honeyrail/postgres' '--without-readline' '--without-zlib' '--without-icu'
-- pg_config --version
PostgreSQL 16.9
-- postgres --version
postgres (PostgreSQL) 16.9
-- initdb --version
initdb (PostgreSQL) 16.9
-- psql --version
psql (PostgreSQL) 16.9
-- grep cacheRoot
clean
-- grep entryId
clean
-- grep cacheKey
clean
-- strings postgres
clean
-- strings pg_config
clean
-- completion marker in the agent view
0
-- Makefile.global prefix
abs_top_srcdir = /build/source
prefix := /opt/honeyrail/postgres
```

Control that the scans are not inert — the same `entryId` search run
host-side over the **whole** cache entry finds it in exactly one place, the
completion marker that is deliberately withheld from the agent's view:

```text
$ grep -R -a -l -F 253f0de09f20e8868279432bd7f81bd2 <installDir>
/tmp/pg-research-validation/build-cache-r4cold/253f0de09f20e8868279432bd7f81bd2/honeyrail-build-complete.json
```

Identical repeat run → **cache hit, no configure/make/install executed**:

```text
### warm: build
cacheKey=76ea147896ebab371c0edcd4561e089438effaaad688a773b99d603164512a56
entryId=253f0de09f20e8868279432bd7f81bd2
cacheHit=true
jobs=8
wallClockMs=647          (cold: 48851)
commands=[]              (cold: configure, make, make install)
```

## 5. Real live-cluster end-to-end — PASS

Driven through `runAgentInPostgresResearchEnvironment()`, the one supported
composition, on the scored defaults (no `build.mode`, no `network` override).

### The agent's own output, from inside its container

```text
pg_config --bindir: /opt/honeyrail/postgres/bin
postgres --version: postgres (PostgreSQL) 16.9
SELECT version(): PostgreSQL 16.9 on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
CREATE TABLE
INSERT 0 1
SELECT after insert: 1|written-by-agent
server log: 1 readiness lines
```

Agent artifact returned to the grader (`$HR_PG_WORK_DIR/result.txt`):

```text
agent-artifact-ok
```

### Image identities, network mode and the exact mount lists

```json
{
  "mode": "container",
  "isolated": true,
  "image": "honeyrail-postgres-research:latest",
  "networkMode": "none",
  "scoredEligible": true,
  "buildScoredEligible": true,
  "runtimeScoredEligible": true,
  "runtime": {
    "mode": "container",
    "scoredEligible": true,
    "image": {
      "reference": "honeyrail-postgres-runtime:latest",
      "id": "sha256:8d590fde3567ddeea732e011e959af6d3ffc426543f405a02b63de7bd38b0522",
      "digest": null,
      "platform": "linux/arm64",
      "os": "linux",
      "architecture": "arm64"
    },
    "containerName": "honeyrail-pg-runtime-3995bcf4-74c3-4974-8f4a-3819ef57b9d9",
    "containerId": "edb58bbc887157cab696749f48f5695593e0d6dadff478881039350f8c7f72eb",
    "networkMode": "none",
    "user": "71393735:1085706827",
    "mounts": [
      "<T>/views/view-YyeAdz/6463871509b2718575b41172ed71c11f:/opt/honeyrail/postgres:ro",
      "<T>/envs/live/pgdata:/runtime/pgdata:rw",
      "/tmp/hrpg-HEkfLR:/runtime/socket:rw",
      "<T>/envs/live/postgres.log:/runtime/postgres.log:rw",
      "/tmp/hrpg-id-GSlFJn/passwd:/etc/passwd:ro",
      "/tmp/hrpg-id-GSlFJn/group:/etc/group:ro"
    ]
  },
  "containerName": "honeyrail-pg-research-2a82b666-60fe-4165-aa0c-af3b04c7520c",
  "mounts": [
    "<T>/envs/live/source:/workspace/source:rw",
    "<T>/envs/live/pgdata:/workspace/runtime/pgdata:rw",
    "/tmp/hrpg-HEkfLR:/workspace/runtime/socket:rw",
    "<T>/envs/live/postgres.log:/workspace/runtime/postgres.log:ro",
    "<T>/envs/live/agent-work:/workspace/agent:rw",
    "<T>/views/view-YyeAdz/6463871509b2718575b41172ed71c11f:/opt/honeyrail/postgres:ro"
  ],
  "buildViewDir": "<T>/views/view-YyeAdz/6463871509b2718575b41172ed71c11f"
}
```

(`<T>` = the run's temp root, `/var/folders/…/T/hrpg-live-R9qfN0`.)

The one thing shared between the two containers is `/tmp/hrpg-HEkfLR`, the
socket directory. Neither container mounts the source mirror, the build-cache
root, the grader-private directory, an attachment tree, a sibling trial, the
HoneyRail checkout, `$HOME`, or the docker socket. Both are `--network none`,
and no `-p`/`--publish` appears anywhere.

### Lifecycle, in order

```json
[
  { "phase": "source.materialized",       "durationMs": 2053, "detail": { "ref": "REL_16_9", "commit": "6e4ab1b6…", "sourceHash": "7f299005…", "gitDirPresent": false } },
  { "phase": "build.completed",           "durationMs": 716,  "detail": { "cacheKey": "76ea1478…", "cacheHit": true } },
  { "phase": "build.view.created",                            "detail": { "viewDir": "<T>/views/view-YyeAdz/…" } },
  { "phase": "runtime.container.created", "durationMs": 258,  "detail": { "image": "honeyrail-postgres-runtime:latest", "imageId": "sha256:8d590fde…", "platform": "linux/arm64", "networkMode": "none", "user": "71393735:1085706827" } },
  { "phase": "cluster.initdb",            "durationMs": 1592, "detail": { "args": ["-A","trust","-U","postgres","--no-locale"], "mode": "container" } },
  { "phase": "cluster.started",           "durationMs": 243,  "detail": { "port": 61244, "mode": "container", "listen": "unix-socket-only" } },
  { "phase": "cluster.ready",                                 "detail": { "latencyMs": 134, "mode": "container" } },
  { "phase": "cluster.stopped",           "durationMs": 257,  "detail": { "mode": "fast", "ok": true } },
  { "phase": "cleanup.completed",                             "detail": { "stopped": true, "stopMode": "fast", "runtimeContainerRemoved": true, "buildViewRemoved": true, "dataDirRemoved": true, "socketDirRemoved": true, "errors": [] } }
]
```

### Server log tail (the real server's own log)

```text
2026-09-02 07:57:44.718 UTC [34] LOG:  starting PostgreSQL 16.9 on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
2026-09-02 07:57:44.719 UTC [34] LOG:  listening on Unix socket "/runtime/socket/.s.PGSQL.61244"
2026-09-02 07:57:44.722 UTC [37] LOG:  database system was shut down at 2026-09-02 07:57:44 UTC
2026-09-02 07:57:44.724 UTC [34] LOG:  database system is ready to accept connections
2026-09-02 07:57:45.406 UTC [34] LOG:  received fast shutdown request
2026-09-02 07:57:45.407 UTC [34] LOG:  aborting any active transactions
2026-09-02 07:57:45.407 UTC [34] LOG:  background worker "logical replication launcher" (PID 40) exited with exit code 1
2026-09-02 07:57:45.407 UTC [35] LOG:  shutting down
2026-09-02 07:57:45.408 UTC [35] LOG:  checkpoint starting: shutdown immediate
2026-09-02 07:57:45.422 UTC [35] LOG:  checkpoint complete: wrote 43 buffers (0.3%); 0 WAL file(s) added, 0 removed, 0 recycled; write=0.005 s, sync=0.003 s, total=0.015 s; sync files=36, longest=0.001 s, average=0.001 s; distance=159 kB, estimate=159 kB; lsn=0/14A79B8, redo lsn=0/14A79B8
2026-09-02 07:57:45.426 UTC [34] LOG:  database system is shut down
```

Note `listening on Unix socket` and the **absence** of any `listening on IPv4
address` line: the postmaster is started with `-h ''`, so no TCP listener
exists at all and no host port is published.

### Restart and data persistence

```text
runtime container: honeyrail-pg-runtime-76e6431b-c0cf-4d0e-9793-2ec18268e6a2
runtime image: honeyrail-postgres-runtime:latest sha256:8d590fde3567ddeea732e011e959af6d3ffc426543f405a02b63de7bd38b0522
SELECT version(): PostgreSQL 16.9 on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
before restart: 42
restart ready=true latencyMs=213
after restart: 42
health: containerRunning=true serverRunning=true
health detail: pg_ctl: server is running (PID: 77)
/opt/honeyrail/postgres/bin/postgres "-p" "61251" "-h" "" "-k" "/runtime/socket"
psqlFile: 1
```

`psqlFile` is included deliberately: a grader-side SQL script lives on the
host, which the runtime container cannot see, so it is streamed in on
`docker exec -i`'s stdin rather than mounted or copied. (`docker cp` is
refused outright by a `--read-only` container — "container rootfs is marked
read-only" — and dropping `--read-only` to accommodate it would have weakened
the sidecar for a convenience.)

### Cleanup, and what survives

```text
pgdata exists: false
socketDir exists: false
buildView exists: false
docker ps -a --filter name=honeyrail-pg- -> (none)
cache entry retained: true
cache marker retained: true
build views root contents: (empty)
```

### Automated equivalent

The same pipeline is a required test, `test/postgres-research-live-e2e.test.ts`:

```text
✔ the scored pipeline: real ref -> builder container -> runtime container -> live PostgreSQL -> isolated agent -> restart -> ordered cleanup (60798ms cold / 12234ms warm)
✔ the supported composed session records every scored axis, and a second real trial reuses the cached build
✔ a missing runtime image fails loudly before anything is materialized or built
✔ an initdb failure tears the runtime container down and leaves no view behind
✔ a real trial's containers, view and ephemeral directories are all gone afterwards
ℹ tests 5  ℹ pass 5  ℹ fail 0  ℹ skipped 0
```

Inside that test the agent additionally proves, in one run: no source `.git`;
no cache root/key/entry id in its environment, in `/proc/self/mountinfo`, in
the installed tree or in `strings` of the `postgres` binary; the build
completion marker absent; grader filesystem sentinels unreadable; a real host
HTTP sentinel unreachable over six enumerated routes with the attempt count
asserted (`tried=6 reached=0`); the server log readable; and agent and grader
querying provably the same server.

## 6. Negative paths — PASS

| Case | Result | Evidence |
| --- | --- | --- |
| missing runtime image fails loudly | **PASS** | `PostgresRuntimeContainerError: Image "honeyrail-postgres-runtime:definitely-not-present" is not available to the docker daemon. Build it first: docker build -t … docker/postgres-research-runtime (or pass runtime.image / set build.mode: "host" …)` and `source materialized anyway: false` — it fails *before* materialization, and never falls back to a host cluster |
| invalid ref never falls back | **PASS** | `PostgresResearchError: Cannot resolve PostgreSQL source ref "refs/heads/definitely-not-a-ref" in /tmp/pg-research-validation/pg-mirror` |
| initdb failure cleans the runtime | **PASS** | test: `initdb failed inside the runtime container`; container still present until `cleanup()` (the ordering), then `runtimeContainerRemoved: true`, build view gone, `bin/initdb` still in the cache |
| missing agent command cleans runtime + view | **PASS** | `agent.ok=false exitCode=127`, OCI `no such file or directory`; `cleanup: {"stopped":true,"stopMode":"fast","runtimeContainerRemoved":true,"buildViewRemoved":true,"dataDirRemoved":true,"socketDirRemoved":true,"errors":[]}`; `leaked containers: (none)` |
| agent timeout kills descendants before server teardown | **PASS** | test `a real trial's containers, view and ephemeral directories are all gone afterwards`: `agent.timedOut = true`, then `stopped: true`, `runtimeContainerRemoved: true`, both containers gone, view/socket/PGDATA gone |
| forced server failure is an environment failure, not an agent finding | **PASS** | a failed `initdb`/`start` throws `PostgresResearchError`/`PostgresRuntimeContainerError` out of `start()`; the session never reaches the agent, so no `PostgresResearchAgentResult` is produced to be mistaken for a finding |
| bridge mode is unscored | **PASS** | `{"networkMode":"bridge","buildScoredEligible":true,"runtimeScoredEligible":true,"scoredEligible":false,"warning":"Not a scored trial. The agent container ran on docker network \"bridge\" … host.docker.internal …"}` |
| host mode is unscored | **PASS** | `{"buildMode":"host","buildScoredEligible":false,"runtimeMode":"host-process","runtimeScoredEligible":false,"scoredEligible":false,"warning":"Not a scored trial. The PostgreSQL under research was not built by the pinned Linux build container … The PostgreSQL server the agent queried ran as host processes rather than inside the pinned Linux runtime container …"}` — both axes, both stated |
| network-none cannot retrieve the host HTTP sentinel | **PASS** | `tried=6 reached=0`, sentinel absent from the agent's entire output; `test/postgres-research-network.test.ts` additionally asserts empty IPv4 **and** IPv6 route tables and no `eth0` |
| parallel trials do not collide | **PASS** | two concurrent scored trials: ports `61405`/`61406`, sockets `/tmp/hrpg-46DRBX` / `/tmp/hrpg-ubViMY`, distinct runtime containers, both `rows=1`, and both sharing one cache entry (`sharedCacheEntry: true`) |
| identical second trial hits the cache | **PASS** | §4 warm run: `cacheHit=true`, `commands=[]`, 647ms vs 48851ms |

Ownership, which the review asked to be proven rather than argued:

- runtime can write PGDATA/socket/log — **PASS**: `initdb` succeeded as uid
  `71393735` into a macOS bind mount, and the socket was created there.
- agent can connect to the socket — **PASS**: real `SELECT version()` from the
  agent container.
- host cleanup can remove the ephemeral paths — **PASS**: `dataDirRemoved`,
  `socketDirRemoved`, `buildViewRemoved` all true, with an empty `errors` array.
- no named-user assumption for an arbitrary host uid — **PASS**: the generated
  two-line `passwd`/`group` shim; without it, `initdb: could not look up
  effective user ID 71393735: user does not exist` (observed directly).
- no broadly privileged agent introduced — **PASS**: both containers keep
  `--cap-drop=ALL --security-opt no-new-privileges --read-only --pids-limit
  --memory --user <host uid>`, and neither runs as root.

- Root-host path (`uid 0` → fixed non-root runtime uid + `chown` of the
  ephemeral dirs) — **NOT TESTED** locally: this machine's user is not root.
  It is covered by a unit test of `runtimeUserIds()` and will be exercised by
  the CI job, which runs on a Linux runner. **KNOWN LIMITATION** for this
  report.

## 7. Repository checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | **PASS** — 0 errors |
| `npm run build` (typecheck + vite production build) | **PASS** — `✓ 1595 modules transformed`, `✓ built in 889ms`, exit 0 |
| `npm test` (full suite, **mirror configured**) | `ℹ tests 500  ℹ pass 493  ℹ fail 7  ℹ skipped 0` — the 7 are pre-existing and unrelated; see below |
| `npm test` (full suite, mirror *not* configured) | `ℹ tests 500  ℹ pass 485  ℹ fail 7  ℹ skipped 8` — the 8 skips are exactly the opt-in real-PostgreSQL tests |
| `test/postgres-research-runtime.test.ts` | **PASS** — `tests 13  pass 13  fail 0  skipped 0` |
| `test/postgres-research-live-e2e.test.ts` (with mirror) | **PASS** — `tests 5  pass 5  fail 0  skipped 0`, cold and warm |
| `test/postgres-research-real-build.test.ts` + `-isolation` + `-network` + `-session` (with mirror, one run) | **PASS** — `tests 20  pass 20  fail 0  skipped 0` |
| `test/postgres-research-environment.test.ts` | **PASS** — `tests 23  pass 23  fail 0  skipped 0` |
| Verify-Gate self-test (`.github/workflows/verify-gate-self-test.yml`) | **NOT TESTED** locally — it boots a production server plus tmux and pytest under a dedicated workflow; unchanged by this PR and unrelated to the PostgreSQL research path |

### Skipped / failing tests, in full

Without `HONEYRAIL_PG_TEST_MIRROR`, `npm test` skips exactly eight tests — the
opt-in real-PostgreSQL ones (5 in `postgres-research-live-e2e`, 3 in
`postgres-research-real-build`), each with a skip message that says a skip does
not satisfy the gate:

```text
﹣ the scored pipeline: real ref -> builder container -> runtime container -> live PostgreSQL -> isolated agent -> restart -> ordered cleanup # HONEYRAIL_PG_TEST_MIRROR is not set … This test is the merge gate for #182 MUST 5; a skip does not satisfy it.
﹣ the supported composed session records every scored axis, and a second real trial reuses the cached build # …
﹣ a missing runtime image fails loudly before anything is materialized or built # …
﹣ an initdb failure tears the runtime container down and leaves no view behind # …
﹣ a real trial's containers, view and ephemeral directories are all gone afterwards # …
﹣ a real containerized PostgreSQL build compiles in the neutral prefix and no grader cache identity # … merge gate for #182 MUST 1; a skip does not satisfy it.
﹣ a second real trial reuses the cached build and sees it at the same neutral path through a different view # …
﹣ a cold real build configures with the neutral prefix, stages through DESTDIR, and bakes only the prefix into pgxs # …
```

**All eight were run with the mirror set and all eight passed** — the full
suite then reports `skipped 0`. A skip is not a pass, so
`.github/workflows/pg-research-integration.yml` fails the build when the
skipped count in any of the four PostgreSQL research logs is non-zero.

Seven test files fail on this machine and are **pre-existing and unrelated**:

```text
test/dsh-evals-demo.test.ts
test/dsh-session-stats.test.ts
test/dsh-trajectory-bridge.test.ts
test/dsh-transcript.test.ts
test/kill-attribution.test.ts
test/tinytable-diagnose.test.ts
test/trial-diagnosis.test.ts
```

all with the same module-load error, before any test body runs:

```text
server/evals/dsh-session-stats.ts:51
import { zstdDecompressSync } from "node:zlib";
SyntaxError: The requested module 'node:zlib' does not provide an export named 'zstdDecompressSync'
Node.js v23.4.0
```

`zstdDecompressSync` landed in Node 22.15 / 23.8; this machine has v23.4.0 and
CI pins `node-version: 22` (a 22.x with it). Verified by checking out the base
commit `dbec0bf` in the same worktree and reproducing the identical failures
there; this PR touches no file under `server/evals/` or `scripts/tinytable-*`.
**KNOWN LIMITATION** of the local host, not a regression.

## 8. What is explicitly not claimed

- **Windows** — **NOT TESTED**. Nothing in the mechanism is macOS-specific and
  Docker Desktop on Windows is the same Linux VM, but no Windows host was
  available, so the documentation says *expected*, not *proven*.
- **Root-host runtime uid fallback** — **NOT TESTED** locally (§6).
- **Restricted model-API egress** — **KNOWN LIMITATION**, and recorded as a
  blocker before #180. A scored trial's containers are `--network none`, so a
  cloud-backed agent CLI cannot run in one. `bridge` works and is honestly
  recorded `scoredEligible: false`. A real egress policy (RFC1918, link-local,
  loopback, metadata and host-gateway destinations, over IPv4 **and** IPv6,
  from inside a `--cap-drop=ALL` container) is its own piece of work; a
  half-built one would be worse than the label.
- **Bit-for-bit reproducible builds** — not claimed. The builder image fixes
  the toolchain, locale and environment, and its content id is in the cache
  key so a rebuilt image invalidates rather than mixes, but the image itself is
  built from a moving package index.
- **Kernel-level isolation** — not claimed. This is Docker's namespace, cgroup
  and capability model, not gVisor or a microVM.

## 9. Reproducing this

```sh
# 1. images (fresh, uniquely tagged)
docker build -t honeyrail-postgres-builder:pr182-r4-validation  -t honeyrail-postgres-builder:latest  docker/postgres-research-builder
docker build -t honeyrail-postgres-runtime:pr182-r4-validation  -t honeyrail-postgres-runtime:latest  docker/postgres-research-runtime
docker build -t honeyrail-postgres-research:pr182-r4-validation -t honeyrail-postgres-research:latest docker/postgres-research
docker image inspect --format '{{.RepoTags}} id={{.Id}} os={{.Os}} arch={{.Architecture}}' \
  honeyrail-postgres-builder:pr182-r4-validation \
  honeyrail-postgres-runtime:pr182-r4-validation \
  honeyrail-postgres-research:pr182-r4-validation

# 2. a real pinned ref (reuse an existing mirror; do not re-clone)
export HONEYRAIL_PG_TEST_MIRROR=/tmp/pg-research-validation/pg-mirror
export HONEYRAIL_PG_TEST_REF=REL_16_9
git -C "$HONEYRAIL_PG_TEST_MIRROR" rev-parse --verify "$HONEYRAIL_PG_TEST_REF^{commit}"
git -C "$HONEYRAIL_PG_TEST_MIRROR" rev-parse --verify "$HONEYRAIL_PG_TEST_REF^{tree}"

# 3. cold build + cache hit + full live E2E, into a fresh cache root
rm -rf /tmp/pg-research-validation/build-cache-verify
export HONEYRAIL_PG_TEST_CACHE=/tmp/pg-research-validation/build-cache-verify
node --import tsx --test test/postgres-research-live-e2e.test.ts     # 5/5, 0 skipped (cold: ~1-2 min)
node --import tsx --test test/postgres-research-live-e2e.test.ts     # again: now a cache hit throughout
node --import tsx --test test/postgres-research-real-build.test.ts   # 3/3, 0 skipped

# 4. everything else
npm run typecheck
node --import tsx --test test/postgres-research-runtime.test.ts
node --import tsx --test test/postgres-research-environment.test.ts
node --import tsx --test test/postgres-research-isolation.test.ts
node --import tsx --test test/postgres-research-network.test.ts
npm test          # with the three env vars above set, this reports 0 skipped
npm run build

# 5. nothing leaked
docker ps -a --filter name=honeyrail-pg- --format '{{.Names}}\t{{.Status}}'   # expect empty
ls "$HONEYRAIL_PG_TEST_CACHE"                                                # expect the entry to remain
```

The transcripts in §4/§5/§6 that are not test output were produced by two
throwaway scripts driving the same public APIs
(`materializePostgresSource`/`buildPostgres`, and
`runAgentInPostgresResearchEnvironment`/`withPostgresResearchEnvironment`).
They are deliberately not committed: everything they assert is also asserted by
`test/postgres-research-live-e2e.test.ts` and
`test/postgres-research-real-build.test.ts`, which are the artifacts that have
to keep working.

## 10. Verdict

Every acceptance condition in the fourth review's "Mandatory local validation"
was executed on this machine against real Docker and real PostgreSQL 16.9, and
no required validation was skipped.

**READY FOR REVIEW**
