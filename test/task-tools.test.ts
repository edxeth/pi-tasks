import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { getSessionTaskDirPath } from "../src/task-store.js";

function cleanupStore(storePath: string) {
  rmSync(storePath, { recursive: true, force: true });
}

function readTaskFile(storePath: string, taskId: string) {
  return JSON.parse(readFileSync(join(storePath, `${taskId}.json`), "utf-8"));
}

function widgetLines(lines: string[]) {
  return lines.map((line) => ` ${line}`);
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let testAgentDir: string;

beforeEach(() => {
  testAgentDir = mkdtempSync(join(tmpdir(), "pi-tasks-agent-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function mockCtx(
  sessionId: string,
  hasUI = false,
  options?: { confirmResponses?: boolean[]; sessionFile?: string; leafId?: string | null; terminalRows?: number },
) {
  const widgets = new Map<string, string[] | undefined>();
  const widgetSetCalls = new Map<string, number>();
  const widgetRenderCalls = new Map<string, number>();
  const widgetComponents = new Map<string, { render?: (width: number) => string[]; dispose?: () => void }>();
  const renderWidget = (key: string, width = 80) => {
    widgetRenderCalls.set(key, (widgetRenderCalls.get(key) ?? 0) + 1);
    const component = widgetComponents.get(key);
    widgets.set(key, component?.render ? component.render(width) : undefined);
  };
  const notifications: Array<{ message: string; level: string }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const confirmResponses = [...(options?.confirmResponses ?? [true])];
  let leafId = options?.leafId ?? null;
  const ctx: any = {
    hasUI,
    widgets,
    widgetSetCalls,
    widgetRenderCalls,
    notifications,
    confirmCalls,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => options?.sessionFile,
      getLeafId: () => leafId,
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async confirm(title: string, message: string) {
        confirmCalls.push({ title, message });
        return confirmResponses.length > 0 ? confirmResponses.shift() ?? true : true;
      },
      setStatus() {},
      setWidget(key: string, content: string[] | ((tui: any, theme: any) => { render?: () => string[]; dispose?: () => void }) | undefined) {
        widgetSetCalls.set(key, (widgetSetCalls.get(key) ?? 0) + 1);
        widgetComponents.get(key)?.dispose?.();
        widgetComponents.delete(key);
        if (typeof content === "function") {
          const component = content({ requestRender: () => renderWidget(key), terminal: { rows: options?.terminalRows } }, ctx.ui.theme);
          widgetComponents.set(key, component);
          renderWidget(key);
        } else {
          widgets.set(key, content ? [...content] : undefined);
        }
      },
      theme: {
        fg(_color: string, text: string) {
          return text;
        },
        bold(text: string) {
          return text;
        },
        strikethrough(text: string) {
          return text;
        },
      },
    },
    model: { id: "test", name: "test" },
    modelRegistry: {},
    renderWidget(key: string, width = 80) {
      renderWidget(key, width);
    },
    setLeafId(nextLeafId: string | null) {
      leafId = nextLeafId;
    },
  };
  return ctx;
}

function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const sentMessages: Array<{ message: any; options: any }> = [];

  const pi = {
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    registerShortcut(shortcut: string, def: any) {
      shortcuts.set(shortcut, def);
    },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)?.push(handler);
    },
    sendMessage(message: any, options?: any) {
      sentMessages.push({ message, options });
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
  };

  return {
    pi,
    tools,
    commands,
    shortcuts,
    sentMessages,
    async fireLifecycle(event: string, ...args: any[]): Promise<any[]> {
      const results: any[] = [];
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        results.push(await handler(...args));
      }
      return results;
    },
    async executeTool(name: string, params: any, ctx: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      await this.fireLifecycle("tool_execution_start", {}, ctx);
      const result = await tool.execute("call-1", params, undefined, undefined, ctx);
      await this.fireLifecycle("tool_result", {
        toolName: name,
        content: result.content,
        details: result.details,
        isError: false,
      });
      return result;
    },
    async executeShortcut(shortcut: string, ctx: any) {
      const handler = shortcuts.get(shortcut);
      if (!handler) throw new Error(`Missing shortcut ${shortcut}`);
      return handler.handler(ctx);
    },
    async executeCommand(name: string, args: string, ctx: any) {
      const command = commands.get(name);
      if (!command) throw new Error(`Missing command ${name}`);
      return command.handler(args, ctx);
    },
  };
}

describe("tasksMode off", () => {
  function setTasksMode(mode: string) {
    writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({ tasksMode: mode }));
  }

  it("registers no tools, hooks, shortcuts, or widget when tasksMode is off", async () => {
    setTasksMode("off");
    const mock = mockPi();
    const ctx = mockCtx(`tasks-off-${Date.now()}`);
    initExtension(mock.pi as any);

    expect([...mock.tools.keys()]).toEqual([]);
    expect([...mock.shortcuts.keys()]).toEqual([]);
    expect([...mock.commands.keys()]).toEqual(["tasks"]);

    const results = await mock.fireLifecycle("before_agent_start", { systemPrompt: "Base prompt" }, ctx);
    expect(results.every((result) => result === undefined)).toBe(true);
  });

  it("re-enables via /tasks on while off, persisting for new sessions", async () => {
    setTasksMode("off");
    const mock = mockPi();
    const ctx = mockCtx(`tasks-off-on-${Date.now()}`, true);
    initExtension(mock.pi as any);

    await mock.executeCommand("tasks", "on", ctx);
    const settings = JSON.parse(readFileSync(join(testAgentDir, "settings.json"), "utf-8"));
    expect(settings.tasksMode).toBe("open");

    const nextSession = mockPi();
    initExtension(nextSession.pi as any);
    expect([...nextSession.tools.keys()].sort()).toEqual([
      "task_batch",
      "task_create",
      "task_get",
      "task_list",
      "task_update",
    ]);
  });

  it("turns off via /tasks off in a normal session, persisting for new sessions", async () => {
    const mock = mockPi();
    const ctx = mockCtx(`tasks-to-off-${Date.now()}`, true);
    initExtension(mock.pi as any);

    await mock.executeCommand("tasks", "off", ctx);
    const settings = JSON.parse(readFileSync(join(testAgentDir, "settings.json"), "utf-8"));
    expect(settings.tasksMode).toBe("off");

    const nextSession = mockPi();
    initExtension(nextSession.pi as any);
    expect([...nextSession.tools.keys()]).toEqual([]);
  });

  it("keeps pending off sticky across widget cycling in the same session", async () => {
    const mock = mockPi();
    const ctx = mockCtx(`tasks-off-sticky-${Date.now()}`, true);
    initExtension(mock.pi as any);

    await mock.executeCommand("tasks", "off", ctx);
    await mock.executeShortcut("ctrl+alt+t", ctx);
    await mock.executeCommand("tasks", "cycle", ctx);
    await mock.executeCommand("tasks", "all", ctx);

    const settings = JSON.parse(readFileSync(join(testAgentDir, "settings.json"), "utf-8"));
    expect(settings.tasksMode).toBe("off");
  });

  it("cancels pending off with an explicit /tasks on in the same session", async () => {
    const mock = mockPi();
    const ctx = mockCtx(`tasks-off-cancel-${Date.now()}`, true);
    initExtension(mock.pi as any);

    await mock.executeCommand("tasks", "off", ctx);
    await mock.executeCommand("tasks", "on", ctx);

    const settings = JSON.parse(readFileSync(join(testAgentDir, "settings.json"), "utf-8"));
    expect(settings.tasksMode).toBe("open");

    const nextSession = mockPi();
    initExtension(nextSession.pi as any);
    expect([...nextSession.tools.keys()].length).toBe(5);
  });
});

describe("pi-tasks extension", () => {
  it("registers only task tools plus the task widget commands", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    expect([...mock.tools.keys()].sort()).toEqual([
      "task_batch",
      "task_create",
      "task_get",
      "task_list",
      "task_update",
    ]);
    expect([...mock.commands.keys()].sort()).toEqual(["tasks", "tasks-clear-completed"]);
  });

  it("injects a hidden task workflow policy into the system prompt", async () => {
    const sessionId = `task-policy-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);

    const [result] = await mock.fireLifecycle("before_agent_start", { systemPrompt: "Base prompt" }, ctx);
    expect(result.systemPrompt).toContain("Base prompt");
    expect(result.systemPrompt).toContain("Task workflow guidance:");
    expect(result.systemPrompt).toContain("skip them for a simple one-off job");
    expect(result.systemPrompt).toContain("Mark a task in_progress before substantial work starts");
    expect(result.systemPrompt).toContain("Mark a task completed only when the work is fully done");
    expect(result.systemPrompt).toContain("call task_list to pick the next ready item");
    expect(result.systemPrompt).toContain("one task_batch call instead of parallel task_update calls");

    cleanupStore(storePath);
  });

  it("creates per-task session-scoped files under ~/.pi/tasks", async () => {
    const sessionId = `todo-tools-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.executeTool("task_create", { subject: "Ship rename", description: "Finish the rename" }, ctx);

    expect(storePath).toContain("/.pi/tasks/");
    expect(storePath.endsWith(`/${sessionId}`)).toBe(true);
    expect(existsSync(join(storePath, "1.json"))).toBe(true);

    const raw = readTaskFile(storePath, "1");
    expect(raw.subject).toBe("Ship rename");

    cleanupStore(storePath);
  });

  it("allows task_create to set an initial in-progress status", async () => {
    const sessionId = `todo-create-status-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("task_create", { subject: "Ship rename", description: "Finish the rename", status: "in_progress" }, ctx);

    expect(readTaskFile(storePath, "1")).toMatchObject({
      subject: "Ship rename",
      status: "in_progress",
      metadata: { stats: { startedAt: expect.any(Number) } },
    });
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "1 open · 0 completed · 1 total · Ctrl+Alt+T to cycle",
      "▶ #1 Ship rename · 0s",
    ]));

    cleanupStore(storePath);
  });

  it("describes single-create and multi-create batching boundaries clearly", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    const createTool = mock.tools.get("task_create");
    const batchTool = mock.tools.get("task_batch");

    expect(createTool.description).toContain("Create one structured task");
    expect(createTool.description).toContain("For 2 or more independent new tasks in one turn, use `task_batch` instead");
    expect(createTool.description).toContain("use `task_create` when later operations depend on the assigned ID");
    expect(batchTool.description).toContain("atomically");
    expect(batchTool.description).toContain("For a single mutation, prefer `task_create` or `task_update`.");
  });

  it("gives every tool a one-line snippet and no guideline bullets", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    for (const [name, tool] of mock.tools) {
      expect(tool.promptGuidelines, name).toBeUndefined();
      expect(typeof tool.promptSnippet, name).toBe("string");
      expect(tool.promptSnippet.length, name).toBeGreaterThan(0);
      expect(tool.promptSnippet, name).not.toContain("\n");
    }
  });

  it("states every always-on rule sentence exactly once across policy and descriptions", async () => {
    const mock = mockPi();
    const ctx = mockCtx(`guidance-unique-${Date.now()}`);
    initExtension(mock.pi as any);

    const [result] = await mock.fireLifecycle("before_agent_start", { systemPrompt: "" }, ctx);
    const policyBullets = String(result.systemPrompt)
      .split("\n")
      .filter((line) => line.startsWith("- "));
    const descriptionSentences = [...mock.tools.values()].flatMap((tool) => String(tool.description).split(/[.!?](?:\s+|$)/));

    const normalized = [...policyBullets, ...descriptionSentences]
      .map((sentence) => sentence.toLowerCase().replace(/[^a-z0-9_]+/g, " ").trim())
      .filter((sentence) => sentence.length > 20);

    const seen = new Set<string>();
    for (const sentence of normalized) {
      expect(seen.has(sentence), `duplicated rule: "${sentence}"`).toBe(false);
      seen.add(sentence);
    }
  });

  it("keeps the always-on guidance payload within budget", async () => {
    const mock = mockPi();
    const ctx = mockCtx(`guidance-budget-${Date.now()}`);
    initExtension(mock.pi as any);

    const [result] = await mock.fireLifecycle("before_agent_start", { systemPrompt: "" }, ctx);
    const policyChars = String(result.systemPrompt).length;
    const toolChars = [...mock.tools.values()].reduce(
      (total, tool) => total + String(tool.description).length + String(tool.promptSnippet ?? "").length,
      0,
    );

    // Budget guard against guidance creep (PRD-0001). Pre-dedup this was ~4,190 chars.
    expect(policyChars + toolChars).toBeLessThan(2200);
  });

  it("bootstraps the global store from the tool call context itself", async () => {
    const sessionId = `todo-direct-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);

    const tool = mock.tools.get("task_create");
    await tool.execute("call-1", { subject: "Direct", description: "Desc" }, undefined, undefined, ctx);

    expect(existsSync(join(storePath, "1.json"))).toBe(true);
    expect(readTaskFile(storePath, "1").subject).toBe("Direct");

    cleanupStore(storePath);
  });

  it("restores task state when navigating back in the tree", async () => {
    const sessionId = `todo-tree-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, false, { leafId: "leaf-a" });
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    await mock.executeTool("task_create", { subject: "First", description: "Desc" }, ctx);
    await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 1 } } }, ctx);

    ctx.setLeafId("leaf-b");
    await mock.executeTool("task_create", { subject: "Second", description: "Desc" }, ctx);
    await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 1 } } }, ctx);

    ctx.setLeafId("leaf-a");
    await mock.fireLifecycle("session_tree", { newLeafId: "leaf-a", oldLeafId: "leaf-b" }, ctx);

    const list = await mock.executeTool("task_list", {}, ctx);
    expect(list.content[0].text).toContain("#1 [pending] First");
    expect(list.content[0].text).not.toContain("Second");

    cleanupStore(storePath);
  });

  it("copies task state into a forked session", async () => {
    const parentSession = `todo-parent-${Date.now()}`;
    const childSession = `todo-child-${Date.now()}`;
    const parentPath = getSessionTaskDirPath(parentSession);
    const childPath = getSessionTaskDirPath(childSession);

    cleanupStore(parentPath);
    cleanupStore(childPath);

    const mock = mockPi();
    initExtension(mock.pi as any);

    const parentCtx = mockCtx(parentSession, false, { leafId: "leaf-a" });
    await mock.fireLifecycle("session_start", { reason: "startup" }, parentCtx);
    await mock.executeTool("task_create", { subject: "Parent", description: "Desc" }, parentCtx);
    await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 1 } } }, parentCtx);

    const childCtx = mockCtx(childSession, false, { leafId: "leaf-a" });
    await mock.fireLifecycle("session_start", { reason: "fork", previousSessionFile: parentSession }, childCtx);

    const list = await mock.executeTool("task_list", {}, childCtx);
    expect(list.content[0].text).toContain("#1 [pending] Parent");

    cleanupStore(parentPath);
    cleanupStore(childPath);
  });

  it("lists and gets tasks with spec-compliant output", async () => {
    const sessionId = `todo-list-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    await mock.executeTool("task_create", { subject: "Completed blocker", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Blocked pending", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "In progress", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Open blocker", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Unblocked pending", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["4", "1"] }, ctx);
    await mock.executeTool("task_update", { taskId: "3", status: "in_progress" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);

    const list = await mock.executeTool("task_list", {}, ctx);
    const get = await mock.executeTool("task_get", { taskId: "2" }, ctx);

    expect(list.content[0].text).toBe([
      "#1 [completed] Completed blocker · 0s",
      "#2 [pending] Blocked pending [blocked by #4]",
      "#3 [in_progress] In progress · 0s",
      "#4 [pending] Open blocker",
      "#5 [pending] Unblocked pending",
    ].join("\n"));
    expect(get.content[0].text).toContain("Task #2: Blocked pending");
    expect(get.content[0].text).toContain("blocked by: #4");
    expect(get.content[0].text).not.toContain("#1");

    cleanupStore(storePath);
  });

  it("returns task-specific success, not-found, and warning text", async () => {
    const sessionId = `todo-output-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    const created = await mock.executeTool("task_create", { subject: "One", description: "Desc" }, ctx);
    const missingGet = await mock.executeTool("task_get", { taskId: "99" }, ctx);
    const missingUpdate = await mock.executeTool("task_update", { taskId: "99", status: "completed" }, ctx);
    const warned = await mock.executeTool("task_update", { taskId: "1", addBlockedBy: ["1", "999"] }, ctx);

    expect(created.content[0].text).toBe("Task #1 created successfully: One");
    expect(missingGet.content[0].text).toBe("Task #99 not found");
    expect(missingUpdate.content[0].text).toBe("Task #99 not found");
    expect(warned.content[0].text).toBe("Updated task #1 blockedBy (warning: #1 blocks itself; #999 does not exist)");

    cleanupStore(storePath);
  });

  it("tracks runtime, tool usage, token usage, and last tool for the active task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00.000Z"));

    const sessionId = `todo-telemetry-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("before_agent_start", {}, ctx);

      await mock.executeTool("task_create", { subject: "Instrumented", description: "Desc" }, ctx);
      await mock.executeTool("task_update", { taskId: "1", status: "in_progress" }, ctx);

      vi.advanceTimersByTime(5_000);
      await mock.fireLifecycle("tool_execution_end", { toolName: "bash", toolCallId: "call-2", result: {}, isError: false }, ctx);
      await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 30 } } }, ctx);
      vi.advanceTimersByTime(15_000);
      await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);

      const get = await mock.executeTool("task_get", { taskId: "1" }, ctx);
      const list = await mock.executeTool("task_list", {}, ctx);
      const raw = readTaskFile(storePath, "1");

      expect(list.content[0].text).toContain("#1 [completed] Instrumented · 20s · 1 tool · 30 tokens");
      expect(get.content[0].text).toContain("time to complete: 20s");
      expect(get.content[0].text).toContain("tool uses: 1");
      expect(get.content[0].text).toContain("output: 30 tokens");
      expect(get.content[0].text).toContain("last tool: bash at 2026-04-15T12:00:05.000Z");
      expect(raw.metadata.stats).toMatchObject({
        startedAt: new Date("2026-04-15T12:00:00.000Z").getTime(),
        completedAt: new Date("2026-04-15T12:00:20.000Z").getTime(),
        toolUseCount: 1,
        outputTokens: 30,
        lastToolName: "bash",
        lastToolAt: new Date("2026-04-15T12:00:05.000Z").getTime(),
      });
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("counts output tokens from subagent results", async () => {
    const sessionId = `todo-subagent-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    await mock.executeTool("task_create", { subject: "Subagents", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "in_progress" }, ctx);

    await mock.fireLifecycle(
      "tool_execution_end",
      {
        toolName: "subagent_join",
        toolCallId: "call-join",
        result: {
          details: {
            status: "completed",
            outputTokens: 20,
          },
        },
        isError: false,
      },
      ctx,
    );
    await mock.fireLifecycle(
      "message_end",
      {
        message: {
          role: "custom",
          customType: "subagent_ping",
          details: { outputTokens: 5 },
        },
      },
      ctx,
    );

    const get = await mock.executeTool("task_get", { taskId: "1" }, ctx);
    const raw = readTaskFile(storePath, "1");

    expect(get.content[0].text).toContain("output: 25 tokens");
    expect(raw.metadata.stats.outputTokens).toBe(25);

    cleanupStore(storePath);
  });

  it("does not reuse deleted IDs from the real tool flow", async () => {
    const sessionId = `todo-reuse-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    await mock.executeTool("task_create", { subject: "One", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Two", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "deleted" }, ctx);
    const created = await mock.executeTool("task_create", { subject: "Three", description: "Desc" }, ctx);

    expect(created.content[0].text).toContain("Task #3 created successfully: Three");
    expect(existsSync(join(storePath, "1.json"))).toBe(false);
    expect(existsSync(join(storePath, "3.json"))).toBe(true);

    cleanupStore(storePath);
  });

  it("applies task_batch atomically and returns per-operation results", async () => {
    const sessionId = `todo-write-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    await mock.executeTool("task_create", { subject: "Existing", description: "Desc" }, ctx);

    const result = await mock.executeTool(
      "task_batch",
      {
        operations: [
          { type: "create", subject: "Batch create", description: "Desc", status: "in_progress" },
          { type: "update", taskId: "1", status: "in_progress" },
          { type: "update", taskId: "2", addBlockedBy: ["1", "999"] },
        ],
      },
      ctx,
    );

    expect(result.content[0].text).toBe([
      "Operation 1: Task #2 created successfully: Batch create",
      "Operation 2: Updated task #1 status",
      "Operation 3: Updated task #2 blockedBy",
      "Warnings: operation 3: #999 does not exist",
    ].join("\n"));
    expect(readTaskFile(storePath, "1").status).toBe("in_progress");
    expect(readTaskFile(storePath, "2")).toMatchObject({
      status: "in_progress",
      blockedBy: ["1", "999"],
      metadata: { stats: { startedAt: expect.any(Number) } },
    });

    cleanupStore(storePath);
  });

  it("rolls back task_batch when one operation fails", async () => {
    const sessionId = `todo-write-fail-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    await mock.executeTool("task_create", { subject: "Existing", description: "Desc" }, ctx);

    const result = await mock.executeTool(
      "task_batch",
      {
        operations: [
          { type: "create", subject: "Should not persist", description: "Desc" },
          { type: "update", taskId: "99", status: "completed" },
        ],
      },
      ctx,
    );

    expect(result.content[0].text).toBe("task_batch failed: operation 2 update task #99 not found\nNo changes were committed.");
    expect(existsSync(join(storePath, "2.json"))).toBe(false);

    const list = await mock.executeTool("task_list", {}, ctx);
    expect(list.content[0].text).toBe("#1 [pending] Existing");

    cleanupStore(storePath);
  });

  it("matches equivalent granular updates after task_batch commits", async () => {
    const writeSessionId = `todo-write-eq-${Date.now()}`;
    const granularSessionId = `todo-granular-eq-${Date.now()}`;
    const writePath = getSessionTaskDirPath(writeSessionId);
    const granularPath = getSessionTaskDirPath(granularSessionId);
    cleanupStore(writePath);
    cleanupStore(granularPath);

    const writeMock = mockPi();
    const writeCtx = mockCtx(writeSessionId);
    initExtension(writeMock.pi as any);
    await writeMock.fireLifecycle("before_agent_start", {}, writeCtx);
    await writeMock.executeTool("task_create", { subject: "First", description: "Desc" }, writeCtx);
    await writeMock.executeTool("task_create", { subject: "Second", description: "Desc" }, writeCtx);
    await writeMock.executeTool(
      "task_batch",
      {
        operations: [
          { type: "update", taskId: "1", status: "in_progress" },
          { type: "update", taskId: "2", addBlockedBy: ["1"] },
          { type: "create", subject: "Third", description: "Desc" },
        ],
      },
      writeCtx,
    );
    const writeList = await writeMock.executeTool("task_list", {}, writeCtx);

    const granularMock = mockPi();
    const granularCtx = mockCtx(granularSessionId);
    initExtension(granularMock.pi as any);
    await granularMock.fireLifecycle("before_agent_start", {}, granularCtx);
    await granularMock.executeTool("task_create", { subject: "First", description: "Desc" }, granularCtx);
    await granularMock.executeTool("task_create", { subject: "Second", description: "Desc" }, granularCtx);
    await granularMock.executeTool("task_update", { taskId: "1", status: "in_progress" }, granularCtx);
    await granularMock.executeTool("task_update", { taskId: "2", addBlockedBy: ["1"] }, granularCtx);
    await granularMock.executeTool("task_create", { subject: "Third", description: "Desc" }, granularCtx);
    const granularList = await granularMock.executeTool("task_list", {}, granularCtx);

    expect(writeList.content[0].text).toBe(granularList.content[0].text);

    cleanupStore(writePath);
    cleanupStore(granularPath);
  });

  it("renders the Open widget with canonical ordering, counts, blockers, and collapsed completed state", async () => {
    const sessionId = `todo-widget-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    expect(ctx.widgetSetCalls.get("tasks")).toBe(1);

    await mock.executeTool("task_create", { subject: "Completed blocker", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Blocked pending", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "In progress", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Open blocker", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Unblocked pending", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "2", addBlockedBy: ["4", "1"] }, ctx);
    await mock.executeTool("task_update", { taskId: "3", status: "in_progress" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);
    expect(ctx.widgetSetCalls.get("tasks")).toBe(1);

    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "4 open · 1 completed · 5 total · Ctrl+Alt+T to cycle",
      "○ #2 Blocked pending [blocked by #4]",
      "▶ #3 In progress · 0s",
      "○ #4 Open blocker",
      "○ #5 Unblocked pending",
    ]));

    cleanupStore(storePath);
  });

  it("prioritizes current work first in the All widget view", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:00:00.000Z"));

    const sessionId = `todo-widget-all-order-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      for (let i = 1; i <= 18; i++) {
        await mock.executeTool("task_create", { subject: `Old done ${i}`, description: "Desc", status: "completed" }, ctx);
      }
      vi.advanceTimersByTime(31_000);
      await mock.executeTool("task_create", { subject: "Current", description: "Desc", status: "in_progress" }, ctx);
      await mock.executeTool("task_create", { subject: "Next", description: "Desc" }, ctx);

      await mock.executeCommand("tasks", "all", ctx);

      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "2 open · 18 completed · 20 total · Ctrl+Alt+T to cycle",
        "▶ #19 Current · 0s",
        "○ #20 Next",
        "✓ #18 Old done 18 · 0s",
        "✓ #17 Old done 17 · 0s",
        "✓ #16 Old done 16 · 0s",
        "✓ #15 Old done 15 · 0s",
        "✓ #14 Old done 14 · 0s",
        "✓ #13 Old done 13 · 0s",
        "✓ #12 Old done 12 · 0s",
        "✓ #11 Old done 11 · 0s",
        "… 10 more",
      ]));
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("uses terminal height to cap the All widget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:30:00.000Z"));

    const sessionId = `todo-widget-height-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true, { terminalRows: 20 });
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      for (let i = 1; i <= 18; i++) {
        await mock.executeTool("task_create", { subject: `Old done ${i}`, description: "Desc", status: "completed" }, ctx);
      }
      vi.advanceTimersByTime(31_000);
      await mock.executeTool("task_create", { subject: "Current", description: "Desc", status: "in_progress" }, ctx);
      await mock.executeTool("task_create", { subject: "Next", description: "Desc" }, ctx);

      await mock.executeCommand("tasks", "all", ctx);

      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "2 open · 18 completed · 20 total · Ctrl+Alt+T to cycle",
        "▶ #19 Current · 0s",
        "○ #20 Next",
        "✓ #18 Old done 18 · 0s",
        "✓ #17 Old done 17 · 0s",
        "✓ #16 Old done 16 · 0s",
        "✓ #15 Old done 15 · 0s",
        "… 14 more",
      ]));
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("cycles the widget Open → All → Hidden and restores the last view from settings.json", async () => {
    const sessionId = `todo-widget-cycle-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    const settingsPath = join(testAgentDir, "settings.json");
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    await mock.executeTool("task_create", { subject: "Done", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Open", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);

    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "1 open · 1 completed · 2 total · Ctrl+Alt+T to cycle",
      "○ #2 Open",
    ]));

    await mock.executeShortcut("ctrl+alt+t", ctx);
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "1 open · 1 completed · 2 total · Ctrl+Alt+T to cycle",
      "○ #2 Open",
      "✓ #1 Done · 0s",
    ]));
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      tasksMode: "all",
    });

    await mock.executeShortcut("ctrl+alt+t", ctx);
    expect(ctx.widgets.get("tasks")).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      tasksMode: "hidden",
    });

    const remount = mockPi();
    const remountCtx = mockCtx(sessionId, true);
    initExtension(remount.pi as any);
    await remount.fireLifecycle("session_start", { reason: "startup" }, remountCtx);
    expect(remountCtx.widgetSetCalls.get("tasks")).toBe(1);
    expect(remountCtx.widgets.get("tasks")).toEqual([]);
    remountCtx.ui.setWidget("later-widget", ["later"]);
    await remount.executeCommand("tasks", "open", remountCtx);
    expect([...remountCtx.widgets.keys()]).toEqual(["tasks", "later-widget"]);

    await mock.executeCommand("tasks", "open", ctx);
    expect(ctx.widgets.get("tasks")?.[0]).toBe(" Tasks");
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      tasksMode: "open",
    });

    await mock.executeCommand("tasks", "all", ctx);
    expect(ctx.widgets.get("tasks")?.[0]).toBe(" Tasks");

    cleanupStore(storePath);
  });

  it("preserves symlinked settings.json when persisting the widget view", async () => {
    const sessionId = `todo-widget-symlink-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    const targetAgentDir = mkdtempSync(join(tmpdir(), "pi-tasks-target-agent-"));
    const settingsPath = join(testAgentDir, "settings.json");
    const targetSettingsPath = join(targetAgentDir, "settings.json");
    cleanupStore(storePath);

    try {
      writeFileSync(targetSettingsPath, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
      symlinkSync(targetSettingsPath, settingsPath);

      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      await mock.executeCommand("tasks", "all", ctx);

      expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(targetSettingsPath, "utf-8"))).toEqual({
        theme: "dark",
        tasksMode: "all",
      });
    } finally {
      cleanupStore(storePath);
      rmSync(targetAgentDir, { recursive: true, force: true });
    }
  });

  it("truncates every widget line to the render width", async () => {
    const sessionId = `todo-widget-width-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("task_create", {
      subject: "Rename pi-share traces to pi-r2-share",
      description: "Desc",
      status: "in_progress",
    }, ctx);
    await mock.fireLifecycle("tool_execution_end", { toolName: "bash", toolCallId: "call-2", result: {}, isError: false }, ctx);
    await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 2049 } } }, ctx);

    ctx.renderWidget("tasks", 76);

    expect(ctx.widgets.get("tasks")?.every((line: string) => line.length <= 76)).toBe(true);
    expect(ctx.widgets.get("tasks")?.[2]).toBe(" ▶ #1 Rename pi-share traces to pi-r2-share · 0s · 1 tool · 2,049 tokens");

    cleanupStore(storePath);
  });

  it("temporarily hides the widget without remounting while a user message is submitted", async () => {
    const sessionId = `todo-widget-input-clear-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.executeCommand("tasks", "all", ctx);
      await mock.executeTool("task_create", { subject: "Done", description: "Desc", status: "completed" }, ctx);

      expect(ctx.widgets.get("tasks")?.join("\n")).toContain("Done");
      const setCallsBeforeInput = ctx.widgetSetCalls.get("tasks") ?? 0;

      await mock.fireLifecycle("input", { type: "input", text: "next", source: "interactive" }, ctx);
      expect(ctx.widgets.get("tasks")).toEqual([]);
      expect(ctx.widgetSetCalls.get("tasks")).toBe(setCallsBeforeInput);

      await mock.fireLifecycle("message_end", { message: { role: "user", content: [{ type: "text", text: "next" }] } }, ctx);
      expect(ctx.widgetSetCalls.get("tasks")).toBe(setCallsBeforeInput);
      expect(ctx.widgets.get("tasks")?.join("\n")).toContain("Done");
    } finally {
      cleanupStore(storePath);
    }
  });

  it("only ticks the widget while an in-progress task can change runtime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:30:00.000Z"));

    const sessionId = `todo-widget-ticker-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      const startupRenders = ctx.widgetRenderCalls.get("tasks");
      vi.advanceTimersByTime(3_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(startupRenders);

      await mock.executeTool("task_create", { subject: "Pending", description: "Desc" }, ctx);
      const pendingRenders = ctx.widgetRenderCalls.get("tasks");
      vi.advanceTimersByTime(3_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(pendingRenders);

      await mock.executeTool("task_update", { taskId: "1", status: "in_progress" }, ctx);
      const inProgressRenders = ctx.widgetRenderCalls.get("tasks") ?? 0;
      vi.advanceTimersByTime(1_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(inProgressRenders + 1);

      await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);
      const completedRenders = ctx.widgetRenderCalls.get("tasks");
      vi.advanceTimersByTime(3_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(completedRenders);
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("updates runtime live and token count after the generation finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T13:00:00.000Z"));

    const sessionId = `todo-widget-live-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.executeTool("task_create", { subject: "Live", description: "Desc" }, ctx);
      await mock.executeTool("task_update", { taskId: "1", status: "in_progress" }, ctx);

      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "1 open · 0 completed · 1 total · Ctrl+Alt+T to cycle",
        "▶ #1 Live · 0s",
      ]));

      vi.advanceTimersByTime(2_000);
      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "1 open · 0 completed · 1 total · Ctrl+Alt+T to cycle",
        "▶ #1 Live · 2s",
      ]));

      await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 18 } } }, ctx);
      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "1 open · 0 completed · 1 total · Ctrl+Alt+T to cycle",
        "▶ #1 Live · 2s · 18 tokens",
      ]));
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("clears completed tasks only after confirmation", async () => {
    const sessionId = `todo-widget-clear-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true, { confirmResponses: [false, true] });
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    await mock.executeTool("task_create", { subject: "Done", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Open", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Also open", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);

    await mock.executeCommand("tasks-clear-completed", "", ctx);
    expect(ctx.confirmCalls).toEqual([
      { title: "Clear completed tasks?", message: "Permanently delete 1 completed task?" },
    ]);
    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe([
      "#1 [completed] Done · 0s",
      "#2 [pending] Open",
      "#3 [pending] Also open",
    ].join("\n"));

    await mock.executeCommand("tasks-clear-completed", "", ctx);
    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe([
      "#2 [pending] Open",
      "#3 [pending] Also open",
    ].join("\n"));
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "2 open · 0 completed · 2 total · Ctrl+Alt+T to cycle",
      "○ #2 Open",
      "○ #3 Also open",
    ]));

    cleanupStore(storePath);
  });

  it("keeps completed tasks on disk across idle turns and session resets", async () => {
    const sessionId = `task-completed-persist-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    await mock.executeTool("task_create", { subject: "Done", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);

    for (let turn = 0; turn < 10; turn++) {
      await mock.fireLifecycle("turn_start", {}, ctx);
    }
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe("#1 [completed] Done · 0s");
    expect(existsSync(join(storePath, "1.json"))).toBe(true);
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "0 open · 1 completed · 1 total · Ctrl+Alt+T to cycle",
      "No open tasks",
    ]));

    cleanupStore(storePath);
  });

  it("injects a hidden read-only reminder into context after 10 assistant turns and repeats every 10 turns", async () => {
    const sessionId = `todo-reminder-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.executeTool("task_create", { subject: "Open", description: "Desc" }, ctx);
    await mock.executeTool("task_create", { subject: "Done", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "2", status: "completed" }, ctx);

    for (let turn = 0; turn < 9; turn++) {
      await mock.fireLifecycle("turn_start", {}, ctx);
    }
    expect(await mock.fireLifecycle("context", { messages: [] }, ctx)).toEqual([undefined]);
    expect(mock.sentMessages).toHaveLength(0);

    await mock.fireLifecycle("turn_start", {}, ctx);
    const [firstReminder] = await mock.fireLifecycle("context", { messages: [] }, ctx);

    expect(firstReminder?.messages).toHaveLength(1);
    expect(firstReminder.messages[0].role).toBe("user");
    expect(firstReminder.messages[0].content).toContain("task tools haven't been used recently");
    expect(firstReminder.messages[0].content).toContain("use task_create when the work is worth tracking");
    expect(firstReminder.messages[0].content).toContain("task_batch for 2 or more task writes in one turn");
    expect(firstReminder.messages[0].content).toContain("Open tasks:");
    expect(firstReminder.messages[0].content).toContain("#1 [pending] Open");
    expect(firstReminder.messages[0].content).not.toContain("Done");
    expect(mock.sentMessages).toHaveLength(0);

    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe("#2 [completed] Done · 0s\n#1 [pending] Open");
    expect(readTaskFile(storePath, "2").status).toBe("completed");

    for (let turn = 0; turn < 9; turn++) {
      await mock.fireLifecycle("turn_start", {}, ctx);
    }
    expect(await mock.fireLifecycle("context", { messages: [] }, ctx)).toEqual([undefined]);

    await mock.fireLifecycle("turn_start", {}, ctx);
    const [secondReminder] = await mock.fireLifecycle("context", { messages: [] }, ctx);
    expect(secondReminder?.messages).toHaveLength(1);
    expect(secondReminder.messages[0].content).toContain("#1 [pending] Open");

    cleanupStore(storePath);
  });

  it("does not let task_list reset the reminder clock and never emits reminder transcript messages", async () => {
    const sessionId = `todo-reminder-task-list-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.executeTool("task_create", { subject: "Open", description: "Desc" }, ctx);

    for (let turn = 0; turn < 9; turn++) {
      await mock.fireLifecycle("turn_start", {}, ctx);
    }
    await mock.executeTool("task_list", {}, ctx);
    await mock.fireLifecycle("turn_start", {}, ctx);

    const [reminder] = await mock.fireLifecycle("context", { messages: [] }, ctx);
    expect(reminder?.messages).toHaveLength(1);
    expect(mock.sentMessages).toHaveLength(0);

    cleanupStore(storePath);
  });

  it("does not inject reminders when only completed tasks remain", async () => {
    const sessionId = `todo-reminder-completed-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.executeTool("task_create", { subject: "Done", description: "Desc" }, ctx);
    await mock.executeTool("task_update", { taskId: "1", status: "completed" }, ctx);

    for (let turn = 0; turn < 10; turn++) {
      await mock.fireLifecycle("turn_start", {}, ctx);
    }

    expect(await mock.fireLifecycle("context", { messages: [] }, ctx)).toEqual([undefined]);
    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe("#1 [completed] Done · 0s");

    cleanupStore(storePath);
  });
});
