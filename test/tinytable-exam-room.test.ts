import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

import { buildDockerArgs, runInExamRoom, DEFAULT_IMAGE } from "../scripts/tinytable-exam-room.js";

const execFileAsync = promisify(execFile);

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("buildDockerArgs mounts only the seed-root, never the host beyond it", () => {
  const args = buildDockerArgs({ seedRootDir: "/some/seed-root", command: ["echo", "hi"] }, "test-container");

  const mountFlags = args.filter((_, i) => args[i - 1] === "-v");
  assert.deepEqual(mountFlags, ["/some/seed-root:/workspace:rw"]);
  assert.ok(!args.includes("--network=host"));
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
});

test("buildDockerArgs hardens the container: read-only root, all caps dropped, no-new-privileges, resource limits", () => {
  const args = buildDockerArgs({ seedRootDir: "/seed", command: ["true"] }, "test-container");

  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("--name"));
  assert.equal(args[args.indexOf("--name") + 1], "test-container");
});

test("buildDockerArgs passes env vars via -e and never bakes them into the image reference", () => {
  const args = buildDockerArgs(
    { seedRootDir: "/seed", command: ["dsh"], env: { DEEPSEEK_API_KEY: "secret-value" } },
    "test-container"
  );

  assert.ok(args.includes("DEEPSEEK_API_KEY=secret-value"));
  assert.equal(args[args.indexOf("DEEPSEEK_API_KEY=secret-value") - 1], "-e");
  // the image reference and command must come after everything else, and
  // must not themselves be "-e"/"-v" flag values
  const imageIndex = args.indexOf(DEFAULT_IMAGE);
  assert.ok(imageIndex > 0);
  assert.deepEqual(args.slice(imageIndex), [DEFAULT_IMAGE, "dsh"]);
});

test("buildDockerArgs supports overriding image, network, memory, and pids limit", () => {
  const args = buildDockerArgs(
    { seedRootDir: "/seed", command: ["true"], image: "custom:tag", network: "none", memory: "1g", pidsLimit: 64 },
    "test-container"
  );

  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--memory") + 1], "1g");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "64");
  assert.equal(args[args.length - 2], "custom:tag");
});

/**
 * Live isolation check against the real docker/tinytable-exam-room image
 * (#105's actual AC1/AC2 verification: enumerate the filesystem inside a
 * running container and confirm no host path beyond the seed-root is
 * readable, including the exact #103 escape paths). Skipped unless a
 * docker daemon is reachable and the image has already been built - CI/dev
 * environments without docker, or without network access to build the
 * image (see docker/tinytable-exam-room/Dockerfile), still pass `npm test`
 * cleanly. Build the image first to opt in:
 *   docker build -t tinytable-exam-room:latest docker/tinytable-exam-room
 */
async function examRoomImageAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", DEFAULT_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

test("runInExamRoom: no host path beyond the seed-root is readable inside the container", async (t) => {
  if (!(await examRoomImageAvailable())) {
    t.skip(`${DEFAULT_IMAGE} not built locally - see docker/tinytable-exam-room/Dockerfile`);
    return;
  }

  const seedRootDir = await tempDir(t, "honeyrail-exam-room-");
  await writeFile(join(seedRootDir, "marker.txt"), "seed-root content\n");

  const result = await runInExamRoom({
    seedRootDir,
    command: [
      "sh",
      "-c",
      "ls /workspace && " +
        "! find / -xdev \\( -path /proc -o -path /sys \\) -prune -o " +
        "\\( -iname 'tinytable-eval*' -o -iname golden -o -iname score.py -o -iname mutants \\) -print 2>/dev/null | grep -q ."
    ],
    timeoutMs: 30_000
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.ok(result.stdout.includes("marker.txt"));
});

test("runInExamRoom: a scored-trial write (e.g. findings.json) lands back on the host seed-root", async (t) => {
  if (!(await examRoomImageAvailable())) {
    t.skip(`${DEFAULT_IMAGE} not built locally - see docker/tinytable-exam-room/Dockerfile`);
    return;
  }

  const seedRootDir = await tempDir(t, "honeyrail-exam-room-");

  const result = await runInExamRoom({
    seedRootDir,
    command: ["sh", "-c", "echo '[]' > /workspace/findings.json"],
    timeoutMs: 30_000
  });

  assert.equal(result.exitCode, 0);
  const written = await import("node:fs/promises").then((fs) => fs.readFile(join(seedRootDir, "findings.json"), "utf8"));
  assert.equal(written.trim(), "[]");
});
