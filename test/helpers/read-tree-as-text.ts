import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every file under `root`, as `{ relativePath, text }`, for recursively
 * scanning agent-visible bundles for leaked secrets. Shared by
 * `test/historical-postgres-task.test.ts` and the per-case leak tests (e.g.
 * `test/historical-postgres-002-task.test.ts`) so a future historical task's
 * leak coverage does not have to re-derive this walk.
 */
export async function readTreeAsText(root: string): Promise<{ relativePath: string; text: string }[]> {
  const out: { relativePath: string; text: string }[] = [];
  async function visit(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(full, rel);
        continue;
      }
      out.push({ relativePath: rel, text: await readFile(full, "utf8").catch(() => "") });
    }
  }
  await visit(root, "");
  return out;
}
