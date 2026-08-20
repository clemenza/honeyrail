import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  describeManifestMismatch,
  findManifestMismatches,
  parseExpectedManifest
} from "../server/evals/manifest-preflight.js";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-manifest-preflight-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("findManifestMismatches: empty when every file is present with a matching hash", async (t) => {
  const root = await tempDir(t);
  await writeFile(join(root, "SPEC.md"), "spec content\n");
  await mkdir(join(root, "tinytable"), { recursive: true });
  await writeFile(join(root, "tinytable", "core.py"), "core\n");

  const mismatches = await findManifestMismatches(root, {
    files: [
      { path: "SPEC.md", sha256: sha256("spec content\n") },
      { path: "tinytable/core.py", sha256: sha256("core\n") }
    ]
  });
  assert.deepEqual(mismatches, []);
});

test("findManifestMismatches: reports a missing file by name (satisfies #103 AC1)", async (t) => {
  const root = await tempDir(t);
  // Deliberately does not write SPEC.md or tinytable/ - the exact #103 scenario.

  const mismatches = await findManifestMismatches(root, {
    files: [
      { path: "SPEC.md", sha256: sha256("spec content\n") },
      { path: "tinytable/__init__.py", sha256: sha256("") }
    ]
  });
  assert.deepEqual(mismatches, [
    { path: "SPEC.md", reason: "missing" },
    { path: "tinytable/__init__.py", reason: "missing" }
  ]);
  const messages = mismatches.map(describeManifestMismatch);
  assert.match(messages[0], /missing "SPEC\.md"/);
  assert.match(messages[1], /missing "tinytable\/__init__\.py"/);
});

test("findManifestMismatches: reports a hash mismatch distinctly from a missing file", async (t) => {
  const root = await tempDir(t);
  await writeFile(join(root, "SPEC.md"), "tampered content\n");

  const expectedSha256 = sha256("original content\n");
  const mismatches = await findManifestMismatches(root, { files: [{ path: "SPEC.md", sha256: expectedSha256 }] });
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].reason, "hash_mismatch");
  assert.match(describeManifestMismatch(mismatches[0]), /does not match the fixture manifest/);
});

test("findManifestMismatches: collects every mismatch, not just the first", async (t) => {
  const root = await tempDir(t);
  await writeFile(join(root, "present-but-wrong.md"), "wrong\n");

  const mismatches = await findManifestMismatches(root, {
    files: [
      { path: "missing-one.md", sha256: sha256("x") },
      { path: "present-but-wrong.md", sha256: sha256("right\n") },
      { path: "missing-two.md", sha256: sha256("y") }
    ]
  });
  assert.equal(mismatches.length, 3);
});

test("parseExpectedManifest: absent/empty means no check", () => {
  assert.equal(parseExpectedManifest(undefined), null);
  assert.equal(parseExpectedManifest(null), null);
  assert.equal(parseExpectedManifest(""), null);
});

test("parseExpectedManifest: accepts both a JSON string and an already-parsed object", () => {
  const hash = sha256("x");
  const expected = { files: [{ path: "SPEC.md", sha256: hash }] };
  assert.deepEqual(parseExpectedManifest(JSON.stringify(expected)), expected);
  assert.deepEqual(parseExpectedManifest(expected), expected);
  // lowercases a hash given in mixed case, so a manifest survives copy/paste unchanged in behavior
  assert.deepEqual(parseExpectedManifest({ files: [{ path: "SPEC.md", sha256: hash.toUpperCase() }] }), expected);
});

test("parseExpectedManifest: rejects malformed shapes with a clear error", () => {
  assert.throws(() => parseExpectedManifest("not json"), /valid JSON/);
  assert.throws(() => parseExpectedManifest("[]"), /object of shape/);
  assert.throws(() => parseExpectedManifest({}), /non-empty array/);
  assert.throws(() => parseExpectedManifest({ files: [] }), /non-empty array/);
  assert.throws(() => parseExpectedManifest({ files: [{ sha256: sha256("x") }] }), /path must be a non-empty string/);
  assert.throws(() => parseExpectedManifest({ files: [{ path: "SPEC.md", sha256: "not-a-hash" }] }), /64-character hex string/);
  assert.throws(
    () => parseExpectedManifest({ files: [{ path: "../outside.md", sha256: sha256("x") }] }),
    /relative path without "\.\."/
  );
  assert.throws(
    () => parseExpectedManifest({ files: [{ path: "/etc/passwd", sha256: sha256("x") }] }),
    /relative path without "\.\."/
  );
});
