/** Display-only adapters for task results saved before checklist snapshots existed. */
import type { TaskViewRow } from "./task-render.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Recovered display rows, not a mutation of stored task results. */
export type LegacyTaskView = { rows: TaskViewRow[]; warnings: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFrom(value: unknown): TaskViewRow["status"] {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted"
    ? value : "unknown";
}

const STATUS_LABELS = {
  pending: "Pending", in_progress: "In progress", completed: "Completed", deleted: "Deleted", unknown: "Updated",
};

function argumentDetails(args: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (typeof args.description === "string") lines.push(`description: ${args.description}`);
  if (isRecord(args.metadata)) lines.push(`metadata update: ${JSON.stringify(args.metadata)}`);
  return lines;
}

function writeRow(body: string, argument: unknown, rows: Map<string, TaskViewRow>, subjects: Map<string, string>): TaskViewRow | undefined {
  const create = /^Task #(\d+) created successfully: (.*)$/.exec(body) ?? /^Created #(\d+): (.*)$/.exec(body);
  const update = /^Updated task #(\d+)(?: (.*))?$/.exec(body) ?? /^Updated #(\d+): (.*)$/.exec(body);
  const deletion = /^Deleted #(\d+)(?:: (.*))?$/.exec(body);
  const match = create ?? update ?? deletion;
  if (!match) return undefined;
  const id = match[1];
  const previous = rows.get(id);
  const args = isRecord(argument) && (create ? argument.action === "create" : argument.taskId === id) ? argument : {};
  const deleted = Boolean(deletion) || update?.[2] === "deleted";
  const suppliedStatus = statusFrom(args.status);
  const status = deleted ? "deleted" : suppliedStatus !== "unknown" ? suppliedStatus
    : previous?.status ?? (args.action === "create" ? "pending" : "unknown");
  const subject = create?.[2] ?? deletion?.[2] ?? (typeof args.subject === "string" ? args.subject : subjects.get(id));
  if (subject !== undefined) subjects.set(id, subject);
  const fields = update?.[2];
  const changedFields = fields && fields !== "no changes" && !deleted ? fields.split(", ") : [];
  return {
    id, subject: subject ?? STATUS_LABELS[status], status,
    lastAction: deleted ? "delete" : create ? "create" : "update",
    changedFields,
    detailLines: argumentDetails(args),
    noop: Boolean(update) && !deleted && changedFields.length === 0 && !previous,
  };
}

/** Recover only facts present in a successful saved acknowledgement and its original call. */
export function parseLegacyTaskWrite(
  text: string,
  operations: unknown[],
  knownSubjects: ReadonlyMap<string, string> = new Map(),
): (LegacyTaskView & { subjects: Map<string, string> }) | undefined {
  const subjects = new Map(knownSubjects);
  const rows = new Map<string, TaskViewRow>();
  const operationIds = new Map<number, string>();
  const warnings: string[] = [];
  let nextIndex = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("Warnings: ") || line.startsWith("Warning #")) {
      warnings.push(line.replace(/^Warnings: /, "").replace(/operation (\d+): /g, (prefix, index) => {
        const id = operationIds.get(Number(index));
        return id ? `#${id}: ` : prefix;
      }));
      continue;
    }
    const numbered = /^Operation (\d+): (.*)$/.exec(line);
    const index = numbered ? Number(numbered[1]) - 1 : nextIndex;
    const row = writeRow(numbered?.[2] ?? line, operations[index], rows, subjects);
    // Unknown text (including errors) must stay visible, never masquerade as a successful checklist.
    if (!row) return undefined;
    rows.set(row.id, row);
    operationIds.set(index + 1, row.id);
    nextIndex++;
  }
  return rows.size > 0 ? { rows: [...rows.values()], warnings, subjects } : undefined;
}

const STATS_SUFFIX = / · ((?:\d+(?:h \d+m|m \d+s|s)|[\d,]+ tools?|[\d,]+ tokens)(?: · (?:[\d,]+ tools?|[\d,]+ tokens))*)$/;

function listRow(line: string): TaskViewRow | undefined {
  const match = /^#(\d+) \[(pending|in_progress|completed)\] (.*)$/.exec(line);
  if (!match) return undefined;
  let subject = match[3];
  const stats = STATS_SUFFIX.exec(subject);
  if (stats) subject = subject.slice(0, stats.index);
  const blockers = / \[blocked by (#\d+(?:, #\d+)*)\]$/.exec(subject);
  if (blockers) subject = subject.slice(0, blockers.index);
  return {
    id: match[1], subject, status: statusFrom(match[2]),
    blockedBy: blockers?.[1].split(", ").map((id) => id.slice(1)),
    detailLines: [
      `status: ${match[2]}`,
      ...(stats ? [`stats: ${stats[1]}`] : []),
    ],
  };
}

/** Recover old overview/detail rows without consulting today's task store. */
export function parseLegacyTaskList(text: string): LegacyTaskView | undefined {
  if (text === "No tasks found") return { rows: [], warnings: [] };
  const lines = text.split("\n");
  const detail = /^Task #(\d+): (.*)$/.exec(lines[0]);
  if (detail && lines[1]?.startsWith("status: ")) {
    return { rows: [{
      id: detail[1], subject: detail[2], status: statusFrom(lines[1].slice(8)), detailLines: lines.slice(1),
    }], warnings: [] };
  }
  const rows: TaskViewRow[] = [];
  for (const line of lines) {
    const row = listRow(line);
    if (!row) return undefined;
    rows.push(row);
  }
  return { rows, warnings: [] };
}

/** Normalize modern and flat historical task-write arguments for display. */
export function taskWriteOperations(args: unknown): unknown[] {
  if (!isRecord(args)) return [];
  if (Array.isArray(args.operations)) return args.operations;
  return args.action !== undefined ? [args] : [];
}

function snapshotRows(data: unknown): Array<{ id: string; subject: string; status: unknown }> | undefined {
  if (!isRecord(data) || !Array.isArray(data.rows)) return undefined;
  const rows = [];
  for (const row of data.rows) {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.subject !== "string") return undefined;
    rows.push({ id: row.id, subject: row.subject, status: row.status });
  }
  return rows;
}

/** Resolve titles chronologically on one session branch, keyed by the original tool call ID. */
export function restoreTaskWriteHistory(entries: readonly SessionEntry[]): Map<string, LegacyTaskView> {
  const restored = new Map<string, LegacyTaskView>();
  const calls = new Map<string, Record<string, unknown>>();
  let subjects = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "tasks-cleaned") {
      for (const row of snapshotRows(entry.data) ?? []) subjects.delete(row.id);
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && (block.name === "task_write" || block.name === "task_list")) {
          calls.set(block.id, block.arguments);
        }
      }
      continue;
    }
    if (message.role !== "toolResult" || message.isError) continue;
    if (message.toolName !== "task_write" && message.toolName !== "task_list") continue;
    const args = calls.get(message.toolCallId) ?? {};
    const details = message.details;
    if (isRecord(details) && (details.taskWriteFailed === true || details.committed === false || details.notFound === true)) continue;
    const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    const saved = isRecord(details) && details.kind === message.toolName ? snapshotRows(details) : undefined;
    if (saved) {
      if (message.toolName === "task_list" && !args.taskId) subjects.clear();
      for (const row of saved) {
        if (row.status === "deleted") subjects.delete(row.id);
        else subjects.set(row.id, row.subject);
      }
    } else if (message.toolName === "task_write") {
      const parsed = parseLegacyTaskWrite(text, taskWriteOperations(args), subjects);
      if (!parsed) continue;
      restored.set(message.toolCallId, { rows: parsed.rows, warnings: parsed.warnings });
      subjects = parsed.subjects;
      for (const row of parsed.rows) if (row.status === "deleted") subjects.delete(row.id);
    } else {
      const parsed = parseLegacyTaskList(text);
      if (!parsed) continue;
      if (!args.taskId) subjects.clear();
      for (const row of parsed.rows) subjects.set(row.id, row.subject);
    }
  }
  return restored;
}
