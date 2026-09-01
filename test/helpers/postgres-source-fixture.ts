import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommandSafe } from "../../server/utils.js";

/**
 * A synthetic "PostgreSQL source tree" for the research-environment tests:
 * a git repository whose configure/make/make install produce four stub
 * binaries that emulate just enough of initdb/pg_ctl/psql/postgres to
 * exercise the real lifecycle (initdb -> start -> readiness -> SQL ->
 * restart -> stop -> cleanup) in seconds and without a C toolchain or a
 * PostgreSQL checkout.
 *
 * The real corpus (which refs, which bugs) must never appear in committed
 * test code, so the automated suite runs entirely against this fixture; the
 * genuine end-to-end proof against upstream PostgreSQL is a manual
 * validation step documented in docs/postgres-research-environment.md.
 */

const CONFIGURE = `#!/bin/sh
# Synthetic configure: records the prefix and flags the way a real
# configure bakes them into the build, and fails loudly without a prefix.
set -e
PREFIX=""
ARGS=""
for arg in "$@"; do
  case "$arg" in
    --prefix=*) PREFIX="\${arg#--prefix=}" ;;
    *) ARGS="$ARGS $arg" ;;
  esac
done
if [ -z "$PREFIX" ]; then
  echo "configure: --prefix is required" >&2
  exit 1
fi
{
  echo "PREFIX = $PREFIX"
  echo "CONFIGURE_ARGS =$ARGS"
} > build-config.mk
echo "configure: prefix $PREFIX"
`;

const MAKEFILE = `include build-config.mk

all:
\t@echo "building synthetic postgres"
\t@printf '%s\\n' "$(CONFIGURE_ARGS)" > build-stamp

install: all
\t@mkdir -p $(DESTDIR)$(PREFIX)/bin
\t@cp stubs/initdb stubs/pg_ctl stubs/psql stubs/postgres $(DESTDIR)$(PREFIX)/bin/
\t@chmod +x $(DESTDIR)$(PREFIX)/bin/initdb $(DESTDIR)$(PREFIX)/bin/pg_ctl $(DESTDIR)$(PREFIX)/bin/psql $(DESTDIR)$(PREFIX)/bin/postgres
\t@cp build-stamp $(DESTDIR)$(PREFIX)/configure-args.txt
\t@echo "install: done"

.PHONY: all install
`;

const STUB_REGISTRY = `REG="\${HR_STUB_PG_REGISTRY:-/tmp/honeyrail-stub-pg}"`;

const INITDB = `#!/bin/sh
set -e
DATADIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    -D) DATADIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$DATADIR" ]; then
  echo "initdb: -D is required" >&2
  exit 1
fi
mkdir -p "$DATADIR"
echo "0.0" > "$DATADIR/PG_VERSION"
: > "$DATADIR/stub_table"
echo "initdb: data directory $DATADIR initialised"
`;

const PG_CTL = `#!/bin/sh
set -e
${STUB_REGISTRY}
mkdir -p "$REG"
DATADIR=""
LOG=""
OPTS=""
ACTION=""
while [ $# -gt 0 ]; do
  case "$1" in
    -D) DATADIR="$2"; shift 2 ;;
    -l) LOG="$2"; shift 2 ;;
    -o) OPTS="$2"; shift 2 ;;
    -m) shift 2 ;;
    start|stop|restart|status) ACTION="$1"; shift ;;
    *) shift ;;
  esac
done
if [ -z "$DATADIR" ]; then
  echo "pg_ctl: -D is required" >&2
  exit 1
fi

stub_stop() {
  PORT=$(cat "$DATADIR/stub.port" 2>/dev/null || echo "")
  if [ -n "$PORT" ]; then rm -f "$REG/$PORT.info"; fi
  rm -f "$DATADIR/stub.port"
  if [ -n "$LOG" ]; then echo "database system is shut down" >> "$LOG"; fi
  echo "server stopped"
}

stub_start() {
  if [ ! -f "$DATADIR/PG_VERSION" ]; then
    echo "pg_ctl: directory \\"$DATADIR\\" is not a database cluster directory" >&2
    exit 1
  fi
  PORT=$(printf '%s' "$OPTS" | sed -n 's/.*-p \\([0-9][0-9]*\\).*/\\1/p')
  if [ -z "$PORT" ]; then
    echo "pg_ctl: no port in server options" >&2
    exit 1
  fi
  printf '%s' "$PORT" > "$DATADIR/stub.port"
  printf '%s' "$DATADIR" > "$REG/$PORT.info"
  if [ -n "$LOG" ]; then
    echo "listening on port $PORT" >> "$LOG"
    echo "database system is ready to accept connections" >> "$LOG"
  fi
  echo "server started"
}

case "$ACTION" in
  start) stub_start ;;
  stop) stub_stop ;;
  restart) stub_stop; stub_start ;;
  status) [ -f "$DATADIR/stub.port" ] || exit 3; echo "server is running" ;;
  *) echo "pg_ctl: unknown action" >&2; exit 1 ;;
esac
`;

const PSQL = `#!/bin/sh
${STUB_REGISTRY}
PORT=""
SQL=""
FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) PORT="$2"; shift 2 ;;
    -c) SQL="$2"; shift 2 ;;
    -f) FILE="$2"; shift 2 ;;
    -h|-U|-d|-v) shift 2 ;;
    *) shift ;;
  esac
done
INFO="$REG/$PORT.info"
if [ ! -f "$INFO" ]; then
  echo "psql: could not connect to server on port $PORT" >&2
  exit 2
fi
DATADIR=$(cat "$INFO")
TABLE="$DATADIR/stub_table"

run_statement() {
  statement=$(printf '%s' "$1" | sed 's/^ *//; s/ *$//')
  [ -z "$statement" ] && return 0
  case "$statement" in
    "SELECT 1;"|"SELECT 1") echo "1" ;;
    "SELECT version();"|"SELECT version()") echo "PostgreSQL 0.0 (honeyrail synthetic stub)" ;;
    "SELECT count(*) FROM stub;"|"SELECT count(*) FROM stub") wc -l < "$TABLE" | tr -d ' ' ;;
    "INSERT "*) printf '%s\\n' "\${statement#INSERT }" >> "$TABLE"; echo "INSERT 0 1" ;;
    *) echo "ERROR:  syntax error at or near \\"$statement\\"" >&2; return 3 ;;
  esac
  return 0
}

if [ -n "$FILE" ]; then
  status=0
  while IFS= read -r line; do
    run_statement "$line" || status=$?
    [ "$status" -ne 0 ] && break
  done < "$FILE"
  exit $status
fi
run_statement "$SQL"
exit $?
`;

const POSTGRES = `#!/bin/sh
case "$1" in
  --version|-V) echo "postgres (PostgreSQL) 0.0 (honeyrail synthetic stub)" ;;
  *) echo "postgres: synthetic stub, start via pg_ctl" >&2; exit 1 ;;
esac
`;

export type SyntheticPostgresSourceRepo = {
  repoPath: string;
  /** Commit holding the buildable tree the tests materialize. */
  ref: string;
  /** A later commit; must never be reachable from a snapshot of `ref`. */
  laterRef: string;
  /** File added only in `laterRef`. */
  laterFile: string;
};

async function git(repoPath: string, args: string[]) {
  const result = await runCommandSafe("git", ["-C", repoPath, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "honeyrail",
      GIT_AUTHOR_EMAIL: "honeyrail@example.invalid",
      GIT_COMMITTER_NAME: "honeyrail",
      GIT_COMMITTER_EMAIL: "honeyrail@example.invalid"
    }
  });
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function createSyntheticPostgresSourceRepo(repoPath: string): Promise<SyntheticPostgresSourceRepo> {
  await mkdir(join(repoPath, "stubs"), { recursive: true });
  await writeFile(join(repoPath, "configure"), CONFIGURE);
  await chmod(join(repoPath, "configure"), 0o755);
  await writeFile(join(repoPath, "Makefile"), MAKEFILE);
  for (const [name, content] of Object.entries({ initdb: INITDB, pg_ctl: PG_CTL, psql: PSQL, postgres: POSTGRES })) {
    await writeFile(join(repoPath, "stubs", name), content);
    await chmod(join(repoPath, "stubs", name), 0o755);
  }

  await git(repoPath, ["init", "-q", "-b", "main"]);
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-q", "-m", "synthetic postgres source"]);
  const ref = await git(repoPath, ["rev-parse", "HEAD"]);

  const laterFile = "FUTURE_FIX.txt";
  await writeFile(join(repoPath, laterFile), "history after the researched ref\n");
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-q", "-m", "later history"]);
  const laterRef = await git(repoPath, ["rev-parse", "HEAD"]);

  return { repoPath, ref, laterRef, laterFile };
}

/** The fixture only needs git, a POSIX shell and make - no C toolchain, no PostgreSQL. */
export async function hasFixtureToolchain(): Promise<boolean> {
  for (const [command, args] of [["git", ["--version"]], ["make", ["--version"]], ["tar", ["--help"]]] as const) {
    const result = await runCommandSafe(command, [...args], { timeout: 10000 });
    if (!result.ok) return false;
  }
  // detectCompilerIdentity() runs for the cache key even when the build
  // itself is a shell script, so a cc must at least answer --version.
  const cc = await runCommandSafe(process.env.CC || "cc", ["--version"], { timeout: 15000 });
  return cc.ok;
}
