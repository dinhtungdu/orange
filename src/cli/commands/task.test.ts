/**
 * Integration tests for task CLI commands.
 *
 * Tests the full task lifecycle: create → spawn → complete/stuck → merge/cancel.
 * Uses mocked tmux/git dependencies for deterministic testing.
 *
 * Note: Tests query the database directly to get task IDs instead of parsing
 * console output to avoid race conditions when tests run in parallel.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Deps,
  Project,
  TaskCreatedEvent,
  StatusChangedEvent,
  AgentStoppedEvent,
} from "../../core/types.js";
import { MockGit } from "../../core/git.js";
import { MockTmux } from "../../core/tmux.js";
import { MockClock } from "../../core/clock.js";
import { parseArgs } from "../args.js";
import { runTaskCommand } from "./task.js";
import { runProjectCommand } from "./project.js";
import { loadTask, loadHistory, saveProjects } from "../../core/state.js";
import { listTasks } from "../../core/db.js";
import { initWorkspacePool } from "../../core/workspace.js";

/**
 * Helper to get task ID from database by branch name.
 * More reliable than parsing console output in parallel test scenarios.
 */
async function getTaskIdByBranch(deps: Deps, branch: string): Promise<string> {
  const tasks = await listTasks(deps, {});
  const task = tasks.find(t => t.branch === branch);
  if (!task) throw new Error(`Task for branch '${branch}' not found`);
  return task.id;
}

describe("task create command", () => {
  let tempDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Initialize database
    // Database is created lazily via ensureDb()

    // Add a test project
    const projects: Project[] = [{
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    }];
    await saveProjects(deps, projects);

    // Capture console output
    consoleLogs = [];
    consoleErrors = [];
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;

    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  });

  test("creates a task with status pending", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "testproj", "feature-x", "Implement feature X"
    ]);

    await runTaskCommand(parsed, deps);

    // Verify task file
    const task = await loadTask(deps, "testproj", "feature-x");
    expect(task).not.toBeNull();
    expect(task!.project).toBe("testproj");
    expect(task!.branch).toBe("feature-x");
    expect(task!.status).toBe("pending");
    expect(task!.description).toBe("Implement feature X");
    expect(task!.workspace).toBeNull();
    expect(task!.tmux_session).toBeNull();

    // Verify console output contains task ID
    expect(consoleLogs[0]).toContain("Created task");
    expect(consoleLogs[0]).toContain("testproj/feature-x");
  });

  test("creates task with multi-word description", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "testproj", "my-branch",
      "This", "is", "a", "multi", "word", "description"
    ]);

    await runTaskCommand(parsed, deps);

    const task = await loadTask(deps, "testproj", "my-branch");
    expect(task!.description).toBe("This is a multi word description");
  });

  test("creates history entry for task creation", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "testproj", "feature-y", "Do something"
    ]);

    await runTaskCommand(parsed, deps);

    const history = await loadHistory(deps, "testproj", "feature-y");
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("task.created");
    const createdEvent = history[0] as TaskCreatedEvent;
    expect(createdEvent.project).toBe("testproj");
    expect(createdEvent.branch).toBe("feature-y");
  });

  test("adds task to SQLite index", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "testproj", "indexed-task", "Test indexing"
    ]);

    await runTaskCommand(parsed, deps);

    const tasks = await listTasks(deps, { project: "testproj" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].branch).toBe("indexed-task");
  });

  test("errors when project not found", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "nonexistent", "branch", "desc"
    ]);

    await expect(runTaskCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("not found");
  });

  test("errors when missing arguments", async () => {
    const parsed = parseArgs(["bun", "script.ts", "task", "create", "testproj"]);

    await expect(runTaskCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("Usage:");
  });
});

describe("task list command", () => {
  let tempDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let originalLog: typeof console.log;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Database is created lazily via ensureDb()

    const projects: Project[] = [
      { name: "proj1", path: "/path/proj1", default_branch: "main", pool_size: 2 },
      { name: "proj2", path: "/path/proj2", default_branch: "main", pool_size: 2 },
    ];
    await saveProjects(deps, projects);

    consoleLogs = [];
    originalLog = console.log;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    process.exit = originalExit;
  });

  test("shows no tasks message when empty", async () => {
    const parsed = parseArgs(["bun", "script.ts", "task", "list"]);

    await runTaskCommand(parsed, deps);

    expect(consoleLogs[0]).toContain("No tasks found");
  });

  test("lists all tasks", async () => {
    // Create tasks
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "proj1", "task1", "Task one"]),
      deps
    );
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "proj2", "task2", "Task two"]),
      deps
    );
    consoleLogs = [];

    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "list"]), deps);

    const output = consoleLogs.join("\n");
    expect(output).toContain("task1");
    expect(output).toContain("task2");
    expect(output).toContain("[pending]");
  });

  test("filters by project", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "proj1", "task1", "Task one"]),
      deps
    );
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "proj2", "task2", "Task two"]),
      deps
    );
    consoleLogs = [];

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "list", "--project", "proj1"]),
      deps
    );

    const output = consoleLogs.join("\n");
    expect(output).toContain("task1");
    expect(output).not.toContain("task2");
  });

  test("filters by status", async () => {
    // Create a pending task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "proj1", "pending-task", "Pending"]),
      deps
    );
    consoleLogs = [];

    // List pending only
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "list", "--status", "pending"]),
      deps
    );

    const output = consoleLogs.join("\n");
    expect(output).toContain("pending-task");

    // List working - should be empty
    consoleLogs = [];
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "list", "--status", "working"]),
      deps
    );
    expect(consoleLogs[0]).toContain("No tasks found");
  });

  test("shows status icons", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "proj1", "task1", "Task"]),
      deps
    );
    consoleLogs = [];

    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "list"]), deps);

    const output = consoleLogs.join("\n");
    // Pending status icon is ○
    expect(output).toContain("○");
  });
});

describe("task spawn command", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let mockTmux: MockTmux;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();
    mockTmux = new MockTmux();

    deps = {
      tmux: mockTmux,
      git: mockGit,
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Database is created lazily via ensureDb()

    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);

    // Initialize workspace pool
    await initWorkspacePool(deps, project);

    // Initialize mock repos in workspaces
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--1"), "main");
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--2"), "main");

    consoleLogs = [];
    consoleErrors = [];
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  });

  test("spawns task and changes status to working", async () => {
    // Create task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "spawn-feature", "Do work"]),
      deps
    );

    // Get task ID from database (more reliable than console output in parallel tests)
    const taskId = await getTaskIdByBranch(deps, "spawn-feature");

    // Spawn
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "spawn", taskId]),
      deps
    );

    // Verify status changed
    const task = await loadTask(deps, "testproj", "spawn-feature");
    expect(task!.status).toBe("working");
    expect(task!.workspace).toBe("testproj--1");
    expect(task!.tmux_session).toBe("testproj/spawn-feature");

    // Verify tmux session created
    const sessions = await mockTmux.listSessions();
    expect(sessions).toContain("testproj/spawn-feature");
  });

  test("creates history events on spawn", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "spawn-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "spawn-history");

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "spawn", taskId]),
      deps
    );

    const history = await loadHistory(deps, "testproj", "spawn-history");
    expect(history.length).toBeGreaterThanOrEqual(3); // created + spawned + status.changed
    expect(history.some(e => e.type === "agent.spawned")).toBe(true);
    expect(history.some(e => e.type === "status.changed" && (e as StatusChangedEvent).to === "working")).toBe(true);
  });

  test("errors when task not found", async () => {
    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", "nonexistent"]), deps)
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("not found");
  });

  test("errors when task not pending", async () => {
    // Create and spawn task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "spawn-notpending", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "spawn-notpending");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);

    consoleErrors = [];

    // Try to spawn again
    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps)
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("not pending");
  });
});

describe("task complete command", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let mockTmux: MockTmux;
  let consoleLogs: string[];
  let originalLog: typeof console.log;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();
    mockTmux = new MockTmux();

    deps = {
      tmux: mockTmux,
      git: mockGit,
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Database is created lazily via ensureDb()

    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    await initWorkspacePool(deps, project);
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--1"), "main");

    consoleLogs = [];
    originalLog = console.log;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    process.exit = originalExit;
  });

  test("marks task as needs_human", async () => {
    // Setup: create and spawn task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "complete-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "complete-feature");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    consoleLogs = [];

    // Complete
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "complete", taskId]),
      deps
    );

    const task = await loadTask(deps, "testproj", "complete-feature");
    expect(task!.status).toBe("needs_human");
    expect(consoleLogs[0]).toContain("needs_human");
  });

  test("creates history events on complete", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "complete-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "complete-history");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "complete", taskId]), deps);

    const history = await loadHistory(deps, "testproj", "complete-history");
    expect(history.some(e => e.type === "agent.stopped" && (e as AgentStoppedEvent).outcome === "passed")).toBe(true);
    expect(history.some(e => e.type === "status.changed" && (e as StatusChangedEvent).to === "needs_human")).toBe(true);
  });
});

describe("task stuck command", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let mockTmux: MockTmux;
  let consoleLogs: string[];
  let originalLog: typeof console.log;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();
    mockTmux = new MockTmux();

    deps = {
      tmux: mockTmux,
      git: mockGit,
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Database is created lazily via ensureDb()

    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    await initWorkspacePool(deps, project);
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--1"), "main");

    consoleLogs = [];
    originalLog = console.log;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    process.exit = originalExit;
  });

  test("marks task as stuck", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "stuck-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "stuck-feature");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    consoleLogs = [];

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "stuck", taskId]),
      deps
    );

    const task = await loadTask(deps, "testproj", "stuck-feature");
    expect(task!.status).toBe("stuck");
    expect(consoleLogs[0]).toContain("stuck");
  });
});

describe("task merge command", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let mockTmux: MockTmux;
  let consoleLogs: string[];
  let originalLog: typeof console.log;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();
    mockTmux = new MockTmux();

    deps = {
      tmux: mockTmux,
      git: mockGit,
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Database is created lazily via ensureDb()

    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    await initWorkspacePool(deps, project);
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--1"), "main");
    mockGit.initRepo("/path/to/testproj", "main");

    consoleLogs = [];
    originalLog = console.log;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    process.exit = originalExit;
  });

  test("merges task, releases workspace, kills session", async () => {
    // Create, spawn, complete task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "merge-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "merge-feature");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "complete", taskId]), deps);

    // Simulate branch being pushed to origin (add branch to source repo)
    mockGit.branches.get("/path/to/testproj")!.add("merge-feature");

    consoleLogs = [];

    // Merge
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "merge", taskId]),
      deps
    );

    const task = await loadTask(deps, "testproj", "merge-feature");
    expect(task!.status).toBe("done");
    expect(task!.workspace).toBeNull();
    expect(task!.tmux_session).toBeNull();

    // Verify tmux session killed
    const sessions = await mockTmux.listSessions();
    expect(sessions).not.toContain("testproj/merge-feature");

    expect(consoleLogs[0]).toMatch(/merged.*and cleaned up/);
  });

  test("creates task.merged history event", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "merge-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "merge-history");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "complete", taskId]), deps);

    // Simulate branch being pushed to origin (add branch to source repo)
    mockGit.branches.get("/path/to/testproj")!.add("merge-history");

    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "merge", taskId]), deps);

    const history = await loadHistory(deps, "testproj", "merge-history");
    expect(history.some(e => e.type === "task.merged")).toBe(true);
    expect(history.some(e => e.type === "status.changed" && (e as StatusChangedEvent).to === "done")).toBe(true);
  });
});

describe("task cancel command", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let mockTmux: MockTmux;
  let consoleLogs: string[];
  let originalLog: typeof console.log;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();
    mockTmux = new MockTmux();

    deps = {
      tmux: mockTmux,
      git: mockGit,
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Database is created lazily via ensureDb()

    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    await initWorkspacePool(deps, project);
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--1"), "main");

    consoleLogs = [];
    originalLog = console.log;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    process.exit = originalExit;
  });

  test("cancels task, releases workspace, kills session", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "cancel-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "cancel-feature");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    consoleLogs = [];

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "cancel", taskId]),
      deps
    );

    const task = await loadTask(deps, "testproj", "cancel-feature");
    expect(task!.status).toBe("failed");
    expect(task!.workspace).toBeNull();
    expect(task!.tmux_session).toBeNull();

    expect(consoleLogs[0]).toContain("cancelled");
  });

  test("creates task.cancelled history event", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "cancel-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "cancel-history");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "cancel", taskId]), deps);

    const history = await loadHistory(deps, "testproj", "cancel-history");
    expect(history.some(e => e.type === "task.cancelled")).toBe(true);
    expect(history.some(e => e.type === "status.changed" && (e as StatusChangedEvent).to === "failed")).toBe(true);
  });
});

describe("task peek command", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let mockTmux: MockTmux;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();
    mockTmux = new MockTmux();

    deps = {
      tmux: mockTmux,
      git: mockGit,
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
    };

    // Database is created lazily via ensureDb()

    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    await initWorkspacePool(deps, project);
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--1"), "main");

    consoleLogs = [];
    consoleErrors = [];
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  });

  test("captures tmux pane output", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "peek-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "peek-feature");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);

    // Add mock output lines
    mockTmux.addOutput("testproj/peek-feature", "Agent working on feature...");
    mockTmux.addOutput("testproj/peek-feature", "Running tests...");
    consoleLogs = [];

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "peek", taskId]),
      deps
    );

    expect(consoleLogs.join("\n")).toContain("Agent working");
  });

  test("errors when task has no session", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "testproj", "peek-nosession", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "peek-nosession");
    // Don't spawn - no session

    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "peek", taskId]), deps)
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("no active session");
  });
});
