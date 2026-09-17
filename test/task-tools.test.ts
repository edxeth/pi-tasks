import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "../node_modules/@earendil-works/pi-ai/dist/utils/validation.js";
import initExtension from "../src/index.js";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { CustomEntryComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-entry.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
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

function writeTaskFile(storePath: string, taskId: string, task: Record<string, unknown>) {
  mkdirSync(storePath, { recursive: true });
  writeFileSync(join(storePath, `${taskId}.json`), JSON.stringify(task));
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
      getBranch: () => [],
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
  const entries: Array<{ customType: string; data: unknown }> = [];
  const entryRenderers = new Map();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const sentMessages: Array<{ message: any; options: any }> = [];

  const pi = {
    registerEntryRenderer(name: string, renderer: unknown) {
      entryRenderers.set(name, renderer);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
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
    entries,
    entryRenderers,
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
    async executeToolThroughValidation(name: string, params: any, ctx: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing tool ${name}`);
      const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
      const validated = validateToolArguments(tool, { name, arguments: prepared } as any);
      return this.executeTool(name, validated, ctx);
    },
    async createTask(params: any, ctx: any) {
      return this.executeTool("task_write", { operations: [{ action: "create", ...params }] }, ctx);
    },
    async updateTask(params: any, ctx: any) {
      return this.executeTool("task_write", { operations: [{ action: "update", ...params }] }, ctx);
    },
    async taskDetail(taskId: string, ctx: any) {
      return this.executeTool("task_list", { taskId }, ctx);
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
    expect([...nextSession.tools.keys()].sort()).toEqual(["task_list", "task_write"]);
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
    expect([...nextSession.tools.keys()].length).toBe(2);
  });
});

describe("pi-tasks extension", () => {
  it("registers only task tools plus the task widget commands", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    expect([...mock.tools.keys()].sort()).toEqual(["task_list", "task_write"]);
    expect([...mock.commands.keys()].sort()).toEqual(["tasks", "tasks-clean"]);
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
    expect(result.systemPrompt).toContain("Create tasks with task_write for multi-step or multi-part work");
    expect(result.systemPrompt).toContain("Skip for a single trivial action");
    expect(result.systemPrompt).toContain("Mark a task in_progress before substantial work starts");
    expect(result.systemPrompt).toContain("Mark a task completed only when the work is fully done");
    expect(result.systemPrompt).toContain("call task_list to pick the next ready item");
    expect(result.systemPrompt).toContain("one task_write call instead of parallel task_write calls");

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
    await mock.createTask( { subject: "Ship rename", description: "Finish the rename" }, ctx);

    expect(storePath).toContain("/.pi/tasks/");
    expect(storePath.endsWith(`/${sessionId}`)).toBe(true);
    expect(existsSync(join(storePath, "1.json"))).toBe(true);

    const raw = readTaskFile(storePath, "1");
    expect(raw.subject).toBe("Ship rename");

    cleanupStore(storePath);
  });

  it("allows task_write to set an initial in-progress status", async () => {
    const sessionId = `todo-create-status-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.createTask( { subject: "Ship rename", description: "Finish the rename", status: "in_progress" }, ctx);

    expect(readTaskFile(storePath, "1")).toMatchObject({
      subject: "Ship rename",
      status: "in_progress",
      metadata: { stats: { startedAt: expect.any(Number) } },
    });
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "1 open · 0 completed · Ctrl+Alt+T to cycle",
      "▶ #1 Ship rename · 0s",
    ]));

    cleanupStore(storePath);
  });

  it("describes the consolidated write and read routing clearly", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    const writeTool = mock.tools.get("task_write");
    const listTool = mock.tools.get("task_list");

    expect(writeTool.description).toContain("Create/update/delete tasks atomically");
    expect(writeTool.description).toContain("use task_list for reads");
    expect(writeTool.description).toContain('{"operations":[{"action":"create"');
    expect(listTool.description).toContain("pass taskId for full details");
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

  it("uses flat enum schemas for task_write action and status guidance", () => {
    const mock = mockPi();
    initExtension(mock.pi as any);

    const writeTool = mock.tools.get("task_write");
    const operationSchema = writeTool.parameters.properties.operations.items;

    expect(operationSchema.properties.action).toMatchObject({
      type: "string",
      enum: ["create", "update", "delete"],
    });
    expect(operationSchema.properties.status).toMatchObject({
      type: "string",
      enum: ["pending", "in_progress", "completed", "deleted"],
    });
    expect(JSON.stringify(operationSchema)).not.toContain("anyOf");
    expect(JSON.stringify(operationSchema)).not.toContain("const");
  });

  it("states every always-on rule sentence exactly once across policy, descriptions, and snippets", async () => {
    const mock = mockPi();
    const ctx = mockCtx(`guidance-unique-${Date.now()}`);
    initExtension(mock.pi as any);

    const [result] = await mock.fireLifecycle("before_agent_start", { systemPrompt: "" }, ctx);
    const policyBullets = String(result.systemPrompt)
      .split("\n")
      .filter((line) => line.startsWith("- "));
    const toolGuidance = [...mock.tools.values()].flatMap((tool) => [
      ...String(tool.description).split(/[.!?](?:\s+|$)/),
      String(tool.promptSnippet ?? ""),
    ]);

    const normalized = [...policyBullets, ...toolGuidance]
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
    expect(policyChars + toolChars).toBeLessThan(1800);
  });

  it("bootstraps the global store from the tool call context itself", async () => {
    const sessionId = `todo-direct-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);

    const tool = mock.tools.get("task_write");
    await tool.execute("call-1", { operations: [{ action: "create", subject: "Direct", description: "Desc" }] }, undefined, undefined, ctx);

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

    await mock.createTask( { subject: "First", description: "Desc" }, ctx);
    await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 1 } } }, ctx);

    ctx.setLeafId("leaf-b");
    await mock.createTask( { subject: "Second", description: "Desc" }, ctx);
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
    await mock.createTask( { subject: "Parent", description: "Desc" }, parentCtx);
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

    await mock.createTask( { subject: "Completed blocker", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Blocked pending", description: "Desc", metadata: { priority: "high" } }, ctx);
    await mock.createTask( { subject: "In progress", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Open blocker", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Unblocked pending", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "2", addBlockedBy: ["4", "1"] }, ctx);
    await mock.updateTask( { taskId: "3", status: "in_progress" }, ctx);
    await mock.updateTask( { taskId: "1", status: "completed" }, ctx);

    const list = await mock.executeTool("task_list", {}, ctx);
    const get = await mock.taskDetail("2", ctx);

    expect(list.content[0].text).toBe([
      "#1 [completed] Completed blocker · 0s",
      "#2 [pending] Blocked pending [blocked by #4]",
      "#3 [in_progress] In progress · 0s",
      "#4 [pending] Open blocker",
      "#5 [pending] Unblocked pending",
    ].join("\n"));
    expect(get.content[0].text).toContain("Task #2: Blocked pending");
    expect(get.content[0].text).toContain("description: Desc");
    expect(get.content[0].text).toContain("blocked by: #4");
    expect(get.content[0].text).toContain('metadata: {"priority":"high"}');
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

    const created = await mock.createTask( { subject: "One", description: "Desc" }, ctx);
    const missingGet = await mock.taskDetail("99", ctx);
    const missingUpdate = await mock.updateTask( { taskId: "99", status: "completed" }, ctx);
    const warned = await mock.updateTask( { taskId: "1", addBlockedBy: ["1", "999"] }, ctx);

    expect(created.content[0].text).toBe("Created #1: One");
    expect(missingGet.content[0].text).toBe("Task #99 not found");
    expect(missingUpdate.content[0].text).toBe("task_write failed: operation 1 update task #99 not found\nNo changes were committed.");
    expect(warned.content[0].text).toBe("Updated #1: blockedBy\nWarning #1: #1 blocks itself\nWarning #1: #999 does not exist");

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

      await mock.createTask( { subject: "Instrumented", description: "Desc" }, ctx);
      await mock.updateTask( { taskId: "1", status: "in_progress" }, ctx);

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(5_000);
      await mock.fireLifecycle("tool_execution_end", { toolName: "bash", toolCallId: "call-2", result: {}, isError: false }, ctx);
      await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 30 } } }, ctx);
      vi.advanceTimersByTime(15_000);
      await mock.fireLifecycle("agent_end", {}, ctx);
      await mock.updateTask( { taskId: "1", status: "completed" }, ctx);

      const get = await mock.taskDetail("1", ctx);
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
        activeMs: 20_000,
        toolUseCount: 1,
        outputTokens: 30,
        lastToolName: "bash",
        lastToolAt: new Date("2026-04-15T12:00:05.000Z").getTime(),
      });
      expect(raw.metadata.stats.activeSince).toBeUndefined();
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("binds the session store before attributing an agent span", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T12:30:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-agent-start-store-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      writeTaskFile(storePath, "1", {
        id: "1",
        subject: "Already active",
        description: "Desc",
        status: "in_progress",
        metadata: { stats: { activeMs: 0 } },
        blocks: [],
        blockedBy: [],
        createdAt: t0,
        updatedAt: t0,
      });

      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(3_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats.activeMs).toBe(3_000);
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

    await mock.createTask( { subject: "Subagents", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "1", status: "in_progress" }, ctx);

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

    const get = await mock.taskDetail("1", ctx);
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

    await mock.createTask( { subject: "One", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Two", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "1", status: "deleted" }, ctx);
    const created = await mock.createTask( { subject: "Three", description: "Desc" }, ctx);

    expect(created.content[0].text).toContain("Created #3: Three");
    expect(existsSync(join(storePath, "1.json"))).toBe(false);
    expect(existsSync(join(storePath, "3.json"))).toBe(true);

    cleanupStore(storePath);
  });

  it("applies task_write atomically and returns per-operation results", async () => {
    const sessionId = `todo-write-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    await mock.createTask( { subject: "Existing", description: "Desc" }, ctx);

    const result = await mock.executeTool(
      "task_write",
      {
        operations: [
          { action: "create", subject: "Batch create", description: "Desc", status: "in_progress" },
          { action: "update", taskId: "1", status: "in_progress" },
          { action: "update", taskId: "2", addBlockedBy: ["1", "999"] },
        ],
      },
      ctx,
    );

    expect(result.content[0].text).toBe([
      "Created #2: Batch create",
      "Updated #1: status",
      "Updated #2: blockedBy",
      "Warning #2: #999 does not exist",
    ].join("\n"));
    expect(readTaskFile(storePath, "1").status).toBe("in_progress");
    expect(readTaskFile(storePath, "2")).toMatchObject({
      status: "in_progress",
      blockedBy: ["1", "999"],
      metadata: { stats: { startedAt: expect.any(Number) } },
    });

    cleanupStore(storePath);
  });

  it("rolls back task_write when one operation fails", async () => {
    const sessionId = `todo-write-fail-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    await mock.createTask( { subject: "Existing", description: "Desc" }, ctx);

    const result = await mock.executeTool(
      "task_write",
      {
        operations: [
          { action: "create", subject: "Should not persist", description: "Desc" },
          { action: "update", taskId: "99", status: "completed" },
        ],
      },
      ctx,
    );

    expect(result.content[0].text).toBe("task_write failed: operation 2 update task #99 not found\nNo changes were committed.");
    expect(existsSync(join(storePath, "2.json"))).toBe(false);

    const list = await mock.executeTool("task_list", {}, ctx);
    expect(list.content[0].text).toBe("#1 [pending] Existing");

    cleanupStore(storePath);
  });

  it("auto-wraps a single flat task_write operation", async () => {
    const sessionId = `todo-write-autowrap-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    const result = await mock.executeToolThroughValidation("task_write", { action: "create", subject: "Flat", description: "Desc" }, ctx);

    expect(result.content[0].text).toBe("Created #1: Flat");
    expect(readTaskFile(storePath, "1").subject).toBe("Flat");

    cleanupStore(storePath);
  });

  it("returns teaching errors for invalid task_write shapes", async () => {
    const sessionId = `todo-write-errors-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    const missingAction = await mock.executeToolThroughValidation("task_write", { operations: [{ taskId: "1", status: "completed" }] }, ctx);
    const missingCreateFields = await mock.executeToolThroughValidation("task_write", { operations: [{ action: "create", subject: "Only subject" }] }, ctx);
    const missingBothFields = await mock.executeToolThroughValidation("task_write", { operations: [{ action: "create", status: "pending" }] }, ctx);
    const missingTaskId = await mock.executeToolThroughValidation("task_write", { operations: [{ action: "update", status: "completed" }] }, ctx);
    const unknownAction = mock.executeToolThroughValidation("task_write", { operations: [{ action: "finish", taskId: "1" }] }, ctx);
    const invalidStatus = mock.executeToolThroughValidation("task_write", { operations: [{ action: "update", taskId: "1", status: "done" }] }, ctx);
    const directUnknownAction = await mock.executeTool("task_write", { operations: [{ action: "finish", taskId: "1" }] }, ctx);
    const directInvalidStatus = await mock.executeTool("task_write", { operations: [{ action: "update", taskId: "1", status: "done" }] }, ctx);
    const emptyOps = await mock.executeToolThroughValidation("task_write", { operations: [] }, ctx);

    expect(emptyOps.content[0].text).toContain("operations must be a non-empty array");
    expect(missingAction.content[0].text).toContain("requires action");
    expect(missingCreateFields.content[0].text).toContain("create requires description");
    expect(missingBothFields.content[0].text).toContain("create requires subject and description");
    expect(missingCreateFields.content[0].text).toContain('expected: {"operations":[{"action":"create","subject":"...","description":"..."}]}');
    expect(missingTaskId.content[0].text).toContain("update requires taskId");
    expect(missingTaskId.content[0].text).toContain('expected: {"operations":[{"action":"update","taskId":"1","status":"completed"}]}');
    await expect(unknownAction).rejects.toThrow("operations.0.action: must be equal to one of the allowed values");
    await expect(invalidStatus).rejects.toThrow("operations.0.status: must be equal to one of the allowed values");
    expect(directUnknownAction.content[0].text).toContain("unknown action");
    expect(directUnknownAction.content[0].text).toContain('expected: {"operations":[{"action":"update","taskId":"1","status":"completed"}]}');
    expect(directInvalidStatus.content[0].text).toContain("invalid status");
    expect(directInvalidStatus.content[0].text).toContain('expected: {"operations":[{"action":"update","taskId":"1","status":"completed"}]}');
    expect(existsSync(join(storePath, "1.json"))).toBe(false);

    cleanupStore(storePath);
  });

  it("rejects create dependencies instead of silently dropping them", async () => {
    const sessionId = `todo-write-create-dependencies-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    const result = await mock.executeToolThroughValidation(
      "task_write",
      { operations: [{ action: "create", subject: "Blocked", description: "Desc", addBlockedBy: ["99"] }] },
      ctx,
    );

    expect(result.content[0].text).toContain("create cannot use addBlockedBy");
    expect(result.content[0].text).toContain('expected: {"operations":[{"action":"create","subject":"...","description":"..."}]}');
    expect(existsSync(join(storePath, "1.json"))).toBe(false);

    cleanupStore(storePath);
  });

  it("rolls back task_write when handler validation rejects one operation", async () => {
    const sessionId = `todo-write-validation-fail-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    const result = await mock.executeTool(
      "task_write",
      {
        operations: [
          { action: "create", subject: "Should not persist", description: "Desc" },
          { action: "update", status: "completed" },
        ],
      },
      ctx,
    );

    expect(result.content[0].text).toContain("update requires taskId");
    expect(existsSync(join(storePath, "1.json"))).toBe(false);

    cleanupStore(storePath);
  });

  it("matches equivalent granular updates after task_write commits", async () => {
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
    await writeMock.createTask( { subject: "First", description: "Desc" }, writeCtx);
    await writeMock.createTask( { subject: "Second", description: "Desc" }, writeCtx);
    await writeMock.executeTool(
      "task_write",
      {
        operations: [
          { action: "update", taskId: "1", status: "in_progress" },
          { action: "update", taskId: "2", addBlockedBy: ["1"] },
          { action: "create", subject: "Third", description: "Desc" },
        ],
      },
      writeCtx,
    );
    const writeList = await writeMock.executeTool("task_list", {}, writeCtx);

    const granularMock = mockPi();
    const granularCtx = mockCtx(granularSessionId);
    initExtension(granularMock.pi as any);
    await granularMock.fireLifecycle("before_agent_start", {}, granularCtx);
    await granularMock.createTask( { subject: "First", description: "Desc" }, granularCtx);
    await granularMock.createTask( { subject: "Second", description: "Desc" }, granularCtx);
    await granularMock.updateTask( { taskId: "1", status: "in_progress" }, granularCtx);
    await granularMock.updateTask( { taskId: "2", addBlockedBy: ["1"] }, granularCtx);
    await granularMock.createTask( { subject: "Third", description: "Desc" }, granularCtx);
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

    await mock.createTask( { subject: "Completed blocker", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Blocked pending", description: "Desc" }, ctx);
    await mock.createTask( { subject: "In progress", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Open blocker", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Unblocked pending", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "2", addBlockedBy: ["4", "1"] }, ctx);
    await mock.updateTask( { taskId: "3", status: "in_progress" }, ctx);
    await mock.updateTask( { taskId: "1", status: "completed" }, ctx);
    expect(ctx.widgetSetCalls.get("tasks")).toBe(1);

    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "4 open · 1 completed (0s) · Ctrl+Alt+T to cycle",
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
        await mock.createTask( { subject: `Old done ${i}`, description: "Desc", status: "completed" }, ctx);
      }
      vi.advanceTimersByTime(31_000);
      await mock.createTask( { subject: "Current", description: "Desc", status: "in_progress" }, ctx);
      await mock.createTask( { subject: "Next", description: "Desc" }, ctx);

      await mock.executeCommand("tasks", "all", ctx);

      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "2 open · 18 completed (0s) · Ctrl+Alt+T to cycle",
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

  it("dims completed task lines and strikes through only the completed title in the All widget view", async () => {
    const sessionId = `todo-widget-completed-title-style-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    ctx.ui.theme = {
      ...ctx.ui.theme,
      fg(color: string, text: string) {
        return color === "muted" ? `[dim:${text}]` : text;
      },
      strikethrough(text: string) {
        return `[strike:${text}]`;
      },
    };
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    await mock.createTask( { subject: "Done title", description: "Desc", status: "completed" }, ctx);
    await mock.createTask( { subject: "Open title", description: "Desc" }, ctx);
    await mock.executeCommand("tasks", "all", ctx);

    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "[dim:1 open · 1 completed (0s)] · Ctrl+Alt+T to cycle",
      "○ #2 Open title",
      "[dim:✓ #1 [strike:[dim:Done title]] [dim:· 0s]]",
    ]));

    cleanupStore(storePath);
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
        await mock.createTask( { subject: `Old done ${i}`, description: "Desc", status: "completed" }, ctx);
      }
      vi.advanceTimersByTime(31_000);
      await mock.createTask( { subject: "Current", description: "Desc", status: "in_progress" }, ctx);
      await mock.createTask( { subject: "Next", description: "Desc" }, ctx);

      await mock.executeCommand("tasks", "all", ctx);

      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "2 open · 18 completed (0s) · Ctrl+Alt+T to cycle",
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

    await mock.createTask( { subject: "Done", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Open", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "1", status: "completed" }, ctx);

    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "1 open · 1 completed (0s) · Ctrl+Alt+T to cycle",
      "○ #2 Open",
    ]));

    await mock.executeShortcut("ctrl+alt+t", ctx);
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "1 open · 1 completed (0s) · Ctrl+Alt+T to cycle",
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
    await mock.createTask( {
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
      await mock.createTask( { subject: "Done", description: "Desc", status: "completed" }, ctx);

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

      await mock.createTask( { subject: "Pending", description: "Desc" }, ctx);
      const pendingRenders = ctx.widgetRenderCalls.get("tasks");
      vi.advanceTimersByTime(3_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(pendingRenders);

      await mock.updateTask( { taskId: "1", status: "in_progress" }, ctx);
      const inProgressRenders = ctx.widgetRenderCalls.get("tasks") ?? 0;
      vi.advanceTimersByTime(1_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(inProgressRenders + 1);

      await mock.updateTask( { taskId: "1", status: "completed" }, ctx);
      const completedRenders = ctx.widgetRenderCalls.get("tasks");
      vi.advanceTimersByTime(3_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(completedRenders);
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("accrues concurrent in-progress tasks from one batch across live renders and persistence", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T12:45:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-widget-concurrent-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      await mock.executeTool(
        "task_write",
        {
          operations: [
            { action: "create", subject: "First", description: "Desc", status: "in_progress" },
            { action: "create", subject: "Second", description: "Desc", status: "in_progress" },
          ],
        },
        ctx,
      );

      await mock.fireLifecycle("agent_start", {}, ctx);
      const rendersAtStart = ctx.widgetRenderCalls.get("tasks") ?? 0;
      vi.advanceTimersByTime(1_000);
      expect(ctx.widgetRenderCalls.get("tasks")).toBe(rendersAtStart + 1);

      vi.advanceTimersByTime(9_000);
      const liveLines = (ctx.widgets.get("tasks") ?? []).join("\n");
      expect(liveLines).toContain("▶ #1 First · 10s");
      expect(liveLines).toContain("▶ #2 Second · 10s");

      await mock.fireLifecycle("tool_execution_end", { toolName: "bash", result: {}, isError: false }, ctx);
      await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 7 } } }, ctx);
      await mock.fireLifecycle("agent_end", {}, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats).toMatchObject({
        activeMs: 10_000,
        toolUseCount: 1,
        outputTokens: 7,
      });
      expect(readTaskFile(storePath, "2").metadata.stats).toMatchObject({ activeMs: 10_000 });
      expect(readTaskFile(storePath, "2").metadata.stats.toolUseCount).toBeUndefined();
      expect(readTaskFile(storePath, "2").metadata.stats.outputTokens).toBeUndefined();

      vi.advanceTimersByTime(30_000);
      const idleLines = (ctx.widgets.get("tasks") ?? []).join("\n");
      expect(idleLines).toContain("▶ #1 First · 10s");
      expect(idleLines).toContain("▶ #2 Second · 10s");
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("stops only changed tasks in a concurrent span", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T12:50:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-span-membership-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.executeTool(
        "task_write",
        {
          operations: [
            { action: "create", subject: "Complete", description: "Desc", status: "in_progress" },
            { action: "create", subject: "Pause", description: "Desc", status: "in_progress" },
            { action: "create", subject: "Delete", description: "Desc", status: "in_progress" },
            { action: "create", subject: "Survive", description: "Desc", status: "in_progress" },
          ],
        },
        ctx,
      );

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(4_000);
      await mock.updateTask({ taskId: "1", status: "completed" }, ctx);
      await mock.updateTask({ taskId: "2", status: "pending" }, ctx);
      await mock.updateTask({ taskId: "3", status: "deleted" }, ctx);
      vi.advanceTimersByTime(6_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats).toMatchObject({ activeMs: 4_000 });
      expect(readTaskFile(storePath, "2").metadata.stats).toMatchObject({ activeMs: 4_000 });
      expect(readTaskFile(storePath, "4").metadata.stats).toMatchObject({ activeMs: 10_000 });
      expect(readTaskFile(storePath, "1").metadata.stats.activeSince).toBeUndefined();
      expect(readTaskFile(storePath, "2").metadata.stats.activeSince).toBeUndefined();
      expect(readTaskFile(storePath, "4").metadata.stats.activeSince).toBeUndefined();
      expect(existsSync(join(storePath, "3.json"))).toBe(false);
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
      await mock.createTask( { subject: "Live", description: "Desc" }, ctx);
      await mock.updateTask( { taskId: "1", status: "in_progress" }, ctx);

      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "1 open · 0 completed · Ctrl+Alt+T to cycle",
        "▶ #1 Live · 0s",
      ]));

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(2_000);
      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "1 open · 0 completed · Ctrl+Alt+T to cycle",
        "▶ #1 Live · 2s",
      ]));

      await mock.fireLifecycle("message_end", { message: { role: "assistant", usage: { output: 18 } } }, ctx);
      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "1 open · 0 completed · Ctrl+Alt+T to cycle",
        "▶ #1 Live · 2s · 18 tokens",
      ]));

      vi.advanceTimersByTime(36_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      vi.advanceTimersByTime(3_600_000);
      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "1 open · 0 completed · Ctrl+Alt+T to cycle",
        "▶ #1 Live · 38s · 18 tokens",
      ]));

      await mock.updateTask( { taskId: "1", status: "completed" }, ctx);
      await mock.createTask( { subject: "Second", description: "Desc", status: "in_progress" }, ctx);
      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(62_000);
      await mock.fireLifecycle("agent_end", {}, ctx);
      await mock.updateTask( { taskId: "2", status: "completed" }, ctx);
      expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
        "Tasks",
        "0 open · 2 completed (1m 40s) · Ctrl+Alt+T to cycle",
        "No open tasks",
      ]));
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("preserves active runtime when a completed task is moved back to pending", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T13:30:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-reopen-active-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.createTask( { subject: "Reopen", description: "Desc" }, ctx);
      await mock.updateTask( { taskId: "1", status: "in_progress" }, ctx);
      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(7_000);
      await mock.fireLifecycle("agent_end", {}, ctx);
      await mock.updateTask( { taskId: "1", status: "completed" }, ctx);
      await mock.updateTask( { taskId: "1", status: "pending" }, ctx);

      const raw = readTaskFile(storePath, "1");
      expect(raw.status).toBe("pending");
      expect(raw.metadata.stats).toMatchObject({ activeMs: 7_000 });
      expect(raw.metadata.stats.completedAt).toBeUndefined();
      expect((await mock.taskDetail("1", ctx)).content[0].text).toContain("runtime: 7s");
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("keeps in-progress stats when moving an unfinished task to pending", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T13:40:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-pending-active-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.createTask( { subject: "Unfinished", description: "Desc" }, ctx);
      await mock.updateTask( { taskId: "1", status: "in_progress" }, ctx);
      await mock.updateTask( { taskId: "1", status: "pending" }, ctx);

      const raw = readTaskFile(storePath, "1");
      expect(raw.status).toBe("pending");
      expect(raw.metadata.stats).toMatchObject({
        startedAt: t0,
        activeMs: 0,
      });
      expect(raw.metadata.stats.completedAt).toBeUndefined();
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("does not create lifecycle stats for a pending task with no runtime history", async () => {
    const sessionId = `todo-pending-without-stats-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.createTask( { subject: "Still pending", description: "Desc" }, ctx);
      await mock.updateTask( { taskId: "1", status: "pending" }, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats).toBeUndefined();
    } finally {
      cleanupStore(storePath);
    }
  });

  it("keeps legacy wall-clock fallback for tasks without active-time stats", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-15T13:45:00.000Z").getTime();
    vi.setSystemTime(now);

    const sessionId = `todo-legacy-runtime-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      writeTaskFile(storePath, "1", {
        id: "1",
        subject: "Legacy completed",
        description: "Desc",
        status: "completed",
        metadata: { stats: { startedAt: now - 20_000, completedAt: now } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 20_000,
        updatedAt: now,
      });
      writeTaskFile(storePath, "2", {
        id: "2",
        subject: "Legacy active",
        description: "Desc",
        status: "in_progress",
        metadata: { stats: { startedAt: now - 10_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 10_000,
        updatedAt: now - 10_000,
      });
      writeTaskFile(storePath, "3", {
        id: "3",
        subject: "Legacy pending",
        description: "Desc",
        status: "pending",
        metadata: { stats: { startedAt: now - 10_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 10_000,
        updatedAt: now - 10_000,
      });

      expect((await mock.taskDetail("1", ctx)).content[0].text).toContain("time to complete: 20s");
      expect((await mock.taskDetail("2", ctx)).content[0].text).toContain("runtime: 10s");
      expect((await mock.taskDetail("3", ctx)).content[0].text).not.toContain("runtime:");
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("starts legacy active tasks with zero accumulated runtime", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T13:55:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-legacy-active-span-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      writeTaskFile(storePath, "1", {
        id: "1",
        subject: "Legacy active",
        description: "Desc",
        status: "in_progress",
        metadata: { stats: { startedAt: t0 - 10_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: t0 - 10_000,
        updatedAt: t0 - 10_000,
      });

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(2_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      const raw = readTaskFile(storePath, "1");
      expect(raw.metadata.stats).toMatchObject({ activeMs: 2_000 });
      expect(raw.metadata.stats.activeSince).toBeUndefined();
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("ignores duplicate agent lifecycle events after one span is open or closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:00:00.000Z"));

    const sessionId = `todo-duplicate-agent-events-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.createTask( { subject: "Single span", description: "Desc", status: "in_progress" }, ctx);

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(2_000);
      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(5_000);
      await mock.fireLifecycle("agent_end", {}, ctx);
      await mock.fireLifecycle("agent_end", {}, ctx);

      const raw = readTaskFile(storePath, "1");
      expect(raw.metadata.stats.activeMs).toBe(7_000);
      expect(raw.metadata.stats.activeSince).toBeUndefined();
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("closes concurrent open spans during session shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:15:00.000Z"));

    const sessionId = `todo-shutdown-active-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.executeTool(
        "task_write",
        {
          operations: [
            { action: "create", subject: "Shutdown first", description: "Desc", status: "in_progress" },
            { action: "create", subject: "Shutdown second", description: "Desc", status: "in_progress" },
          ],
        },
        ctx,
      );

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(9_000);
      await mock.fireLifecycle("session_shutdown", {}, ctx);

      for (const taskId of ["1", "2"]) {
        const raw = readTaskFile(storePath, taskId);
        expect(raw.metadata.stats.activeMs).toBe(9_000);
        expect(raw.metadata.stats.activeSince).toBeUndefined();
      }
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("recovers dangling active spans from a crash and freezes legacy idle timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:00:00.000Z"));

    const sessionId = `todo-active-recovery-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const now = Date.now();
      writeTaskFile(storePath, "1", {
        id: "1",
        subject: "Crashed",
        description: "Desc",
        status: "in_progress",
        metadata: { stats: { startedAt: now - 3_600_000, activeMs: 5_000, activeSince: now - 30_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 3_600_000,
        updatedAt: now - 30_000,
      });
      writeTaskFile(storePath, "2", {
        id: "2",
        subject: "Legacy",
        description: "Desc",
        status: "in_progress",
        metadata: { stats: { startedAt: now - 7_200_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 7_200_000,
        updatedAt: now - 7_200_000,
      });

      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      const crashed = readTaskFile(storePath, "1");
      expect(crashed.metadata.stats.activeSince).toBeUndefined();
      expect(crashed.metadata.stats.activeMs).toBe(5_000);

      const legacy = readTaskFile(storePath, "2");
      expect(legacy.metadata.stats.activeMs).toBe(0);

      vi.advanceTimersByTime(3_600_000);
      const lines = (ctx.widgets.get("tasks") ?? []).join("\n");
      expect(lines).toContain("▶ #1 Crashed · 5s");
      expect(lines).toContain("▶ #2 Legacy · 0s");
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("does not seed active runtime on completed or pending legacy tasks", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-15T14:30:00.000Z").getTime();
    vi.setSystemTime(now);

    const sessionId = `todo-active-recovery-statuses-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      writeTaskFile(storePath, "1", {
        id: "1",
        subject: "Pending legacy",
        description: "Desc",
        status: "pending",
        metadata: { stats: { startedAt: now - 20_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 20_000,
        updatedAt: now - 20_000,
      });
      writeTaskFile(storePath, "2", {
        id: "2",
        subject: "Completed legacy",
        description: "Desc",
        status: "completed",
        metadata: { stats: { startedAt: now - 20_000, completedAt: now - 5_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 20_000,
        updatedAt: now - 5_000,
      });

      const mock = mockPi();
      const ctx = mockCtx(sessionId);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats.activeMs).toBeUndefined();
      expect(readTaskFile(storePath, "2").metadata.stats.activeMs).toBeUndefined();
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("attributes a mid-run task only from the moment it became active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T15:00:00.000Z"));

    const sessionId = `todo-unattributed-span-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(30_000);
      await mock.createTask( { subject: "Late", description: "Desc", status: "in_progress" }, ctx);
      vi.advanceTimersByTime(10_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      const raw = readTaskFile(storePath, "1");
      expect(raw.metadata.stats.activeMs).toBe(10_000);
      expect(raw.metadata.stats.activeSince).toBeUndefined();
      expect((ctx.widgets.get("tasks") ?? []).join("\n")).toContain("▶ #1 Late · 10s");
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("matches an independent attribution ledger across randomized runs", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-16T09:00:00.000Z").getTime();
    let clock = t0;
    vi.setSystemTime(clock);

    const sessionId = `todo-span-oracle-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      // Deterministic PRNG so failures replay exactly.
      let seed = 20260831;
      const rand = (max: number) => {
        seed = (seed * 48271) % 2147483647;
        return seed % max;
      };
      const advance = (ms: number) => {
        clock += ms;
        vi.setSystemTime(clock);
      };

      // Independent ledger implementing the documented contract: every in-progress
      // task accrues at each moment. The aggregate can exceed wall time during overlap.
      const ledger = new Map<string, number>();
      const inProgressByRecency: string[] = [];
      const inProgressIds = new Set<string>();
      const pendingIds: string[] = [];
      let windowStart: number | undefined;
      let maxConcurrent = 0;
      let overlappedMs = 0;
      const bank = () => {
        if (windowStart === undefined) return;
        const elapsed = clock - windowStart;
        if (inProgressIds.size > 1) overlappedMs += elapsed;
        for (const id of inProgressIds) ledger.set(id, (ledger.get(id) ?? 0) + elapsed);
      };
      const beginWindow = () => {
        windowStart = clock;
      };
      const write = async (id: string, status: "in_progress" | "completed") => {
        bank();
        if (status === "in_progress") {
          const pendingIndex = pendingIds.indexOf(id);
          if (pendingIndex >= 0) pendingIds.splice(pendingIndex, 1);
          const openIndex = inProgressByRecency.indexOf(id);
          if (openIndex >= 0) inProgressByRecency.splice(openIndex, 1);
          inProgressByRecency.push(id);
          inProgressIds.add(id);
          maxConcurrent = Math.max(maxConcurrent, inProgressIds.size);
        } else {
          const openIndex = inProgressByRecency.indexOf(id);
          if (openIndex >= 0) inProgressByRecency.splice(openIndex, 1);
          inProgressIds.delete(id);
        }
        await mock.updateTask( { taskId: id, status }, ctx);
        beginWindow();
      };

      let nextId = 1;
      for (let run = 0; run < 25; run++) {
        await mock.fireLifecycle("agent_start", {}, ctx);
        beginWindow();
        const steps = 1 + rand(4);
        for (let step = 0; step < steps; step++) {
          advance(1_000 + rand(8_000));
          const choice = rand(6);
          if (choice === 0 && nextId <= 12) {
            const asInProgress = inProgressByRecency.length < 2 && rand(2) === 1;
            const id = String(nextId++);
            bank();
            await mock.createTask(
              asInProgress
                ? { subject: `T${id}`, description: "Desc", status: "in_progress" }
                : { subject: `T${id}`, description: "Desc" },
              ctx,
            );
            if (asInProgress) {
              inProgressByRecency.push(id);
              inProgressIds.add(id);
              maxConcurrent = Math.max(maxConcurrent, inProgressIds.size);
            } else pendingIds.push(id);
            beginWindow();
          } else if (choice === 1 && inProgressByRecency.length > 0) {
            await write(inProgressByRecency[inProgressByRecency.length - 1], "completed");
          } else if (choice === 2 && inProgressByRecency.length === 2) {
            await write(inProgressByRecency[0], "completed");
          } else if (choice === 3 && pendingIds.length > 0) {
            await write(pendingIds[rand(pendingIds.length)], "in_progress");
          }
        }
        advance(1_000 + rand(5_000));
        await mock.fireLifecycle("agent_end", {}, ctx);
        bank();
        windowStart = undefined;
      }

      for (let id = 1; id < nextId; id++) {
        const raw = readTaskFile(storePath, String(id));
        expect(raw.metadata.stats?.activeMs ?? 0).toBe(ledger.get(String(id)) ?? 0);
      }
      const ledgerTotal = [...ledger.values()].reduce((total, ms) => total + ms, 0);
      expect(ledgerTotal).toBeGreaterThan(0);
      expect(maxConcurrent).toBeGreaterThan(1);
      expect(overlappedMs).toBeGreaterThan(0);
      expect(ledgerTotal).toBeLessThanOrEqual((clock - t0) * maxConcurrent);
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("credits sequential in-progress tasks without charging gaps", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T18:00:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-span-split-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      // One long run: plan, then work two tasks back to back without overlap.
      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(10_000);
      await mock.createTask( { subject: "First", description: "Desc", status: "in_progress" }, ctx);
      vi.advanceTimersByTime(30_000);
      await mock.updateTask( { taskId: "1", status: "completed" }, ctx);
      await mock.createTask( { subject: "Second", description: "Desc", status: "in_progress" }, ctx);
      vi.advanceTimersByTime(20_000);
      await mock.updateTask( { taskId: "2", status: "completed" }, ctx);
      vi.advanceTimersByTime(5_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats.activeMs).toBe(30_000);
      expect(readTaskFile(storePath, "2").metadata.stats.activeMs).toBe(20_000);

      // Next run: task active at open, switched mid-run.
      await mock.createTask( { subject: "Third", description: "Desc", status: "in_progress" }, ctx);
      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(8_000);
      await mock.updateTask( { taskId: "3", status: "completed" }, ctx);
      await mock.createTask( { subject: "Fourth", description: "Desc", status: "in_progress" }, ctx);
      vi.advanceTimersByTime(12_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      expect(readTaskFile(storePath, "3").metadata.stats.activeMs).toBe(8_000);
      expect(readTaskFile(storePath, "4").metadata.stats.activeMs).toBe(12_000);
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("keeps concurrent timing separate from single-owner telemetry recency", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-04-15T16:00:00.000Z").getTime();
    vi.setSystemTime(t0);

    const sessionId = `todo-span-ownership-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      await mock.createTask( { subject: "First", description: "Desc" }, ctx);
      await mock.updateTask( { taskId: "1", status: "in_progress" }, ctx);

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(5_000);
      await mock.createTask( { subject: "Second", description: "Desc", status: "in_progress" }, ctx);
      vi.advanceTimersByTime(5_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      const first = readTaskFile(storePath, "1");
      expect(first.metadata.stats.activeMs).toBe(10_000);
      expect(first.updatedAt).toBe(t0);

      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(8_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats.activeMs).toBe(18_000);
      const second = readTaskFile(storePath, "2");
      expect(second.metadata.stats.activeMs).toBe(13_000);
      expect(second.updatedAt).toBe(t0 + 5_000);
    } finally {
      cleanupStore(storePath);
      vi.useRealTimers();
    }
  });

  it("reconciles dangling spans without changing task recency", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-15T17:00:00.000Z").getTime();
    vi.setSystemTime(now);

    const sessionId = `todo-reconcile-recency-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    try {
      writeTaskFile(storePath, "1", {
        id: "1",
        subject: "Crashed",
        description: "Desc",
        status: "in_progress",
        metadata: { stats: { startedAt: now - 7_200_000, activeMs: 5_000, activeSince: now - 30_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 7_200_000,
        updatedAt: now - 7_200_000,
      });
      writeTaskFile(storePath, "2", {
        id: "2",
        subject: "Current",
        description: "Desc",
        status: "in_progress",
        metadata: { stats: { startedAt: now - 60_000 } },
        blocks: [],
        blockedBy: [],
        createdAt: now - 60_000,
        updatedAt: now - 60_000,
      });

      const mock = mockPi();
      const ctx = mockCtx(sessionId, true);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

      const crashed = readTaskFile(storePath, "1");
      expect(crashed.metadata.stats.activeSince).toBeUndefined();
      expect(crashed.metadata.stats.activeMs).toBe(5_000);
      expect(crashed.updatedAt).toBe(now - 7_200_000);
      const current = readTaskFile(storePath, "2");
      expect(current.metadata.stats.activeMs).toBe(0);
      expect(current.updatedAt).toBe(now - 60_000);

      await mock.fireLifecycle("agent_start", {}, ctx);
      vi.advanceTimersByTime(4_000);
      await mock.fireLifecycle("agent_end", {}, ctx);

      expect(readTaskFile(storePath, "1").metadata.stats.activeMs).toBe(9_000);
      expect(readTaskFile(storePath, "2").metadata.stats.activeMs).toBe(4_000);
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

    await mock.createTask( { subject: "Done", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Open", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Also open", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "1", status: "completed" }, ctx);

    await mock.executeCommand("tasks-clean", "", ctx);
    expect(ctx.confirmCalls).toEqual([
      { title: "Clear completed tasks?", message: "Permanently delete 1 completed task?" },
    ]);
    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe([
      "#1 [completed] Done · 0s",
      "#2 [pending] Open",
      "#3 [pending] Also open",
    ].join("\n"));

    await mock.executeCommand("tasks-clean", "", ctx);
    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe([
      "#2 [pending] Open",
      "#3 [pending] Also open",
    ].join("\n"));
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "2 open · 0 completed · Ctrl+Alt+T to cycle",
      "○ #2 Open",
      "○ #3 Also open",
    ]));

    cleanupStore(storePath);
  });

  it("tasks-clean saves an expandable UI-only checklist of cleared tasks", async () => {
    const sessionId = `task-clean-receipt-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    try {
      await mock.executeTool("task_write", { operations: [
        ...Array.from({ length: 14 }, (_, index) => ({
          action: "create", subject: `Finished ${index + 1}`, description: `Details ${index + 1}`, status: "completed",
        })),
        { action: "create", subject: "Keep working", description: "Do not remove", status: "in_progress" },
      ] }, ctx);
      await mock.executeCommand("tasks-clean", "", ctx);
      expect(mock.entries).toHaveLength(1);
      expect(mock.sentMessages).toEqual([]);
      expect(ctx.notifications).toEqual([]);
      expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toContain("#15 [in_progress] Keep working");
      expect(existsSync(join(storePath, "1.json"))).toBe(false);

      const saved = JSON.parse(JSON.stringify(mock.entries[0]));
      const reloaded = mockPi();
      initExtension(reloaded.pi as any);
      initTheme("dark", false);
      const component = new CustomEntryComponent(
        { ...saved, type: "custom", id: "receipt", parentId: null, timestamp: new Date().toISOString() },
        reloaded.entryRenderers.get(saved.customType),
      );
      for (const name of ["dark", "light"]) {
        initTheme(name, false);
        component.invalidate();
        component.setExpanded(false);
        const ansi = component.render(100).join("\n");
        const text = stripTerminalSequences(ansi);
        expect(ansi).not.toBe(text);
        expect(text).toContain("Cleared 14 completed tasks");
        expect(text).toContain("× #1 Finished 1");
        expect(text).toContain("expand 4 more tasks");
        expect(text).not.toContain("Finished 14");
        expect(text).not.toContain("Keep working");
        expect(text).not.toContain("Details 1");
        component.setExpanded(true);
        const expanded = stripTerminalSequences(component.render(100).join("\n"));
        expect(expanded).toContain("× #14 Finished 14");
        expect(expanded).toContain("description: Details 14");
        for (const line of component.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      }
    } finally {
      await mock.fireLifecycle("session_shutdown", {}, ctx);
      cleanupStore(storePath);
    }
  });

  it("keeps cleanup cancellation and empty states out of the transcript", async () => {
    const sessionId = `task-clean-empty-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    const mock = mockPi();
    const ctx = mockCtx(sessionId, true, { confirmResponses: [false, true] });
    initExtension(mock.pi as any);
    try {
      await mock.executeCommand("tasks-clean", "", ctx);
      expect(ctx.confirmCalls).toEqual([]);
      expect(ctx.notifications.at(-1)?.message).toBe("No completed tasks to clear");
      await mock.createTask({ subject: "Done", description: "Desc", status: "completed" }, ctx);
      await mock.executeCommand("tasks-clean", "", ctx);
      expect(ctx.notifications.at(-1)?.message).toBe("Clear completed cancelled");
      expect(mock.entries).toEqual([]);
      expect(existsSync(join(storePath, "1.json"))).toBe(true);
      await mock.executeCommand("tasks-clean", "", ctx);
      expect(mock.entries).toHaveLength(1);
      const receipt = mock.entries[0];
      const output = mock.entryRenderers.get(receipt.customType)({ data: receipt.data }, { expanded: false }, ctx.ui.theme).render(100).join("\n");
      expect(output).toContain("Cleared 1 completed task");
      expect(output).not.toMatch(/expand/i);
      expect(existsSync(join(storePath, "1.json"))).toBe(false);
      expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe("No tasks found");
    } finally {
      cleanupStore(storePath);
    }
  });

  it("keeps completed tasks on disk across idle turns and session resets", async () => {
    const sessionId = `task-completed-persist-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId, true);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    await mock.createTask( { subject: "Done", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "1", status: "completed" }, ctx);

    for (let turn = 0; turn < 10; turn++) {
      await mock.fireLifecycle("turn_start", {}, ctx);
    }
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe("#1 [completed] Done · 0s");
    expect(existsSync(join(storePath, "1.json"))).toBe(true);
    expect(ctx.widgets.get("tasks")).toEqual(widgetLines([
      "Tasks",
      "0 open · 1 completed (0s) · Ctrl+Alt+T to cycle",
      "No open tasks",
    ]));

    cleanupStore(storePath);
  });

  it("injects a one-time empty-list nudge on the first context event", async () => {
    const sessionId = `todo-empty-nudge-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.fireLifecycle("turn_start", {}, ctx);

    const [nudge] = await mock.fireLifecycle("context", { messages: [] }, ctx);
    expect(nudge?.messages).toHaveLength(1);
    expect(nudge.messages[0].role).toBe("user");
    expect(nudge.messages[0].content).toContain("The task list is empty");
    expect(nudge.messages[0].content).toContain("your FIRST tool call must be task_write");
    expect(nudge.messages[0].content).toContain('{"operations":[{"action":"create","subject":"...","description":"..."}]}');
    expect(nudge.messages[0].content).toContain("more than one thing in a single prompt");
    expect(nudge.messages[0].content).toContain("review, audit, debugging pass, or research pass");
    expect(nudge.messages[0].content).toContain("NEVER mention this reminder");

    expect(await mock.fireLifecycle("context", { messages: [] }, ctx)).toEqual([undefined]);

    cleanupStore(storePath);
  });

  it("skips the empty-list nudge when tasks already exist", async () => {
    const sessionId = `todo-empty-nudge-skip-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.createTask( { subject: "Open", description: "Desc" }, ctx);
    await mock.fireLifecycle("turn_start", {}, ctx);

    expect(await mock.fireLifecycle("context", { messages: [] }, ctx)).toEqual([undefined]);

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
    await mock.createTask( { subject: "Open", description: "Desc" }, ctx);
    await mock.createTask( { subject: "Done", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "2", status: "completed" }, ctx);

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
    expect(firstReminder.messages[0].content).toContain("use task_write when the work is worth tracking");
    expect(firstReminder.messages[0].content).toContain("batching multiple task writes into one call");
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
    await mock.createTask( { subject: "Open", description: "Desc" }, ctx);

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
    await mock.createTask( { subject: "Done", description: "Desc" }, ctx);
    await mock.updateTask( { taskId: "1", status: "completed" }, ctx);

    for (let turn = 0; turn < 10; turn++) {
      await mock.fireLifecycle("turn_start", {}, ctx);
    }

    expect(await mock.fireLifecycle("context", { messages: [] }, ctx)).toEqual([undefined]);
    expect((await mock.executeTool("task_list", {}, ctx)).content[0].text).toBe("#1 [completed] Done · 0s");

    cleanupStore(storePath);
  });

  it("re-nudges with the create shape when the list stays truly empty past the interval", async () => {
    const sessionId = `todo-reminder-empty-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);

    // First context event consumes the one-time full empty-list nudge.
    const [oneTime] = await mock.fireLifecycle("context", { messages: [] }, ctx);
    expect(oneTime.messages[0].content).toContain("The task list is empty");

    for (let turn = 0; turn < 9; turn++) await mock.fireLifecycle("turn_start", {}, ctx);
    expect(await mock.fireLifecycle("context", { messages: [] }, ctx)).toEqual([undefined]);

    await mock.fireLifecycle("turn_start", {}, ctx);
    const [reNudge] = await mock.fireLifecycle("context", { messages: [] }, ctx);
    expect(reNudge?.messages).toHaveLength(1);
    expect(reNudge.messages[0].content).toContain("still empty several steps into this work");
    expect(reNudge.messages[0].content).toContain('{"operations":[{"action":"create","subject":"...","description":"..."}]}');

    cleanupStore(storePath);
  });

  it("does not let a rejected task_write reset the reminder clock", async () => {
    const sessionId = `todo-reminder-failed-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.createTask({ subject: "Open", description: "Desc" }, ctx);

    for (let turn = 0; turn < 9; turn++) await mock.fireLifecycle("turn_start", {}, ctx);

    // Malformed create is rejected with a teaching error; it must NOT count as recent use.
    const failed = await mock.executeTool("task_write", { operations: [{ action: "create", subject: "only subject" }] }, ctx);
    expect(failed.content[0].text).toContain("task_write failed");

    await mock.fireLifecycle("turn_start", {}, ctx);
    const [reminder] = await mock.fireLifecycle("context", { messages: [] }, ctx);
    expect(reminder?.messages).toHaveLength(1);
    expect(reminder.messages[0].content).toContain("#1 [pending] Open");

    cleanupStore(storePath);
  });

  it("tightens the reminder interval to 5 turns under context pressure", async () => {
    const sessionId = `todo-reminder-pressure-${Date.now()}`;
    const storePath = getSessionTaskDirPath(sessionId);
    cleanupStore(storePath);

    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.createTask({ subject: "Open", description: "Desc" }, ctx);

    const heavy = [{ role: "user", content: "x".repeat(200001) }];
    for (let turn = 0; turn < 4; turn++) await mock.fireLifecycle("turn_start", {}, ctx);
    expect(await mock.fireLifecycle("context", { messages: heavy }, ctx)).toEqual([undefined]);

    await mock.fireLifecycle("turn_start", {}, ctx);
    const [reminder] = await mock.fireLifecycle("context", { messages: heavy }, ctx);
    expect(reminder?.messages).toHaveLength(2);
    expect(reminder.messages[1].content).toContain("#1 [pending] Open");

    cleanupStore(storePath);
  });
});
