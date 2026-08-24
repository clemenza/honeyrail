# tinytable-eval exam-room isolation (#105)

Zone 2 ("exam room") of the #104/#105/#106/#109 three-zone eval isolation
design - the remediation for #103 (P0): a `dsh-testengineer-trial` agent
escaped its sandbox and read `examples/tinytable-eval`'s answer key (mutants,
golden tests, `score.py`) straight off the shared host filesystem, because
nothing but dsh's own `workspace-write` sandbox mode stood between the agent
and the rest of the host - and #103 proved that mode does not restrict reads
at all.

This document describes the mechanism, what it was verified to do, and its
known limitations - see #104 for the builder (zone 1) that produces the
seed-root this consumes, and #106/#109 for the preflight check and driver
integration that are not part of this issue.

## Mechanism

- **Image**: `docker/tinytable-exam-room/Dockerfile` builds a standalone
  image with Node 24 and `dsh@0.1.0-rc.7` (the version
  `docs/dsh-adapter-notes.md`'s spike verified) preinstalled, plus a non-root
  `examroom` user. Nothing from `examples/tinytable-eval` - or the honeyrail
  checkout at all - is ever baked into it.
- **Runner**: `scripts/tinytable-exam-room.ts`'s `runInExamRoom()` launches a
  command inside that image via `docker run`, bind-mounting *only* the
  caller-supplied seed-root directory (normally #104's `buildSeedRoot()`
  output) at `/workspace`. No other host path is ever mounted in, unless the
  caller opts into `dshHomeDir` - a second, write-only mount at `/dsh-home`
  (`$DSH_HOME` pointed at it) that lets dsh's own session-persistence JSONL
  log survive the container's `--rm` instead of being lost with the
  ephemeral tmpfs `$HOME` (see server/evals/dsh-session-stats.ts, and
  `scripts/tinytable-exam-room.ts`'s module docstring for why this doesn't
  weaken the guarantee below: it carries no fixture/answer material, and
  nothing about it is a path the agent can read *out* through).
- **Container hardening** (`buildDockerArgs()`): `--read-only` root
  filesystem (dsh's writes go to `$HOME=/tmp`, a tmpfs, and to `/workspace`,
  both exempted), `--cap-drop=ALL`, `--security-opt no-new-privileges`,
  `--pids-limit`, `--memory`, and `--user <host uid:gid>` so the agent can
  write `sql-tests/agent/`/`findings.json` back into the bind-mounted
  seed-root without needing it pre-chowned.
- **Not routed through HoneyRail's own worktree/tmux/session-monitor
  machinery** - per `docs/security-model.md` ("do not treat the gateway as a
  sandbox") and #93's amendment, this is a standalone execution path
  specifically for scored eval trials, meant to be called by #93's driver,
  not a general-purpose sandboxing feature of the product.

## What was actually verified (not just designed)

Both ACs were checked empirically against a real container built from this
Dockerfile (see `test/tinytable-exam-room.test.ts`'s live tests, which
build/run against `tinytable-exam-room:latest` when present and skip
cleanly otherwise - CI/dev environments without docker still pass `npm
test`):

- **AC1 (filesystem enumeration)**: from inside a running container with a
  real #104-built seed-root mounted, `find` for
  `tinytable-eval*`/`golden`/`score.py`/`mutants` and `grep` for
  `tinytable-eval`/`honeyrail`/`seeded defect` across the entire filesystem
  (excluding `/proc`, `/sys`) returned nothing. `cat /proc/mounts` shows
  exactly one host bind mount (`/workspace`) plus the container's own
  pseudo-filesystems. Every plausible host path (`/host`, `~/.honeyrail`,
  `/agent-worktrees`, the honeyrail checkout, `/Users/*`) is simply absent.
- **AC2 (#103 re-run)**: re-created the #103 scenario - an empty seed-root
  missing `tinytable/`/`SPEC.md` entirely - and replayed the *exact* escape
  probes the #103 transcript described (reading
  `/Users/<user>/Workspace/honeyrail/examples/tinytable-eval`, checking
  `~/.honeyrail` readability, a broad filesystem search for
  `tinytable`/`SPEC.md` by name). Every probe failed: the paths don't exist
  inside the container's mount namespace, full stop. This holds regardless
  of what dsh's own sandbox does, because the boundary is the container's
  mount namespace, not an in-process policy.

## Known escape surfaces / limitations

Documenting these plainly rather than claiming an unqualified guarantee:

- **Shared-kernel isolation, not a microVM.** This uses Docker's namespace +
  cgroup + capability model, not gVisor or a Firecracker microVM. A kernel
  or container-runtime vulnerability could in principle still allow a
  container escape; this is a pragmatic boundary sized to the actual #103
  threat (an agent reading host files a lenient in-process sandbox failed to
  restrict), not a defense against a sophisticated kernel exploit. If that
  threat model changes, revisit with a microVM.
- **Network egress is not restricted.** The container runs on Docker's
  default bridge network so the agent can reach its model API
  (`DEEPSEEK_API_KEY` / DeepSeek's endpoint); nothing stops it from making
  other outbound requests. It cannot reach the host's loopback services
  (its own network namespace has no route to `127.0.0.1` on the host), but
  general internet egress is unrestricted. An egress allowlist is future
  work if exfiltration (as opposed to reading local answer material)
  becomes an in-scope threat.
- **Root-filesystem writability depends on the runtime `--user`.** `--cap-
  drop=ALL` plus `--read-only` mean a non-root container user cannot write
  outside `/workspace`/`$HOME`; if the host process invoking the runner
  itself runs as root (uid 0), the mapped in-container user is also uid 0,
  which weakens (though does not eliminate, since `CAP_DAC_OVERRIDE` is
  still dropped) the practical benefit of the read-only root. Deployments
  should run HoneyRail as a non-root local user, which `docs/security-
  model.md` already documents as the general expectation.
- **Resource limits are best-effort caps, not accounting.** `--pids-limit`/
  `--memory` bound a single run; nothing here yet prevents many concurrent
  scored-trial containers from collectively exhausting the host (that's a
  driver-level concern for #93/#109, not this issue).
- **dsh's launcher needed a local fix, unrelated to containerization.**
  dsh 0.1.0-rc.7's `headless` profile fails to boot
  (`--expose-internals is required for HMR service`) unless Node itself is
  launched with `--expose-internals` - confirmed on both Node 22 and Node
  24, so not a Node-version issue, and not fixable via `NODE_OPTIONS` (node
  refuses that flag there). The Dockerfile replaces the installed `dsh` bin
  shim with a wrapper that adds the flag so callers can keep invoking plain
  `dsh ...`; worth folding upstream into the dsh adapter (#88) if other
  launch paths hit the same thing outside a container.
- **dsh's own `tool-bash` sandbox needed to be turned off, not hardened
  further (#115).** dsh's default `workspace-write` mode makes it build a
  *second*, nested sandbox around every shell command it runs - and that
  nested sandbox needs to mount a fresh `/proc`, which Docker's default
  seccomp profile denies for any non-privileged container regardless of
  `--cap-drop`/`--security-opt no-new-privileges` (reproduced directly:
  `unshare --user --map-root-user --mount --pid --fork sh -c 'mount -t proc
  proc /proc'` fails identically with or without `no-new-privileges`). The
  practical effect before the fix: dsh's bash tool was completely unusable
  inside this image - every real trial fell back to static-analysis-only
  submissions instead of actually running `run_sql_tests.py` as the task
  prompt instructs. Since this container's own isolation is already the
  real security boundary for a scored trial, dsh's redundant inner sandbox
  is not just broken here but unnecessary; `scripts/tinytable-exam-room.ts`
  and `scripts/dsh-evals-demo.ts` now default `DSH_PERMISSION_MODE` to
  `danger-full-access` for exactly that reason. (Fixing this also exposed
  that the image had no Python interpreter at all - `run_sql_tests.py`/
  `score.py` are stdlib-only per `SPEC.md`, so the Dockerfile now installs
  bare `python3` via `apt-get`, no pip packages needed.)

## Manual verification (this session)

Reproducible with:

```sh
docker build -t tinytable-exam-room:latest docker/tinytable-exam-room
node --import tsx scripts/tinytable-seed-root-builder.ts --mutant m04 \
  --out /tmp/seed --manifest-out /tmp/manifest.json
node --import tsx --test test/tinytable-exam-room.test.ts
```

Building the image needs real internet access to pull `node:24-bookworm-
slim` from Docker Hub - this session's sandboxed environment blocks that
specific registry CDN host by policy, so the image used for the checks
above was assembled from the same post-base RUN steps (zstd check, dsh
install, launcher wrapper, non-root user) against a differently-sourced but
equivalent Ubuntu+Node base, to keep verification honest without routing
around that policy. The Dockerfile itself is unchanged by that
substitution and should build as-is wherever normal Docker Hub access is
available (e.g. CI, a real deployment host).
