/** Compact TUI rendering for task_write and task_list. */

import { keyText, type EntryRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { TaskBatchResult } from "./task-store.js";
import { parseLegacyTaskList, parseLegacyTaskWrite, taskWriteOperations, type LegacyTaskView } from "./task-legacy.js";

// Match Pi's generic/read/write preview length; Pi does not export a shared limit.
const COMPACT_ROW_LIMIT = 10;
const ROW_INDENT = "  ";
const DETAIL_INDENT = "    ";

type TaskViewStatus = "pending" | "in_progress" | "completed" | "deleted" | "unknown";

/** Persisted display data for one task, independent of the live store. */
export type TaskViewRow = {
  id: string;
  subject: string;
  status: TaskViewStatus;
  detailLines?: string[];
  blockedBy?: string[];
  lastAction?: "create" | "update" | "delete";
  changedFields?: string[];
  noop?: boolean;
};

type TaskWriteSnapshot = {
  kind: "task_write";
  committed: boolean;
  error?: string;
  rows: TaskViewRow[];
  warnings: string[];
  opCount: number;
};

type TaskListSnapshot = {
  kind: "task_list";
  taskId?: string;
  notFound?: boolean;
  rows: TaskViewRow[];
};

type ThemeLike = Pick<Theme, "fg" | "bold" | "strikethrough">;

type RenderCtx = {
  args: unknown;
  lastComponent: Component | undefined;
  isPartial: boolean;
  expanded: boolean;
  isError: boolean;
};

type ToolResultLike = {
  content: Array<{ type: string; text?: string }>;
  details: unknown;
};

class TaskToolView implements Component {
  private lines: string[] = [];
  private wrapLines = false;

  setLines(lines: string[], wrapLines: boolean): this {
    this.lines = lines;
    this.wrapLines = wrapLines;
    return this;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const maxWidth = width;
    const out: string[] = [];
    for (const line of this.lines) {
      if (this.wrapLines) out.push(...wrapTextWithAnsi(line, maxWidth));
      else out.push(truncateToWidth(line.replace(/[\r\n\t]+/g, " ").trimEnd(), maxWidth, "…"));
    }
    return out;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function writeWarnings(result: TaskBatchResult): string[] {
  return unique(result.operations.flatMap((operation) =>
    operation.warnings.map((warning) => `Warning #${operation.taskId}: ${warning}`),
  ));
}

function contentText(result: ToolResultLike): string {
  return result.content
    .flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("\n");
}

function takeView(context: RenderCtx): TaskToolView {
  return context.lastComponent instanceof TaskToolView ? context.lastComponent : new TaskToolView();
}

function emptyView(context: RenderCtx): Component {
  const view = takeView(context);
  view.setLines([], false);
  return view;
}

function isTaskWriteSnapshot(value: unknown): value is TaskWriteSnapshot {
  return isRecord(value) && value.kind === "task_write";
}

function isTaskListSnapshot(value: unknown): value is TaskListSnapshot {
  return isRecord(value) && value.kind === "task_list";
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function statusIcon(status: TaskViewStatus): string {
  if (status === "unknown") return "•";
  if (status === "completed") return "✓";
  if (status === "in_progress") return "◉";
  if (status === "deleted") return "×";
  return "○";
}

function statusColor(status: TaskViewStatus): Parameters<Theme["fg"]>[0] {
  if (status === "completed") return "success";
  if (status === "in_progress") return "accent";
  if (status === "deleted") return "dim";
  return "dim";
}

function expandHint(hidden: number): string {
  const key = keyText("app.tools.expand");
  return `${key ? `${key} to expand` : "expand"} ${hidden} more ${plural(hidden, "task", "tasks")}`;
}

function subjectFromBefore(before: Map<string, TaskViewRow>, taskId: string): string | undefined {
  const row = before.get(taskId);
  return row?.subject;
}

function formatWriteOperation(
  operation: TaskBatchResult["operations"][number],
  before: Map<string, TaskViewRow>,
): string {
  if (operation.type === "create") return `Created #${operation.taskId}: ${operation.subject}`;

  const deleted = operation.type === "delete" || (operation.type === "update" && operation.changedFields.includes("deleted"));
  if (deleted) {
    const subject = subjectFromBefore(before, operation.taskId);
    return subject ? `Deleted #${operation.taskId}: ${subject}` : `Deleted #${operation.taskId}`;
  }

  if (operation.changedFields.length === 0) return `Updated #${operation.taskId}: no changes`;
  return `Updated #${operation.taskId}: ${operation.changedFields.join(", ")}`;
}

/** Format concise model-facing acknowledgements without operation-number boilerplate. */
export function formatTaskWriteContent(result: TaskBatchResult, before: Map<string, TaskViewRow> = new Map()): string {
  if (!result.committed) {
    return `task_write failed: ${result.error}\nNo changes were committed.`;
  }

  const lines = result.operations.map((operation) => formatWriteOperation(operation, before));
  const warnings = writeWarnings(result);
  if (warnings.length > 0) lines.push(...warnings);
  return lines.join("\n");
}

function foldWriteRows(
  operations: TaskBatchResult["operations"],
  before: Map<string, TaskViewRow>,
  after: Map<string, TaskViewRow>,
): TaskViewRow[] {
  const folded = new Map<string, TaskViewRow>();

  for (const operation of operations) {
    const previous = folded.get(operation.taskId);

    if (operation.type === "create") {
      const row = after.get(operation.taskId) ?? {
        id: operation.taskId,
        subject: operation.subject,
        status: "pending" as const,
      };
      folded.set(operation.taskId, { ...row, lastAction: "create", changedFields: [] });
      continue;
    }

    const deleted = operation.type === "delete" || (operation.type === "update" && operation.changedFields.includes("deleted"));
    if (deleted) {
      const source = previous ?? before.get(operation.taskId) ?? after.get(operation.taskId);
      folded.set(operation.taskId, {
        id: operation.taskId,
        subject: source?.subject ?? operation.taskId,
        status: "deleted",
        detailLines: source?.detailLines?.map((line) => line.startsWith("status:") ? "status: deleted" : line),
        blockedBy: source?.blockedBy,
        lastAction: "delete",
        changedFields: operation.type === "update" ? operation.changedFields : ["deleted"],
      });
      continue;
    }

    const source = after.get(operation.taskId) ?? previous ?? before.get(operation.taskId);
    const changedFields = unique([...(previous?.changedFields ?? []), ...operation.changedFields]);
    folded.set(operation.taskId, {
      id: operation.taskId,
      subject: source?.subject ?? operation.taskId,
      status: source?.status ?? "pending",
      detailLines: source?.detailLines,
      blockedBy: source?.blockedBy,
      lastAction: previous?.lastAction === "create" ? "create" : "update",
      changedFields,
      noop: changedFields.length === 0 && previous?.lastAction !== "create",
    });
  }

  return [...folded.values()];
}

/** Fold a committed batch into stable final-state checklist rows. */
export function makeWriteSnapshot(
  result: TaskBatchResult,
  before: Map<string, TaskViewRow>,
  after: Map<string, TaskViewRow>,
): TaskWriteSnapshot {
  return {
    kind: "task_write",
    committed: result.committed,
    error: result.error,
    rows: result.committed ? foldWriteRows(result.operations, before, after) : [],
    warnings: writeWarnings(result),
    opCount: result.operations.length,
  };
}

function formatBlockedBy(ids: string[] | undefined): string {
  if (!ids || ids.length === 0) return "";
  return ` [blocked by ${ids.map((id) => `#${id}`).join(", ")}]`;
}

function paintRow(row: TaskViewRow, theme: ThemeLike): string {
  const icon = theme.fg(statusColor(row.status), statusIcon(row.status));
  const id = theme.fg("muted", `#${row.id}`);
  const rawSubject = row.subject || `#${row.id}`;
  const subject =
    row.status === "completed" || row.status === "deleted"
      ? theme.strikethrough(theme.fg("muted", rawSubject))
      : rawSubject;
  const blockers = row.blockedBy && row.blockedBy.length > 0 ? theme.fg("muted", formatBlockedBy(row.blockedBy)) : "";
  const noop = row.noop ? theme.fg("dim", " · no changes") : "";
  return `${ROW_INDENT}${icon} ${id} ${subject}${blockers}${noop}`;
}

function paintDetailLines(row: TaskViewRow, theme: ThemeLike): string[] {
  const lines = (row.detailLines ?? []).map((line) => theme.fg("dim", `${DETAIL_INDENT}${line}`));
  if (row.noop) lines.push(theme.fg("dim", `${DETAIL_INDENT}no changes`));
  else if (row.changedFields && row.changedFields.length > 0 && row.lastAction === "update") {
    lines.push(theme.fg("dim", `${DETAIL_INDENT}changed: ${row.changedFields.join(", ")}`));
  }
  return lines;
}

function paintWarnings(warnings: string[], theme: ThemeLike): string[] {
  return warnings.map((warning) => theme.fg("warning", `${ROW_INDENT}! ${warning}`));
}

function paintChecklist(
  rows: TaskViewRow[],
  warnings: string[],
  theme: ThemeLike,
  expanded: boolean,
  emptyLabel: string,
): string[] {
  if (rows.length === 0) {
    return [theme.fg("dim", `${ROW_INDENT}${emptyLabel}`), ...paintWarnings(warnings, theme)];
  }

  const hidden = expanded || rows.length <= COMPACT_ROW_LIMIT ? 0 : rows.length - COMPACT_ROW_LIMIT;
  const visible = hidden > 0 ? rows.slice(0, COMPACT_ROW_LIMIT) : rows;
  const lines: string[] = [];

  for (const row of visible) {
    lines.push(paintRow(row, theme));
    if (expanded) lines.push(...paintDetailLines(row, theme));
  }

  if (!expanded && hidden > 0) {
    lines.push(theme.fg("dim", `${ROW_INDENT}${expandHint(hidden)}`));
  }

  lines.push(...paintWarnings(warnings, theme));
  return lines;
}

function paintError(result: ToolResultLike, theme: ThemeLike): string[] {
  const text = contentText(result).trim() || "task_write failed";
  return text.split("\n").map((line) => theme.fg("error", line));
}

function paintLegacy(result: ToolResultLike, theme: ThemeLike): string[] {
  const text = contentText(result).trim();
  if (!text) return [];
  const color = /^(?:task_write failed:|Task #\d+ not found)/.test(text) ? "error" : "toolOutput";
  return text.split("\n").map((line) => theme.fg(color, line));
}

function header(theme: ThemeLike, title: string, meta?: string): string {
  let line = `▸ ${theme.fg("toolTitle", theme.bold(title))}`;
  if (meta) line += theme.fg("muted", ` · ${meta}`);
  return line;
}

function operationTitle(operation: unknown): string {
  if (!isRecord(operation)) return "Update tasks";
  if (operation.action === "create") return "Create tasks";
  if (operation.action === "delete") return "Delete tasks";
  if (operation.action !== "update") return "Update tasks";
  switch (operation.status) {
    case "in_progress": return "Start tasks";
    case "completed": return "Complete tasks";
    case "pending": return "Queue tasks";
    case "deleted": return "Delete tasks";
    default: return "Update tasks";
  }
}

/** Render the batch header without raw arguments. */
export function renderTaskWriteCall(args: unknown, theme: ThemeLike, context: RenderCtx): Component {
  const view = takeView(context);
  const ops = taskWriteOperations(args);
  const count = ops.length;
  const meta = count > 0 ? `${count} ${plural(count, "change", "changes")}` : undefined;
  const titles = new Set(ops.map(operationTitle));
  const title = titles.size === 1 ? operationTitle(ops[0]) : "Update tasks";
  view.setLines([header(theme, title, meta)], false);
  return view;
}

/** Render a saved write result as a checklist, retaining failures and warnings. */
export function renderTaskWriteResult(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: ThemeLike,
  context: RenderCtx,
  restored?: LegacyTaskView,
): Component {
  const details = result.details;
  if (options.isPartial && !isTaskWriteSnapshot(details)) return emptyView(context);

  const failed =
    context.isError ||
    (isRecord(details) && details.taskWriteFailed === true) ||
    (isTaskWriteSnapshot(details) && details.committed === false);

  const view = takeView(context);
  if (failed) {
    view.setLines(paintError(result, theme), options.expanded);
    return view;
  }

  if (!isTaskWriteSnapshot(details)) {
    const legacy = restored ?? parseLegacyTaskWrite(contentText(result), taskWriteOperations(context.args));
    const lines = legacy ? paintChecklist(legacy.rows, legacy.warnings, theme, options.expanded, "No changes") : paintLegacy(result, theme);
    if (lines.length === 0) return new Container();
    view.setLines(lines, options.expanded);
    return view;
  }

  view.setLines(paintChecklist(details.rows, details.warnings, theme, options.expanded, "No changes"), options.expanded);
  return view;
}

/** Render a list or single-task read header. */
export function renderTaskListCall(args: unknown, theme: ThemeLike, context: RenderCtx): Component {
  const view = takeView(context);
  const rec = isRecord(args) ? args : undefined;
  const taskId = typeof rec?.taskId === "string" && rec.taskId.trim() ? rec.taskId.trim() : undefined;
  if (taskId) {
    view.setLines([header(theme, "Read task", `#${taskId}`)], false);
    return view;
  }
  view.setLines([header(theme, "List tasks")], false);
  return view;
}

/** Render saved task rows, with full details available on expansion. */
export function renderTaskListResult(
  result: ToolResultLike,
  options: { expanded: boolean; isPartial: boolean },
  theme: ThemeLike,
  context: RenderCtx,
): Component {
  const details = result.details;
  if (options.isPartial && !isTaskListSnapshot(details)) return emptyView(context);

  const view = takeView(context);
  if (context.isError) {
    view.setLines(paintError(result, theme), options.expanded);
    return view;
  }

  if (!isTaskListSnapshot(details)) {
    const legacy = parseLegacyTaskList(contentText(result));
    const lines = legacy ? paintChecklist(legacy.rows, legacy.warnings, theme, options.expanded, "No tasks") : paintLegacy(result, theme);
    if (lines.length === 0) return new Container();
    view.setLines(lines, options.expanded);
    return view;
  }

  if (details.notFound) {
    const id = details.taskId ?? "";
    view.setLines([theme.fg("error", `${ROW_INDENT}Task #${id} not found`)], options.expanded);
    return view;
  }

  view.setLines(paintChecklist(details.rows, [], theme, options.expanded, "No tasks"), options.expanded);
  return view;
}

/** Render a durable, model-context-free receipt for the completed tasks removed by cleanup. */
export const renderTaskCleanup: EntryRenderer<{ rows: TaskViewRow[] }> = (entry, { expanded }, theme) => {
  if (!entry.data) return new Container();
  const rows = entry.data.rows;
  const title = `Cleared ${rows.length} completed ${plural(rows.length, "task", "tasks")}`;
  return new TaskToolView().setLines([
    theme.fg("success", `✓ ${theme.bold(title)}`),
    ...paintChecklist(rows, [], theme, expanded, "No completed tasks to clear"),
  ], expanded);
};
