/**
 * Preflight precondition check (#106): before an agent-task step launches
 * an agent, verify the target repo already contains what a fixture manifest
 * (e.g. #104's buildSeedRoot() output) says it should - files present, with
 * matching SHA-256 hashes - and fail with a specific, human-readable reason
 * if not.
 *
 * Closes the #103 AC1 gap: a `dsh-testengineer-trial` run launched against
 * the wrong/unrelated project had no fixture at all, and rather than fail,
 * the agent "helpfully" reconstructed one by reading the answer key off the
 * shared host filesystem. A step whose prerequisites plainly aren't met
 * should fail before an agent turn is spent, not after.
 *
 * Pure filesystem-reading functions, kept separate from
 * server/executors/agent-task.ts (which wires this into Executor.preflight())
 * so the check itself is unit-testable without any Store/EventBus/executor
 * machinery - same split server/evals/verify-gate.ts uses relative to its
 * driver script.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type ManifestFileEntry = { path: string; sha256: string };

/** Only the part of #104's SeedRootManifest this check needs. */
export type PreflightManifest = { files: ManifestFileEntry[] };

export type ManifestMismatch =
  | { path: string; reason: "missing" }
  | { path: string; reason: "hash_mismatch"; expectedSha256: string; actualSha256: string };

export function describeManifestMismatch(mismatch: ManifestMismatch): string {
  if (mismatch.reason === "missing") return `missing "${mismatch.path}" (expected by the fixture manifest)`;
  return `"${mismatch.path}" does not match the fixture manifest (sha256 ${mismatch.actualSha256} vs expected ${mismatch.expectedSha256})`;
}

/**
 * Checks every file the manifest expects against `rootPath`, returning every
 * mismatch found (not just the first) so a caller can report the complete
 * picture in one error rather than making an operator fix-and-retry
 * one-missing-file-at-a-time.
 */
export async function findManifestMismatches(rootPath: string, manifest: PreflightManifest): Promise<ManifestMismatch[]> {
  const mismatches: ManifestMismatch[] = [];
  for (const file of manifest.files) {
    const fullPath = join(rootPath, file.path);
    let content: Buffer;
    try {
      content = await readFile(fullPath);
    } catch {
      mismatches.push({ path: file.path, reason: "missing" });
      continue;
    }
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (actualSha256 !== file.sha256) {
      mismatches.push({ path: file.path, reason: "hash_mismatch", expectedSha256: file.sha256, actualSha256 });
    }
  }
  return mismatches;
}

const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Parses a step's optional input.expectedManifest - a JSON string (the
 * natural shape for a recipe's string-typed parameter) or an already-parsed
 * object (for a run created directly via the API). Absent/empty means "no
 * check" so this stays fully opt-in - existing recipes/steps that never set
 * it are completely unaffected. Throws on any malformed shape so a step that
 * could only ever fail this check is rejected at preflight time rather than
 * partway through a run.
 */
export function parseExpectedManifest(value: unknown): PreflightManifest | null {
  if (value === undefined || value === null || value === "") return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("expectedManifest must be valid JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("expectedManifest must be an object of shape { files: [{ path, sha256 }, ...] }");
  }
  const rawFiles = (parsed as Record<string, unknown>).files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error("expectedManifest.files must be a non-empty array");
  }
  const files: ManifestFileEntry[] = rawFiles.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`expectedManifest.files[${index}] must be an object`);
    }
    const path = (entry as Record<string, unknown>).path;
    const sha256 = (entry as Record<string, unknown>).sha256;
    if (typeof path !== "string" || !path.trim()) {
      throw new Error(`expectedManifest.files[${index}].path must be a non-empty string`);
    }
    if (isAbsolute(path) || path.split(/[/\\]/).includes("..")) {
      throw new Error(`expectedManifest.files[${index}].path must be a relative path without "..", got "${path}"`);
    }
    if (typeof sha256 !== "string" || !SHA256_RE.test(sha256)) {
      throw new Error(`expectedManifest.files[${index}].sha256 must be a 64-character hex string`);
    }
    return { path, sha256: sha256.toLowerCase() };
  });
  return { files };
}
