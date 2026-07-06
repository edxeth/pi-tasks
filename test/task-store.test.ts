import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore (in-memory)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("creates todos with auto-incrementing IDs", () => {
    const first = store.create("First todo", "Description 1");
    const second = store.create("Second todo", "Description 2");

    expect(first.id).toBe("1");
    expect(second.id).toBe("2");
    expect(first.status).toBe("pending");
  });

  it("creates todos with an initial status when provided", () => {
    const first = store.create("First todo", "Description 1", "in_progress");
    const second = store.create("Second todo", "Description 2", "completed");

    expect(first.status).toBe("in_progress");
    expect(second.status).toBe("completed");
  });

  it("rejects invalid initial statuses", () => {
    expect(() => store.create("Bad", "Description", "done" as any)).toThrow("invalid task status: done");
    expect(store.list()).toEqual([]);
  });

  it("rejects invalid update statuses", () => {
    store.create("Task", "Desc");

    expect(() => store.update("1", { status: "done" as any })).toThrow("invalid task status: done");
    expect(store.get("1")?.status).toBe("pending");
  });

  it("updates multiple fields", () => {
    store.create("Task", "Desc");
    const result = store.update("1", {
      subject: "Updated",
      description: "New desc",
      metadata: { review: "done" },
    });

    expect(result.changedFields).toEqual(["subject", "description", "metadata"]);
    expect(store.get("1")).toMatchObject({
      subject: "Updated",
      description: "New desc",
      metadata: { review: "done" },
    });
  });

  it("maintains bidirectional blockers", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");

    store.update("2", { addBlockedBy: ["1"] });

    expect(store.get("1")?.blocks).toEqual(["2"]);
    expect(store.get("2")?.blockedBy).toEqual(["1"]);
  });

  it("removes blocker edges when deleting", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("1", { addBlocks: ["2"] });

    store.update("1", { status: "deleted" });

    expect(store.get("2")?.blockedBy).toEqual([]);
  });

  it("clears completed todos", () => {
    store.create("Done", "Desc");
    store.create("Open", "Desc");
    store.update("1", { status: "completed" });

    expect(store.clearCompleted()).toBe(1);
    expect(store.list().map((todo) => todo.id)).toEqual(["2"]);
  });

  it("keeps warnings for cycles, self refs, and dangling refs", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { addBlocks: ["2"] });

    expect(store.update("2", { addBlocks: ["1"] }).warnings).toContain("cycle: #2 and #1 block each other");
    expect(store.update("1", { addBlocks: ["1"] }).warnings).toContain("#1 blocks itself");
    expect(store.update("1", { addBlocks: ["999"] }).warnings).toContain("#999 does not exist");
  });

  it("orders in-progress, unblocked pending, blocked pending, and completed todos deterministically", () => {
    store.create("Completed blocker", "Desc");
    store.create("Blocked pending", "Desc");
    store.create("In progress", "Desc");
    store.create("Open blocker", "Desc");
    store.create("Unblocked pending", "Desc");

    store.update("2", { addBlockedBy: ["4", "1"] });
    store.update("3", { status: "in_progress" });
    store.update("1", { status: "completed" });

    expect(store.list().map((todo) => `${todo.id}:${todo.status}`)).toEqual([
      "3:in_progress",
      "4:pending",
      "5:pending",
      "2:pending",
      "1:completed",
    ]);
  });

  it("applies task_write operations atomically in memory", () => {
    store.create("Existing", "Desc");

    const result = store.write([
      { type: "create", subject: "Batch create", description: "Desc", status: "in_progress" },
      { type: "update", taskId: "1", status: "in_progress" },
      { type: "update", taskId: "2", addBlockedBy: ["1", "999"] },
    ]);

    expect(result.committed).toBe(true);
    expect(store.get("1")?.status).toBe("in_progress");
    expect(store.get("2")?.status).toBe("in_progress");
    expect(store.get("2")?.blockedBy).toEqual(["1", "999"]);
    expect(result.operations).toMatchObject([
      { index: 1, type: "create", taskId: "2", subject: "Batch create", warnings: [] },
      { index: 2, type: "update", taskId: "1", changedFields: ["status"], warnings: [] },
      { index: 3, type: "update", taskId: "2", changedFields: ["blockedBy"], warnings: ["#999 does not exist"] },
    ]);
  });

  it("does not partially commit task_write when one operation fails", () => {
    store.create("Existing", "Desc");

    const result = store.write([
      { type: "create", subject: "No commit", description: "Desc" },
      { type: "update", taskId: "99", status: "completed" },
    ]);

    expect(result).toEqual({
      committed: false,
      operations: [],
      error: "operation 2 update task #99 not found",
    });
    expect(store.list().map((todo) => `${todo.id}:${todo.subject}:${todo.status}`)).toEqual([
      "1:Existing:pending",
    ]);
  });

  it("does not partially commit task_write when an operation has an invalid status", () => {
    store.create("Existing", "Desc");

    const result = store.write([
      { type: "create", subject: "No commit", description: "Desc" },
      { type: "update", taskId: "1", status: "done" as any },
    ]);

    expect(result).toEqual({
      committed: false,
      operations: [],
      error: "operation 2 has invalid task status: done",
    });
    expect(store.list().map((todo) => `${todo.id}:${todo.subject}:${todo.status}`)).toEqual([
      "1:Existing:pending",
    ]);
  });
});

describe("TaskStore (file-backed)", () => {
  let storePath: string;

  beforeEach(() => {
    storePath = join(tmpdir(), `pi-tasks-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    rmSync(storePath, { recursive: true, force: true });
  });

  it("persists per-task files and reloads in stable order", () => {
    const first = new TaskStore(storePath);
    first.create("First", "Desc");
    first.create("Second", "Desc");

    expect(existsSync(join(storePath, "1.json"))).toBe(true);
    expect(existsSync(join(storePath, "2.json"))).toBe(true);

    const second = new TaskStore(storePath);
    expect(second.list().map((todo) => todo.id)).toEqual(["1", "2"]);
    expect(second.list().map((todo) => todo.subject)).toEqual(["First", "Second"]);
  });

  it("persists completed entries in their own task files", () => {
    const store = new TaskStore(storePath);
    store.create("Open", "Desc");
    store.create("Done", "Desc");
    store.update("2", { status: "completed" });

    const raw = JSON.parse(readFileSync(join(storePath, "2.json"), "utf-8"));
    expect(raw.status).toBe("completed");
  });

  it("does not reuse deleted IDs across new creates and restarts", () => {
    const first = new TaskStore(storePath);
    first.create("One", "Desc");
    first.create("Two", "Desc");
    first.update("1", { status: "deleted" });
    const third = first.create("Three", "Desc");

    expect(third.id).toBe("3");

    const reloaded = new TaskStore(storePath);
    expect(reloaded.list().map((todo) => todo.id)).toEqual(["2", "3"]);
    expect(reloaded.create("Four", "Desc").id).toBe("4");
  });

  it("keeps canonical ordering stable after restart", () => {
    const first = new TaskStore(storePath);
    first.create("Completed blocker", "Desc");
    first.create("Blocked pending", "Desc");
    first.create("In progress", "Desc");
    first.create("Open blocker", "Desc");
    first.create("Unblocked pending", "Desc");

    first.update("2", { addBlockedBy: ["4", "1"] });
    first.update("3", { status: "in_progress" });
    first.update("1", { status: "completed" });

    const reloaded = new TaskStore(storePath);
    expect(reloaded.list().map((todo) => todo.id)).toEqual(["3", "4", "5", "2", "1"]);
  });

  it("preserves the high-water mark after clearing all tasks", () => {
    const first = new TaskStore(storePath);
    first.create("Only", "Desc");
    first.clearAll();

    expect(first.deleteFileIfEmpty()).toBe(true);

    const second = new TaskStore(storePath);
    expect(second.create("Next", "Desc").id).toBe("2");
  });

  it("keeps task_write all-or-nothing on disk when a later operation fails", () => {
    const store = new TaskStore(storePath);
    store.create("Existing", "Desc");

    const result = store.write([
      { type: "create", subject: "No commit", description: "Desc" },
      { type: "update", taskId: "99", status: "completed" },
    ]);

    expect(result.committed).toBe(false);
    expect(existsSync(join(storePath, "2.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(storePath, "1.json"), "utf-8"))).toMatchObject({
      id: "1",
      subject: "Existing",
      status: "pending",
    });
  });

  it("recovers from a stale lock file", () => {
    const store = new TaskStore(storePath);
    writeFileSync(join(storePath, ".lock"), "999999");

    const created = store.create("Recovered", "Desc");

    expect(created.id).toBe("1");
    expect(store.list().map((todo) => todo.subject)).toEqual(["Recovered"]);
  });
});
