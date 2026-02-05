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
import { MockGitHub } from "../../core/github.js";
import { MockTmux } from "../../core/tmux.js";
import { MockClock } from "../../core/clock.js";
import { NullLogger } from "../../core/logger.js";
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
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
      "bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "feature-x", "Implement feature X"
    ]);

    await runTaskCommand(parsed, deps);

    // Get task ID then load by ID
    const taskId = await getTaskIdByBranch(deps, "feature-x");
    const task = await loadTask(deps, "testproj", taskId);
    expect(task).not.toBeNull();
    expect(task!.project).toBe("testproj");
    expect(task!.branch).toBe("feature-x");
    expect(task!.status).toBe("pending");
    expect(task!.summary).toBe("Implement feature X");
    expect(task!.workspace).toBeNull();
    expect(task!.tmux_session).toBeNull();

    // Verify console output contains task ID
    expect(consoleLogs[0]).toContain("Created task");
    expect(consoleLogs[0]).toContain("testproj/feature-x");
  });

  test("creates task with multi-word summary", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "my-branch",
      "This", "is", "a", "multi", "word", "summary"
    ]);

    await runTaskCommand(parsed, deps);

    const taskId = await getTaskIdByBranch(deps, "my-branch");
    const task = await loadTask(deps, "testproj", taskId);
    expect(task!.summary).toBe("This is a multi word summary");
  });

  test("creates history entry for task creation", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "feature-y", "Do something"
    ]);

    await runTaskCommand(parsed, deps);

    const taskId = await getTaskIdByBranch(deps, "feature-y");
    const history = await loadHistory(deps, "testproj", taskId);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe("task.created");
    const createdEvent = history[0] as TaskCreatedEvent;
    expect(createdEvent.project).toBe("testproj");
    expect(createdEvent.branch).toBe("feature-y");
  });

  test("adds task to index", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "indexed-task", "Test indexing"
    ]);

    await runTaskCommand(parsed, deps);

    const tasks = await listTasks(deps, { project: "testproj" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].branch).toBe("indexed-task");
  });

  test("errors when project not found", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "--no-spawn", "--project", "nonexistent", "branch", "desc"
    ]);

    await expect(runTaskCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("not found");
  });

  test("creates task with no arguments using defaults", async () => {
    const parsed = parseArgs(["bun", "script.ts", "task", "create", "--project", "testproj"]);

    await runTaskCommand(parsed, deps);

    // Should create task with auto-generated branch (orange-tasks/<id>) and clarification status (empty summary)
    expect(consoleLogs[0]).toMatch(/Created task \w+ \(testproj\/orange-tasks\/\w+\) \[clarification\]/);
  });

  test("creates task with --status=reviewing and skips spawn", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "--project", "testproj", "--status", "reviewing", "existing-work", "Already done"
    ]);

    await runTaskCommand(parsed, deps);

    // Verify task created with reviewing status
    const taskId = await getTaskIdByBranch(deps, "existing-work");
    const task = await loadTask(deps, "testproj", taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe("reviewing");
    expect(task!.workspace).toBeNull();  // No workspace assigned
    expect(task!.tmux_session).toBeNull();  // No session spawned

    // Verify console output shows status
    expect(consoleLogs[0]).toContain("[reviewing]");
    // Should not have spawn message
    expect(consoleLogs).toHaveLength(1);
  });

  test("errors on invalid status", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "task", "create", "--project", "testproj", "--status", "working", "branch", "desc"
    ]);

    await expect(runTaskCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("Invalid status");
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
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
    const parsed = parseArgs(["bun", "script.ts", "task", "list", "--all"]);

    await runTaskCommand(parsed, deps);

    expect(consoleLogs[0]).toContain("No tasks found");
  });

  test("lists all tasks", async () => {
    // Create tasks
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "proj1", "task1", "Task one"]),
      deps
    );
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "proj2", "task2", "Task two"]),
      deps
    );
    consoleLogs = [];

    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "list", "--all"]), deps);

    const output = consoleLogs.join("\n");
    expect(output).toContain("task1");
    expect(output).toContain("task2");
    expect(output).toContain("[pending]");
  });

  test("filters by project", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "proj1", "task1", "Task one"]),
      deps
    );
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "proj2", "task2", "Task two"]),
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "proj1", "pending-task", "Pending"]),
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "proj1", "task1", "Task"]),
      deps
    );
    consoleLogs = [];

    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "list", "--all"]), deps);

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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "spawn-feature", "Do work"]),
      deps
    );

    // Get task ID from database (more reliable than console output in parallel tests)
    const taskId = await getTaskIdByBranch(deps, "spawn-feature");

    // Spawn
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "spawn", taskId]),
      deps
    );

    // Verify status changed (load by task ID)
    const task = await loadTask(deps, "testproj", taskId);
    expect(task!.status).toBe("working");
    expect(task!.workspace).toBe("testproj--1");
    expect(task!.tmux_session).toBe("testproj/spawn-feature");

    // Verify tmux session created
    const sessions = await mockTmux.listSessions();
    expect(sessions).toContain("testproj/spawn-feature");
  });

  test("creates history events on spawn", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "spawn-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "spawn-history");

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "spawn", taskId]),
      deps
    );

    // Load history by task ID
    const history = await loadHistory(deps, "testproj", taskId);
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "spawn-notpending", "Work"]),
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
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

  test("marks task as reviewing", async () => {
    // Setup: create and spawn task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "complete-feature", "Work"]),
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

    // Load by task ID
    const task = await loadTask(deps, "testproj", taskId);
    expect(task!.status).toBe("reviewing");
    expect(consoleLogs[0]).toContain("reviewing");
  });

  test("creates history events on complete", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "complete-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "complete-history");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "complete", taskId]), deps);

    // Load history by task ID
    const history = await loadHistory(deps, "testproj", taskId);
    expect(history.some(e => e.type === "agent.stopped" && (e as AgentStoppedEvent).outcome === "passed")).toBe(true);
    expect(history.some(e => e.type === "status.changed" && (e as StatusChangedEvent).to === "reviewing")).toBe(true);
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "stuck-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "stuck-feature");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    consoleLogs = [];

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "stuck", taskId]),
      deps
    );

    // Load by task ID
    const task = await loadTask(deps, "testproj", taskId);
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "merge-feature", "Work"]),
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

    // Load by task ID
    const task = await loadTask(deps, "testproj", taskId);
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "merge-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "merge-history");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "complete", taskId]), deps);

    // Simulate branch being pushed to origin (add branch to source repo)
    mockGit.branches.get("/path/to/testproj")!.add("merge-history");

    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "merge", taskId]), deps);

    // Load history by task ID
    const history = await loadHistory(deps, "testproj", taskId);
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
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
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "cancel-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "cancel-feature");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    consoleLogs = [];

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "cancel", taskId, "--yes"]),
      deps
    );

    // Load by task ID
    const task = await loadTask(deps, "testproj", taskId);
    expect(task!.status).toBe("cancelled");
    expect(task!.workspace).toBeNull();
    expect(task!.tmux_session).toBeNull();

    expect(consoleLogs[0]).toContain("cancelled");
  });

  test("creates task.cancelled history event", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "cancel-history", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "cancel-history");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "cancel", taskId, "--yes"]), deps);

    // Load history by task ID
    const history = await loadHistory(deps, "testproj", taskId);
    expect(history.some(e => e.type === "task.cancelled")).toBe(true);
    expect(history.some(e => e.type === "status.changed" && (e as StatusChangedEvent).to === "cancelled")).toBe(true);
  });
});

describe("task delete command", () => {
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

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

  test("deletes done task, removes folder and db entry", async () => {
    // Create and complete a task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "delete-done", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "delete-done");
    // Add branch to project repo for merge step (simulates it being pushed)
    mockGit.branches.get("/path/to/testproj")!.add("delete-done");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "merge", taskId]), deps);
    consoleLogs = [];

    // Verify task exists before delete (load by task ID)
    let task = await loadTask(deps, "testproj", taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe("done");

    // Delete the task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "delete", taskId, "--yes"]),
      deps
    );

    // Verify task folder is gone (load by task ID)
    task = await loadTask(deps, "testproj", taskId);
    expect(task).toBeNull();

    // Verify task is removed from db
    const tasks = await listTasks(deps, {});
    expect(tasks.find(t => t.id === taskId)).toBeUndefined();

    expect(consoleLogs[0]).toContain("deleted");
  });

  test("deletes cancelled task", async () => {
    // Create and cancel a task (makes it cancelled)
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "delete-failed", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "delete-failed");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "cancel", taskId, "--yes"]), deps);
    consoleLogs = [];

    // Delete the task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "delete", taskId, "--yes"]),
      deps
    );

    // Verify task is gone (load by task ID)
    const task = await loadTask(deps, "testproj", taskId);
    expect(task).toBeNull();
    expect(consoleLogs[0]).toContain("deleted");
  });

  test("errors when deleting working task", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "delete-working", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "delete-working");
    await runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps);
    consoleErrors = [];

    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "delete", taskId, "--yes"]), deps)
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrors[0]).toContain("Cannot delete");
    expect(consoleErrors[0]).toContain("working");
  });

  test("errors when deleting pending task", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "delete-pending", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "delete-pending");
    consoleErrors = [];

    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "delete", taskId, "--yes"]), deps)
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrors[0]).toContain("Cannot delete");
    expect(consoleErrors[0]).toContain("pending");
  });
});

describe("task update command", () => {
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
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

    consoleLogs = [];
    consoleErrors = [];
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;

    console.log = (...args) => consoleLogs.push(args.join(" "));
    console.error = (...args) => consoleErrors.push(args.join(" "));
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never;

    // Setup project
    const projectPath = join(tempDir, "testproj");
    mockGit.initRepo(projectPath, "main");
    await saveProjects(deps, [
      { name: "testproj", path: projectPath, default_branch: "main", pool_size: 2 },
    ]);
    await initWorkspacePool(deps, { name: "testproj", path: projectPath, default_branch: "main", pool_size: 2 });
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("updates task summary", async () => {
    // Create a task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "test-branch", "original summary"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "test-branch");

    // Update summary
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "update", taskId, "--summary", "updated summary"]),
      deps
    );

    const task = await loadTask(deps, "testproj", taskId);
    expect(task?.summary).toBe("updated summary");
    expect(consoleLogs.some(l => l.includes("summary updated"))).toBe(true);
  });

  test("renames branch when new name does not exist", async () => {
    // Create a task with a workspace
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--project", "testproj", "old-branch", "test"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "old-branch");

    // Update branch
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "update", taskId, "--branch", "new-branch"]),
      deps
    );

    const task = await loadTask(deps, "testproj", taskId);
    expect(task?.branch).toBe("new-branch");
    expect(consoleLogs.some(l => l.includes("old-branch") && l.includes("new-branch"))).toBe(true);
  });

  test("switches to existing branch and deletes old", async () => {
    // Create a task
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--project", "testproj", "auto-branch", "test"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "auto-branch");
    const task = await loadTask(deps, "testproj", taskId);
    const workspacePath = join(deps.dataDir, "workspaces", task!.workspace!);

    // Create an existing branch in the workspace
    mockGit.branches.get(workspacePath)?.add("existing-branch");

    // Update to existing branch
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "update", taskId, "--branch", "existing-branch"]),
      deps
    );

    const updatedTask = await loadTask(deps, "testproj", taskId);
    expect(updatedTask?.branch).toBe("existing-branch");
  });

  test("errors when no options provided", async () => {
    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "test-branch", "test"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "test-branch");

    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "update", taskId]), deps)
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrors[0]).toContain("--branch, --summary, or --status");
  });

  test("errors when task not found", async () => {
    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "update", "nonexistent", "--summary", "test"]), deps)
    ).rejects.toThrow("process.exit(1)");

    expect(consoleErrors[0]).toContain("not found");
  });
});

describe("MockTmux availability", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let mockTmux: MockTmux;
  let consoleErrors: string[];
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();
    mockTmux = new MockTmux();

    deps = {
      tmux: mockTmux,
      git: mockGit,
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    await initWorkspacePool(deps, project);
    mockGit.initRepo(join(tempDir, "workspaces", "testproj--1"), "main");

    consoleErrors = [];
    originalError = console.error;
    originalExit = process.exit;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.error = originalError;
    process.exit = originalExit;
  });

  test("isAvailable returns true by default", async () => {
    const available = await mockTmux.isAvailable();
    expect(available).toBe(true);
  });

  test("isAvailable can be set to false", async () => {
    mockTmux.setAvailable(false);
    const available = await mockTmux.isAvailable();
    expect(available).toBe(false);
  });

  test("spawn fails when tmux not available", async () => {
    mockTmux.setAvailable(false);

    await runTaskCommand(
      parseArgs(["bun", "script.ts", "task", "create", "--no-spawn", "--project", "testproj", "unavail-feature", "Work"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "unavail-feature");

    // Clear errors from task creation
    consoleErrors = [];

    await expect(
      runTaskCommand(parseArgs(["bun", "script.ts", "task", "spawn", taskId]), deps)
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("tmux is not installed");
  });

  test("killSessionSafe ignores errors", async () => {
    // Should not throw when session doesn't exist
    await mockTmux.killSessionSafe("nonexistent-session");
  });

  test("capturePaneSafe returns null when session doesn't exist", async () => {
    const output = await mockTmux.capturePaneSafe("nonexistent-session", 10);
    expect(output).toBeNull();
  });

  test("capturePaneSafe returns output when session exists", async () => {
    await mockTmux.newSession("test-session", "/tmp", "command");
    mockTmux.addOutput("test-session", "line 1");
    mockTmux.addOutput("test-session", "line 2");

    const output = await mockTmux.capturePaneSafe("test-session", 10);
    expect(output).toContain("line 1");
    expect(output).toContain("line 2");
  });
});

describe("JSON output", () => {
  let tempDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-json-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

    const projects: Project[] = [
      { name: "testproj", path: "/path/testproj", default_branch: "main", pool_size: 2 },
    ];
    await saveProjects(deps, projects);

    consoleLogs = [];
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    console.error = () => {}; // suppress
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

  /** Parse last JSON line from console output (outputJson writes before exit). */
  function getJsonOutput(): unknown {
    // outputJson writes console.log then process.exit, so JSON is the last log line
    for (let i = consoleLogs.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(consoleLogs[i]);
      } catch {
        continue;
      }
    }
    throw new Error(`No JSON found in output: ${consoleLogs.join("\n")}`);
  }

  test("task list --json returns tasks array", async () => {
    // Create a task first
    await runTaskCommand(
      parseArgs(["bun", "s", "task", "create", "--no-spawn", "--project", "testproj", "feat-1", "Feature one"]),
      deps
    );
    consoleLogs = [];

    // list --json calls process.exit(0) via outputJson
    try {
      await runTaskCommand(
        parseArgs(["bun", "s", "task", "list", "--all", "--json"]),
        deps
      );
    } catch {
      // process.exit throws
    }

    const result = getJsonOutput() as { tasks: unknown[] };
    expect(result.tasks).toBeArray();
    expect(result.tasks.length).toBe(1);
    expect((result.tasks[0] as { branch: string }).branch).toBe("feat-1");
  });

  test("task list --json returns empty array when no tasks", async () => {
    try {
      await runTaskCommand(
        parseArgs(["bun", "s", "task", "list", "--all", "--json"]),
        deps
      );
    } catch {
      // process.exit throws
    }

    const result = getJsonOutput() as { tasks: unknown[] };
    expect(result.tasks).toBeArray();
    expect(result.tasks.length).toBe(0);
  });

  test("task show --json returns task object", async () => {
    await runTaskCommand(
      parseArgs(["bun", "s", "task", "create", "--no-spawn", "--project", "testproj", "feat-2", "Feature two"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "feat-2");
    consoleLogs = [];

    try {
      await runTaskCommand(
        parseArgs(["bun", "s", "task", "show", taskId, "--json"]),
        deps
      );
    } catch {
      // process.exit throws
    }

    const result = getJsonOutput() as { task: { id: string; summary: string } };
    expect(result.task).toBeDefined();
    expect(result.task.id).toBe(taskId);
    expect(result.task.summary).toBe("Feature two");
  });

  test("task show --json returns error for missing task", async () => {
    try {
      await runTaskCommand(
        parseArgs(["bun", "s", "task", "show", "nonexistent", "--json"]),
        deps
      );
    } catch {
      // process.exit throws
    }

    const result = getJsonOutput() as { error: string };
    expect(result.error).toContain("not found");
  });

  test("task create --json returns created task", async () => {
    try {
      await runTaskCommand(
        parseArgs(["bun", "s", "task", "create", "--no-spawn", "--project", "testproj", "feat-3", "Feature three", "--json"]),
        deps
      );
    } catch {
      // process.exit throws
    }

    const result = getJsonOutput() as { task: { branch: string; summary: string }; message: string };
    expect(result.task).toBeDefined();
    expect(result.task.branch).toBe("feat-3");
    expect(result.task.summary).toBe("Feature three");
    expect(result.message).toContain("Created");
  });

  test("task update --json returns updated task", async () => {
    await runTaskCommand(
      parseArgs(["bun", "s", "task", "create", "--no-spawn", "--project", "testproj", "feat-4", "Old summary"]),
      deps
    );
    const taskId = await getTaskIdByBranch(deps, "feat-4");
    consoleLogs = [];

    try {
      await runTaskCommand(
        parseArgs(["bun", "s", "task", "update", taskId, "--summary", "New summary", "--json"]),
        deps
      );
    } catch {
      // process.exit throws
    }

    const result = getJsonOutput() as { task: { summary: string }; message: string };
    expect(result.task).toBeDefined();
    expect(result.task.summary).toBe("New summary");
    expect(result.message).toContain("Updated");
  });
});


