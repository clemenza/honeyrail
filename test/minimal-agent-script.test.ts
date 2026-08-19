import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";

// End-to-end coverage for the actual scripts/minimal-agent.mjs process
// (#71) - not just the adapter's command-string construction (see
// test/agent-adapters.test.ts) - run against a local mock server standing
// in for the model API, so this proves the ReAct loop genuinely executes
// shell commands and terminates, without a real API key or network access.

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "..", "scripts", "minimal-agent.mjs");

type MockReply = { content: string };

function startMockModelServer(replies: MockReply[]): Promise<{ url: string; requestCount: () => number; close: () => Promise<void> }> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const index = requestCount;
      requestCount += 1;
      const reply = replies[Math.min(index, replies.length - 1)];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: reply.content } }] }));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        requestCount: () => requestCount,
        close: () => new Promise<void>((res) => server.close(() => res()))
      });
    });
  });
}

function runScript(t: TestContext, env: Record<string, string>, cwd: string) {
  const child = spawn(process.execPath, [scriptPath, "--prompt", "do the task"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(() => {
    if (!child.killed) child.kill("SIGKILL");
  });

  async function waitForMarker(timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (/MINIMAL_AGENT_DONE status=/.test(output)) return output;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for MINIMAL_AGENT_DONE marker. Output so far:\n${output}`);
  }

  return { child, waitForMarker, output: () => output };
}

test("minimal-agent.mjs has no code path that can read stdin - the #71 'no interactive prompt' guarantee is structural", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.doesNotMatch(source, /process\.stdin/);
  assert.doesNotMatch(source, /readline/i);
  assert.doesNotMatch(source, /\bprompt\(/);
});

test("minimal-agent.mjs runs a shell command the model asks for, then finishes on DONE, then stays alive", async (t) => {
  const mock = await startMockModelServer([
    { content: "```bash\necho hello-from-minimal-agent\n```" },
    { content: "DONE" }
  ]);
  t.after(() => mock.close());
  const workDir = await mkdtemp(join(tmpdir(), "honeyrail-minimal-agent-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { waitForMarker, child } = runScript(t, { MINIMAL_AGENT_API_KEY: "test-key", MINIMAL_AGENT_BASE_URL: mock.url }, workDir);
  const output = await waitForMarker();

  assert.match(output, /\$ echo hello-from-minimal-agent/);
  assert.match(output, /hello-from-minimal-agent/);
  assert.match(output, /MINIMAL_AGENT_DONE status=done \(2 iterations\)/);
  assert.equal(mock.requestCount(), 2);

  // The process must still be alive after signaling completion - see the
  // idleForever() doc comment in the script for why it never exits itself.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(child.exitCode, null, "the process must not have exited on its own");
});

test("minimal-agent.mjs recovers from a protocol-violating reply instead of giving up", async (t) => {
  const mock = await startMockModelServer([
    { content: "I'll think about this first." },
    { content: "```bash\ntrue\n```" },
    { content: "DONE" }
  ]);
  t.after(() => mock.close());
  const workDir = await mkdtemp(join(tmpdir(), "honeyrail-minimal-agent-protocol-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { waitForMarker } = runScript(t, { MINIMAL_AGENT_API_KEY: "test-key", MINIMAL_AGENT_BASE_URL: mock.url }, workDir);
  const output = await waitForMarker();
  assert.match(output, /MINIMAL_AGENT_DONE status=done \(3 iterations\)/);
  assert.equal(mock.requestCount(), 3);
});

test("minimal-agent.mjs terminates at MINIMAL_AGENT_MAX_ITERATIONS instead of looping forever when the model never says DONE", async (t) => {
  const mock = await startMockModelServer([{ content: "```bash\ntrue\n```" }]);
  t.after(() => mock.close());
  const workDir = await mkdtemp(join(tmpdir(), "honeyrail-minimal-agent-cap-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const { waitForMarker } = runScript(t, {
    MINIMAL_AGENT_API_KEY: "test-key",
    MINIMAL_AGENT_BASE_URL: mock.url,
    MINIMAL_AGENT_MAX_ITERATIONS: "2"
  }, workDir);
  const output = await waitForMarker();
  assert.match(output, /MINIMAL_AGENT_DONE status=max_iterations \(2\)/);
  assert.equal(mock.requestCount(), 2);
});

test("minimal-agent.mjs reports a clean error and never calls the model when no API key is configured", async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), "honeyrail-minimal-agent-noapikey-"));
  t.after(() => rm(workDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [scriptPath, "--prompt", "do the task"], {
    cwd: workDir,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "",
      AGENT_SESSION_SUMMARY_API_KEY: "",
      MINIMAL_AGENT_API_KEY: "",
      MINIMAL_AGENT_BASE_URL: "http://127.0.0.1:1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(() => {
    if (!child.killed) child.kill("SIGKILL");
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !/MINIMAL_AGENT_DONE status=/.test(output)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(output, /MINIMAL_AGENT_DONE status=error.*no API key configured/);
});
