import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { RUNTIME_CONTAINER_PATHS, RESEARCH_CONTAINER_PATHS } from "../server/postgres/container-paths.js";
import {
  buildRuntimeContainerArgs,
  resolveRuntimeImageIdentity,
  runtimeIdentityFiles,
  runtimeUserIds,
  writeRuntimeIdentityFiles,
  DEFAULT_RUNTIME_IMAGE,
  PostgresRuntimeContainer,
  PostgresRuntimeContainerError,
  ROOT_HOST_FALLBACK_GID,
  ROOT_HOST_FALLBACK_UID,
  RUNTIME_INERT_PROCESS
} from "../server/postgres/runtime-container.js";
import { unscoredReasons } from "../server/postgres/research-session.js";
import type { RunCommand } from "../server/postgres/runtime.js";

/**
 * MUST 1/3/4 of the #182 fourth review, statically: what the runtime sidecar
 * actually asks docker for, and what it records about itself.
 *
 * These need no docker daemon on purpose - they are the assertions that must
 * hold on every CI runner, including ones that cannot run the real
 * live-cluster test in test/postgres-research-live-e2e.test.ts. They do not
 * substitute for it: a mount list being correct says nothing about whether a
 * real PostgreSQL ever started.
 */

const IMAGE = {
  reference: DEFAULT_RUNTIME_IMAGE,
  id: `sha256:${"a".repeat(64)}`,
  digest: null,
  platform: "linux/arm64",
  os: "linux",
  architecture: "arm64"
};

const MOUNTS = {
  buildViewDir: "/host/views/view-xyz/0123456789abcdef0123456789abcdef",
  dataDir: "/host/env/pgdata",
  socketDir: "/host/sock/hrpg-abc",
  logPath: "/host/env/postgres.log",
  passwdPath: "/host/sock/hrpg-id-abc/passwd",
  groupPath: "/host/sock/hrpg-id-abc/group"
};

function argsFor(overrides: Partial<Parameters<typeof buildRuntimeContainerArgs>[0]> = {}) {
  return buildRuntimeContainerArgs({ mounts: MOUNTS, ...overrides }, "rt1");
}

test("the runtime container mounts the cluster's four paths plus the identity shim, and nothing else", () => {
  const args = argsFor();
  const mounts = args.filter((_value, index) => args[index - 1] === "-v");

  assert.deepEqual(mounts, [
    `${MOUNTS.buildViewDir}:/opt/honeyrail/postgres:ro`,
    `${MOUNTS.dataDir}:/runtime/pgdata:rw`,
    `${MOUNTS.socketDir}:/runtime/socket:rw`,
    `${MOUNTS.logPath}:/runtime/postgres.log:rw`,
    `${MOUNTS.passwdPath}:/etc/passwd:ro`,
    `${MOUNTS.groupPath}:/etc/group:ro`
  ]);
  // No source snapshot, no source mirror, no attachment root, no
  // grader-private directory, no build-cache root, no docker socket, no home.
  assert.equal(mounts.length, 6);
  assert.equal(
    mounts.some((mount) => /docker\.sock|\/\.git|attachments|build-cache/.test(mount)),
    false
  );
  // The build is exposed read-only: the server executes it, it does not own it.
  assert.ok(mounts[0].endsWith(":ro"));
});

test("the runtime container is detached, network-less, hardened, and runs an inert PID 1", () => {
  const args = argsFor();

  assert.equal(args[0], "run");
  // Detached, so the container - and therefore the postmaster reparented to
  // its PID 1 - outlives the `docker run` client.
  assert.ok(args.includes("-d"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("--memory"));
  assert.equal(args[args.indexOf("--name") + 1], "rt1");
  assert.equal(args[args.indexOf("--tmpfs") + 1].startsWith("/tmp:size="), true);
  // No published host port at all: -p/--publish never appears.
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("--publish"), false);

  const image = args.indexOf(DEFAULT_RUNTIME_IMAGE);
  assert.ok(image > 0);
  assert.deepEqual(args.slice(image + 1), [...RUNTIME_INERT_PROCESS]);
});

test("the runtime container inherits nothing of the host environment and no PG* variable", () => {
  const args = argsFor();
  const env = args.filter((_value, index) => args[index - 1] === "-e");

  assert.deepEqual(env.sort(), [
    "HOME=/tmp",
    "LANG=C",
    "LC_ALL=C",
    `LD_LIBRARY_PATH=${RUNTIME_CONTAINER_PATHS.lib}`,
    `PATH=${RUNTIME_CONTAINER_PATHS.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  ]);
  assert.equal(
    env.some((entry) => entry.startsWith("PG")),
    false,
    "an ambient PGHOST/PGPORT/PGDATA must not reach the cluster"
  );
});

test("the runtime and the agent see the build at the same neutral prefix it was compiled with", () => {
  // Not a tautology: these are three separate consumers of one constant, and
  // the whole point of container-paths.ts is that they cannot drift.
  assert.equal(RUNTIME_CONTAINER_PATHS.postgres, RESEARCH_CONTAINER_PATHS.postgres);
  assert.equal(RUNTIME_CONTAINER_PATHS.bin, "/opt/honeyrail/postgres/bin");
});

test("the postmaster listens on the shared Unix socket and on no TCP address", () => {
  const runtime = new PostgresRuntimeContainer({ image: IMAGE, mounts: MOUNTS, containerName: "rt-opts" });
  const options = runtime.postmasterOptions(54321);

  assert.match(options, /-p 54321/);
  assert.match(options, /-k \/runtime\/socket/);
  // `-h ''` is an empty listen_addresses: no TCP listener exists, in the
  // container's own namespace or anywhere else.
  assert.match(options, /-h ''/);
});

test("an arbitrary host uid gets a generated passwd entry, because PostgreSQL calls getpwuid before anything else", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "honeyrail-pg-identity-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  // The real failure this exists to prevent, observed on this repository's own
  // developer machine (uid 71393735):
  //   initdb: could not look up effective user ID 71393735: user does not exist
  const files = await writeRuntimeIdentityFiles(dir, { uid: 71393735, gid: 1085706827 });
  const passwd = await readFile(files.passwd, "utf8");
  const group = await readFile(files.group, "utf8");

  assert.match(passwd, /^hrpg:x:71393735:1085706827:/m);
  assert.match(group, /^hrpg:x:1085706827:$/m);
  // Nothing but the uid/gid: no host path, no username, no research fact.
  assert.equal(passwd.includes("/Users"), false);
  assert.equal(passwd.split("\n").filter(Boolean).length, 2);
  assert.equal((await stat(files.passwd)).mode & 0o777, 0o644, "libc reads /etc/passwd as whatever uid is asking");
});

test("a root host runs the server as a non-root uid, because PostgreSQL refuses uid 0", () => {
  assert.deepEqual(runtimeUserIds({ uid: 0, gid: 0 }), { uid: ROOT_HOST_FALLBACK_UID, gid: ROOT_HOST_FALLBACK_GID });
  // Every non-root host keeps its own uid, so the bind-mounted PGDATA, socket
  // directory and log are owned by the user that has to clean them up.
  assert.deepEqual(runtimeUserIds({ uid: 501, gid: 20 }), { uid: 501, gid: 20 });
  assert.match(runtimeIdentityFiles({ uid: 501, gid: 20 }).passwd, /^hrpg:x:501:20:/m);
});

test("a missing runtime image fails loudly with the command that would create it, and never falls back", async () => {
  const absent: RunCommand = async () => ({ ok: false, stdout: "", stderr: "Error: No such image", code: 1 });

  await assert.rejects(
    resolveRuntimeImageIdentity("honeyrail-postgres-runtime:definitely-not-present", absent),
    (error: Error) =>
      error instanceof PostgresRuntimeContainerError &&
      /is not available to the docker daemon/.test(error.message) &&
      /docker build -t honeyrail-postgres-runtime:definitely-not-present docker\/postgres-research-runtime/.test(error.message)
  );
});

test("the runtime records the image identity the daemon resolved, not the tag it was asked for", async () => {
  const answers: Record<string, string> = {
    "{{.Id}}": `sha256:${"b".repeat(64)}`,
    "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}": "",
    "{{.Os}}": "linux",
    "{{.Architecture}}": "arm64"
  };
  const runCommand: RunCommand = async (_command, args = []) => ({
    ok: true,
    stdout: `${answers[args[3]] ?? ""}\n`,
    stderr: "",
    code: 0
  });

  const identity = await resolveRuntimeImageIdentity("honeyrail-postgres-runtime:latest", runCommand);
  assert.deepEqual(identity, {
    reference: "honeyrail-postgres-runtime:latest",
    id: `sha256:${"b".repeat(64)}`,
    // A locally built image has no registry digest; recording null is honest,
    // and is why the cache keys on `id`.
    digest: null,
    platform: "linux/arm64",
    os: "linux",
    architecture: "arm64"
  });
});

test("a container-built PostgreSQL that ran on the host is not a scored trial either", () => {
  // MUST 3: the axes are separate because they fail separately. A container
  // *build* alone was exactly the claim the fourth review rejected.
  assert.deepEqual(unscoredReasons({ networkMode: "none", buildScoredEligible: true, runtimeScoredEligible: true }), []);

  const [reason] = unscoredReasons({ networkMode: "none", buildScoredEligible: true, runtimeScoredEligible: false });
  assert.match(reason, /ran as host processes rather than inside the pinned Linux runtime container/);

  assert.equal(
    unscoredReasons({ networkMode: "bridge", buildScoredEligible: false, runtimeScoredEligible: false }).length,
    3,
    "network, build and runtime each contribute their own reason"
  );
});

test("lifecycle calls against a container that was never created fail rather than silently no-op", async () => {
  const runtime = new PostgresRuntimeContainer({ image: IMAGE, mounts: MOUNTS, containerName: "rt-uncreated" });

  await assert.rejects(runtime.exec(["/bin/true"]), PostgresRuntimeContainerError);
  // ...but cleanup is safe on every path, including this one.
  assert.equal(await runtime.cleanup(), true);
});

test("cleanup removes the container and treats an already-removed one as success", async () => {
  const calls: string[][] = [];
  const runCommand: RunCommand = async (command, args = []) => {
    calls.push([command, ...args]);
    if (args[0] === "run") return { ok: true, stdout: `${"c".repeat(64)}\n`, stderr: "", code: 0 };
    if (args[0] === "rm") return { ok: false, stdout: "", stderr: "Error: No such container: rt-gone", code: 1 };
    return { ok: true, stdout: "", stderr: "", code: 0 };
  };
  const runtime = new PostgresRuntimeContainer({ image: IMAGE, mounts: MOUNTS, runCommand, containerName: "rt-gone" });

  await runtime.create();
  assert.equal(runtime.isCreated(), true);
  assert.equal(runtime.record().containerId, "c".repeat(64));

  assert.equal(await runtime.cleanup(), true, "`--rm` may already have removed it; that is success, not a leak");
  assert.deepEqual(calls.at(-1), ["docker", "rm", "-f", "rt-gone"]);
  assert.equal(runtime.isCreated(), false);
  // Idempotent: cleanup runs from finally blocks that may run twice.
  assert.equal(await runtime.cleanup(), true);
  assert.equal(calls.filter((call) => call[1] === "rm").length, 1);
});

test("a container that starts but cannot be run is force-removed rather than left holding the mounts", async () => {
  const calls: string[][] = [];
  const runCommand: RunCommand = async (command, args = []) => {
    calls.push([command, ...args]);
    if (args[0] === "run") return { ok: false, stdout: "", stderr: "docker: Error response from daemon: boom", code: 125 };
    return { ok: true, stdout: "", stderr: "", code: 0 };
  };
  const runtime = new PostgresRuntimeContainer({ image: IMAGE, mounts: MOUNTS, runCommand, containerName: "rt-boom" });

  await assert.rejects(runtime.create(), (error: Error) => /Could not start the PostgreSQL runtime container/.test(error.message));
  assert.deepEqual(calls.at(-1), ["docker", "rm", "-f", "rt-boom"]);
  assert.equal(runtime.isCreated(), false);
});
