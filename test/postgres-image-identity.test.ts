import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveImageIdentity, PostgresImageError } from "../server/postgres/image-identity.js";
import type { RunCommand } from "../server/postgres/runtime.js";

/**
 * `resolveImageIdentity()` is the one place every pinned image (builder,
 * runtime, agent, egress-gateway) resolves its immutable identity, so this
 * file gives it direct coverage rather than leaving it tested only
 * incidentally through each caller's own fixtures.
 *
 * #197 round 2 review: on a real GitHub Actions daemon, the old
 * five-call-per-field `docker image inspect --format '{{if .Variant}}...'`
 * form raised `template parsing error: ... map has no entry for key
 * "Variant"` for any image with no variant at all - the ordinary case for
 * amd64/arm64 images, not just an edge case like `arm/v7`. Confirmed against
 * this repository's own `test/postgres-research-live-e2e.test.ts` run in CI.
 * `resolveImageIdentity()` now issues one plain `docker image inspect
 * <image>` (JSON) call instead, so an absent key is just `undefined` in
 * TypeScript, never a template execution error. These tests model exactly
 * that daemon shape - a JSON object with no `Variant` property at all, not
 * merely an empty string - since that distinction is what the old bug was.
 */

const buildHint = "Build it first: docker build -t test-image:latest test/fixtures.";

function fakeInspect(payload: unknown, options: { ok?: boolean; stderr?: string } = {}): RunCommand {
  return async () => ({
    ok: options.ok ?? true,
    stdout: options.ok === false ? "" : `${JSON.stringify(payload)}\n`,
    stderr: options.stderr ?? "",
    code: options.ok === false ? 1 : 0
  });
}

test("resolves identity for an image whose inspect JSON has no Variant key at all", async () => {
  const inspected = [{ Id: `sha256:${"1".repeat(64)}`, RepoDigests: [], Os: "linux", Architecture: "arm64" }];
  const identity = await resolveImageIdentity("test-image:latest", { runCommand: fakeInspect(inspected), buildHint });

  assert.deepEqual(identity, {
    reference: "test-image:latest",
    id: `sha256:${"1".repeat(64)}`,
    digest: null,
    platform: "linux/arm64",
    os: "linux",
    architecture: "arm64",
    variant: null
  });
});

test("resolves identity for an image with no RepoDigests key present either (a fresh local build)", async () => {
  const inspected = [{ Id: `sha256:${"2".repeat(64)}`, Os: "linux", Architecture: "amd64" }];
  const identity = await resolveImageIdentity("test-image:latest", { runCommand: fakeInspect(inspected), buildHint });

  assert.equal(identity.digest, null);
  assert.equal(identity.platform, "linux/amd64");
  assert.equal(identity.variant, null);
});

test("a genuinely present Variant is still recorded and normalized, e.g. arm/v7", async () => {
  const inspected = [
    { Id: `sha256:${"3".repeat(64)}`, RepoDigests: ["example.test/img@sha256:abc"], Os: "linux", Architecture: "arm", Variant: "v7" }
  ];
  const identity = await resolveImageIdentity("test-image:latest", { runCommand: fakeInspect(inspected), buildHint });

  assert.equal(identity.variant, "v7");
  assert.equal(identity.platform, "linux/arm/v7");
  assert.equal(identity.digest, "example.test/img@sha256:abc");
});

test("a registry digest is recorded from the first RepoDigests entry when present", async () => {
  const inspected = [
    {
      Id: `sha256:${"4".repeat(64)}`,
      RepoDigests: ["example.test/img@sha256:first", "example.test/img@sha256:second"],
      Os: "linux",
      Architecture: "arm64"
    }
  ];
  const identity = await resolveImageIdentity("test-image:latest", { runCommand: fakeInspect(inspected), buildHint });
  assert.equal(identity.digest, "example.test/img@sha256:first");
});

test("a missing image fails loudly, names the build hint, and never falls back to a pull", async () => {
  await assert.rejects(
    resolveImageIdentity("test-image:definitely-not-present", {
      runCommand: fakeInspect(null, { ok: false, stderr: "Error: No such image: test-image:definitely-not-present" }),
      buildHint
    }),
    (error: Error) =>
      error instanceof PostgresImageError &&
      /is not available to the docker daemon/.test(error.message) &&
      error.message.includes(buildHint) &&
      /No such image/.test(error.message)
  );
});

test("an image reporting no id at all fails loudly rather than resolving a blank identity", async () => {
  const inspected = [{ RepoDigests: [], Os: "linux", Architecture: "arm64" }];
  await assert.rejects(
    resolveImageIdentity("test-image:latest", { runCommand: fakeInspect(inspected), buildHint }),
    (error: Error) => error instanceof PostgresImageError && /reported no image id/.test(error.message)
  );
});

test("output that is not valid JSON fails clearly rather than throwing an opaque parse error", async () => {
  const runCommand: RunCommand = async () => ({ ok: true, stdout: "not json at all\n", stderr: "", code: 0 });
  await assert.rejects(
    resolveImageIdentity("test-image:latest", { runCommand, buildHint }),
    (error: Error) => error instanceof PostgresImageError && /could not be parsed as JSON/.test(error.message)
  );
});

test("output that is valid JSON but not a non-empty array fails clearly", async () => {
  const runCommand: RunCommand = async () => ({ ok: true, stdout: "[]\n", stderr: "", code: 0 });
  await assert.rejects(
    resolveImageIdentity("test-image:latest", { runCommand, buildHint }),
    (error: Error) => error instanceof PostgresImageError && /returned no entry/.test(error.message)
  );
});

test("issues exactly one docker command, not five", async () => {
  const calls: string[][] = [];
  const inspected = [{ Id: `sha256:${"5".repeat(64)}`, RepoDigests: [], Os: "linux", Architecture: "arm64" }];
  const runCommand: RunCommand = async (command, args = []) => {
    calls.push([command, ...args]);
    return { ok: true, stdout: `${JSON.stringify(inspected)}\n`, stderr: "", code: 0 };
  };
  await resolveImageIdentity("test-image:latest", { runCommand, buildHint });
  assert.deepEqual(calls, [["docker", "image", "inspect", "test-image:latest"]]);
});
