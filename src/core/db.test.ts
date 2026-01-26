/**
 * Tests for SQLite index cache.
 *
 * Tests database operations and rebuild from task folders.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Task } from "./types.js";
import { MockGit } from "./git.js";
import { MockTmux } from "./tmux.js";
import { MockClock } from "./clock.js";
import { saveTask } from "./state.js";
import { updateTaskInDb, listTasks, getTaskById, rebuildDb } from "./db.js";

describe("SQLite Index Cache", () => {
  let tempDir: string;
  let deps: Deps;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      clock: new MockClock(),
      dataDir: tempDir,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: "abc12345",
    project: "orange",
    branch: "feature-x",
    status: "pending",
    workspace: null,
    tmux_session: null,
    description: "Test task",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  });

  test("updateTaskInDb inserts new task", async () => {
    const task = createTask();
    await updateTaskInDb(deps, task);

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("abc12345");
  });

  test("updateTaskInDb updates existing task", async () => {
    const task = createTask();
    await updateTaskInDb(deps, task);

    task.status = "working";
    task.workspace = "orange--1";
    await updateTaskInDb(deps, task);

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("working");
    expect(tasks[0].workspace).toBe("orange--1");
  });

  test("listTasks returns all tasks ordered by created_at desc", async () => {
    await updateTaskInDb(deps, createTask({ id: "task1", created_at: "2024-01-01T00:00:00.000Z" }));
    await updateTaskInDb(deps, createTask({ id: "task2", created_at: "2024-01-02T00:00:00.000Z" }));
    await updateTaskInDb(deps, createTask({ id: "task3", created_at: "2024-01-03T00:00:00.000Z" }));

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe("task3");
    expect(tasks[1].id).toBe("task2");
    expect(tasks[2].id).toBe("task1");
  });

  test("listTasks filters by project", async () => {
    await updateTaskInDb(deps, createTask({ id: "task1", project: "orange" }));
    await updateTaskInDb(deps, createTask({ id: "task2", project: "coffee" }));

    const tasks = await listTasks(deps, { project: "orange" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task1");
  });

  test("listTasks filters by status", async () => {
    await updateTaskInDb(deps, createTask({ id: "task1", status: "pending" }));
    await updateTaskInDb(deps, createTask({ id: "task2", status: "working" }));
    await updateTaskInDb(deps, createTask({ id: "task3", status: "done" }));

    const pending = await listTasks(deps, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("task1");

    const working = await listTasks(deps, { status: "working" });
    expect(working).toHaveLength(1);
    expect(working[0].id).toBe("task2");
  });

  test("listTasks filters by both project and status", async () => {
    await updateTaskInDb(deps, createTask({ id: "task1", project: "orange", status: "pending" }));
    await updateTaskInDb(deps, createTask({ id: "task2", project: "orange", status: "working" }));
    await updateTaskInDb(deps, createTask({ id: "task3", project: "coffee", status: "pending" }));

    const tasks = await listTasks(deps, { project: "orange", status: "pending" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task1");
  });

  test("getTaskById returns task", async () => {
    await updateTaskInDb(deps, createTask({ id: "abc12345" }));

    const task = await getTaskById(deps, "abc12345");
    expect(task).not.toBeNull();
    expect(task?.id).toBe("abc12345");
  });

  test("getTaskById returns null for non-existent task", async () => {
    const task = await getTaskById(deps, "nonexistent");
    expect(task).toBeNull();
  });

  test("rebuildDb populates from task folders", async () => {
    // Create tasks using file system
    await saveTask(deps, createTask({ id: "task1", project: "orange", branch: "feature-1" }));
    await saveTask(deps, createTask({ id: "task2", project: "orange", branch: "feature-2" }));
    await saveTask(deps, createTask({ id: "task3", project: "coffee", branch: "fix-bug" }));

    // Rebuild from files
    await rebuildDb(deps);

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(3);
  });

  test("rebuildDb clears existing data", async () => {
    // Insert directly
    await updateTaskInDb(deps, createTask({ id: "old-task" }));

    // Create only one task file
    await saveTask(deps, createTask({ id: "new-task", project: "orange", branch: "feature" }));

    // Rebuild
    await rebuildDb(deps);

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("new-task");
  });
});
