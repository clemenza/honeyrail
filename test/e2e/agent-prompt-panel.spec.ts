import { expect, test, type Page } from "@playwright/test";

const project = {
  id: "proj_1",
  name: "agent-gateway-demo",
  repoPath: "/tmp/agent-gateway-demo",
  defaultBranch: "main",
  defaultAgent: "codex"
};

const session = {
  id: "sess_prompt",
  projectId: project.id,
  name: "continuous optimization",
  agent: "codex",
  model: null,
  tmuxSessionName: "agw_test_prompt",
  cwd: project.repoPath,
  status: "running",
  createdAt: "2026-06-20T01:02:00.000Z"
};

const sessionHeadingExpect = { timeout: 15_000 };

async function mockGateway(page: Page, output: string, options: { holdInput?: boolean } = {}) {
  const inputs: any[] = [];
  const summaries: any[] = [];
  const inputResolvers: Array<() => void> = [];
  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, tmux: "tmux 3.5", agents: { codex: true, claude: true } })
    });
  });

  await page.route("**/api/dashboard", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        projects: [project],
        sessions: [session],
        tasks: [],
        worktrees: [],
        events: [
          {
            id: "evt_1",
            type: "session.input_sent",
            sessionId: session.id,
            projectId: project.id,
            createdAt: "2026-06-20T01:02:30.000Z",
            payload: { preview: "check the prompt panel", attachments: [] }
          }
        ],
        tmuxSessions: []
      })
    });
  });

  await page.route("**/api/events/stream", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      },
      body: "event: gateway.connected\ndata: {}\n\n"
    });
  });

  await page.route("**/api/sessions/sess_prompt/output?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ output })
    });
  });

  await page.route("**/api/sessions/sess_prompt/input", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    inputs.push(await route.request().postDataJSON());
    if (options.holdInput) {
      await new Promise<void>((resolve) => inputResolvers.push(resolve));
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.route("**/api/sessions/sess_prompt/key", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    inputs.push(await route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.route("**/api/sessions/sess_prompt/summarize", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    summaries.push(await route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        summary: {
          model: "deepseek-v4-flash",
          generatedAt: "2026-06-20T01:04:00.000Z",
          text: [
            "本轮做了什么: 替换 Log 入口为 Summary。",
            "改了哪些文件: src/main.tsx, server/api.ts。",
            "测试结果: npm test 通过。",
            "当前阻塞点: 无。",
            "下一步建议: 手机端复核。"
          ].join("\n")
        }
      })
    });
  });

  return {
    inputs,
    summaries,
    resolveInput: () => inputResolvers.splice(0).forEach((resolve) => resolve())
  };
}

async function mockManagementGateway(page: Page, options: { holdSession?: boolean; holdTask?: boolean } = {}) {
  const sessions: any[] = [];
  const tasks: any[] = [];
  const sessionResolvers: Array<() => void> = [];
  const taskResolvers: Array<() => void> = [];

  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, tmux: "tmux 3.5", agents: { codex: true, claude: true } })
    });
  });

  await page.route("**/api/dashboard", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        projects: [project],
        sessions,
        tasks,
        events: [],
        tmuxSessions: [],
        worktrees: []
      })
    });
  });

  await page.route("**/api/events/stream", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      },
      body: "event: gateway.connected\ndata: {}\n\n"
    });
  });

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sessions.push(await route.request().postDataJSON());
    if (options.holdSession) {
      await new Promise<void>((resolve) => sessionResolvers.push(resolve));
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, session: { ...session, id: "sess_new" } })
    });
  });

  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    tasks.push(await route.request().postDataJSON());
    if (options.holdTask) {
      await new Promise<void>((resolve) => taskResolvers.push(resolve));
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, task: { id: "task_new", projectId: project.id, status: "agent_running" } })
    });
  });

  return {
    sessions,
    tasks,
    resolveSession: () => sessionResolvers.splice(0).forEach((resolve) => resolve()),
    resolveTask: () => taskResolvers.splice(0).forEach((resolve) => resolve())
  };
}

async function mockDeletableGateway(page: Page, { failDelete = false } = {}) {
  const sessions = [
    { ...session, id: "sess_primary", name: "primary session", tmuxSessionName: "agw_primary" },
    { ...session, id: "sess_next", name: "next session", tmuxSessionName: "agw_next" }
  ];
  const events = [
    {
      id: "evt_delete_1",
      type: "session.input_sent",
      sessionId: "sess_primary",
      projectId: project.id,
      createdAt: "2026-06-20T01:02:30.000Z",
      payload: { preview: "delete me", attachments: [] }
    }
  ];

  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, tmux: "tmux 3.5", agents: { codex: true, claude: true } })
    });
  });

  await page.route("**/api/dashboard", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        projects: [project],
        sessions,
        tasks: [],
        worktrees: [],
        events,
        tmuxSessions: []
      })
    });
  });

  await page.route("**/api/events/stream", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache"
      },
      body: "event: gateway.connected\ndata: {}\n\n"
    });
  });

  await page.route("**/api/sessions/*/output?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ output: "agent output" })
    });
  });

  await page.route("**/api/sessions/sess_primary", async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    if (failDelete) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "Session is busy" })
      });
      return;
    }
    sessions.splice(0, 1);
    events.splice(0, events.length);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, sessionId: "sess_primary" })
    });
  });
}

test.describe("agent prompt panel removal", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/auth/config", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ enabled: false, loginEnabled: false })
      });
    });
  });

  const promptOutputs = [
    {
      name: "codex update output",
      output: "Update available! 0.128.0 -> 0.141.0\nPress enter to continue\n1. Update now\n2. Skip\n3. Skip until next version",
      forbidden: ["Codex update prompt", "Update now", "Skip until next"]
    },
    {
      name: "MCP selection output",
      output: "Select any you wish to enable\nSpace to select\nPress Enter to confirm",
      forbidden: ["MCP selection prompt", "Confirm selected", "Reject all", "Toggle selection"]
    },
    {
      name: "Claude permission output",
      output: "Do you want to proceed?\nPress Enter to continue setup",
      forbidden: ["Claude permission prompt", "Claude prompt"]
    }
  ];

  for (const { name, output, forbidden } of promptOutputs) {
    test(`does not render automatic prompt actions for ${name}`, async ({ page }) => {
      await mockGateway(page, output);

      await page.goto("/session/sess_prompt");
      await expect(page.getByRole("heading", { name: "continuous optimization" })).toBeVisible(sessionHeadingExpect);
      await expect(page.locator(".agent-prompt-card")).toHaveCount(0);

      for (const text of forbidden) {
        await expect(page.getByText(text, { exact: true })).toHaveCount(0);
      }

      await page.getByRole("button", { name: "Controls" }).click();
      const controls = page.locator(".session-controls-popup");
      await expect(controls.getByRole("button", { name: /Approve/ })).toBeVisible();
      await expect(controls.getByRole("button", { name: /Reject/ })).toBeVisible();
      await expect(controls.getByRole("button", { name: /Interrupt/ })).toBeVisible();
    });
  }

  test("keeps terminal divider lines out of the chat transcript and terminal view", async ({ page }) => {
    await mockGateway(
      page,
      [
        "Implemented the requested change.",
        "       ⋮",
        "─ Worked for 21m 22s ─────────────────",
        "────────────",
        "────────────",
        "────────────",
        "Use /skills to list available skills"
      ].join("\n")
    );

    await page.goto("/session/sess_prompt");
    await expect(page.getByRole("heading", { name: "continuous optimization" })).toBeVisible(sessionHeadingExpect);
    await expect(page.locator(".agent-card")).toContainText("Implemented the requested change.");
    await expect(page.locator(".agent-card")).not.toContainText("────────────");
    await expect(page.locator(".agent-card")).not.toContainText("⋮");
    await expect(page.locator(".agent-card")).toContainText("Worked for 21m 22s");
    await expect(page.locator(".agent-card")).not.toContainText("─ Worked");
    await expect(page.getByText("Details", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Terminal" }).click();
    const terminalTranscript = page.locator(".terminal-view");
    await expect(terminalTranscript).toBeVisible();
    await expect(terminalTranscript).toContainText("Implemented the requested change.");
    await expect(terminalTranscript).not.toContainText("────────────");
    await expect(terminalTranscript).not.toContainText("⋮");
    await expect(terminalTranscript).toContainText("Worked for 21m 22s");
    await expect(terminalTranscript).not.toContainText("─ Worked");
  });

  test("shows mobile quick actions and sends approval shortcuts", async ({ page }) => {
    const gateway = await mockGateway(page, "Do you want to continue?");

    await page.goto("/session/sess_prompt");
    await expect(page.getByRole("heading", { name: "continuous optimization" })).toBeVisible(sessionHeadingExpect);
    await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Terminal" })).toBeVisible();
    await expect(page.locator(".view-toggle").getByRole("button", { name: "Summary" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Log" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).first().click();
    await expect.poll(() => gateway.inputs.at(-1)?.text).toBe("y");
    await page.getByRole("button", { name: "Ctrl-C" }).click();
    await expect.poll(() => gateway.inputs.at(-1)?.key).toBe("C-c");
  });

  test("disables prompt send and shows sending state while input is in flight", async ({ page }) => {
    const gateway = await mockGateway(page, "Ready.", { holdInput: true });

    await page.goto("/session/sess_prompt");
    await page.locator(".chat-composer textarea").fill("run the checks");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByRole("button", { name: "Sending" })).toBeDisabled();
    await page.getByRole("button", { name: "Sending" }).click({ force: true });
    expect(gateway.inputs).toHaveLength(1);

    gateway.resolveInput();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    await expect(page.locator(".chat-composer textarea")).toHaveValue("");
    await page.locator(".chat-composer textarea").fill("run the next checks");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  test("disables launch buttons and shows starting state while requests are in flight", async ({ page }) => {
    const gateway = await mockManagementGateway(page, { holdSession: true, holdTask: true });

    await page.goto("/?view=sessions");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByRole("button", { name: "Starting session" })).toBeDisabled();
    await page.getByRole("button", { name: "Starting session" }).click({ force: true });
    expect(gateway.sessions).toHaveLength(1);
    gateway.resolveSession();
    await expect(page.getByRole("button", { name: "Start session" })).toBeEnabled();

    await page.goto("/?view=worktrees");
    await page.getByLabel("Title").fill("fix duplicate click");
    await page.getByLabel("Prompt").fill("add a submitting state");
    await page.getByRole("button", { name: "Start task" }).click();
    await expect(page.getByRole("button", { name: "Starting task" })).toBeDisabled();
    await page.getByRole("button", { name: "Starting task" }).click({ force: true });
    expect(gateway.tasks).toHaveLength(1);
    gateway.resolveTask();
    await expect(page.getByRole("button", { name: "Start task" })).toBeEnabled();
  });

  test("generates and displays a mobile session summary", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const gateway = await mockGateway(page, "Implemented summary API and frontend view.");

    await page.goto("/session/sess_prompt");
    await expect(page.getByRole("heading", { name: "continuous optimization" })).toBeVisible(sessionHeadingExpect);
    await page.locator(".view-toggle").getByRole("button", { name: "Summary" }).click();

    const summaryView = page.locator(".summary-view");
    await expect(summaryView).toBeVisible();
    await expect(summaryView).toContainText("Session summary");
    await expect(summaryView).toContainText("本轮做了什么");
    await expect(summaryView).toContainText("改了哪些文件");
    await expect(summaryView).toContainText("测试结果");
    await expect(summaryView).not.toHaveClass(/terminal-view/);
    await expect(summaryView.locator("pre")).toHaveCount(0);
    await expect(summaryView.locator(".summary-markdown")).toBeVisible();
    await expect(page.locator(".chat-workspace")).toHaveClass(/terminal-fullscreen/);
    await expect.poll(() => gateway.summaries.length).toBe(1);
    await expect(page.getByRole("button", { name: "Regenerate" })).toBeVisible();
  });

  test("expands terminal into a mobile full-page transcript and toggles back", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockGateway(
      page,
      Array.from({ length: 90 }, (_, index) => `terminal line ${String(index + 1).padStart(2, "0")} with enough content to review across the mobile page`).join("\n")
    );

    await page.goto("/session/sess_prompt");
    await page.getByRole("button", { name: "Terminal" }).click();

    const workspace = page.locator(".chat-workspace");
    await expect(workspace).toHaveClass(/terminal-fullscreen/);
    await expect(page.locator(".terminal-view")).toBeVisible();
    await expect(page.locator(".chat-composer")).toBeHidden();

    const metrics = await page.locator(".terminal-view").evaluate((terminal) => {
      const workspaceElement = terminal.closest(".chat-workspace");
      if (!workspaceElement) throw new Error("Missing chat workspace");
      return {
        terminalHeight: terminal.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        scrollHeight: workspaceElement.scrollHeight,
        clientHeight: workspaceElement.clientHeight
      };
    });
    expect(metrics.terminalHeight).toBeGreaterThan(metrics.viewportHeight * 0.8);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    const scrollTop = await workspace.evaluate((element) => {
      element.scrollTop = 400;
      return element.scrollTop;
    });
    expect(scrollTop).toBeGreaterThan(0);

    await workspace.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole("button", { name: "Terminal" }).click();
    await expect(workspace).not.toHaveClass(/terminal-fullscreen/);
    await expect(page.locator(".chat-composer")).toBeVisible();
  });

  test("deletes the selected session and selects the remaining newest session", async ({ page }) => {
    await mockDeletableGateway(page);

    await page.goto("/session/sess_primary");
    await expect(page.getByRole("heading", { name: "primary session" })).toBeVisible(sessionHeadingExpect);

    await page.getByRole("button", { name: "Controls" }).click();
    await page.getByRole("button", { name: "Delete session" }).click();
    await expect(page.getByRole("heading", { name: "next session" })).toBeVisible();
    await expect(page).toHaveURL(/\/session\/sess_next$/);
    await expect(page.getByText("primary session", { exact: true })).toHaveCount(0);
  });

  test("keeps the session selected and shows an error when deletion fails", async ({ page }) => {
    await mockDeletableGateway(page, { failDelete: true });

    await page.goto("/session/sess_primary");
    await page.getByRole("button", { name: "Controls" }).click();
    await page.getByRole("button", { name: "Delete session" }).click();

    await expect(page.getByRole("heading", { name: "primary session" })).toBeVisible();
    await expect(page.getByText("Session is busy")).toBeVisible();
    await expect(page).toHaveURL(/\/session\/sess_primary$/);
  });
});
