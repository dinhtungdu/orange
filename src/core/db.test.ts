/**
 * Tests for task queries.
 *
 * Tests reading tasks directly from TASK.md files.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Task } from "./types.js";
import { MockGit } from "./git.js";
import { MockGitHub } from "./github.js";
import { MockTmux } from "./tmux.js";
import { MockClock } from "./clock.js";
import { NullLogger } from "./logger.js";
import { saveTask } from "./state.js";
import { listTasks, getTaskById, getTaskByBranch } from "./db.js";

describe("Task Queries", () => {
  let tempDir: string;
  let deps: Deps;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(),
      logger: new NullLogger(),
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
    harness: "claude",
    status: "pending",
    workspace: null,
    tmux_session: null,
    summary: "Test task",
    body: "",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    pr_url: null,
    ...overrides,
  });

  test("listTasks returns empty array when no tasks", async () => {
    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(0);
  });

  test("listTasks returns task from TASK.md file", async () => {
    await saveTask(deps, createTask());

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("abc12345");
  });

  test("listTasks returns all tasks ordered by created_at desc", async () => {
    await saveTask(deps, createTask({ id: "task1", branch: "b1", created_at: "2024-01-01T00:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "task2", branch: "b2", created_at: "2024-01-02T00:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "task3", branch: "b3", created_at: "2024-01-03T00:00:00.000Z" }));

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(3);
    expect(tasks[0].id).toBe("task3");
    expect(tasks[1].id).toBe("task2");
    expect(tasks[2].id).toBe("task1");
  });

  test("listTasks filters by project", async () => {
    await saveTask(deps, createTask({ id: "task1", project: "orange", branch: "b1" }));
    await saveTask(deps, createTask({ id: "task2", project: "coffee", branch: "b2" }));

    const tasks = await listTasks(deps, { project: "orange" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task1");
  });

  test("listTasks filters by status", async () => {
    await saveTask(deps, createTask({ id: "task1", branch: "b1", status: "pending" }));
    await saveTask(deps, createTask({ id: "task2", branch: "b2", status: "working" }));
    await saveTask(deps, createTask({ id: "task3", branch: "b3", status: "done" }));

    const pending = await listTasks(deps, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("task1");

    const working = await listTasks(deps, { status: "working" });
    expect(working).toHaveLength(1);
    expect(working[0].id).toBe("task2");
  });

  test("listTasks filters by both project and status", async () => {
    await saveTask(deps, createTask({ id: "task1", project: "orange", branch: "b1", status: "pending" }));
    await saveTask(deps, createTask({ id: "task2", project: "orange", branch: "b2", status: "working" }));
    await saveTask(deps, createTask({ id: "task3", project: "coffee", branch: "b3", status: "pending" }));

    const tasks = await listTasks(deps, { project: "orange", status: "pending" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task1");
  });

  test("getTaskById returns task", async () => {
    await saveTask(deps, createTask({ id: "abc12345" }));

    const task = await getTaskById(deps, "abc12345");
    expect(task).not.toBeNull();
    expect(task?.id).toBe("abc12345");
  });

  test("getTaskById returns null for non-existent task", async () => {
    const task = await getTaskById(deps, "nonexistent");
    expect(task).toBeNull();
  });

  test("getTaskByBranch returns task", async () => {
    await saveTask(deps, createTask({ id: "abc12345", project: "orange", branch: "feature-x" }));

    const task = await getTaskByBranch(deps, "orange", "feature-x");
    expect(task).not.toBeNull();
    expect(task?.id).toBe("abc12345");
    expect(task?.branch).toBe("feature-x");
  });

  test("getTaskByBranch returns null for non-existent branch", async () => {
    const task = await getTaskByBranch(deps, "orange", "nonexistent");
    expect(task).toBeNull();
  });

  test("listTasks finds tasks with slashes in branch names", async () => {
    await saveTask(deps, createTask({ id: "task1", branch: "feature/auth" }));
    await saveTask(deps, createTask({ id: "task2", branch: "fix/login/oauth" }));
    await saveTask(deps, createTask({ id: "task3", branch: "simple-branch" }));

    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(3);

    const ids = tasks.map(t => t.id).sort();
    expect(ids).toEqual(["task1", "task2", "task3"]);

    // Branch names preserved from frontmatter (not sanitized dir name)
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    expect(byId.task1.branch).toBe("feature/auth");
    expect(byId.task2.branch).toBe("fix/login/oauth");
    expect(byId.task3.branch).toBe("simple-branch");
  });

  test("task directories are named by task ID", async () => {
    await saveTask(deps, createTask({ id: "task1", branch: "feature/auth" }));

    // Directory should be task ID, not branch name
    const { existsSync } = await import("node:fs");
    const idDir = join(tempDir, "tasks", "orange", "task1", "TASK.md");
    const branchDir = join(tempDir, "tasks", "orange", "feature--auth", "TASK.md");
    expect(existsSync(idDir)).toBe(true);
    expect(existsSync(branchDir)).toBe(false);
  });

  test("listTasks filters by project with slashed branches", async () => {
    await saveTask(deps, createTask({ id: "task1", project: "orange", branch: "feature/auth" }));
    await saveTask(deps, createTask({ id: "task2", project: "coffee", branch: "feature/login" }));

    const tasks = await listTasks(deps, { project: "orange" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].branch).toBe("feature/auth");
  });

  test("getTaskById finds task with slashed branch", async () => {
    await saveTask(deps, createTask({ id: "slash1", branch: "feature/auth" }));

    const task = await getTaskById(deps, "slash1");
    expect(task).not.toBeNull();
    expect(task?.branch).toBe("feature/auth");
  });

  test("listTasks reflects changes to TASK.md files", async () => {
    const task = createTask({ id: "task1" });
    await saveTask(deps, task);

    // Verify initial state
    let tasks = await listTasks(deps, {});
    expect(tasks[0].status).toBe("pending");

    // Update the task file
    task.status = "working";
    task.workspace = "orange--1";
    await saveTask(deps, task);

    // Verify updated state
    tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe("working");
    expect(tasks[0].workspace).toBe("orange--1");
  });
});
