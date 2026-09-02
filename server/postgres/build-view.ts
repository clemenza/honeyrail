import { randomBytes } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The per-trial *view* of a cached PostgreSQL build, and the completion marker
 * that view deliberately leaves out (#182).
 *
 * This is a leaf module for the same reason container-paths.ts is one. Two
 * different consumers need it and neither may import the other:
 *
 *   research-environment.ts   mounts the view into the runtime container
 *   agent-container.ts        mounts the same view into the agent container
 *
 * and agent-container.ts already imports research-environment.ts, so defining
 * the helpers there and importing them back would close an ESM cycle - a
 * module-scope `const` read across a cycle is a temporal-dead-zone crash whose
 * occurrence depends on which module the process happened to load first. Both
 * modules re-export from here, so every existing import path still resolves.
 */

/**
 * The only file HoneyRail writes into a cache entry. It exists so an
 * interrupted build is never mistaken for a usable one, and it says nothing
 * else. It carries the `entryId`, which is deterministic, so createBuildView()
 * deliberately leaves it out of the view an agent (or the runtime container)
 * sees.
 */
export const BUILD_COMPLETE_MARKER = "honeyrail-build-complete.json";
export const BUILD_COMPLETE_MARKER_ID = "honeyrail-pg-build-complete";

export type BuildView = {
  /** Host path of this trial's view. Grader-side; the containers see /opt/honeyrail/postgres. */
  dir: string;
  /** Random, per-trial, uncorrelatable across trials. */
  id: string;
};

/**
 * Where per-trial build views live: a sibling of the build cache rather than
 * a directory inside it, so that the cache root's own path never appears in
 * a container's mount table either. A sibling is also guaranteed to be on the
 * same filesystem, which is what makes the hard-link view below possible.
 */
export function defaultBuildViewsRoot(cacheRoot?: string): string {
  if (process.env.HONEYRAIL_PG_BUILD_VIEWS) return process.env.HONEYRAIL_PG_BUILD_VIEWS;
  if (cacheRoot) return join(dirname(cacheRoot), "pg-research-build-views");
  return join(homedir(), ".honeyrail", "pg-research-build-views");
}

async function linkTree(src: string, dest: string, skip: ReadonlySet<string>) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      await linkTree(from, to, new Set());
    } else if (entry.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else {
      // Hard links share the cached build's data - this is a second *view* of
      // one build, not a second copy of it. A cross-device or link-hostile
      // filesystem falls back to a real copy rather than failing the trial.
      await link(from, to).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code === "EXDEV" || error.code === "EPERM" || error.code === "EMLINK" || error.code === "ENOTSUP") {
          await copyFile(from, to);
          return;
        }
        throw error;
      });
    }
  }
}

/**
 * Builds this trial's private, randomly-named hard-link view of a cached
 * build, and mounts *that* rather than the cache entry itself.
 *
 * This is what actually closes the deterministic-identity hole, and the
 * reason it is needed even though the containers already expose the build at
 * a fixed neutral path: a bind mount's source path is visible inside the
 * container in `/proc/self/mountinfo`. Verified directly - mounting
 * `<cacheRoot>/<entryId>` at `/opt/honeyrail/postgres` puts the literal
 * `entryId` in the container's own mount table, where an agent that can
 * enumerate a bounded set of candidate refs could recompute and match it.
 * Mounting a per-trial random directory puts a random string there instead.
 *
 * The build itself is not duplicated (hard links), and the cache stays
 * deterministic and shared grader-side, so cache reuse is unaffected.
 *
 * The completion marker is deliberately left out of the view: it carries the
 * deterministic `entryId`, which is exactly what must not reach the agent.
 */
export async function createBuildView(installDir: string, viewsRoot: string): Promise<BuildView> {
  await mkdir(viewsRoot, { recursive: true });
  const parent = await mkdtemp(join(viewsRoot, "view-"));
  const id = randomBytes(16).toString("hex");
  const dir = join(parent, id);
  await linkTree(installDir, dir, new Set([BUILD_COMPLETE_MARKER]));
  return { dir, id };
}

/** Removes a build view. Never throws: it runs from cleanup paths. */
export async function removeBuildView(view: BuildView | undefined): Promise<void> {
  if (!view) return;
  await rm(dirname(view.dir), { recursive: true, force: true }).catch(() => {});
}
