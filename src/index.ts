import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  compareTaskIds,
  copyTaskStore,
  getSessionTaskDirPath,
  getSessionTaskSnapshotDirPath,
  restoreTaskStoreSnapshot,
  snapshotTaskStore,
  type TaskBatchResult,
  TaskStore,
} from "./task-store.js";
import type { Task } from "./task-types.js";

const TASK_MANAGEMENT_TOOL_NAMES = new Set(["task_write"]);
const TASK_TELEMETRY_EXCLUDED_TOOL_NAMES = new Set([...TASK_MANAGEMENT_TOOL_NAMES, "task_list"]);
const TASK_WIDGET_KEY = "tasks";
const TASK_WIDGET_SHORTCUT = Key.ctrlAlt("t");
const REMINDER_INTERVAL = 10;
const STATS_METADATA_KEY = "stats";
const TASK_WIDGET_SETTINGS_KEY = "tasksMode";
const TASK_WIDGET_LEGACY_NAMESPACE = "piTasks";
const TASK_WIDGET_LEGACY_KEY = "widgetView";
const WIDGET_REFRESH_INTERVAL_MS = 1000;
const RECENT_COMPLETED_TTL_MS = 30_000;
const FALLBACK_WIDGET_LINES = 13;
const MIN_WIDGET_LINES = 5;
const MAX_WIDGET_LINES = 18;
const WIDGET_HEIGHT_RATIO = 0.45;
const WIDGET_HORIZONTAL_PADDING = 1;
const DEBUG = !!process.env.PI_TODOS_DEBUG;

type TaskWidgetView = "open" | "all" | "hidden";
type TasksMode = TaskWidgetView | "off";

type TaskUsageStats = {
  outputTokens?: number;
};

type TaskStats = TaskUsageStats & {
  startedAt?: number;
  completedAt?: number;
  toolUseCount?: number;
  lastToolName?: string;
  lastToolAt?: number;
};

type TaskMetadata = Record<string, any>;

type AssistantUsage = {
  output?: number;
};

type TaskWriteOperation = {
  action: "create" | "update" | "delete";
  taskId?: string;
  subject?: string;
  description?: string;
  status?: "pending" | "in_progress" | "completed" | "deleted";
  activeForm?: string;
  metadata?: TaskMetadata;
  addBlocks?: string[];
  addBlockedBy?: string[];
};

type TaskBatchOperation =
  | {
      type: "create";
      subject: string;
      description: string;
      status?: "pending" | "in_progress" | "completed";
      activeForm?: string;
      metadata?: TaskMetadata;
    }
  | {
      type: "update";
      taskId: string;
      status?: "pending" | "in_progress" | "completed" | "deleted";
      subject?: string;
      description?: string;
      activeForm?: string;
      metadata?: TaskMetadata;
      addBlocks?: string[];
      addBlockedBy?: string[];
    }
  | {
      type: "delete";
      taskId: string;
    };

// One home per rule (PRD-0001 / ADR-0001): this policy block owns lifecycle rules and is
// the only always-on system-prompt text; tool descriptions own per-tool contract facts and
// cross-tool routing. Do not restate a rule in more than one channel.
const TASK_SYSTEM_POLICY = [
  "Task workflow guidance:",
  "- Create tasks with task_write for multi-step or multi-part work, including reviews, audits, debugging, and research passes that span multiple files; also when you generate follow-up steps while working that should not be lost. Skip for a single trivial action.",
  "- Capture or revise the task list early once the work has become multi-step.",
  "- Mark a task in_progress before substantial work starts.",
  "- Mark a task completed only when the work is fully done; if it is partial, blocked, or failing verification, leave it pending or in_progress.",
  "- After completing a task, call task_list to pick the next ready item; prefer lower task IDs when equally ready.",
  "- Use task_list to refresh stale details before updating a task whose latest state may have changed.",
  "- Keep shared task-list writes in one task_write call instead of parallel task_write calls; when subagents help execute work, the parent agent owns the canonical task list.",
].join("\n");

const TASK_WRITE_DESCRIPTION =
  'Create/update/delete tasks atomically; use task_list for reads. Example: {"operations":[{"action":"create","subject":"S","description":"D"}]}';

const TASK_LIST_DESCRIPTION = "List all tasks, or pass taskId for full details before a write.";

const TASK_WRITE_SNIPPET = "Create, update, or delete tasks atomically";
const TASK_LIST_SNIPPET = "List tasks or read one task's details";

const EMPTY_LIST_REMINDER = [
  "<system-reminder>",
  "The task list is empty. Before your first tool call, decide whether this request qualifies; if it does, your FIRST tool call must be task_write to create the task list.",
  "It qualifies when any of these hold:",
  "- The work needs multiple actions over the conversation.",
  "- The user asked for more than one thing in a single prompt.",
  "- A review, audit, debugging pass, or research pass requires inspecting multiple files or steps.",
  "- Sequencing or dependencies matter because one step must wait for another.",
  "Skip task tools only for a single trivial action you can complete immediately.",
  "Example subjects \u2014 Good: Reproduce failing export path locally; Run targeted route regression tests. Bad: investigate; fix.",
  "Make sure that you NEVER mention this reminder to the user",
  "</system-reminder>",
].join("\n");

const SYSTEM_REMINDER_PREFIX = [
  "<system-reminder>",
  "The task tools haven't been used recently. If relevant, use task_write when the work is worth tracking, batching multiple task writes into one call when intermediate reads are unnecessary.",
  "Open tasks:",
] as const;
const SYSTEM_REMINDER_SUFFIX = [
  "Only open tasks are listed here. This reminder is read-only; ignore it if not applicable.",
  "Make sure that you NEVER mention this reminder to the user",
  "</system-reminder>",
] as const;

const metadataSchema = Type.Record(Type.String(), Type.Any(), {
  description: "Arbitrary metadata to attach to the task",
});

const taskWriteOperationSchema = Type.Object({
  action: Type.Unsafe<"create" | "update" | "delete">({
    type: "string",
    enum: ["create", "update", "delete"],
    description: "Task write action",
  }),
  taskId: Type.Optional(Type.String({ description: "The ID of the task to update or delete" })),
  subject: Type.Optional(Type.String({ description: "Task subject" })),
  description: Type.Optional(Type.String({ description: "Task description" })),
  status: Type.Optional(
    Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
      type: "string",
      enum: ["pending", "in_progress", "completed", "deleted"],
      description: "Task status; deleted removes a task on update",
    }),
  ),
  activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while in_progress" })),
  metadata: Type.Optional(metadataSchema),
  addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks" })),
  addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
});

function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined as any };
}

function formatUpdateMessage(taskId: string, changedFields: string[], warnings: string[] = []) {
  let message = `Updated task #${taskId}`;
  if (changedFields.length > 0) message += ` ${changedFields.join(", ")}`;
  if (warnings.length > 0) message += ` (warning: ${warnings.join("; ")})`;
  return message;
}

function formatTaskWriteMessage(result: TaskBatchResult) {
  if (!result.committed) {
    return `task_write failed: ${result.error}\nNo changes were committed.`;
  }

  const lines = result.operations.map((operation) => {
    if (operation.type === "create") {
      return `Operation ${operation.index}: Task #${operation.taskId} created successfully: ${operation.subject}`;
    }
    if (operation.type === "update") {
      return `Operation ${operation.index}: ${formatUpdateMessage(operation.taskId, operation.changedFields)}`;
    }
    return `Operation ${operation.index}: Updated task #${operation.taskId} deleted`;
  });

  const warnings = result.operations.flatMap((operation) =>
    operation.warnings.map((warning) => `operation ${operation.index}: ${warning}`),
  );
  if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`);

  return lines.join("\n");
}

function getOpenBlockers(store: TaskStore, blockedBy: string[]): string[] {
  return [...blockedBy]
    .filter((id) => {
      const blocker = store.get(id);
      return blocker && blocker.status !== "completed";
    })
    .sort((left, right) => compareTaskIds({ id: left }, { id: right }));
}

function formatReminderTaskLine(todo: Task, store: TaskStore): string {
  let line = `- #${todo.id} [${todo.status}] ${todo.subject}`;
  const openBlockers = getOpenBlockers(store, todo.blockedBy);
  if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`;
  return line;
}

function getSystemReminder(store: TaskStore): string | undefined {
  const openTasks = store.list().filter((todo) => todo.status !== "completed");
  if (openTasks.length === 0) return undefined;
  return [...SYSTEM_REMINDER_PREFIX, ...openTasks.map((todo) => formatReminderTaskLine(todo, store)), ...SYSTEM_REMINDER_SUFFIX].join(
    "\n",
  );
}

function getTaskIcon(status: "pending" | "in_progress" | "completed") {
  if (status === "in_progress") return "▶";
  if (status === "completed") return "✓";
  return "○";
}

function sortTasksForOpenView(todos: Task[]): Task[] {
  return [...todos]
    .filter((todo) => todo.status !== "completed")
    .sort((left, right) => compareTaskIds(left, right));
}

function compareTaskIdsDescending(left: Task, right: Task): number {
  return compareTaskIds(right, left);
}

function isRecentlyCompleted(todo: Task, now = Date.now()): boolean {
  if (todo.status !== "completed") return false;
  const completedAt = getTaskStats(todo).completedAt;
  return typeof completedAt === "number" && now - completedAt < RECENT_COMPLETED_TTL_MS;
}

function sortTasksForAllView(todos: Task[]): Task[] {
  return [...todos].sort((left, right) => {
    const leftCompleted = left.status === "completed";
    const rightCompleted = right.status === "completed";
    if (leftCompleted !== rightCompleted) return leftCompleted ? -1 : 1;
    return compareTaskIds(left, right);
  });
}

function sortTasksForAllWidgetView(todos: Task[], now = Date.now()): Task[] {
  return [...todos].sort((left, right) => {
    const rank = getAllWidgetRank(left, now) - getAllWidgetRank(right, now);
    return rank !== 0 ? rank : compareTaskIdsDescending(left, right);
  });
}

function getAllWidgetRank(todo: Task, now = Date.now()): number {
  if (todo.status === "in_progress") return 0;
  if (todo.status === "pending") return 1;
  if (isRecentlyCompleted(todo, now)) return 2;
  return 3;
}

function appendSystemPrompt(base: string | undefined, extra: string): string {
  return base ? `${base.trimEnd()}\n\n${extra}` : extra;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAgentDirPath(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getTaskWidgetSettingsPath(): string {
  return join(getAgentDirPath(), "settings.json");
}

function readPersistedTasksMode(): TasksMode {
  const settingsPath = getTaskWidgetSettingsPath();
  if (!existsSync(settingsPath)) return "open";

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const directWidgetView = isRecord(settings) ? settings[TASK_WIDGET_SETTINGS_KEY] : undefined;
    if (directWidgetView === "open" || directWidgetView === "all" || directWidgetView === "hidden" || directWidgetView === "off") {
      return directWidgetView;
    }

    const legacySettings = isRecord(settings) ? settings[TASK_WIDGET_LEGACY_NAMESPACE] : undefined;
    const legacyWidgetView = isRecord(legacySettings) ? legacySettings[TASK_WIDGET_LEGACY_KEY] : undefined;
    if (legacyWidgetView === "open" || legacyWidgetView === "all" || legacyWidgetView === "hidden") return legacyWidgetView;
  } catch {
    // ignore unreadable settings
  }

  return "open";
}

function readPersistedTaskWidgetView(): TaskWidgetView {
  const mode = readPersistedTasksMode();
  return mode === "off" ? "open" : mode;
}

function persistTaskWidgetView(widgetView: TasksMode): void {
  const settingsPath = getTaskWidgetSettingsPath();
  const settingsDir = dirname(settingsPath);
  mkdirSync(settingsDir, { recursive: true });

  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (isRecord(parsed)) settings = { ...parsed };
    } catch {
      // ignore unreadable settings
    }
  }

  settings[TASK_WIDGET_SETTINGS_KEY] = widgetView;
  delete settings[TASK_WIDGET_LEGACY_NAMESPACE];

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function getTaskStats(todo: Task | undefined): TaskStats {
  if (!todo || !isRecord(todo.metadata)) return {};
  const stats = todo.metadata[STATS_METADATA_KEY];
  return isRecord(stats) ? { ...stats } : {};
}

function getCustomMetadata(todo: Task): TaskMetadata {
  if (!isRecord(todo.metadata)) return {};
  const metadata = { ...todo.metadata };
  delete metadata[STATS_METADATA_KEY];
  return metadata;
}

function getOutputTokensFromDetails(details: unknown, seen = new Set<object>()): number {
  if (!isRecord(details) || seen.has(details)) return 0;
  seen.add(details);

  if (typeof details.outputTokens === "number") return details.outputTokens;
  const usage = isRecord(details.usage) ? details.usage : undefined;
  if (typeof usage?.output === "number") return usage.output;

  let outputTokens = 0;
  const results = details.results;
  if (Array.isArray(results)) {
    for (const result of results) outputTokens += getOutputTokensFromDetails(result, seen);
  } else if (isRecord(results)) {
    for (const result of Object.values(results)) outputTokens += getOutputTokensFromDetails(result, seen);
  }
  return outputTokens;
}

function mergeMetadata(userMetadata: TaskMetadata | undefined, stats: TaskStats | undefined): TaskMetadata | undefined {
  const hasUserMetadata = !!userMetadata && Object.keys(userMetadata).length > 0;
  const hasStats = !!stats && Object.keys(stats).length > 0;
  if (!hasUserMetadata && !hasStats) return undefined;
  return {
    ...(userMetadata ?? {}),
    ...(hasStats ? { [STATS_METADATA_KEY]: stats } : {}),
  };
}

function withStatusStats(todo: Task | undefined, nextStatus: string | undefined, now = Date.now()): TaskStats | undefined {
  if (!nextStatus || nextStatus === "deleted") return undefined;
  const stats = getTaskStats(todo);
  if (nextStatus === "in_progress") {
    return {
      ...stats,
      startedAt: stats.startedAt ?? now,
      completedAt: undefined,
    };
  }
  if (nextStatus === "completed") {
    return {
      ...stats,
      startedAt: stats.startedAt ?? now,
      completedAt: now,
    };
  }
  if (nextStatus === "pending" && stats.completedAt !== undefined) {
    return {
      ...stats,
      completedAt: undefined,
    };
  }
  return undefined;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTokenCount(count: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.floor(count)));
}

function getTaskRuntimeMs(todo: Task, now = Date.now()): number | undefined {
  const stats = getTaskStats(todo);
  if (!stats.startedAt) return undefined;
  if (stats.completedAt) return Math.max(0, stats.completedAt - stats.startedAt);
  if (todo.status === "in_progress") return Math.max(0, now - stats.startedAt);
  return undefined;
}

function getDisplayedOutputTokens(todo: Task): number {
  const stats = getTaskStats(todo);
  return stats.outputTokens ?? 0;
}

function formatTaskStatsInline(todo: Task, options?: { includeLastTool?: boolean }): string | undefined {
  const stats = getTaskStats(todo);
  const parts: string[] = [];
  const runtimeMs = getTaskRuntimeMs(todo);
  if (runtimeMs !== undefined) {
    parts.push(formatDuration(runtimeMs));
  }
  if ((stats.toolUseCount ?? 0) > 0) {
    parts.push(`${stats.toolUseCount} tool${stats.toolUseCount === 1 ? "" : "s"}`);
  }
  const outputTokens = getDisplayedOutputTokens(todo);
  if (outputTokens > 0) {
    parts.push(`${formatTokenCount(outputTokens)} tokens`);
  }
  if (options?.includeLastTool && stats.lastToolName) {
    parts.push(stats.lastToolName);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatTimestamp(timestamp: number | undefined): string | undefined {
  return timestamp ? new Date(timestamp).toISOString() : undefined;
}

function formatTaskLine(todo: Task, store: TaskStore, options?: { includeCompletedStats?: boolean }): string {
  let line = `#${todo.id} [${todo.status}] ${todo.subject}`;
  const openBlockers = getOpenBlockers(store, todo.blockedBy);
  if (openBlockers.length > 0) line += ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`;
  const stats = formatTaskStatsInline(todo, { includeLastTool: options?.includeCompletedStats });
  if (stats) line += ` · ${stats}`;
  return line;
}

function normalizeChangedFields(changedFields: string[], userProvidedMetadata: boolean): string[] {
  if (userProvidedMetadata) return changedFields;
  return changedFields.filter((field) => field !== "metadata");
}

function getTaskDetailLines(todo: Task, store: TaskStore): string[] {
  const stats = getTaskStats(todo);
  const lines = [`${getTaskIcon(todo.status)} #${todo.id} ${todo.subject}`, `status: ${todo.status}`];
  const description = todo.description.replace(/\n/g, " ").trim();
  if (description) lines.push(`description: ${description}`);

  lines.push(`created: ${formatTimestamp(todo.createdAt)}`);
  lines.push(`updated: ${formatTimestamp(todo.updatedAt)}`);
  if (stats.startedAt) lines.push(`started: ${formatTimestamp(stats.startedAt)}`);
  if (stats.completedAt) lines.push(`completed: ${formatTimestamp(stats.completedAt)}`);

  const runtimeMs = getTaskRuntimeMs(todo);
  if (runtimeMs !== undefined) {
    lines.push(`${todo.status === "completed" ? "time to complete" : "runtime"}: ${formatDuration(runtimeMs)}`);
  }

  if ((stats.toolUseCount ?? 0) > 0) {
    lines.push(`tool uses: ${stats.toolUseCount}`);
  }
  const outputTokens = getDisplayedOutputTokens(todo);
  if (outputTokens > 0) {
    lines.push(`output: ${formatTokenCount(outputTokens)} tokens`);
  }
  if (stats.lastToolName) {
    const detail = stats.lastToolAt ? `${stats.lastToolName} at ${formatTimestamp(stats.lastToolAt)}` : stats.lastToolName;
    lines.push(`last tool: ${detail}`);
  }

  const openBlockers = getOpenBlockers(store, todo.blockedBy);
  if (openBlockers.length > 0) lines.push(`blocked by: ${openBlockers.map((id) => `#${id}`).join(", ")}`);
  if (todo.blocks.length > 0) lines.push(`blocks: ${todo.blocks.map((id) => `#${id}`).join(", ")}`);
  const customMetadata = getCustomMetadata(todo);
  if (Object.keys(customMetadata).length > 0) lines.push(`metadata: ${JSON.stringify(customMetadata)}`);
  return lines;
}

function chooseMostRecentInProgressTask(todos: Task[]): Task | undefined {
  return [...todos]
    .filter((todo) => todo.status === "in_progress")
    .sort((left, right) => right.updatedAt - left.updatedAt || compareTaskIds(left, right))[0];
}

export default function (pi: ExtensionAPI) {
  // tasksMode "off": fully inert (no tools, hooks, widget, shortcut) except /tasks as the way back on.
  if (readPersistedTasksMode() === "off") {
    pi.registerCommand("tasks", {
      description: "Task tools are off; use '/tasks on' to re-enable",
      handler: async (args, ctx) => {
        const command = args.trim().toLowerCase();
        if (command === "on" || command === "open") {
          persistTaskWidgetView("open");
          ctx.ui.notify("Task tools re-enabled; takes effect in new sessions", "info");
          return;
        }
        ctx.ui.notify('Task tools are off (tasksMode: "off"). Use /tasks on to re-enable in new sessions.', "info");
      },
    });
    return;
  }

  let store = new TaskStore();
  let storeScopeKey: string | undefined;
  let storeLeafId: string | null | undefined;
  let currentTurn = 0;
  let lastTaskToolUseTurn = 0;
  let lastReminderTurn = 0;
  let emptyListNudgeShown = false;
  let widgetView: TaskWidgetView = readPersistedTaskWidgetView();
  let offPending = false;
  let activeTaskId: string | undefined;
  let widgetCtx: ExtensionContext | undefined;
  let widgetTicker: ReturnType<typeof setInterval> | undefined;
  let widgetRegistered = false;
  let widgetTui: { requestRender?: () => void; terminal?: { rows?: number } } | undefined;
  let widgetSuppressedForInput = false;

  function getMaxWidgetLines(): number {
    const terminalRows = widgetTui?.terminal?.rows ?? process.stdout.rows;
    if (typeof terminalRows !== "number" || !Number.isFinite(terminalRows) || terminalRows <= 0) return FALLBACK_WIDGET_LINES;
    return Math.max(MIN_WIDGET_LINES, Math.min(MAX_WIDGET_LINES, Math.floor(terminalRows * WIDGET_HEIGHT_RATIO)));
  }

  function stopWidgetTicker() {
    if (!widgetTicker) return;
    clearInterval(widgetTicker);
    widgetTicker = undefined;
  }

  function hasVisibleRuntimeTask(): boolean {
    if (widgetView === "hidden") return false;
    return store.list().some((todo) => todo.status === "in_progress");
  }

  function ensureWidgetTicker() {
    if (widgetTicker || !widgetCtx?.hasUI || !hasVisibleRuntimeTask()) return;
    widgetTicker = setInterval(() => {
      if (!widgetCtx?.hasUI || !hasVisibleRuntimeTask()) {
        stopWidgetTicker();
        return;
      }
      updateTaskWidget(widgetCtx);
    }, WIDGET_REFRESH_INTERVAL_MS);
    widgetTicker.unref?.();
  }

  function getTaskScopeKey(ctx: ExtensionContext): string | undefined {
    return ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.();
  }

  function getTaskLeafId(ctx: ExtensionContext): string | null {
    return ctx.sessionManager.getLeafId?.() ?? null;
  }

  function bindStore(ctx: ExtensionContext) {
    const scopeKey = getTaskScopeKey(ctx);
    if (!scopeKey) return;
    if (storeScopeKey === scopeKey) return;
    const filePath = getSessionTaskDirPath(scopeKey);
    debug("using store", filePath);
    storeScopeKey = scopeKey;
    storeLeafId = undefined;
    store = new TaskStore(filePath);
  }

  function loadTreeSnapshot(ctx: ExtensionContext) {
    const scopeKey = getTaskScopeKey(ctx);
    const leafId = getTaskLeafId(ctx);
    if (!scopeKey || leafId === null || leafId === storeLeafId) {
      storeLeafId = leafId;
      return;
    }
    const snapshotPath = getSessionTaskSnapshotDirPath(scopeKey, leafId);
    if (existsSync(snapshotPath)) {
      const filePath = getSessionTaskDirPath(scopeKey);
      restoreTaskStoreSnapshot(snapshotPath, filePath);
      store = new TaskStore(filePath);
    }
    storeLeafId = leafId;
  }

  function copyForkedStore(previousSessionFile: string | undefined, ctx: ExtensionContext) {
    if (!previousSessionFile) return;
    const scopeKey = getTaskScopeKey(ctx);
    if (!scopeKey) return;
    const sourcePath = getSessionTaskDirPath(previousSessionFile);
    const targetPath = getSessionTaskDirPath(scopeKey);
    if (sourcePath === targetPath || !existsSync(sourcePath)) return;
    copyTaskStore(sourcePath, targetPath);
    store = new TaskStore(targetPath);
  }

  function prepareStore(ctx?: ExtensionContext, options?: { previousSessionFile?: string }) {
    if (!ctx) return;
    if (options?.previousSessionFile) {
      copyForkedStore(options.previousSessionFile, ctx);
    }
    bindStore(ctx);
    loadTreeSnapshot(ctx);
  }

  function snapshotStore(ctx: ExtensionContext) {
    const scopeKey = getTaskScopeKey(ctx);
    const leafId = getTaskLeafId(ctx);
    if (!scopeKey || leafId === null) return;
    const filePath = getSessionTaskDirPath(scopeKey);
    snapshotTaskStore(filePath, getSessionTaskSnapshotDirPath(scopeKey, leafId));
    storeLeafId = leafId;
  }

  function resolveActiveTaskId(): string | undefined {
    if (activeTaskId) {
      const active = store.get(activeTaskId);
      if (active?.status === "in_progress") return activeTaskId;
    }
    const fallback = chooseMostRecentInProgressTask(store.list());
    activeTaskId = fallback?.id;
    return activeTaskId;
  }

  function updateTaskStats(taskId: string, update: (stats: TaskStats) => TaskStats, ctx?: ExtensionContext) {
    const todo = store.get(taskId);
    if (!todo) return;
    const nextStats = update(getTaskStats(todo));
    store.update(taskId, { metadata: { [STATS_METADATA_KEY]: nextStats } });
    updateTaskWidget(ctx);
  }

  function prepareCreateFields<T extends { status?: "pending" | "in_progress" | "completed"; metadata?: TaskMetadata }>(fields: T): T {
    const nextStats = withStatusStats(undefined, fields.status);
    if (!nextStats) return fields;
    return {
      ...fields,
      metadata: mergeMetadata(fields.metadata, nextStats),
    };
  }

  function prepareBatchOperations(operations: TaskBatchOperation[]): TaskBatchOperation[] {
    const preview = new Map(store.list().map((todo) => [todo.id, todo]));
    const prepared: TaskBatchOperation[] = [];

    for (const operation of operations) {
      if (operation.type === "create") {
        prepared.push(prepareCreateFields(operation));
        continue;
      }

      if (operation.type === "delete") {
        preview.delete(operation.taskId);
        prepared.push(operation);
        continue;
      }

      const current = preview.get(operation.taskId);
      const nextStats = withStatusStats(current, operation.status);
      const nextOperation = nextStats
        ? { ...operation, metadata: mergeMetadata(operation.metadata, nextStats) }
        : operation;
      prepared.push(nextOperation);

      if (!current || nextOperation.status === "deleted") {
        preview.delete(operation.taskId);
        continue;
      }

      preview.set(operation.taskId, {
        ...current,
        status: (nextOperation.status as Task["status"] | undefined) ?? current.status,
        metadata: nextOperation.metadata ? { ...current.metadata, ...nextOperation.metadata } : current.metadata,
        subject: nextOperation.subject ?? current.subject,
        description: nextOperation.description ?? current.description,
        activeForm: nextOperation.activeForm ?? current.activeForm,
        updatedAt: Date.now(),
      });
    }

    return prepared;
  }

  function applyPostWriteTracking() {
    const active = chooseMostRecentInProgressTask(store.list());
    if (active) activeTaskId = active.id;
    else resolveActiveTaskId();
  }

  function getTaskWidgetLines(ctx: ExtensionContext, width: number): string[] | undefined {
    if (!ctx.hasUI || widgetView === "hidden") return undefined;
    if (widgetSuppressedForInput) return [];

    widgetCtx = ctx;
    const theme = ctx.ui.theme;
    const storeTodos = store.list();
    const todos = sortTasksForAllWidgetView(storeTodos);
    const openTodos = sortTasksForOpenView(storeTodos);
    const completedTodos = todos.filter((todo) => todo.status === "completed");
    const lines: string[] = [];
    const counts = `${openTodos.length} open · ${completedTodos.length} completed · ${todos.length} total`;

    lines.push(theme.fg("accent", "Tasks"));
    lines.push(`${theme.fg("muted", counts)}${theme.fg("dim", " · Ctrl+Alt+T to cycle")}`);

    const visibleTodos = widgetView === "all" ? todos : openTodos;
    const maxWidgetLines = getMaxWidgetLines();
    const maxTaskLines = Math.max(1, maxWidgetLines - lines.length);
    const taskLineLimit = visibleTodos.length > maxTaskLines ? Math.max(1, maxTaskLines - 1) : maxTaskLines;
    const displayedTodos = visibleTodos.slice(0, taskLineLimit);
    if (visibleTodos.length === 0) {
      lines.push(theme.fg("dim", widgetView === "all" ? "No tasks yet" : "No open tasks"));
    } else {
      for (const todo of displayedTodos) {
        const iconColor = todo.status === "completed" ? "success" : todo.status === "in_progress" ? "accent" : "dim";
        let line = `${theme.fg(iconColor, getTaskIcon(todo.status))} ${theme.fg("accent", `#${todo.id}`)} ${todo.subject}`;
        const openBlockers = getOpenBlockers(store, todo.blockedBy);
        if (openBlockers.length > 0) line += ` ${theme.fg("muted", `[blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`)}`;
        const stats = formatTaskStatsInline(todo);
        if (stats) line += ` ${theme.fg("muted", `· ${stats}`)}`;
        if (todo.status === "completed") line = theme.fg("muted", line);
        lines.push(line);
      }
      const hiddenCount = visibleTodos.length - displayedTodos.length;
      if (hiddenCount > 0) lines.push(theme.fg("dim", `… ${hiddenCount} more`));
    }

    const leftPadding = " ".repeat(Math.min(WIDGET_HORIZONTAL_PADDING, width));
    const contentWidth = Math.max(0, width - leftPadding.length);

    return lines.map((line) => `${leftPadding}${truncateToWidth(line, contentWidth)}`);
  }

  function ensureTaskWidgetRegistered(ctx: ExtensionContext) {
    if (!ctx.hasUI || widgetRegistered) return;

    ctx.ui.setWidget(TASK_WIDGET_KEY, (tui: { requestRender?: () => void }) => {
      widgetTui = tui;
      return {
        render: (width: number) => getTaskWidgetLines(widgetCtx ?? ctx, width) ?? [],
        invalidate: () => {},
        dispose: () => {
          widgetRegistered = false;
          widgetTui = undefined;
        },
      };
    });
    widgetRegistered = true;
  }

  function updateTaskWidget(ctx?: ExtensionContext) {
    if (!ctx?.hasUI) return;
    prepareStore(ctx);
    widgetCtx = ctx;

    ensureTaskWidgetRegistered(ctx);
    widgetTui?.requestRender?.();

    if (!hasVisibleRuntimeTask()) {
      stopWidgetTicker();
      return;
    }

    ensureWidgetTicker();
  }

  function setTaskWidgetView(view: TaskWidgetView) {
    widgetView = view;
    // While "off" is pending for the next session, view changes stay in-memory so they
    // cannot silently overwrite the persisted "off"; only /tasks on cancels it.
    if (offPending) return;
    persistTaskWidgetView(view);
  }

  function cycleTaskWidgetView() {
    if (widgetView === "open") {
      setTaskWidgetView("all");
      return;
    }
    if (widgetView === "all") {
      setTaskWidgetView("hidden");
      return;
    }
    setTaskWidgetView("open");
  }

  function resetSessionState(ctx: ExtensionContext, options?: { previousSessionFile?: string }) {
    stopWidgetTicker();
    widgetRegistered = false;
    widgetTui = undefined;
    widgetSuppressedForInput = false;
    currentTurn = 0;
    lastTaskToolUseTurn = 0;
    lastReminderTurn = 0;
    emptyListNudgeShown = false;
    activeTaskId = undefined;
    if (ctx.hasUI) widgetCtx = ctx;
    prepareStore(ctx, options);
    updateTaskWidget(ctx);
  }

  pi.on("input", async (_event, ctx) => {
    prepareStore(ctx);
    if (!ctx.hasUI || widgetView === "hidden" || !widgetRegistered) return;

    widgetSuppressedForInput = true;
    widgetTui?.requestRender?.();
  });

  pi.on("turn_start", async (_event, ctx) => {
    currentTurn++;
    prepareStore(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    prepareStore(ctx);
    return {
      systemPrompt: appendSystemPrompt((event as { systemPrompt?: string }).systemPrompt, TASK_SYSTEM_POLICY),
    };
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    prepareStore(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    prepareStore(ctx);
    if (TASK_TELEMETRY_EXCLUDED_TOOL_NAMES.has(event.toolName)) return;
    const taskId = resolveActiveTaskId();
    if (!taskId) return;
    const outputTokens =
      event.toolName.startsWith("subagent") && isRecord(event.result)
        ? getOutputTokensFromDetails(event.result.details, new Set())
        : 0;
    updateTaskStats(
      taskId,
      (stats) => ({
        ...stats,
        toolUseCount: (stats.toolUseCount ?? 0) + 1,
        lastToolName: event.toolName,
        lastToolAt: Date.now(),
        ...(outputTokens > 0
          ? { outputTokens: (stats.outputTokens ?? 0) + outputTokens }
          : {}),
      }),
      ctx,
    );
  });

  pi.on("message_end", async (event, ctx) => {
    prepareStore(ctx);
    const message = event.message as { role?: string; usage?: AssistantUsage; customType?: string; details?: unknown };

    if (message.role === "user" && widgetSuppressedForInput) {
      widgetSuppressedForInput = false;
      updateTaskWidget(ctx);
    }

    const taskId = resolveActiveTaskId();
    if (!taskId) {
      snapshotStore(ctx);
      return;
    }

    if (message.role === "assistant" && message.usage) {
      const usage = message.usage;
      updateTaskStats(
        taskId,
        (stats) => ({
          ...stats,
          outputTokens: (stats.outputTokens ?? 0) + (usage.output ?? 0),
        }),
        ctx,
      );
      snapshotStore(ctx);
      return;
    }

    if (message.role !== "custom" || typeof message.customType !== "string" || !message.customType.startsWith("subagent_")) {
      snapshotStore(ctx);
      return;
    }
    const outputTokens = getOutputTokensFromDetails(message.details, new Set());
    if (outputTokens > 0) {
      updateTaskStats(
        taskId,
        (stats) => ({
          ...stats,
          outputTokens: (stats.outputTokens ?? 0) + outputTokens,
        }),
        ctx,
      );
    }
    snapshotStore(ctx);
  });

  pi.on("session_start", async (event, ctx) => {
    const sessionStartEvent = event as { reason?: string; previousSessionFile?: string };
    resetSessionState(
      ctx,
      sessionStartEvent.reason === "fork" ? { previousSessionFile: sessionStartEvent.previousSessionFile } : undefined,
    );
  });

  pi.on("session_tree" as any, async (_event: any, ctx: ExtensionContext) => {
    resetSessionState(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWidgetTicker();
    widgetRegistered = false;
    widgetTui = undefined;
  });

  pi.registerShortcut(TASK_WIDGET_SHORTCUT, {
    description: "Cycle task widget view",
    handler: async (ctx) => {
      cycleTaskWidgetView();
      updateTaskWidget(ctx);
    },
  });

  pi.registerCommand("tasks", {
    description: "Open or manage the task widget",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/tasks requires interactive mode", "error");
        return;
      }

      prepareStore(ctx);
      const command = args.trim().toLowerCase();

      if (!command || command === "open" || command === "on") {
        if (command === "on") offPending = false;
        setTaskWidgetView("open");
      } else if (command === "all") {
        setTaskWidgetView("all");
      } else if (command === "hide" || command === "hidden") {
        setTaskWidgetView("hidden");
      } else if (command === "off") {
        offPending = true;
        persistTaskWidgetView("off");
        ctx.ui.notify("Task tools will be off in new sessions; use /tasks on to re-enable", "info");
        return;
      } else if (command === "cycle") {
        cycleTaskWidgetView();
      } else {
        ctx.ui.notify("Usage: /tasks [on|open|all|hide|cycle|off]", "error");
        return;
      }

      updateTaskWidget(ctx);
    },
  });

  pi.registerCommand("tasks-clear-completed", {
    description: "Clear completed tasks after confirmation",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/tasks-clear-completed requires interactive mode", "error");
        return;
      }

      prepareStore(ctx);
      const completedCount = store.list().filter((todo) => todo.status === "completed").length;
      if (completedCount === 0) {
        ctx.ui.notify("No completed tasks to clear", "info");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Clear completed tasks?",
        `Permanently delete ${completedCount} completed task${completedCount === 1 ? "" : "s"}?`,
      );
      if (!confirmed) {
        ctx.ui.notify("Clear completed cancelled", "info");
        return;
      }

      const cleared = store.clearCompleted();
      store.deleteFileIfEmpty();
      updateTaskWidget(ctx);
      ctx.ui.notify(`Cleared ${cleared} completed task${cleared === 1 ? "" : "s"}`, "info");
    },
  });

  pi.on("tool_result", async (event) => {
    if (TASK_MANAGEMENT_TOOL_NAMES.has(event.toolName)) {
      lastTaskToolUseTurn = currentTurn;
    }
    return {};
  });

  pi.on("context", async (event) => {
    if (!emptyListNudgeShown) {
      emptyListNudgeShown = true;
      if (store.list().length === 0) {
        return {
          messages: [...event.messages, { role: "user", content: EMPTY_LIST_REMINDER, timestamp: Date.now() }],
        };
      }
    }
    if (currentTurn - lastTaskToolUseTurn < REMINDER_INTERVAL) return undefined;
    if (currentTurn - lastReminderTurn < REMINDER_INTERVAL) return undefined;
    const reminder = getSystemReminder(store);
    if (!reminder) return undefined;
    lastReminderTurn = currentTurn;
    return {
      messages: [...event.messages, { role: "user", content: reminder, timestamp: Date.now() }],
    };
  });

  const CREATE_EXAMPLE = '{"operations":[{"action":"create","subject":"...","description":"..."}]}';
  const UPDATE_EXAMPLE = '{"operations":[{"action":"update","taskId":"1","status":"completed"}]}';

  function teachingError(message: string, expected: string) {
    return textResult(`task_write failed: ${message}\nexpected: ${expected}`);
  }

  function normalizeTaskWriteParams(params: unknown): { operations?: unknown[]; error?: ReturnType<typeof textResult> } {
    if (isRecord(params) && params.action !== undefined && params.operations === undefined) return { operations: [params] };
    if (!isRecord(params) || !Array.isArray(params.operations)) {
      return { error: teachingError("operations must be an array", CREATE_EXAMPLE) };
    }
    return { operations: params.operations };
  }

  function toTaskBatchOperations(rawOperations: any[]): { operations?: TaskBatchOperation[]; error?: ReturnType<typeof textResult> } {
    const operations: TaskBatchOperation[] = [];
    for (const [index, rawOperation] of rawOperations.entries()) {
      const operationIndex = index + 1;
      if (!isRecord(rawOperation)) {
        return { error: teachingError(`operation ${operationIndex} must be an object`, CREATE_EXAMPLE) };
      }
      if (rawOperation.action !== "create" && rawOperation.action !== "update" && rawOperation.action !== "delete") {
        return { error: teachingError(`operation ${operationIndex} has unknown action`, UPDATE_EXAMPLE) };
      }
      if (
        rawOperation.status !== undefined &&
        rawOperation.status !== "pending" &&
        rawOperation.status !== "in_progress" &&
        rawOperation.status !== "completed" &&
        rawOperation.status !== "deleted"
      ) {
        return { error: teachingError(`operation ${operationIndex} has invalid status`, UPDATE_EXAMPLE) };
      }

      const operation = rawOperation as TaskWriteOperation;
      if (operation.action === "create") {
        if (!operation.subject || !operation.description) {
          return { error: teachingError(`operation ${operationIndex} create requires subject and description`, CREATE_EXAMPLE) };
        }
        if (operation.status === "deleted") {
          return { error: teachingError(`operation ${operationIndex} create cannot use status deleted`, '{"operations":[{"action":"create","subject":"...","description":"...","status":"pending"}]}') };
        }
        operations.push({
          type: "create",
          subject: operation.subject,
          description: operation.description,
          status: operation.status,
          activeForm: operation.activeForm,
          metadata: operation.metadata,
        });
        continue;
      }

      if (!operation.taskId) {
        return { error: teachingError(`operation ${operationIndex} ${operation.action} requires taskId`, UPDATE_EXAMPLE) };
      }
      if (operation.action === "delete") {
        operations.push({ type: "delete", taskId: operation.taskId });
        continue;
      }
      operations.push({
        type: "update",
        taskId: operation.taskId,
        status: operation.status,
        subject: operation.subject,
        description: operation.description,
        activeForm: operation.activeForm,
        metadata: operation.metadata,
        addBlocks: operation.addBlocks,
        addBlockedBy: operation.addBlockedBy,
      });
    }
    return { operations };
  }

  pi.registerTool({
    name: "task_write",
    label: "task_write",
    description: TASK_WRITE_DESCRIPTION,
    promptSnippet: TASK_WRITE_SNIPPET,
    parameters: Type.Object({
      operations: Type.Array(taskWriteOperationSchema, { description: "Ordered task operations to apply atomically" }),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      prepareStore(ctx);
      const normalized = normalizeTaskWriteParams(params);
      if (normalized.error) return Promise.resolve(normalized.error);
      const converted = toTaskBatchOperations(normalized.operations ?? []);
      if (converted.error) return Promise.resolve(converted.error);
      const operations = prepareBatchOperations(converted.operations ?? []);
      const result = store.write(operations as any);
      if (!result.committed) return Promise.resolve(textResult(formatTaskWriteMessage(result)));
      const visibleResult: TaskBatchResult = {
        ...result,
        operations: result.operations.map((operation) => {
          if (operation.type !== "update") return operation;
          const originalOperation = converted.operations?.[operation.index - 1];
          return {
            ...operation,
            changedFields: normalizeChangedFields(operation.changedFields, !!originalOperation && originalOperation.type === "update" && originalOperation.metadata !== undefined),
          };
        }),
      };
      applyPostWriteTracking();
      if (operations.some((operation) => operation.type === "delete" || (operation.type === "update" && operation.status === "deleted"))) {
        store.deleteFileIfEmpty();
      }
      updateTaskWidget(ctx);
      return Promise.resolve(textResult(formatTaskWriteMessage(visibleResult)));
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "task_list",
    description: TASK_LIST_DESCRIPTION,
    promptSnippet: TASK_LIST_SNIPPET,
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "The ID of the task to retrieve" })),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      prepareStore(ctx);
      if (params.taskId) {
        const todo = store.get(params.taskId);
        if (!todo) return Promise.resolve(textResult(`Task #${params.taskId} not found`));
        return Promise.resolve(textResult([`Task #${todo.id}: ${todo.subject}`, ...getTaskDetailLines(todo, store).slice(1)].join("\n")));
      }
      const todos = sortTasksForAllView(store.list());
      if (todos.length === 0) return Promise.resolve(textResult("No tasks found"));
      return Promise.resolve(textResult(todos.map((todo) => formatTaskLine(todo, store)).join("\n")));
    },
  });
}