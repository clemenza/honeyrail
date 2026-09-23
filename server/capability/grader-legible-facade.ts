/**
 * The truth boundary between a #237 agent and the fixture it is investigating.
 *
 * Round 2 of this harness mounted the archetype's real `bin/` into the agent's
 * container read-only, and called that isolation. It is not. Read-only stops an
 * agent from *rewriting* the fixture; it does nothing about reading it, and the
 * fixture's source is exactly the discriminating truth the task asks the agent
 * to discover by experiment:
 *
 *     $ cat "$(command -v meter)"
 *     ...
 *     case "$2" in base) printf '1000\n' ;; adjusted) printf '1007\n' ;; esac
 *
 * One `cat` and the task is over. A capability number produced that way
 * measures `cat`, not the construction of a grader-legible observable.
 *
 * So the real fixture never enters the container's mount namespace at all.
 * What the agent gets on PATH is a *facade*: one generic POSIX-sh client,
 * byte-identical for every archetype, containing zero archetype-specific
 * behavior. Reading it tells an agent only that invocations are forwarded
 * somewhere. It runs the fixture by asking, and the answer comes back from a
 * broker running on the host, outside anything the agent can reach.
 *
 * The channel is a bind-mounted directory and two files per call:
 *
 *   container                        host
 *   ---------                        ----
 *   write <id>.request.json    -->   broker polls, validates, spawns the
 *                                    REAL bin/<command> with the request's argv
 *   poll for <id>.response.json <--  broker writes stdout/stderr/status
 *
 * Deliberately polling and not `fs.watch`. Bind-mount filesystem-change events
 * do not propagate reliably across the VM boundary on Docker Desktop or
 * OrbStack, so an inotify-based broker works on Linux and silently hangs on the
 * machines this repo is actually developed on.
 *
 * Responses are line-framed base64 (stdout, stderr, exit status) rather than
 * JSON: fixture output is arbitrary bytes, including newlines and invalid
 * UTF-8, and a framing that can be confused by the payload is a framing that
 * the agent controls. Each response is written to a temp file and renamed, so a
 * polling client never observes a half-written response.
 *
 * Operator-supplied images must provide `base64` (coreutils) and `sed` on the
 * container's PATH; both are present in any Debian-derived base, including the
 * `node:24-bookworm-slim` the test stub uses.
 *
 * What this module does NOT do: it is not a sandbox framework and not an RPC
 * platform. It forwards one fixture invocation per request, to one directory of
 * executables the caller names, with a constructed environment of exactly one
 * variable.
 */

import { spawn } from "node:child_process";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** In-container location of the request/response channel. Bind-mounted read-write. */
export const GRADER_LEGIBLE_FACADE_CONTAINER_DIR = "/workspace/.facade";

/** Name of the variable that tells the facade client where the channel is. */
export const GRADER_LEGIBLE_FACADE_DIR_ENV = "HONEYRAIL_FACADE_DIR";

/** How often the broker looks for new requests. Fast enough to feel synchronous, cheap enough to leave running. */
const BROKER_POLL_MS = 30;

/**
 * The facade client, written into `facade-bin/<fixtureCommand>` for every
 * archetype. It is a constant, not a template: any per-archetype substitution
 * would be archetype truth living inside the container, which is the bug this
 * whole module exists to fix. `basename "$0"` is what makes one text serve
 * every fixture name.
 *
 * Exit codes 97 and 98 are the facade's own, chosen above the range the
 * fixtures use so a channel failure can never be mistaken for a fixture result.
 */
export const GRADER_LEGIBLE_FACADE_CLIENT = `#!/bin/sh
# Generic fixture facade client. Identical for every archetype by construction.
set -u
cmd=$(basename "$0")
dir="\${${GRADER_LEGIBLE_FACADE_DIR_ENV}:?${GRADER_LEGIBLE_FACADE_DIR_ENV} is not set}"
id="req-$$-$(date +%s%N 2>/dev/null || echo 0)-$(od -An -N4 -tu4 /dev/urandom 2>/dev/null | tr -d ' ' || echo 0)"
args_json=$(printf '"%s",' "$@" | sed 's/,$//')
tmp="$dir/.$id.request.json.tmp"
printf '{"command":"%s","args":[%s]}' "$cmd" "$args_json" > "$tmp"
mv "$tmp" "$dir/$id.request.json"
resp="$dir/$id.response.json"
i=0
while [ ! -f "$resp" ]; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    printf 'facade: broker did not respond within timeout\\n' >&2
    exit 97
  fi
  sleep 0.05
done
stdout_b64=$(sed -n '1p' "$resp")
stderr_b64=$(sed -n '2p' "$resp")
status=$(sed -n '3p' "$resp")
printf '%s' "$stdout_b64" | base64 -d
printf '%s' "$stderr_b64" | base64 -d >&2
if [ "$status" = "null" ]; then exit 98; fi
exit "$status"
`;

export type GraderLegibleFacadeBroker = {
  /** Stops polling. Safe to call more than once; the caller runs it in a `finally`. */
  stop(): Promise<void>;
};

type FacadeRequest = { command: string; args: string[] };

/**
 * Duplicated from `grader-legible-run.ts` rather than imported.
 *
 * `runGraderLegibleAttempt()` imports this module to start the broker, so
 * importing its `captureSpawn` back would close an import cycle for fifteen
 * lines. The fixture case is also strictly simpler than the agent case: a
 * fixture is a short-lived shell script with no children to outlive it, so the
 * process-group kill the run module needs is not required here.
 */
function runFixture(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ stdout: Buffer; stderr: Buffer; exitStatus: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.from(`facade: ${(error as Error).message}\n`), exitStatus: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitStatus: code });
    });
  });
}

/**
 * Starts the host-side broker for one attempt.
 *
 * `binDir` is the archetype's real fixture directory and is never mounted
 * anywhere; only this process opens it. `stateDir` is the *investigation* state
 * directory inside the agent's workspace, not the grader-owned `state/` whose
 * invocation log drives failure-stage attribution for the graded executions.
 *
 * `timeoutMs` bounds the broker's own lifetime as a backstop: if a caller ever
 * failed to `stop()` it, the interval would otherwise keep a Node process alive
 * indefinitely.
 */
export function startGraderLegibleFacadeBroker(options: {
  facadeDir: string;
  binDir: string;
  stateDir: string;
  timeoutMs: number;
}): GraderLegibleFacadeBroker {
  const seen = new Set<string>();
  let draining = false;
  let stopped = false;

  const respond = async (id: string, stdout: Buffer, stderr: Buffer, exitStatus: number | null): Promise<void> => {
    const body = `${stdout.toString("base64")}\n${stderr.toString("base64")}\n${exitStatus === null ? "null" : exitStatus}\n`;
    const temp = join(options.facadeDir, `.${id}.response.tmp`);
    await writeFile(temp, body);
    // Rename, so the client's `[ -f "$resp" ]` can never observe a partial response.
    await rename(temp, join(options.facadeDir, `${id}.response.json`));
  };

  const handle = async (filename: string): Promise<void> => {
    const id = filename.slice(0, -".request.json".length);
    const path = join(options.facadeDir, filename);
    let request: FacadeRequest;
    try {
      request = JSON.parse(await readFile(path, "utf8")) as FacadeRequest;
    } catch (error) {
      await respond(id, Buffer.alloc(0), Buffer.from(`facade: unreadable request: ${(error as Error).message}\n`), null);
      return;
    }
    await rm(path, { force: true });

    // The request is agent-controlled input, so `command` is validated against
    // the directory listing rather than merely path-joined: a bare `join()`
    // would happily resolve "../../../bin/sh" into an arbitrary host binary
    // spawned with the harness's own privileges.
    const available = await readdir(options.binDir).catch(() => [] as string[]);
    if (typeof request.command !== "string" || !available.includes(request.command)) {
      await respond(id, Buffer.alloc(0), Buffer.from(`facade: unknown command\n`), 127);
      return;
    }
    const args = Array.isArray(request.args) ? request.args.filter((arg): arg is string => typeof arg === "string") : [];

    const result = await runFixture(
      join(options.binDir, request.command),
      args,
      // Constructed, never inherited: the fixture needs exactly one variable,
      // and the broker's own environment holds the operator's credentials.
      { HONEYRAIL_FIXTURE_STATE: options.stateDir },
      options.timeoutMs
    );
    await respond(id, result.stdout, result.stderr, result.exitStatus);
  };

  const poll = async (): Promise<void> => {
    if (draining || stopped) return;
    draining = true;
    try {
      const entries = await readdir(options.facadeDir).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!entry.endsWith(".request.json") || entry.startsWith(".") || seen.has(entry)) continue;
        seen.add(entry);
        await handle(entry);
      }
    } finally {
      draining = false;
    }
  };

  const interval = setInterval(() => void poll(), BROKER_POLL_MS);
  const lifetime = setTimeout(() => {
    stopped = true;
    clearInterval(interval);
  }, options.timeoutMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(interval);
      clearTimeout(lifetime);
    }
  };
}
