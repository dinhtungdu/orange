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
import { saveTask, saveProjects, loadTask } from "../core/state.js";
import { loadPoolState } from "../core/workspace.js";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Helper to create a task.
 */
const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: "test123",
  project: "testproj",
  branch: "feature-x",
  harness: "claude",
  review_harness: "claude",
  status: "pending",
  review_round: 0,
  crash_count: 0,
  workspace: null,
  tmux_session: null,
  summary: "Test task description",
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
    expect(state.data.createMode.summary).toBe("");
  });

  test("tab switches focus between fields", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    expect(state.data.createMode.focusedField).toBe("branch");

    state.handleInput("tab");
    expect(state.data.createMode.focusedField).toBe("summary");

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
    expect(state.data.createMode.summary).toBe("Bug");
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

  // --- View mode tests ---

  test("v key enters view mode with selected task", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", body: "Task body content" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    expect(state.isViewMode()).toBe(false);
    state.handleInput("v");
    expect(state.isViewMode()).toBe(true);
    expect(state.data.viewMode.task?.id).toBe("t1");
    expect(state.data.viewMode.scrollOffset).toBe(0);
  });

  test("v key does nothing when no tasks", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    expect(state.isViewMode()).toBe(false);
  });

  test("escape exits view mode", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    expect(state.isViewMode()).toBe(true);

    state.handleInput("escape");
    expect(state.isViewMode()).toBe(false);
    expect(state.data.viewMode.task).toBeNull();
  });

  test("v key also exits view mode", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    expect(state.isViewMode()).toBe(true);

    state.handleInput("v");
    expect(state.isViewMode()).toBe(false);
  });

  test("j/k scrolls in view mode", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    expect(state.data.viewMode.scrollOffset).toBe(0);

    state.handleInput("j");
    expect(state.data.viewMode.scrollOffset).toBe(1);

    state.handleInput("j");
    expect(state.data.viewMode.scrollOffset).toBe(2);

    state.handleInput("k");
    expect(state.data.viewMode.scrollOffset).toBe(1);
  });

  test("k does not scroll below 0", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    state.handleInput("k");
    expect(state.data.viewMode.scrollOffset).toBe(0);
  });

  test("view mode disables normal navigation", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", created_at: "2024-01-01T00:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2", created_at: "2024-01-02T00:00:00.000Z" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    // j in view mode scrolls, does not move cursor
    state.handleInput("j");
    expect(state.getCursor()).toBe(0);
    expect(state.data.viewMode.scrollOffset).toBe(1);
  });

  test("context keys show view mode hints", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    const keys = state.getContextKeys();
    expect(keys).toContain("j/k:scroll");
    expect(keys).toContain("Esc:close");
  });

  test("context keys show v:view when task selected", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    const keys = state.getContextKeys();
    expect(keys).toContain("v:view");
  });

  test("q exits view mode instead of quitting", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("v");
    expect(state.isViewMode()).toBe(true);

    state.handleInput("q");
    expect(state.isViewMode()).toBe(false);
  });
});

describe("Dashboard Poll Cycle", () => {
  let tempDir: string;
  let deps: Deps;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-poll-test-"));

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      logger: new NullLogger(),
      dataDir: tempDir,
    };

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

  test("orphan cleanup releases workspace for done task", async () => {
    // Create a done task with workspace bound
    const task = createTask({
      id: "done-task",
      branch: "done-branch",
      status: "done",
      workspace: "testproj--1",
      tmux_session: null,
    });
    await saveTask(deps, task);

    // Create workspace directory and seed .pool.json
    const workspacesDir = join(tempDir, "workspaces");
    const workspacePath = join(workspacesDir, "testproj--1");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacesDir, ".pool.json"), JSON.stringify({
      workspaces: { "testproj--1": { status: "bound", task: "testproj/done-branch" } },
    }));

    // Init mock git for the workspace
    const mockGit = deps.git as MockGit;
    mockGit.initRepo(workspacePath, "main");

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    // Verify workspace shows as bound before cleanup
    let poolState = await loadPoolState(deps);
    expect(poolState.workspaces["testproj--1"].status).toBe("bound");

    // Run poll cycle (orphan cleanup clears task.workspace and releases)
    await state.runPollCycle();

    // Check workspace was released (task.workspace cleared, so now available)
    poolState = await loadPoolState(deps);
    expect(poolState.workspaces["testproj--1"].status).toBe("available");
  });

  test("orphan cleanup releases workspace for cancelled task", async () => {
    const task = createTask({
      id: "cancelled-task",
      branch: "cancelled-branch",
      status: "cancelled",
      workspace: "testproj--1",
      tmux_session: null,
    });
    await saveTask(deps, task);

    // Create workspace directory and seed .pool.json
    const workspacesDir = join(tempDir, "workspaces");
    const workspacePath = join(workspacesDir, "testproj--1");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacesDir, ".pool.json"), JSON.stringify({
      workspaces: { "testproj--1": { status: "bound", task: "testproj/cancelled-branch" } },
    }));

    // Init mock git for the workspace
    const mockGit = deps.git as MockGit;
    mockGit.initRepo(workspacePath, "main");

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    const poolState = await loadPoolState(deps);
    expect(poolState.workspaces["testproj--1"].status).toBe("available");
  });

  test("orphan cleanup kills session for terminal task", async () => {
    const mockTmux = deps.tmux as MockTmux;
    // Create a session using the Map interface
    mockTmux.sessions.set("testproj/done-branch", { cwd: "/tmp", command: "echo", output: [] });

    const task = createTask({
      id: "done-task",
      branch: "done-branch",
      status: "done",
      workspace: null,
      tmux_session: "testproj/done-branch",
    });
    await saveTask(deps, task);

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    // Session should be killed
    expect(mockTmux.sessions.has("testproj/done-branch")).toBe(false);
  });

  test("PR discovery populates pr_url for task with existing PR", async () => {
    const mockGitHub = deps.github as MockGitHub;
    mockGitHub.prs.set("feature-x", {
      exists: true,
      url: "https://github.com/test/repo/pull/123",
      state: "OPEN",
      checks: "pass",
    });

    // Task without pr_url
    const task = createTask({
      id: "pr-task",
      branch: "feature-x",
      status: "working",
      review_harness: "claude",
    review_round: 0,
    pr_url: null,
    });
    await saveTask(deps, task);

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    // Reload task and check pr_url was set
    const updatedTask = await loadTask(deps, "testproj", "pr-task");
    expect(updatedTask?.pr_url).toBe("https://github.com/test/repo/pull/123");
  });

  test("PR discovery does not overwrite existing pr_url", async () => {
    const mockGitHub = deps.github as MockGitHub;
    mockGitHub.prs.set("feature-x", {
      exists: true,
      url: "https://github.com/test/repo/pull/999",
      state: "OPEN",
      checks: "pass",
    });

    // Task with existing pr_url
    const task = createTask({
      id: "pr-task",
      branch: "feature-x",
      status: "working",
      pr_url: "https://github.com/test/repo/pull/123",
    });
    await saveTask(deps, task);

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    // pr_url should remain unchanged
    const updatedTask = await loadTask(deps, "testproj", "pr-task");
    expect(updatedTask?.pr_url).toBe("https://github.com/test/repo/pull/123");
  });

  test("PR discovery skips terminal tasks", async () => {
    const mockGitHub = deps.github as MockGitHub;
    mockGitHub.prs.set("done-branch", {
      exists: true,
      url: "https://github.com/test/repo/pull/123",
      state: "MERGED",
      checks: "pass",
    });

    const task = createTask({
      id: "done-task",
      branch: "done-branch",
      status: "done",
      review_harness: "claude",
    review_round: 0,
    pr_url: null,
    });
    await saveTask(deps, task);

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    // pr_url should not be set for terminal tasks
    const updatedTask = await loadTask(deps, "testproj", "done-task");
    expect(updatedTask?.pr_url).toBeNull();
  });
});

describe("Dashboard v2 Features", () => {
  let tempDir: string;
  let deps: Deps;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-v2-test-"));

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      logger: new NullLogger(),
      dataDir: tempDir,
    };

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

  // --- Planning status ---

  test("planning status shows in active filter", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", status: "planning" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2", status: "done" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    // All tasks visible
    expect(state.data.tasks.length).toBe(2);

    // Switch to active filter
    state.handleInput("f");
    expect(state.data.tasks.length).toBe(1);
    expect(state.data.tasks[0].status).toBe("planning");
  });

  test("planning status has correct color", async () => {
    const { STATUS_COLOR } = await import("./state.js");
    expect(STATUS_COLOR.planning).toBeDefined();
    expect(typeof STATUS_COLOR.planning).toBe("string");
  });

  // --- Sorting ---

  test("active tasks sorted before terminal tasks", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "b1", status: "done", updated_at: "2024-01-15T12:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t2", branch: "b2", status: "planning", updated_at: "2024-01-15T09:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t3", branch: "b3", status: "working", updated_at: "2024-01-15T11:00:00.000Z" }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    // Active tasks first (working most recent, then planning), terminal last
    expect(state.data.tasks[0].status).toBe("working");
    expect(state.data.tasks[1].status).toBe("planning");
    expect(state.data.tasks[2].status).toBe("done");
  });

  // --- Context keys ---

  test("context keys show w:workspace for task with live session", async () => {
    const mockTmux = deps.tmux as MockTmux;
    mockTmux.sessions.set("testproj/feature-x", { cwd: "/tmp", command: "", output: [] });

    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "working",
      tmux_session: "testproj/feature-x",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    const keys = state.getContextKeys();
    expect(keys).toContain("w:workspace");
  });

  test("context keys hide w:workspace for dead session", async () => {
    // Task has tmux_session but session doesn't exist in mock
    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "working",
      tmux_session: "testproj/feature-x",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();
    // Mark session as dead
    state.data.deadSessions.add("t1");

    const keys = state.getContextKeys();
    expect(keys).not.toContain("w:workspace");
  });

  test("context keys show R:refresh for task with PR", async () => {
    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "reviewing",
      pr_url: "https://github.com/test/repo/pull/123",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    const keys = state.getContextKeys();
    expect(keys).toContain("R:refresh");
  });

  test("context keys hide R:refresh when no PR", async () => {
    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "reviewing",
      pr_url: null,
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    const keys = state.getContextKeys();
    expect(keys).not.toContain("R:refresh");
  });

  // --- Workspace mode ---

  test("w key enters workspace mode for task with live session", async () => {
    const mockTmux = deps.tmux as MockTmux;
    mockTmux.sessions.set("testproj/feature-x", { cwd: "/tmp", command: "", output: [] });

    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "working",
      tmux_session: "testproj/feature-x",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    expect(state.isWorkspaceMode()).toBe(false);
    state.handleInput("w");
    expect(state.isWorkspaceMode()).toBe(true);
    expect(state.data.workspaceMode.task?.id).toBe("t1");
  });

  test("w key does nothing for task without session", async () => {
    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "pending",
      tmux_session: null,
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("w");
    expect(state.isWorkspaceMode()).toBe(false);
  });

  test("exitWorkspaceMode clears workspace mode", async () => {
    const mockTmux = deps.tmux as MockTmux;
    mockTmux.sessions.set("testproj/feature-x", { cwd: "/tmp", command: "", output: [] });

    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "working",
      tmux_session: "testproj/feature-x",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("w");
    expect(state.isWorkspaceMode()).toBe(true);

    state.exitWorkspaceMode();
    expect(state.isWorkspaceMode()).toBe(false);
    expect(state.data.workspaceMode.task).toBeNull();
  });

  test("onWorkspace listener fires when entering workspace mode", async () => {
    const mockTmux = deps.tmux as MockTmux;
    mockTmux.sessions.set("testproj/feature-x", { cwd: "/tmp", command: "", output: [] });

    await saveTask(deps, createTask({
      id: "t1", branch: "feature-x", status: "working",
      tmux_session: "testproj/feature-x",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    let workspaceTaskId = "";
    state.onWorkspace((task) => { workspaceTaskId = task.id; });

    state.handleInput("w");
    expect(workspaceTaskId).toBe("t1");
  });

  // --- Create form ---

  test("create status toggles between pending and reviewing", async () => {
    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    state.handleInput("c");
    expect(state.data.createMode.status).toBe("pending");

    // Tab to status field
    state.handleInput("tab"); // summary
    state.handleInput("tab"); // harness
    state.handleInput("tab"); // status

    // Toggle
    state.handleInput(" ");
    expect(state.data.createMode.status).toBe("reviewing");

    state.handleInput(" ");
    expect(state.data.createMode.status).toBe("pending");
  });

  // --- Exit monitoring integration ---

  test("exit monitor detects dead sessions via checkDeadSessions", async () => {
    // Create a working task with a tmux session that doesn't exist
    await saveTask(deps, createTask({
      id: "dead-task",
      branch: "dead-branch",
      status: "working",
      tmux_session: "testproj/dead-branch",
      workspace: "testproj--1",
      body: "", // No ## Handoff → will crash
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    // Run exit monitor (session doesn't exist in mock → dead)
    await state.runPollCycle();

    // Task should be marked as dead
    expect(state.data.deadSessions.has("dead-task")).toBe(true);
  });

  test("exit monitor auto-advances working task with valid handoff", async () => {
    // Create a working task with valid ## Handoff that has a dead session
    await saveTask(deps, createTask({
      id: "advance-task",
      branch: "advance-branch",
      status: "working",
      tmux_session: "testproj/advance-branch",
      workspace: "testproj--1",
      body: "## Handoff\n\nDONE: Implemented the feature\nREMAINING: Tests",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    // Run exit monitor
    await state.runPollCycle();

    // Task should have been auto-advanced to agent-review
    const updatedTask = await loadTask(deps, "testproj", "advance-task");
    expect(updatedTask?.status).toBe("agent-review");
  });

  test("exit monitor auto-advances planning task with valid plan", async () => {
    await saveTask(deps, createTask({
      id: "plan-task",
      branch: "plan-branch",
      status: "planning",
      tmux_session: "testproj/plan-branch",
      workspace: "testproj--1",
      body: "## Plan\n\nAPPROACH: Use JWT tokens for auth\nTOUCHING: src/auth/login.ts",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    const updatedTask = await loadTask(deps, "testproj", "plan-task");
    expect(updatedTask?.status).toBe("working");
  });

  test("exit monitor increments crash_count for dead session without artifacts", async () => {
    await saveTask(deps, createTask({
      id: "crash-task",
      branch: "crash-branch",
      status: "working",
      tmux_session: "testproj/crash-branch",
      workspace: "testproj--1",
      crash_count: 0,
      body: "", // No ## Handoff
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    const updatedTask = await loadTask(deps, "testproj", "crash-task");
    expect(updatedTask?.crash_count).toBe(1);
  });

  test("exit monitor moves to stuck after 2 crashes", async () => {
    await saveTask(deps, createTask({
      id: "stuck-task",
      branch: "stuck-branch",
      status: "working",
      tmux_session: "testproj/stuck-branch",
      workspace: "testproj--1",
      crash_count: 1, // Already crashed once
      body: "", // No ## Handoff
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    const updatedTask = await loadTask(deps, "testproj", "stuck-task");
    expect(updatedTask?.status).toBe("stuck");
  });

  test("exit monitor skips tasks without tmux_session", async () => {
    await saveTask(deps, createTask({
      id: "no-session",
      branch: "no-session-branch",
      status: "working",
      tmux_session: null, // No session
      workspace: null,
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    // Should not be marked as dead (no session to check)
    expect(state.data.deadSessions.has("no-session")).toBe(false);
  });

  // --- captureOutputs with planning ---

  test("captureOutputs detects dead planning sessions", async () => {
    // Planning task with dead session (session doesn't exist in mock)
    await saveTask(deps, createTask({
      id: "planning-dead",
      branch: "planning-branch",
      status: "planning",
      tmux_session: "testproj/planning-branch",
    }));

    const { DashboardState } = await import("./state.js");
    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();

    await state.runPollCycle();

    expect(state.data.deadSessions.has("planning-dead")).toBe(true);
  });
});
