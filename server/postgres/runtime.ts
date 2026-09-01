import { createServer } from "node:net";
import type { runCommandSafe } from "../utils.js";

export type RunCommand = typeof runCommandSafe;

/**
 * Binds port 0 on the loopback interface, reads the port the kernel assigned
 * back, and releases it.
 *
 * This is a *candidate* port, not a reservation. The listener is closed
 * before PostgreSQL binds the same number, so there is a real (if narrow)
 * time-of-check/time-of-use window in which another process - including a
 * second research environment - can take it. The kernel's "hand out the
 * least-recently-used ephemeral port" policy makes a collision unlikely, not
 * impossible, so callers that actually bind the port must be able to recover:
 * see `isAddressInUseFailure()` and the bounded start retry in
 * PostgresResearchEnvironment.start().
 *
 * Extracted verbatim from the transaction-restart-alpha path in
 * executors/postgres.ts so the research environment reuses the exact same
 * mechanic instead of growing a second copy of it.
 */
export async function allocatePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Failed to allocate PostgreSQL test port");
  return port;
}

/**
 * Recognises "the port I was handed is already taken" in whatever a failed
 * server start left behind - `pg_ctl`'s own stderr, or the tail of the
 * server log it points at, which is where PostgreSQL actually reports a bind
 * failure ("could not bind IPv4 address ...: Address already in use").
 *
 * Deliberately narrow: any other startup failure must stay a hard failure
 * rather than being retried on a different port.
 */
export function isAddressInUseFailure(text: string): boolean {
  return /address already in use|could not bind|EADDRINUSE|address is already in use/i.test(text);
}

export type PostgresConnectionTarget = {
  host?: string;
  port: number;
  user?: string;
  database?: string;
};

/**
 * The `psql` argument prefix every caller here uses: no psqlrc (-X), tuples
 * only (-t) and unaligned (-A) so stdout is directly parseable.
 */
export function psqlArgs(target: PostgresConnectionTarget, tail: string[]): string[] {
  return [
    "-X",
    "-h",
    target.host ?? "127.0.0.1",
    "-p",
    String(target.port),
    "-U",
    target.user ?? "postgres",
    "-d",
    target.database ?? "postgres",
    "-t",
    "-A",
    ...tail
  ];
}

export type PostgresReadiness = { ready: boolean; latencyMs: number };

export type WaitForPostgresReadyOptions = PostgresConnectionTarget & {
  runCommand: RunCommand;
  cwd: string;
  /** Absolute path of the psql to poll with; defaults to whatever is on PATH. */
  psql?: string;
  attempts?: number;
  intervalMs?: number;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Polls `SELECT 1` until the server answers, the readiness signal both the
 * alpha scenario and the research environment use. Defaults reproduce the
 * original executors/postgres.ts waitReady() exactly (80 attempts, 125ms
 * apart, 2s per probe) so extracting it changed no behavior.
 */
export async function waitForPostgresReady(options: WaitForPostgresReadyOptions): Promise<PostgresReadiness> {
  const attempts = options.attempts ?? 80;
  const intervalMs = options.intervalMs ?? 125;
  const started = Date.now();
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await options.runCommand(options.psql ?? "psql", psqlArgs(options, ["-c", "SELECT 1;"]), {
      cwd: options.cwd,
      timeout: options.timeout ?? 2000,
      env: options.env
    });
    if (result.ok && result.stdout.trim() === "1") {
      return { ready: true, latencyMs: Date.now() - started };
    }
    lastError = result.stderr || result.stdout;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`PostgreSQL did not become ready: ${lastError}`);
}
