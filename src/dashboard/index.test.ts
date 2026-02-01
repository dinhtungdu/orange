/**
 * Tests for Dashboard state machine.
 *
 * Tests state logic, keyboard navigation, and filtering
 * independently of the TUI rendering layer.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Task, Project } from "../core/types.js";
import { MockGit } from "../core/git.js";
import { MockGitHub } from "../core/github.js";
import { MockTmux } from "../core/tmux.js";
import { MockClock } from "../core/clock.js";
import { NullLogger } from "../core/logger.js";
import { saveTask, saveProjects } from "../core/state.js";

/**
 * Helper to create a task.
 */
const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: "test123",
  project: "testproj",
  branch: "feature-x",
  harness: "claude",
  status: "pending",
  workspace: null,
  tmux_session: null,
  description: "Test task description",
  body: "",
  created_at: "2024-01-15T10:00:00.000Z",
  updated_at: "2024-01-15T10:00:00.000Z",
  pr_url: null,
  ...overrides,
});

describe("Dashboard State", () => {
  let tempDir: string;
  let deps: Deps;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-dashboard-test-"));

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      logger: new NullLogger(),
      dataDir: tempDir,
    };

    // Create a test project
    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("loads tasks for project scope", async () => {
    const task = createTask({ id: "task1", status: "pending" });
    await saveTask(deps, task);

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    expect(state.data.tasks.length).toBe(1);
    expect(state.data.projectLabel).toBe("testproj");
  });

  test("initializes with 'all' label for global view", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { all: true });

    expect(state.data.projectLabel).toBe("all");
  });

  test("loads tasks with different statuses", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", status: "pending" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2", status: "working" }));
    await saveTask(deps, createTask({ id: "t3", branch: "b3", status: "reviewing" }));
    await saveTask(deps, createTask({ id: "t4", branch: "b4", status: "done" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    expect(state.data.tasks.length).toBe(4);
  });

  test("shows empty tasks when none exist", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    expect(state.data.tasks.length).toBe(0);
  });

  test("context keys include basic nav and quit", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { all: true });

    const keys = state.getContextKeys();
    expect(keys).toContain("j/k");
    expect(keys).toContain("q:quit");
  });

  test("cursor navigation with j/k keys", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", created_at: "2024-01-01T00:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2", created_at: "2024-01-02T00:00:00.000Z" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    // Initial cursor at 0
    expect(state.getCursor()).toBe(0);

    // Move down
    state.handleInput("j");
    expect(state.getCursor()).toBe(1);

    // Move up
    state.handleInput("k");
    expect(state.getCursor()).toBe(0);

    // Can't move above 0
    state.handleInput("k");
    expect(state.getCursor()).toBe(0);
  });

  test("cursor navigation with arrow keys", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", created_at: "2024-01-01T00:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2", created_at: "2024-01-02T00:00:00.000Z" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("down");
    expect(state.getCursor()).toBe(1);

    state.handleInput("up");
    expect(state.getCursor()).toBe(0);
  });

  test("status filter cycling with f key", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { all: true });

    // Initial filter is "all"
    expect(state.getStatusFilter()).toBe("all");

    // Cycle to "active"
    state.handleInput("f");
    expect(state.getStatusFilter()).toBe("active");

    // Cycle to "done"
    state.handleInput("f");
    expect(state.getStatusFilter()).toBe("done");

    // Cycle back to "all"
    state.handleInput("f");
    expect(state.getStatusFilter()).toBe("all");
  });

  test("filter changes project label indicator", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { all: true });

    state.handleInput("f"); // Switch to "active"
    expect(state.data.statusFilter).toBe("active");
  });

  test("active filter shows only active tasks", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", status: "pending" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2", status: "working" }));
    await saveTask(deps, createTask({ id: "t3", branch: "b3", status: "done" }));
    await saveTask(deps, createTask({ id: "t4", branch: "b4", status: "cancelled" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    // All tasks visible initially
    expect(state.data.tasks.length).toBe(4);

    // Switch to active filter
    state.handleInput("f");
    expect(state.data.tasks.length).toBe(2); // pending + working

    // Switch to done filter
    state.handleInput("f");
    expect(state.data.tasks.length).toBe(2); // done + failed
  });

  test("getSelectedTask returns current task", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    const task = state.getSelectedTask();
    expect(task).toBeDefined();
    expect(task!.project).toBe("testproj");
  });

  test("getSelectedTask returns undefined when no tasks", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    expect(state.getSelectedTask()).toBeUndefined();
  });

  test("onChange listener fires on state changes", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    let changeCount = 0;
    state.onChange(() => changeCount++);

    state.handleInput("j");
    expect(changeCount).toBe(1);

    state.handleInput("f");
    expect(changeCount).toBe(2);
  });

  // --- Create mode tests ---

  test("c key enters create mode when project-scoped", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks(); // Loads installed harnesses

    expect(state.isCreateMode()).toBe(false);
    state.handleInput("c");
    expect(state.isCreateMode()).toBe(true);
    expect(state.data.createMode.focusedField).toBe("branch");
  });

  test("c key shows error in global view", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { all: true });

    state.handleInput("c");
    expect(state.isCreateMode()).toBe(false);
    expect(state.data.error).toContain("project scope");
  });

  test("escape exits create mode", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    expect(state.isCreateMode()).toBe(true);

    state.handleInput("escape");
    expect(state.isCreateMode()).toBe(false);
    expect(state.data.createMode.branch).toBe("");
    expect(state.data.createMode.description).toBe("");
  });

  test("tab switches focus between fields", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    expect(state.data.createMode.focusedField).toBe("branch");

    state.handleInput("tab");
    expect(state.data.createMode.focusedField).toBe("description");

    state.handleInput("tab");
    expect(state.data.createMode.focusedField).toBe("harness");

    state.handleInput("tab");
    expect(state.data.createMode.focusedField).toBe("status");

    state.handleInput("tab");
    expect(state.data.createMode.focusedField).toBe("branch");
  });

  test("typing appends to focused field", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    // Type into branch field
    state.handleInput("f");
    state.handleInput("i");
    state.handleInput("x");
    expect(state.data.createMode.branch).toBe("fix");

    // Switch to description and type
    state.handleInput("tab");
    state.handleInput("B");
    state.handleInput("u");
    state.handleInput("g");
    expect(state.data.createMode.description).toBe("Bug");
  });

  test("backspace removes last character from focused field", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    state.handleInput("a");
    state.handleInput("b");
    state.handleInput("c");
    expect(state.data.createMode.branch).toBe("abc");

    state.handleInput("backspace");
    expect(state.data.createMode.branch).toBe("ab");
  });

  test("branch field rejects invalid characters", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    state.handleInput("a");
    state.handleInput(" "); // spaces not allowed in branch
    state.handleInput("b");
    expect(state.data.createMode.branch).toBe("ab");
  });

  test("branch field allows hyphens, underscores, slashes, dots", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    for (const ch of "fix/bug-1_test.ts") {
      state.handleInput(ch);
    }
    expect(state.data.createMode.branch).toBe("fix/bug-1_test.ts");
  });

  test("enter with empty fields creates task with defaults", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    state.handleInput("enter");
    // Should not show validation error - empty fields are allowed
    // Note: submitCreateTask is async, so we just verify no immediate validation error
    expect(state.data.error).toBeNull();
  });

  test("create mode disables normal navigation keys", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    // j in create mode types 'j' into branch, doesn't move cursor
    state.handleInput("j");
    expect(state.getCursor()).toBe(0);
    expect(state.data.createMode.branch).toBe("j");
  });

  test("context keys show create mode hints", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    const keys = state.getContextKeys();
    expect(keys).toContain("Enter:submit");
    expect(keys).toContain("Escape:cancel");
    expect(keys).toContain("Tab:switch field");
  });

  test("context keys show c:create when project-scoped", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });

    const keys = state.getContextKeys();
    expect(keys).toContain("c:create");
  });

  test("context keys hide c:create in global view", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { all: true });

    const keys = state.getContextKeys();
    expect(keys).not.toContain("c:create");
  });

  test("onChange unsubscribe works", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    let changeCount = 0;
    const unsub = state.onChange(() => changeCount++);

    state.handleInput("j");
    expect(changeCount).toBe(1);

    unsub();
    state.handleInput("k");
    expect(changeCount).toBe(1); // No change after unsub
  });
});
