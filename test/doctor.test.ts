import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { formatDoctorReport, runDoctor } from "../server/doctor.js";
import type { GatewayConfig } from "../server/config.js";
import type { SafeCommandOutput } from "../server/utils.js";

function ok(stdout: string): SafeCommandOutput {
  return { ok: true, stdout, stderr: "" };
}

function fail(stderr = "not found"): SafeCommandOutput {
  return { ok: false, stdout: "", stderr, code: 127 };
}

function config(root: string): GatewayConfig {
  return {
    port: 4177,
    dataFile: join(root, "gateway.sqlite"),
    legacyJsonDataFile: join(root, "gateway.json"),
    worktreeRoot: join(root, "worktrees"),
    attachmentRoot: join(root, "attachments"),
    sessionLogRoot: join(root, "sessions"),
    token: null,
    accounts: null,
    sessionSecret: null,
    publicBaseUrl: null,
    healthCheckIntervalMs: 15000,
    sessionStaleMs: 1800000,
    orchestrationPollIntervalMs: 3000
  };
}

function fakeRun(missingCore = false) {
  return async (cmd: string, args: string[] = []): Promise<SafeCommandOutput> => {
    if (cmd === "git") return ok("git version 2.50.0\n");
    if (cmd === "tmux") return missingCore ? fail() : ok("tmux 3.5\n");
    if (cmd === "sh") {
      const script = args.join(" ");
      if (script.includes("codex")) return ok("/usr/local/bin/codex\n");
      if (script.includes("claude")) return fail();
      if (script.includes("hermes")) return fail();
      if (script.includes(process.env.SHELL || "sh")) return ok(`${process.env.SHELL || "/bin/sh"}\n`);
      return fail();
    }
    if (cmd === "codex") return ok("codex 0.142.0\n");
    if (cmd === process.env.SHELL) return ok("zsh 5.9\n");
    return fail();
  };
}

test("doctor reports core dependencies and agent availability without requiring every agent", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-doctor-"));
  try {
    const report = await runDoctor({ run: fakeRun(), config: config(tempDir), env: { NODE_ENV: "development" } });
    assert.equal(report.ready, true);
    assert.equal(report.core.find((check) => check.name === "tmux")?.ok, true);
    assert.equal(report.agents.find((agent) => agent.id === "codex")?.available, true);
    assert.equal(report.agents.find((agent) => agent.id === "claude")?.available, false);
    assert.equal(report.agents.find((agent) => agent.id === "hermes")?.stability, "experimental");
    assert.ok(report.stableAgentsAvailable >= 1);
    assert.match(formatDoctorReport(report), /Result: READY/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("doctor returns not ready when a required core dependency is missing", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-doctor-"));
  try {
    const report = await runDoctor({ run: fakeRun(true), config: config(tempDir) });
    assert.equal(report.ready, false);
    assert.equal(report.core.find((check) => check.name === "tmux")?.ok, false);
    assert.match(formatDoctorReport(report), /Result: NOT READY/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
