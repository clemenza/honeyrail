import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";

import { createApp } from "../server/api.js";
import { EventBus } from "../server/events.js";
import { JsonStore } from "../server/store.js";

async function withServer(t: TestContext) {
  const tempDir = await mkdtemp(join(tmpdir(), "agw-session-summary-"));
  const store = new JsonStore(join(tempDir, "store.json"));
  const bus = new EventBus();
  const summaryCalls: any[] = [];
  const app = createApp({
    store,
    bus,
    tmux: {
      listSessions: async () => [],
      capture: async () => "Changed src/main.tsx\nRan npm test\nBlocked on mobile review",
      startSession: async () => {},
      sendInput: async () => {},
      sendKey: async () => {},
      killSession: async () => {}
    } as any,
    worktrees: {} as any,
    run: async (cmd: string, args: string[] = []) => {
      if (cmd === "git" && args.join(" ") === "status --short") {
        return { ok: true, stdout: " M src/main.tsx\n M server/api.ts\n", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    token: null,
    sessionLogRoot: join(tempDir, "sessions"),
    summaryClient: {
      summarize: async (input: any) => {
        summaryCalls.push(input);
        return [
          "本轮做了什么: 替换 Log 入口为自动摘要。",
          "改了哪些文件: src/main.tsx, server/api.ts。",
          "测试结果: npm test 通过。",
          "当前阻塞点: 无。",
          "下一步建议: 移动端验证。"
        ].join("\n");
      }
    }
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
  });

  const { port } = server.address() as AddressInfo;
  return { store, summaryCalls, tempDir, baseUrl: `http://127.0.0.1:${port}` };
}

async function readJson(response: Response) {
  assert.match(response.headers.get("content-type") || "", /application\/json/);
  return response.json();
}

test("POST /api/sessions/:id/summarize creates and persists a mobile session summary", async (t) => {
  const { store, summaryCalls, tempDir, baseUrl } = await withServer(t);
  const logPath = join(tempDir, "sessions", "sess_summary.log");
  await mkdir(join(tempDir, "sessions"), { recursive: true });
  await writeFile(logPath, "Log says created server summary endpoint\nLog says tested build\n", "utf8");
  const session = await store.createSession({
    id: "sess_summary",
    projectId: "proj_1",
    name: "summary session",
    agent: "codex",
    prompt: "replace logs with summary",
    tmuxSessionName: "agw_summary",
    cwd: tempDir,
    logPath,
    status: "running"
  });
  await store.appendEvent({
    type: "session.input_sent",
    sessionId: session.id,
    projectId: "proj_1",
    payload: { preview: "替换 logs 按钮，实现 session llm 自动摘要" }
  });

  const response = await fetch(`${baseUrl}/api/sessions/${session.id}/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const body = await readJson(response);
  const updated = await store.getSession(session.id);

  assert.equal(response.status, 200);
  assert.equal(body.summary.model, "deepseek-v4-flash");
  assert.match(body.summary.text, /本轮做了什么/);
  assert.match(updated!.summary!.text, /改了哪些文件/);
  assert.equal(summaryCalls.length, 1);
  assert.equal(summaryCalls[0].model, "deepseek-v4-flash");
  assert.match(summaryCalls[0].prompt, /本轮做了什么/);
  assert.match(summaryCalls[0].prompt, /改了哪些文件/);
  assert.match(summaryCalls[0].prompt, /测试结果/);
  assert.match(summaryCalls[0].prompt, /当前阻塞点/);
  assert.match(summaryCalls[0].prompt, /下一步建议/);
  assert.match(summaryCalls[0].prompt, /Changed src\/main\.tsx/);
  assert.match(summaryCalls[0].prompt, /M src\/main\.tsx/);
});
