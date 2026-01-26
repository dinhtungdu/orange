/**
 * Tests for Dashboard TUI component.
 *
 * Tests rendering output and keyboard navigation using a mock terminal.
 * The dashboard component renders directly to string arrays, so we can
 * test the render output without a full terminal.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Task, Project } from "../core/types.js";
import { MockGit } from "../core/git.js";
import { MockTmux } from "../core/tmux.js";
import { MockClock } from "../core/clock.js";
import { NullLogger } from "../core/logger.js";
import { saveTask } from "../core/state.js";
import { saveProjects } from "../core/state.js";
import { updateTaskInDb } from "../core/db.js";

/**
 * Mock Terminal for testing TUI components.
 * Captures output and simulates input.
 */
class MockTerminal {
  private _columns = 80;
  private _rows = 24;
  private _output: string[] = [];
  private _inputHandler?: (data: string) => void;
  private _resizeHandler?: () => void;

  get columns(): number { return this._columns; }
  get rows(): number { return this._rows; }
  get kittyProtocolActive(): boolean { return false; }
  get output(): string[] { return this._output; }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this._inputHandler = onInput;
    this._resizeHandler = onResize;
  }

  stop(): void {
    this._inputHandler = undefined;
    this._resizeHandler = undefined;
  }

  write(data: string): void {
    this._output.push(data);
  }

  sendInput(data: string): void {
    this._inputHandler?.(data);
  }

  resize(columns: number, rows: number): void {
    this._columns = columns;
    this._rows = rows;
    this._resizeHandler?.();
  }

  clearOutput(): void {
    this._output = [];
  }

  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void { this._output = []; }
  setTitle(_title: string): void {}
}

/**
 * Helper to create a task.
 */
const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: "test123",
  project: "testproj",
  branch: "feature-x",
  status: "pending",
  workspace: null,
  tmux_session: null,
  description: "Test task description",
  created_at: "2024-01-15T10:00:00.000Z",
  updated_at: "2024-01-15T10:00:00.000Z",
  ...overrides,
});

describe("Dashboard Component", () => {
  let tempDir: string;
  let deps: Deps;
  let mockTerminal: MockTerminal;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-dashboard-test-"));
    mockTerminal = new MockTerminal();

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
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

  // Import dashboard dynamically to test the component
  // We test the DashboardComponent's render method directly
  // since it implements the Component interface

  test("renders header with project name when scoped", async () => {
    // Create a task
    const task = createTask({ id: "task1", status: "pending" });
    await saveTask(deps, task);
    await updateTaskInDb(deps, task);

    // Import and create dashboard component
    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { project: "testproj" });

    // Render
    const lines = dashboard.render(80);

    // Check header contains project name
    expect(lines.some(line => line.includes("testproj"))).toBe(true);
  });

  test("renders header with 'all' when global view", async () => {
    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { all: true });

    const lines = dashboard.render(80);

    expect(lines.some(line => line.includes("all"))).toBe(true);
  });

  test("renders status icons for different task statuses", async () => {
    // Create tasks with different statuses
    await saveTask(deps, createTask({ id: "t1", branch: "b1", status: "pending" }));
    await updateTaskInDb(deps, createTask({ id: "t1", branch: "b1", status: "pending" }));

    await saveTask(deps, createTask({ id: "t2", branch: "b2", status: "working" }));
    await updateTaskInDb(deps, createTask({ id: "t2", branch: "b2", status: "working" }));

    await saveTask(deps, createTask({ id: "t3", branch: "b3", status: "needs_human" }));
    await updateTaskInDb(deps, createTask({ id: "t3", branch: "b3", status: "needs_human" }));

    await saveTask(deps, createTask({ id: "t4", branch: "b4", status: "done" }));
    await updateTaskInDb(deps, createTask({ id: "t4", branch: "b4", status: "done" }));

    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { project: "testproj" });
    await dashboard.loadTasks();

    const lines = dashboard.render(80);
    const output = lines.join("\n");

    // Check status icons exist
    expect(output).toContain("○"); // pending
    expect(output).toContain("●"); // working
    expect(output).toContain("◉"); // needs_human
    expect(output).toContain("✓"); // done
  });

  test("renders 'no tasks' message when empty", async () => {
    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { project: "testproj" });
    await dashboard.loadTasks();

    const lines = dashboard.render(80);
    const output = lines.join("\n");

    expect(output).toContain("No tasks");
  });

  test("renders keybindings in footer", async () => {
    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { all: true });

    const lines = dashboard.render(80);
    const output = lines.join("\n");

    // Check footer has key hints
    expect(output).toContain("j/k");
    expect(output).toContain("Enter");
    expect(output).toContain("q:");
  });

  test("cursor navigation with j/k keys", async () => {
    // Create multiple tasks
    await saveTask(deps, createTask({ id: "t1", branch: "b1", created_at: "2024-01-01T00:00:00.000Z" }));
    await updateTaskInDb(deps, createTask({ id: "t1", branch: "b1", created_at: "2024-01-01T00:00:00.000Z" }));

    await saveTask(deps, createTask({ id: "t2", branch: "b2", created_at: "2024-01-02T00:00:00.000Z" }));
    await updateTaskInDb(deps, createTask({ id: "t2", branch: "b2", created_at: "2024-01-02T00:00:00.000Z" }));

    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { project: "testproj" });
    await dashboard.loadTasks();

    // Initial cursor at 0
    expect(dashboard.getCursor()).toBe(0);

    // Move down
    dashboard.handleInput("j");
    expect(dashboard.getCursor()).toBe(1);

    // Move up
    dashboard.handleInput("k");
    expect(dashboard.getCursor()).toBe(0);

    // Can't move above 0
    dashboard.handleInput("k");
    expect(dashboard.getCursor()).toBe(0);
  });

  test("status filter cycling with f key", async () => {
    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { all: true });

    // Initial filter is "all"
    expect(dashboard.getStatusFilter()).toBe("all");

    // Cycle to "active"
    dashboard.handleInput("f");
    expect(dashboard.getStatusFilter()).toBe("active");

    // Cycle to "done"
    dashboard.handleInput("f");
    expect(dashboard.getStatusFilter()).toBe("done");

    // Cycle back to "all"
    dashboard.handleInput("f");
    expect(dashboard.getStatusFilter()).toBe("all");
  });

  test("filter shows in header", async () => {
    const { DashboardComponent } = await import("./index.js");
    const dashboard = new DashboardComponent(deps, { all: true });

    dashboard.handleInput("f"); // Switch to "active"
    const lines = dashboard.render(80);
    const output = lines.join("\n");

    expect(output).toContain("[active]");
  });
});
