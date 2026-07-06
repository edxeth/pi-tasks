/** Global file-backed task store with CRUD, dependency management, and file locking. */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task, TaskStatus } from "./task-types.js";

export const TASKS_DIR = join(homedir(), ".pi", "tasks");
const HIGH_WATER_MARK_FILE = ".highwatermark";
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function isTaskStatus(status: unknown): status is TaskStatus {
  return status === "pending" || status === "in_progress" || status === "completed";
}

function isTaskUpdateStatus(status: unknown): status is TaskStatus | "deleted" {
  return isTaskStatus(status) || status === "deleted";
}

function getInvalidTaskStatusError(status: unknown): string | undefined {
  if (typeof status === "string") return `invalid task status: ${status}`;
  return `invalid task status: ${JSON.stringify(status)}`;
}

function assertTaskStatus(status: unknown): asserts status is TaskStatus {
  if (!isTaskStatus(status)) throw new Error(getInvalidTaskStatusError(status));
}

function assertTaskUpdateStatus(status: unknown): asserts status is TaskStatus | "deleted" {
  if (!isTaskUpdateStatus(status)) throw new Error(getInvalidTaskStatusError(status));
}

type TaskUpdateFields = {
  status?: TaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  metadata?: Record<string, any>;
  addBlocks?: string[];
  addBlockedBy?: string[];
};

type TaskBatchOperation =
  | {
      type: "create";
      subject: string;
      description: string;
      status?: TaskStatus;
      activeForm?: string;
      metadata?: Record<string, any>;
    }
  | ({
      type: "update";
      taskId: string;
    } & TaskUpdateFields)
  | {
      type: "delete";
      taskId: string;
    };

type TaskBatchOperationResult =
  | {
      index: number;
      type: "create";
      taskId: string;
      subject: string;
      warnings: string[];
    }
  | {
      index: number;
      type: "update";
      taskId: string;
      changedFields: string[];
      warnings: string[];
    }
  | {
      index: number;
      type: "delete";
      taskId: string;
      warnings: string[];
    };

export type TaskBatchResult = {
  committed: boolean;
  operations: TaskBatchOperationResult[];
  error?: string;
};

function getSafePathSegment(value: string): string {
  return /^[a-zA-Z0-9._-]+$/.test(value) ? value : Buffer.from(value).toString("base64url");
}

export function getSessionTaskDirPath(sessionKey: string): string {
  return join(TASKS_DIR, getSafePathSegment(sessionKey));
}

export function getSessionTaskSnapshotDirPath(sessionKey: string, leafId: string): string {
  return join(getSessionTaskDirPath(sessionKey), ".tree", getSafePathSegment(leafId));
}

function getTaskFilePath(storePath: string, id: string): string {
  return join(storePath, `${id}.json`);
}

function isTaskFileName(fileName: string): boolean {
  return /^\d+\.json$/.test(fileName);
}

function copyDirectoryRecursive(sourcePath: string, targetPath: string): void {
  if (!existsSync(sourcePath)) return;
  rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(targetPath, { recursive: true });
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.name === ".lock") continue;
    const sourceEntryPath = join(sourcePath, entry.name);
    const targetEntryPath = join(targetPath, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourceEntryPath, targetEntryPath);
      continue;
    }
    writeFileSync(targetEntryPath, readFileSync(sourceEntryPath));
  }
}

function copyTopLevelTaskFiles(sourcePath: string, targetPath: string, resetTarget = true): void {
  if (!existsSync(sourcePath)) return;
  if (resetTarget) rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(targetPath, { recursive: true });
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!isTaskFileName(entry.name) && entry.name !== HIGH_WATER_MARK_FILE) continue;
    const sourceEntryPath = join(sourcePath, entry.name);
    const targetEntryPath = join(targetPath, entry.name);
    writeFileSync(targetEntryPath, readFileSync(sourceEntryPath));
  }
}

export function copyTaskStore(sourcePath: string, targetPath: string): void {
  copyDirectoryRecursive(sourcePath, targetPath);
}

export function snapshotTaskStore(sourcePath: string, snapshotPath: string): void {
  copyTopLevelTaskFiles(sourcePath, snapshotPath);
}

export function restoreTaskStoreSnapshot(snapshotPath: string, targetPath: string): void {
  if (!existsSync(snapshotPath)) return;
  if (existsSync(targetPath)) {
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!isTaskFileName(entry.name) && entry.name !== HIGH_WATER_MARK_FILE && entry.name !== ".lock") continue;
      unlinkSync(join(targetPath, entry.name));
    }
  }
  copyTopLevelTaskFiles(snapshotPath, targetPath, false);
}

function cloneTask(todo: Task): Task {
  return {
    ...todo,
    metadata: { ...(todo.metadata ?? {}) },
    blocks: [...todo.blocks],
    blockedBy: [...todo.blockedBy],
  };
}

function cloneTasks(todos: Map<string, Task>): Map<string, Task> {
  return new Map([...todos.entries()].map(([id, todo]) => [id, cloneTask(todo)]));
}

function sortTaskIds(ids: Iterable<string>): string[] {
  return [...ids].sort((left, right) => compareTaskIds({ id: left }, { id: right }));
}

export function compareTaskIds(left: { id: string }, right: { id: string }): number {
  const leftId = Number.parseInt(left.id, 10);
  const rightId = Number.parseInt(right.id, 10);
  if (!Number.isNaN(leftId) && !Number.isNaN(rightId)) return leftId - rightId;
  return left.id.localeCompare(right.id);
}

function getOpenBlockerIds(todo: Task, todos: Map<string, Task>): string[] {
  return [...todo.blockedBy]
    .filter((id) => {
      const blocker = todos.get(id);
      return blocker && blocker.status !== "completed";
    })
    .sort((left, right) => compareTaskIds({ id: left }, { id: right }));
}

function getCanonicalOrderRank(todo: Task, todos: Map<string, Task>): number {
  if (todo.status === "in_progress") return 0;
  if (todo.status === "pending") return getOpenBlockerIds(todo, todos).length > 0 ? 2 : 1;
  return 3;
}

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (error: any) {
      if (error.code === "EEXIST") {
        try {
          const pid = Number.parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // ignore stale lock read errors
        }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) {
          // busy wait
        }
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore lock cleanup errors
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;
  private nextId = 1;
  private todos = new Map<string, Task>();

  constructor(filePath?: string) {
    if (!filePath) return;
    mkdirSync(filePath, { recursive: true });
    this.filePath = filePath;
    this.lockPath = join(filePath, ".lock");
    this.load();
  }

  getFilePath(): string | undefined {
    return this.filePath;
  }

  private getHighWaterMarkPath(): string | undefined {
    if (!this.filePath) return undefined;
    return join(this.filePath, HIGH_WATER_MARK_FILE);
  }

  private readHighWaterMark(): number {
    const highWaterMarkPath = this.getHighWaterMarkPath();
    if (!highWaterMarkPath || !existsSync(highWaterMarkPath)) return 0;
    try {
      const value = Number.parseInt(readFileSync(highWaterMarkPath, "utf-8").trim(), 10);
      return Number.isNaN(value) ? 0 : value;
    } catch {
      return 0;
    }
  }

  private writeHighWaterMark(id: number): void {
    const highWaterMarkPath = this.getHighWaterMarkPath();
    if (!highWaterMarkPath) return;
    const nextValue = Math.max(this.readHighWaterMark(), id);
    const tmpPath = `${highWaterMarkPath}.tmp`;
    writeFileSync(tmpPath, String(nextValue));
    renameSync(tmpPath, highWaterMarkPath);
  }

  private writeTaskFile(todo: Task): void {
    if (!this.filePath) return;
    const todoPath = getTaskFilePath(this.filePath, todo.id);
    const tmpPath = `${todoPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(todo, null, 2));
    renameSync(tmpPath, todoPath);
  }

  private deleteTaskFile(id: string): void {
    if (!this.filePath) return;
    try {
      unlinkSync(getTaskFilePath(this.filePath, id));
    } catch {
      // ignore missing file cleanup errors
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;

    const highWaterMark = this.readHighWaterMark();
    let highestId = highWaterMark;
    this.todos.clear();

    for (const fileName of readdirSync(this.filePath)) {
      if (!isTaskFileName(fileName)) continue;
      try {
        const todo = JSON.parse(readFileSync(join(this.filePath, fileName), "utf-8")) as Task;
        this.todos.set(todo.id, todo);
        const numericId = Number.parseInt(todo.id, 10);
        if (!Number.isNaN(numericId)) highestId = Math.max(highestId, numericId);
      } catch {
        // ignore corrupted task files
      }
    }

    this.nextId = highestId + 1;
  }

  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load();
      return fn();
    } finally {
      releaseLock(this.lockPath);
    }
  }

  private commitState(todos: Map<string, Task>, nextId: number): void {
    const previousIds = new Set(this.todos.keys());
    this.todos = todos;
    this.nextId = nextId;

    for (const todo of [...this.todos.values()].sort(compareTaskIds)) {
      this.writeTaskFile(todo);
      previousIds.delete(todo.id);
    }

    for (const id of sortTaskIds(previousIds)) {
      this.deleteTaskFile(id);
    }

    this.writeHighWaterMark(Math.max(nextId - 1, 0));
  }

  private createInState(
    todos: Map<string, Task>,
    nextId: number,
    subject: string,
    description: string,
    status?: TaskStatus,
    activeForm?: string,
    metadata?: Record<string, any>,
  ): { todo: Task; nextId: number } {
    const now = Date.now();
    const todo: Task = {
      id: String(nextId),
      subject,
      description,
      status: status ?? "pending",
      activeForm,
      metadata: metadata ?? {},
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    };
    todos.set(todo.id, todo);
    return { todo, nextId: nextId + 1 };
  }

  private deleteInState(todos: Map<string, Task>, id: string): boolean {
    if (!todos.has(id)) return false;
    todos.delete(id);

    for (const todo of todos.values()) {
      const nextBlocks = todo.blocks.filter((blockedId) => blockedId !== id);
      const nextBlockedBy = todo.blockedBy.filter((blockerId) => blockerId !== id);
      if (nextBlocks.length === todo.blocks.length && nextBlockedBy.length === todo.blockedBy.length) continue;
      todo.blocks = nextBlocks;
      todo.blockedBy = nextBlockedBy;
      todo.updatedAt = Date.now();
    }

    return true;
  }

  private updateInState(
    todos: Map<string, Task>,
    id: string,
    fields: TaskUpdateFields,
  ): { todo: Task | undefined; changedFields: string[]; warnings: string[] } {
    const todo = todos.get(id);
    if (!todo) return { todo: undefined, changedFields: [], warnings: [] };

    if (fields.status === "deleted") {
      this.deleteInState(todos, id);
      return { todo: undefined, changedFields: ["deleted"], warnings: [] };
    }

    const changedFields: string[] = [];
    const warnings: string[] = [];
    const touch = (current: Task) => {
      current.updatedAt = Date.now();
    };

    if (fields.status !== undefined) {
      todo.status = fields.status;
      changedFields.push("status");
    }
    if (fields.subject !== undefined) {
      todo.subject = fields.subject;
      changedFields.push("subject");
    }
    if (fields.description !== undefined) {
      todo.description = fields.description;
      changedFields.push("description");
    }
    if (fields.activeForm !== undefined) {
      todo.activeForm = fields.activeForm;
      changedFields.push("activeForm");
    }
    if (fields.metadata !== undefined) {
      todo.metadata ??= {};
      for (const [key, value] of Object.entries(fields.metadata)) {
        if (value === null) delete todo.metadata[key];
        else todo.metadata[key] = value;
      }
      changedFields.push("metadata");
    }

    if (fields.addBlocks?.length) {
      for (const targetId of fields.addBlocks) {
        if (!todo.blocks.includes(targetId)) todo.blocks.push(targetId);
        const target = todos.get(targetId);
        if (target && !target.blockedBy.includes(id)) {
          target.blockedBy.push(id);
          touch(target);
        }
        if (targetId === id) warnings.push(`#${id} blocks itself`);
        else if (!target) warnings.push(`#${targetId} does not exist`);
        else if (target.blocks.includes(id)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
      }
      changedFields.push("blocks");
    }

    if (fields.addBlockedBy?.length) {
      for (const targetId of fields.addBlockedBy) {
        if (!todo.blockedBy.includes(targetId)) todo.blockedBy.push(targetId);
        const target = todos.get(targetId);
        if (target && !target.blocks.includes(id)) {
          target.blocks.push(id);
          touch(target);
        }
        if (targetId === id) warnings.push(`#${id} blocks itself`);
        else if (!target) warnings.push(`#${targetId} does not exist`);
        else if (todo.blocks.includes(targetId)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
      }
      changedFields.push("blockedBy");
    }

    if (changedFields.length > 0) touch(todo);

    return {
      todo,
      changedFields,
      warnings: [...new Set(warnings)],
    };
  }

  create(subject: string, description: string, status?: TaskStatus, activeForm?: string, metadata?: Record<string, any>): Task {
    if (status !== undefined) assertTaskStatus(status);
    return this.withLock(() => {
      const todos = cloneTasks(this.todos);
      const { todo, nextId } = this.createInState(todos, this.nextId, subject, description, status, activeForm, metadata);
      this.commitState(todos, nextId);
      return todo;
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    const todo = this.todos.get(id);
    return todo ? cloneTask(todo) : undefined;
  }

  list(): Task[] {
    if (this.filePath) this.load();
    return Array.from(this.todos.values())
      .sort((left, right) => {
        const rank = getCanonicalOrderRank(left, this.todos) - getCanonicalOrderRank(right, this.todos);
        return rank !== 0 ? rank : compareTaskIds(left, right);
      })
      .map(cloneTask);
  }

  update(id: string, fields: TaskUpdateFields): { todo: Task | undefined; changedFields: string[]; warnings: string[] } {
    if (fields.status !== undefined) assertTaskUpdateStatus(fields.status);
    return this.withLock(() => {
      const todos = cloneTasks(this.todos);
      const result = this.updateInState(todos, id, fields);
      if (!result.todo && result.changedFields.length === 0) return result;
      this.commitState(todos, this.nextId);
      return result;
    });
  }

  write(operations: TaskBatchOperation[]): TaskBatchResult {
    return this.withLock(() => {
      const todos = cloneTasks(this.todos);
      let nextId = this.nextId;
      const results: TaskBatchOperationResult[] = [];

      for (const [index, operation] of operations.entries()) {
        const operationIndex = index + 1;

        if (operation.type === "create") {
          if (operation.status !== undefined && !isTaskStatus(operation.status)) {
            return {
              committed: false,
              operations: [],
              error: `operation ${operationIndex} has ${getInvalidTaskStatusError(operation.status)}`,
            };
          }
          const created = this.createInState(
            todos,
            nextId,
            operation.subject,
            operation.description,
            operation.status,
            operation.activeForm,
            operation.metadata,
          );
          nextId = created.nextId;
          results.push({
            index: operationIndex,
            type: "create",
            taskId: created.todo.id,
            subject: created.todo.subject,
            warnings: [],
          });
          continue;
        }

        if (operation.type === "update") {
          if (operation.status !== undefined && !isTaskUpdateStatus(operation.status)) {
            return {
              committed: false,
              operations: [],
              error: `operation ${operationIndex} has ${getInvalidTaskStatusError(operation.status)}`,
            };
          }
          const { taskId, type: _type, ...fields } = operation;
          const updated = this.updateInState(todos, taskId, fields);
          if (!updated.todo && updated.changedFields.length === 0) {
            return {
              committed: false,
              operations: [],
              error: `operation ${operationIndex} update task #${taskId} not found`,
            };
          }
          results.push({
            index: operationIndex,
            type: "update",
            taskId,
            changedFields: updated.changedFields,
            warnings: updated.warnings,
          });
          continue;
        }

        if (operation.type === "delete") {
          if (!this.deleteInState(todos, operation.taskId)) {
            return {
              committed: false,
              operations: [],
              error: `operation ${operationIndex} delete task #${operation.taskId} not found`,
            };
          }
          results.push({
            index: operationIndex,
            type: "delete",
            taskId: operation.taskId,
            warnings: [],
          });
          continue;
        }

        return {
          committed: false,
          operations: [],
          error: `operation ${operationIndex} has an invalid type`,
        };
      }

      this.commitState(todos, nextId);
      return {
        committed: true,
        operations: results,
      };
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      const todos = cloneTasks(this.todos);
      if (!this.deleteInState(todos, id)) return false;
      this.commitState(todos, this.nextId);
      return true;
    });
  }

  clearAll(): number {
    return this.withLock(() => {
      const count = this.todos.size;
      this.commitState(new Map(), this.nextId);
      return count;
    });
  }

  clearCompleted(): number {
    return this.withLock(() => {
      const todos = cloneTasks(this.todos);
      const completedIds = new Set(
        Array.from(todos.values())
          .filter((todo) => todo.status === "completed")
          .map((todo) => todo.id),
      );
      if (completedIds.size === 0) return 0;

      for (const id of completedIds) {
        todos.delete(id);
      }

      for (const todo of todos.values()) {
        const nextBlocks = todo.blocks.filter((blockedId) => !completedIds.has(blockedId));
        const nextBlockedBy = todo.blockedBy.filter((blockerId) => !completedIds.has(blockerId));
        if (nextBlocks.length === todo.blocks.length && nextBlockedBy.length === todo.blockedBy.length) continue;
        todo.blocks = nextBlocks;
        todo.blockedBy = nextBlockedBy;
        todo.updatedAt = Date.now();
      }

      this.commitState(todos, this.nextId);
      return completedIds.size;
    });
  }

  deleteFileIfEmpty(): boolean {
    if (!this.filePath) return false;
    this.load();
    return this.todos.size === 0;
  }
}
