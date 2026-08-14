import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { JsonStore } from "../server/store.js";

test("JsonStore synchronously loads existing quality gate decisions before first read", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "honeyrail-json-store-"));
  t.after(async () => rm(tempDir, { recursive: true, force: true }));
  const storePath = join(tempDir, "store.json");
  await writeFile(storePath, JSON.stringify({
    qualityGateDecisions: [{
      id: "qgd_existing",
      runId: "run_existing",
      stepId: "verify",
      attempt: 1,
      status: "passed",
      evaluationIds: ["eval_existing"],
      decidedBy: "system",
      createdAt: "2026-08-14T00:00:00.000Z"
    }]
  }));

  const store = new JsonStore(storePath);

  assert.equal((await store.listQualityGateDecisions("run_existing", "verify"))[0]?.status, "passed");
});
