/**
 * The two remaining `trajectory.py` event kinds (issue #40) this driver
 * can produce entirely on its own, without a tinytable-evals change or a
 * submodule re-pin: `file_diff` (the seed-root's working-tree diff
 * against its pristine baseline commit) and `agent_snapshot` (a
 * content-hashed manifest of `sql-tests/agent/`). Both only need
 * filesystem/git access this driver already has to the seed-root after
 * the exam-room container exits - the same access
 * `gatherAuditableText`/`findManifestMismatches` in scripts/dsh-evals-
 * demo.ts already use. `test_run` (grade.py --trajectory-log) and
 * `tool_call`/`shell_command` (server/evals/dsh-trajectory-bridge.ts)
 * cover the other three kinds - together, every trial now produces all
 * five, appended to the same seed-root `trajectory.jsonl` `run_sql_tests.py
 * --trajectory-log` and grade.py already write to.
 *
 * Field shapes match vendor/tinytable-evals's `trajectory.py`
 * `TrajectoryWriter.log_file_diff`/`log_agent_snapshot` exactly (see its
 * `trajectory_schema.json`) - `git_diff`/`snapshot_manifest` below are
 * this driver's own TypeScript equivalent of that Python module's
 * same-named functions, kept behaviorally identical rather than shelled
 * out to Python, since this driver already has git/fs primitives of its
 * own (`server/utils.ts`'s `runCommandSafe`) and doesn't otherwise depend
 * on invoking arbitrary tinytable-evals internals directly.
 */

import { createHash } from "node:crypto";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { runCommandSafe } from "../utils.js";

async function appendTrajectoryEvent(seedRootDir: string, kind: string, fields: Record<string, unknown>): Promise<void> {
  const event = { seq: 1, ts: new Date().toISOString(), kind, ...fields };
  await appendFile(join(seedRootDir, "trajectory.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export type FileDiff = { diff: string; filesChanged: string[][] };

/**
 * The working tree's unified diff against `baselineRef`, plus a
 * `[status, path]` (or `[status, oldPath, newPath]` for a rename/copy)
 * pair per changed file from `--name-status` - mirrors trajectory.py's
 * `git_diff`. Empty diff/list on a git failure (not a git repo, `git`
 * missing) rather than throwing - "no diff available" is a legitimate
 * outcome for a caller logging opportunistically, same trade-off
 * trajectory.py's own version makes.
 *
 * `git diff <ref>` alone never mentions an untracked path - and every
 * `.test` file an agent adds under `sql-tests/agent/` starts out
 * untracked, since the seed-root's initial commit only has a `.gitkeep`
 * there (see build_seed_root.py) - so it would otherwise vanish from
 * both `diff` and `files_changed` entirely, not just show up
 * mislabeled. `git add --intent-to-add` marks every untracked path with
 * a zero-content index entry first (no content staged, nothing
 * committed) so `git diff` reports it as a full addition instead of
 * silently ignoring it - harmless for any later `git status`-based check
 * (e.g. grade.py's protected-path check), which reports an intent-to-add
 * path the same way it reports a plain untracked one.
 */
export async function gitDiff(seedRootDir: string, baselineRef = "HEAD"): Promise<FileDiff> {
  await runCommandSafe("git", ["add", "--intent-to-add", "--all", "--", "."], { cwd: seedRootDir });
  const diffResult = await runCommandSafe("git", ["diff", baselineRef, "--"], { cwd: seedRootDir });
  const statusResult = await runCommandSafe("git", ["diff", baselineRef, "--name-status", "--"], { cwd: seedRootDir });
  if (!diffResult.ok || !statusResult.ok) return { diff: "", filesChanged: [] };
  const filesChanged = statusResult.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split("\t"));
  return { diff: diffResult.stdout, filesChanged };
}

export type SnapshotFile = { path: string; sha256: string; size: number };

/**
 * `{path, sha256, size}` for every file under `seedRootDir/subdir`
 * (`path` relative to `seedRootDir`, POSIX-separated), sorted by path -
 * mirrors trajectory.py's `snapshot_manifest`. A directory entry (or any
 * transient read failure) is skipped rather than failing the whole
 * snapshot - `readdir(..., {recursive: true})` returns files and
 * directories both, with no cheap way to tell them apart without a
 * second stat call per entry, and attempting to read a directory as a
 * file fails predictably, which is all this needs.
 */
export async function snapshotManifest(seedRootDir: string, subdir = "sql-tests/agent"): Promise<SnapshotFile[]> {
  const base = join(seedRootDir, subdir);
  const entries = await readdir(base, { recursive: true }).catch(() => [] as string[]);
  const files: SnapshotFile[] = [];
  for (const entry of [...entries].sort()) {
    const data = await readFile(join(base, entry)).catch(() => null);
    if (data === null) continue;
    const relativePath = `${subdir}/${entry}`.replace(/\\/g, "/");
    files.push({ path: relativePath, sha256: createHash("sha256").update(data).digest("hex"), size: data.length });
  }
  return files;
}

/** Appends one `file_diff` event for `seedRootDir`'s current diff against `baselineRef` to its `trajectory.jsonl`. */
export async function logFileDiff(seedRootDir: string, baselineRef = "HEAD"): Promise<void> {
  const { diff, filesChanged } = await gitDiff(seedRootDir, baselineRef);
  await appendTrajectoryEvent(seedRootDir, "file_diff", { root: seedRootDir, baseline_ref: baselineRef, files_changed: filesChanged, diff });
}

/** Appends one `agent_snapshot` event for `seedRootDir/subdir`'s current contents to its `trajectory.jsonl`. */
export async function logAgentSnapshot(seedRootDir: string, subdir = "sql-tests/agent"): Promise<void> {
  const files = await snapshotManifest(seedRootDir, subdir);
  await appendTrajectoryEvent(seedRootDir, "agent_snapshot", { subdir, files });
}
