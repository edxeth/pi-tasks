import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, truncateToWidth } from "@mariozechner/pi-tui";
import { StringEnum, Type } from "@mariozechner/pi-ai";
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

const TASK_MANAGEMENT_TOOL_NAMES = new Set(["task_create", "task_update", "task_batch"]);
const TASK_TELEMETRY_EXCLUDED_TOOL_NAMES = new Set([...TASK_MANAGEMENT_TOOL_NAMES, "task_list", "task_get"]);
const TASK_WIDGET_KEY = "tasks";
const TASK_WIDGET_SHORTCUT = Key.ctrlAlt("t");
const REMINDER_INTERVAL = 10;
const STATS_METADATA_KEY = "stats";
const TASK_WIDGET_SETTINGS_KEY = "tasksMode";
const TASK_WIDGET_LEGACY_NAMESPACE = "piTasks";
const TASK_WIDGET_LEGACY_KEY = "widgetView";
const WIDGET_REFRESH_INTERVAL_MS = 1000;
const DEBUG = !!process.env.PI_TODOS_DEBUG;

type TaskWidgetView = "open" | "all" | "hidden";

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

const TASK_SYSTEM_POLICY = [
  "Task workflow guidance:",
  "- Use the task tools when the work is non-trivial, multi-step, or clearly benefits from persistence across turns.",
  "- Skip task tools for a simple one-off job or purely conversational replies.",
  "- Capture or revise the task list early once the work has become multi-step or the context is growing.",
  "- Mark a task in_progress before substantial work starts.",
  "- Mark a task completed only when the work is fully done; if it is partial, blocked, or failing verification, leave it pending or in_progress.",
  "- Use task_get to refresh stale details before updating a task whose latest state may have changed.",
  "- After completing a task, call task_list to choose the next ready item. Prefer lower task IDs when multiple tasks are equally ready.",
  "- Use task_create for a new task only when the work is worth tracking, or when later work depends on the ID of this creation.",
  "- Use task_update for ordinary single-task changes.",
  "- Use task_batch when creating 2 or more tasks in one turn or when several task mutations should commit together without intermediate reads.",
  "- Parallel task tool calls are fine for independent reads, but shared task-list writes should usually stay in one task_batch call instead of parallel task_update calls.",
  "- Subagents may help execute work, but keep the canonical session task list coherent; the parent agent should usually own shared task updates.",
].join("\n");

const TASK_CREATE_DESCRIPTION = `Use this tool to create one structured task for the current coding session.

Use it when the work is non-trivial, multi-step, or already worth tracking, or when later work depends on the ID of this creation. For 2 or more new tasks in one turn, prefer \`task_batch\` unless you need intermediate reads between creations. Skip it for a simple one-off job, especially at the start of a conversation.

New tasks start as \`pending\` unless an initial \`status\` is provided.

Fields:
- **subject**: brief imperative title
- **description**: concrete context, requirements, and acceptance criteria
- **status**: optional initial status (\`pending\`, \`in_progress\`, or \`completed\`)
- **activeForm**: optional present continuous form shown while in_progress
- **metadata**: optional shallow metadata object`;

const TASK_LIST_DESCRIPTION = `List all tasks in the current session-scoped task list.

Use it to see available work, overall progress, blocked tasks, and the next ready item. Results use display ordering: completed tasks first in all-task outputs, with lower IDs first inside each section.`;

const TASK_GET_DESCRIPTION = `Retrieve one task by ID, including full description, dependency information, metadata, and tracked task stats.

Use it before starting work that needs the task's latest requirements, or before updating a task whose state may have changed.`;

const TASK_UPDATE_DESCRIPTION = `Update one task in the current session-scoped task list.

Use it to start work, finish work, revise requirements, merge metadata, or manage dependencies on one task. Status flows \`pending\` → \`in_progress\` → \`completed\`. Use \`deleted\` to remove a task permanently.

Only mark a task \`completed\` when the work is fully done. If work is partial, blocked, or failing verification, leave it pending or in_progress. If several related tasks need to change together, use \`task_batch\` instead.`;

const TASK_BATCH_DESCRIPTION = `Apply multiple task create, update, and delete operations atomically through the canonical task store.

Use this for batched task changes, including creating 2 or more tasks in one turn when you do not need intermediate reads. For ordinary single-task changes, prefer \`task_create\` or \`task_update\`. Either the full operation list commits, or none of it does.`;

const TASK_CREATE_GUIDELINES = [
  "Capture new multi-step requirements early and keep the session task list current.",
  "Use task_create only when the work is worth tracking; skip it for a simple one-off job at the start of a conversation.",
  "Use task_create only for one new task at a time; for 2 or more new tasks in one turn, prefer task_batch unless you need intermediate reads.",
  "Check task_list before creating more tasks when duplicate or overlapping work is possible.",
  "Mark tasks in_progress before substantive work begins.",
  "Keep task metadata concise and relevant to the current task.",
];

const TASK_LIST_GUIDELINES = [
  "Use task_list after completing a task to find the next ready task.",
  "Prefer lower task IDs when multiple tasks are equally ready.",
  "Use task_get for full details before starting work that depends on exact requirements.",
];

const TASK_GET_GUIDELINES = [
  "Use task_get before starting a task that needs its full requirements or dependency context.",
  "Use task_get before task_update when the latest task state may have changed.",
];

const TASK_UPDATE_GUIDELINES = [
  "Set a task to in_progress before substantial work begins.",
  "Only mark a task completed when the implementation is fully done and not blocked by unresolved issues.",
  "Call task_list after completing a task to pick the next ready item.",
  "Use task_update as the default tool for ordinary single-task changes.",
];

const TASK_BATCH_GUIDELINES = [
  "Use task_batch for batched create/update/delete flows that should commit atomically.",
  "Prefer task_batch when creating 2 or more tasks in one turn and you do not need intermediate reads or IDs from earlier results.",
  "Use task_create or task_update for one-off mutations, or when you need intermediate reads between steps.",
];

const SYSTEM_REMINDER_PREFIX = [
  "<system-reminder>",
  "The task tools haven't been used recently. If relevant, use task_create when the work is worth tracking, task_update for one existing task, and task_batch for 2 or more task writes in one turn when intermediate reads are unnecessary.",
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

const taskUpdateFieldsSchema = {
  status: Type.Optional(
    StringEnum(["pending", "in_progress", "completed", "deleted"], {
      description: "New status for the task",
    }),
  ),
  subject: Type.Optional(Type.String({ description: "New subject for the task" })),
  description: Type.Optional(Type.String({ description: "New description for the task" })),
  activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while in_progress" })),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Metadata keys to merge into the task. Set a key to null to delete it.",
    }),
  ),
  addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task blocks" })),
  addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
};

const taskBatchOperationSchema = Type.Union([
  Type.Object({
    type: Type.Literal("create"),
    subject: Type.String({ description: "A brief title for the task" }),
    description: Type.String({ description: "A detailed description of what needs to be done" }),
    status: Type.Optional(
      StringEnum(["pending", "in_progress", "completed"], {
        description: "Optional initial status for the new task",
      }),
    ),
    activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while in_progress" })),
    metadata: Type.Optional(metadataSchema),
  }),
  Type.Object({
    type: Type.Literal("update"),
    taskId: Type.String({ description: "The ID of the task to update" }),
    ...taskUpdateFieldsSchema,
  }),
  Type.Object({
    type: Type.Literal("delete"),
    taskId: Type.String({ description: "The ID of the task to delete" }),
  }),
]);

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

function formatTaskBatchMessage(result: TaskBatchResult) {
  if (!result.committed) {
    return `task_batch failed: ${result.error}\nNo changes were committed.`;
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

function sortTasksForAllView(todos: Task[]): Task[] {
  return [...todos].sort((left, right) => {
    const leftCompleted = left.status === "completed";
    const rightCompleted = right.status === "completed";
    if (leftCompleted !== rightCompleted) return leftCompleted ? -1 : 1;
    return compareTaskIds(left, right);
  });
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

function readPersistedTaskWidgetView(): TaskWidgetView {
  const settingsPath = getTaskWidgetSettingsPath();
  if (!existsSync(settingsPath)) return "open";

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const directWidgetView = isRecord(settings) ? settings[TASK_WIDGET_SETTINGS_KEY] : undefined;
    if (directWidgetView === "open" || directWidgetView === "all" || directWidgetView === "hidden") return directWidgetView;

    const legacySettings = isRecord(settings) ? settings[TASK_WIDGET_LEGACY_NAMESPACE] : undefined;
    const legacyWidgetView = isRecord(legacySettings) ? legacySettings[TASK_WIDGET_LEGACY_KEY] : undefined;
    if (legacyWidgetView === "open" || legacyWidgetView === "all" || legacyWidgetView === "hidden") return legacyWidgetView;
  } catch {
    // ignore unreadable settings
  }

  return "open";
}

function persistTaskWidgetView(widgetView: TaskWidgetView): void {
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

  const tmpPath = `${settingsPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmpPath, settingsPath);
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
  if (runtimeMs !== undefined && todo.status === "in_progress") {
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
  let store = new TaskStore();
  let storeScopeKey: string | undefined;
  let storeLeafId: string | null | undefined;
  let currentTurn = 0;
  let lastTaskToolUseTurn = 0;
  let lastReminderTurn = 0;
  let widgetView: TaskWidgetView = readPersistedTaskWidgetView();
  let activeTaskId: string | undefined;
  let widgetCtx: ExtensionContext | undefined;
  let widgetTicker: ReturnType<typeof setInterval> | undefined;

  function stopWidgetTicker() {
    if (!widgetTicker) return;
    clearInterval(widgetTicker);
    widgetTicker = undefined;
  }

  function ensureWidgetTicker() {
    if (widgetTicker || !widgetCtx?.hasUI || widgetView === "hidden") return;
    widgetTicker = setInterval(() => {
      if (!widgetCtx?.hasUI || widgetView === "hidden") return;
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

  function prepareTaskUpdate(taskId: string, fields: Record<string, any>) {
    const todo = store.get(taskId);
    if (!todo) return fields;
    const nextStats = withStatusStats(todo, fields.status);
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

  function applyPostWriteTracking(operations: TaskBatchOperation[]) {
    for (const operation of operations) {
      if (operation.type === "create") continue;
      if (operation.type !== "update") continue;
      if (operation.status === "in_progress") activeTaskId = operation.taskId;
      if ((operation.status === "completed" || operation.status === "deleted") && activeTaskId === operation.taskId) {
        activeTaskId = undefined;
      }
    }
    const active = chooseMostRecentInProgressTask(store.list());
    if (active) activeTaskId = active.id;
    else resolveActiveTaskId();
  }

  function getTaskWidgetLines(ctx: ExtensionContext): string[] | undefined {
    if (!ctx.hasUI || widgetView === "hidden") return undefined;

    widgetCtx = ctx;
    const theme = ctx.ui.theme;
    const todos = sortTasksForAllView(store.list());
    const openTodos = sortTasksForOpenView(todos);
    const completedTodos = todos.filter((todo) => todo.status === "completed");
    const lines: string[] = [];
    const counts = `${openTodos.length} open · ${completedTodos.length} completed · ${todos.length} total`;

    lines.push(theme.fg("accent", "Tasks"));
    lines.push(`${theme.fg("muted", counts)}${theme.fg("dim", " · Ctrl+Alt+T to cycle")}`);

    const visibleTodos = widgetView === "all" ? todos : openTodos;
    if (visibleTodos.length === 0) {
      lines.push(theme.fg("dim", widgetView === "all" ? "No tasks yet" : "No open tasks"));
    } else {
      for (const todo of visibleTodos) {
        const iconColor = todo.status === "completed" ? "success" : todo.status === "in_progress" ? "accent" : "dim";
        let line = `${theme.fg(iconColor, getTaskIcon(todo.status))} ${theme.fg("accent", `#${todo.id}`)} ${todo.subject}`;
        const openBlockers = getOpenBlockers(store, todo.blockedBy);
        if (openBlockers.length > 0) line += ` ${theme.fg("muted", `[blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]`)}`;
        const stats = formatTaskStatsInline(todo);
        if (stats) line += ` ${theme.fg("muted", `· ${stats}`)}`;
        if (todo.status === "completed") line = theme.fg("muted", line);
        lines.push(truncateToWidth(line, 120));
      }
    }

    return lines;
  }

  function updateTaskWidget(ctx?: ExtensionContext) {
    if (!ctx?.hasUI) return;
    prepareStore(ctx);
    widgetCtx = ctx;
    ctx.ui.setWidget(TASK_WIDGET_KEY, getTaskWidgetLines(ctx));
    if (widgetView === "hidden") stopWidgetTicker();
    else ensureWidgetTicker();
  }

  function setTaskWidgetView(view: TaskWidgetView) {
    widgetView = view;
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
    currentTurn = 0;
    lastTaskToolUseTurn = 0;
    lastReminderTurn = 0;
    activeTaskId = undefined;
    if (ctx.hasUI) widgetCtx = ctx;
    prepareStore(ctx, options);
    updateTaskWidget(ctx);
  }

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

  pi.on("session_fork" as any, async (_event: any, ctx: ExtensionContext) => {
    resetSessionState(ctx);
  });

  pi.on("session_switch" as any, async (_event: any, ctx: ExtensionContext) => {
    resetSessionState(ctx);
  });

  pi.on("session_tree" as any, async (_event: any, ctx: ExtensionContext) => {
    resetSessionState(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopWidgetTicker();
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

      if (!command || command === "open") {
        setTaskWidgetView("open");
      } else if (command === "all") {
        setTaskWidgetView("all");
      } else if (command === "hide" || command === "hidden") {
        setTaskWidgetView("hidden");
      } else if (command === "cycle") {
        cycleTaskWidgetView();
      } else {
        ctx.ui.notify("Usage: /tasks [open|all|hide|cycle]", "error");
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
    if (currentTurn - lastTaskToolUseTurn < REMINDER_INTERVAL) return undefined;
    if (currentTurn - lastReminderTurn < REMINDER_INTERVAL) return undefined;
    const reminder = getSystemReminder(store);
    if (!reminder) return undefined;
    lastReminderTurn = currentTurn;
    return {
      messages: [...event.messages, { role: "user", content: reminder, timestamp: Date.now() }],
    };
  });

  pi.registerTool({
    name: "task_create",
    label: "task_create",
    description: TASK_CREATE_DESCRIPTION,
    promptGuidelines: TASK_CREATE_GUIDELINES,
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      status: Type.Optional(
        StringEnum(["pending", "in_progress", "completed"], {
          description: "Optional initial status for the new task",
        }),
      ),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while in_progress" })),
      metadata: Type.Optional(metadataSchema),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      prepareStore(ctx);
      const fields = prepareCreateFields(params);
      const todo = store.create(fields.subject, fields.description, fields.status, fields.activeForm, fields.metadata);
      if (todo.status === "in_progress") activeTaskId = todo.id;
      updateTaskWidget(ctx);
      return Promise.resolve(textResult(`Task #${todo.id} created successfully: ${todo.subject}`));
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "task_list",
    description: TASK_LIST_DESCRIPTION,
    promptGuidelines: TASK_LIST_GUIDELINES,
    parameters: Type.Object({}),
    execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      prepareStore(ctx);
      const todos = sortTasksForAllView(store.list());
      if (todos.length === 0) return Promise.resolve(textResult("No tasks found"));
      return Promise.resolve(textResult(todos.map((todo) => formatTaskLine(todo, store)).join("\n")));
    },
  });

  pi.registerTool({
    name: "task_get",
    label: "task_get",
    description: TASK_GET_DESCRIPTION,
    promptGuidelines: TASK_GET_GUIDELINES,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      prepareStore(ctx);
      const todo = store.get(params.taskId);
      if (!todo) return Promise.resolve(textResult(`Task #${params.taskId} not found`));
      return Promise.resolve(textResult([`Task #${todo.id}: ${todo.subject}`, ...getTaskDetailLines(todo, store).slice(1)].join("\n")));
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "task_update",
    description: TASK_UPDATE_DESCRIPTION,
    promptGuidelines: TASK_UPDATE_GUIDELINES,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      ...taskUpdateFieldsSchema,
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      prepareStore(ctx);
      const { taskId, ...rawFields } = params;
      const fields = prepareTaskUpdate(taskId, rawFields);
      const { todo, changedFields, warnings } = store.update(taskId, fields);
      if (changedFields.length === 0 && !todo) return Promise.resolve(textResult(`Task #${taskId} not found`));
      const visibleChangedFields = normalizeChangedFields(changedFields, rawFields.metadata !== undefined);
      if (fields.status === "in_progress") activeTaskId = taskId;
      if ((fields.status === "completed" || fields.status === "deleted") && activeTaskId === taskId) activeTaskId = undefined;
      if (fields.status === "deleted") {
        store.deleteFileIfEmpty();
      }
      updateTaskWidget(ctx);
      return Promise.resolve(textResult(formatUpdateMessage(taskId, visibleChangedFields, warnings)));
    },
  });

  pi.registerTool({
    name: "task_batch",
    label: "task_batch",
    description: TASK_BATCH_DESCRIPTION,
    promptGuidelines: TASK_BATCH_GUIDELINES,
    parameters: Type.Object({
      operations: Type.Array(taskBatchOperationSchema, { description: "Ordered task operations to apply atomically" }),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      prepareStore(ctx);
      const operations = prepareBatchOperations(params.operations as TaskBatchOperation[]);
      const result = store.write(operations as any);
      if (!result.committed) return Promise.resolve(textResult(formatTaskBatchMessage(result)));
      const visibleResult: TaskBatchResult = {
        ...result,
        operations: result.operations.map((operation) => {
          if (operation.type !== "update") return operation;
          const originalOperation = params.operations[operation.index - 1] as TaskBatchOperation | undefined;
          return {
            ...operation,
            changedFields: normalizeChangedFields(operation.changedFields, !!originalOperation && originalOperation.type === "update" && originalOperation.metadata !== undefined),
          };
        }),
      };
      applyPostWriteTracking(operations);
      if (operations.some((operation) => operation.type === "delete")) {
        store.deleteFileIfEmpty();
      }
      updateTaskWidget(ctx);
      return Promise.resolve(textResult(formatTaskBatchMessage(visibleResult)));
    },
  });
}
