import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  buildEngineServiceDockerArgs,
  startEngineService,
  DEFAULT_ENGINE_SERVICE_IMAGE,
  ENGINE_SERVICE_NETWORK_ALIAS
} from "../scripts/tinytable-engine-service.js";
import { buildDockerArgs, runInExamRoom } from "../scripts/tinytable-exam-room.js";

const execFileAsync = promisify(execFile);

test("buildEngineServiceDockerArgs mounts only the mutant tinytable/ package, read-only", () => {
  const args = buildEngineServiceDockerArgs({ mutantRootDir: "/some/privateRoot/tinytable" }, "test-container", "test-net");

  const mountFlags = args.filter((_, i) => args[i - 1] === "-v");
  assert.deepEqual(mountFlags, ["/some/privateRoot/tinytable:/mutant/tinytable:ro"]);
});

test("buildEngineServiceDockerArgs joins the given private network with a stable DNS alias", () => {
  const args = buildEngineServiceDockerArgs({ mutantRootDir: "/mutant" }, "test-container", "my-private-net");

  assert.equal(args[args.indexOf("--network") + 1], "my-private-net");
  assert.equal(args[args.indexOf("--network-alias") + 1], ENGINE_SERVICE_NETWORK_ALIAS);
});

test("buildEngineServiceDockerArgs hardens the container: read-only root, all caps dropped, no-new-privileges, resource limits", () => {
  const args = buildEngineServiceDockerArgs({ mutantRootDir: "/mutant" }, "test-container", "test-net");

  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("no-new-privileges"));
  assert.ok(args.includes("--pids-limit"));
  assert.ok(args.includes("--memory"));
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("-d"));
});

test("buildEngineServiceDockerArgs passes --root/--host/--port to engine_service.py, never publishes a host port", () => {
  const args = buildEngineServiceDockerArgs({ mutantRootDir: "/mutant", port: 9999 }, "test-container", "test-net");

  const imageIndex = args.indexOf(DEFAULT_ENGINE_SERVICE_IMAGE);
  assert.ok(imageIndex > 0);
  assert.deepEqual(args.slice(imageIndex), [DEFAULT_ENGINE_SERVICE_IMAGE, "--root", "/mutant", "--host", "0.0.0.0", "--port", "9999"]);
  assert.ok(!args.includes("-p"), "must never publish a host port - only reachable over the private network");
});

test("buildEngineServiceDockerArgs supports overriding image, memory, and pids limit", () => {
  const args = buildEngineServiceDockerArgs({ mutantRootDir: "/mutant", image: "custom-engine:tag", memory: "1g", pidsLimit: 32 }, "c", "n");

  assert.equal(args[args.indexOf("--memory") + 1], "1g");
  assert.equal(args[args.indexOf("--pids-limit") + 1], "32");
  assert.ok(args.includes("custom-engine:tag"));
});

/**
 * Live tests against a real docker daemon + the built
 * docker/tinytable-engine-service image. Skipped (not failed) without
 * both, mirroring test/tinytable-exam-room.test.ts's own pattern - so
 * `npm test` stays green in environments without docker. Build first to
 * opt in:
 *   docker build -f docker/tinytable-engine-service/Dockerfile -t tinytable-engine-service:latest .
 */
async function engineServiceImageAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", DEFAULT_ENGINE_SERVICE_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

async function examRoomImageAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", "tinytable-exam-room:latest"]);
    return true;
  } catch {
    return false;
  }
}

test("startEngineService: becomes healthy, serves /run over the private network, and stop() removes the container and network", async (t) => {
  if (!(await engineServiceImageAvailable())) {
    t.skip(`${DEFAULT_ENGINE_SERVICE_IMAGE} not built locally - see docker/tinytable-engine-service/Dockerfile`);
    return;
  }

  const mutantRootDir = new URL("../vendor/tinytable-evals/clean/tinytable", import.meta.url).pathname;
  const handle = await startEngineService({ mutantRootDir });
  t.after(() => handle.stop());

  assert.equal(handle.hostname, ENGINE_SERVICE_NETWORK_ALIAS);
  assert.ok(handle.containerName.startsWith("tinytable-engine-service-"));
  assert.ok(handle.networkName.startsWith("tinytable-engine-net-"));

  // Verified from a throwaway container on the same private network,
  // exactly the position the exam-room container is in - this process
  // (running on the host, outside any docker network) has no standing to
  // assert reachability the agent's own container would actually have.
  const probe = await execFileAsync("docker", [
    "run", "--rm", "--network", handle.networkName,
    "curlimages/curl:latest", "-sf", `http://${handle.hostname}:${handle.port}/health`
  ]).catch((error) => ({ stdout: "", stderr: String(error) }));
  assert.ok(probe.stdout.includes('"ok": true') || probe.stdout.includes('"ok":true'), `expected a healthy /health response, got: ${JSON.stringify(probe)}`);

  await handle.stop();
  const inspectAfterStop = await execFileAsync("docker", ["network", "inspect", handle.networkName]).then(
    () => "still exists",
    () => "removed"
  );
  assert.equal(inspectAfterStop, "removed");
});

test("runInExamRoom + startEngineService: the exam-room container reaches the engine-service by its DNS alias, and nothing else is on that network", async (t) => {
  if (!(await engineServiceImageAvailable()) || !(await examRoomImageAvailable())) {
    t.skip("both tinytable-engine-service:latest and tinytable-exam-room:latest must be built locally for this composition test");
    return;
  }

  const mutantRootDir = new URL("../vendor/tinytable-evals/clean/tinytable", import.meta.url).pathname;
  const handle = await startEngineService({ mutantRootDir });
  t.after(() => handle.stop());

  const seedRootDir = new URL("../vendor/tinytable-evals/clean", import.meta.url).pathname;
  const result = await runInExamRoom({
    seedRootDir,
    network: handle.networkName,
    // tinytable-exam-room:latest deliberately ships no wget/curl (minimal
    // image per docker/tinytable-exam-room/Dockerfile) - python3 is already
    // there for run_sql_tests.py/score.py, so use it as the http client too.
    command: ["python3", "-c", `import urllib.request; print(urllib.request.urlopen("http://${handle.hostname}:${handle.port}/health").read().decode())`],
    timeoutMs: 30_000
  });

  assert.equal(result.exitCode, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.ok(result.stdout.includes("ok"), result.stdout);

  // sanity: the exam-room container still has its own outbound path (the
  // private network is a plain bridge, not --internal) - this is the
  // difference between "isolated from other trials" and "no internet".
  const dnsArgs = buildDockerArgs({ seedRootDir, network: handle.networkName, command: ["true"] }, "unused-name-for-arg-check");
  assert.equal(dnsArgs[dnsArgs.indexOf("--network") + 1], handle.networkName);
});
