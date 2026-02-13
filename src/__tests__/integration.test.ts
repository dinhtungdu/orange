/**
 * Integration tests with real git repositories.
 *
 * These tests create actual git repositories in temp directories
 * to test the full workflow end-to-end.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Project, Task } from "../core/types.js";
import { MockTmux } from "../core/tmux.js";
import { MockGit } from "../core/git.js";
import { MockGitHub } from "../core/github.js";
import { RealClock, MockClock } from "../core/clock.js";
import { NullLogger } from "../core/logger.js";
import { saveProjects, loadProjects, saveTask, loadTask } from "../core/state.js";
import { listTasks } from "../core/db.js";
import { initWorkspacePool, acquireWorkspace, releaseWorkspace, getPoolStats } from "../core/workspace.js";
import { getGitRoot, detectProject, autoRegisterProject } from "../core/cwd.js";

/**
 * Execute git command in directory.
 */
async function execGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return await new Response(proc.stdout).text();
}

/**
 * Create a real git repository with initial commit.
 * Returns the realpath (resolving symlinks like /var -> /private/var on macOS).
 */
async function createGitRepo(path: string, defaultBranch = "main"): Promise<string> {
  await Bun.spawn(["mkdir", "-p", path]).exited;
  await execGit(path, ["init", "-b", defaultBranch]);
  await execGit(path, ["config", "user.email", "test@test.com"]);
  await execGit(path, ["config", "user.name", "Test User"]);
  
  // Create initial commit
  await Bun.write(join(path, "README.md"), "# Test Project\n");
  await execGit(path, ["add", "README.md"]);
  await execGit(path, ["commit", "-m", "Initial commit"]);
  
  // Return realpath for consistent comparisons
  return realpathSync(path);
}

describe("Integration: Git Operations", () => {
  let tempDir: string;
  let repoPath: string;
  let deps: Deps;

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "orange-integration-")));
    repoPath = await createGitRepo(join(tempDir, "test-repo"));

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(), // Use MockGit for these tests - we're testing CWD detection, not git operations
      clock: new RealClock(),
      dataDir: join(tempDir, "orange"),
      logger: new NullLogger(),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("getGitRoot finds repository root", async () => {
    const root = await getGitRoot(repoPath);
    expect(root).toBe(repoPath);
  });

  test("getGitRoot works from subdirectory", async () => {
    const subdir = join(repoPath, "src", "deep");
    await Bun.spawn(["mkdir", "-p", subdir]).exited;
    
    const root = await getGitRoot(subdir);
    expect(root).toBe(repoPath);
  });

  test("detectProject returns null for unregistered repo", async () => {
    const result = await detectProject(deps, repoPath);
    expect(result.project).toBeNull();
    expect(result.gitRoot).toBe(repoPath);
  });

  test("detectProject returns project for registered repo", async () => {
    const project: Project = {
      name: "test-repo",
      path: repoPath,
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);

    const result = await detectProject(deps, repoPath);
    expect(result.project).not.toBeNull();
    expect(result.project?.name).toBe("test-repo");
  });

  test("autoRegisterProject creates project entry", async () => {
    const project = await autoRegisterProject(deps, repoPath);
    
    expect(project.name).toBe("test-repo");
    expect(project.path).toBe(repoPath);
    expect(project.default_branch).toBe("main");
    expect(project.pool_size).toBe(2);

    // Verify it's saved
    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("test-repo");
  });
});

describe("Integration: Workspace Pool", () => {
  let tempDir: string;
  let deps: Deps;
  let project: Project;
  let mockGit: MockGit;

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "orange-workspace-int-")));
    mockGit = new MockGit();

    deps = {
      tmux: new MockTmux(),
      git: mockGit,
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: join(tempDir, "orange"),
      logger: new NullLogger(),
    };

    project = {
      name: "test-repo",
      path: join(tempDir, "test-repo"),
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    
    // Initialize mock repo
    mockGit.initRepo(project.path, "main");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("initWorkspacePool creates worktrees", async () => {
    await initWorkspacePool(deps, project);

    const workspacesDir = join(deps.dataDir, "workspaces");
    expect(existsSync(join(workspacesDir, "test-repo--1"))).toBe(true);
    expect(existsSync(join(workspacesDir, "test-repo--2"))).toBe(true);
  });

  test("acquireWorkspace returns worktree path", async () => {
    await initWorkspacePool(deps, project);

    const workspace = await acquireWorkspace(deps, "test-repo", "test-repo/feature");
    expect(workspace).toBe("test-repo--1");

    const workspacePath = join(deps.dataDir, "workspaces", workspace);
    expect(existsSync(workspacePath)).toBe(true);
  });

  test("lazy init creates worktree on demand", async () => {
    // Don't call initWorkspacePool - let acquireWorkspace create lazily
    const workspace = await acquireWorkspace(deps, "test-repo", "test-repo/feature");
    
    expect(workspace).toBe("test-repo--1");
    
    const workspacePath = join(deps.dataDir, "workspaces", workspace);
    expect(existsSync(workspacePath)).toBe(true);
  });

  test("release and reacquire workspace", async () => {
    await initWorkspacePool(deps, project);

    const ws1 = await acquireWorkspace(deps, "test-repo", "test-repo/feature1");
    expect(ws1).toBe("test-repo--1");

    await releaseWorkspace(deps, ws1);

    const ws2 = await acquireWorkspace(deps, "test-repo", "test-repo/feature2");
    expect(ws2).toBe("test-repo--1"); // Same workspace reused
  });

  test("pool stats reflect actual state", async () => {
    await initWorkspacePool(deps, project);

    let stats = await getPoolStats(deps, "test-repo");
    expect(stats.total).toBe(2);
    expect(stats.available).toBe(2);
    expect(stats.bound).toBe(0);

    // Acquire workspace and bind via TASK.md (source of truth)
    const ws = await acquireWorkspace(deps, "test-repo", "test-repo/f1");
    const task: Task = {
      id: "test-task-1",
      project: "test-repo",
      branch: "f1",
      harness: "claude",
      status: "working",
      workspace: ws,
      tmux_session: "test-repo/f1",
      summary: "Test task",
      body: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };
    await saveTask(deps, task);
    
    stats = await getPoolStats(deps, "test-repo");
    expect(stats.total).toBe(2);
    expect(stats.available).toBe(1);
    expect(stats.bound).toBe(1);
  });
});

describe("Integration: Full Task Lifecycle", () => {
  let tempDir: string;
  let deps: Deps;
  let project: Project;
  let mockGit: MockGit;

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "orange-lifecycle-int-")));
    mockGit = new MockGit();

    deps = {
      tmux: new MockTmux(),
      git: mockGit,
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: join(tempDir, "orange"),
      logger: new NullLogger(),
    };

    project = {
      name: "test-repo",
      path: join(tempDir, "test-repo"),
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
    mockGit.initRepo(project.path, "main");
    await initWorkspacePool(deps, project);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("create task and verify via listTasks", async () => {
    const task = {
      id: "task123",
      project: "test-repo",
      branch: "feature-x",
      harness: "claude" as const,
      status: "pending" as const,
      workspace: null,
      tmux_session: null,
      summary: "Add new feature",
      body: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };

    await saveTask(deps, task);

    // Verify in file (load by task ID)
    const loadedTask = await loadTask(deps, "test-repo", "task123");
    expect(loadedTask).not.toBeNull();
    expect(loadedTask?.id).toBe("task123");

    // Verify via listTasks
    const tasks = await listTasks(deps, { project: "test-repo" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task123");
  });

  test("listTasks reads directly from TASK.md files", async () => {
    // Create tasks via file system
    const task1 = {
      id: "task1",
      project: "test-repo",
      branch: "feature-1",
      harness: "claude" as const,
      status: "pending" as const,
      workspace: null,
      tmux_session: null,
      summary: "Task 1",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };
    const task2 = {
      id: "task2",
      project: "test-repo",
      branch: "feature-2",
      harness: "claude" as const,
      status: "working" as const,
      workspace: "test-repo--1",
      tmux_session: "test-repo/feature-2",
      summary: "Task 2",
      body: "",
      created_at: "2024-01-02T00:00:00.000Z",
      updated_at: "2024-01-02T00:00:00.000Z",
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };

    await saveTask(deps, task1);
    await saveTask(deps, task2);

    // Verify both tasks are found
    const tasks = await listTasks(deps, {});
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.id).sort()).toEqual(["task1", "task2"]);
  });

  test("workspace acquisition updates task state", async () => {
    const task = {
      id: "task456",
      project: "test-repo",
      branch: "feature-y",
      harness: "claude" as const,
      status: "pending" as const,
      workspace: null,
      tmux_session: null,
      summary: "Another feature",
      body: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };

    await saveTask(deps, task);

    // Acquire workspace
    const workspace = await acquireWorkspace(deps, "test-repo", "test-repo/feature-y");

    // Update task with workspace info
    const updatedTask = {
      ...task,
      workspace,
      status: "working" as const,
      tmux_session: "test-repo/feature-y",
      updated_at: new Date().toISOString(),
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };

    await saveTask(deps, updatedTask);

    // Verify updated state (load by task ID)
    const loadedTask = await loadTask(deps, "test-repo", "task456");
    expect(loadedTask?.status).toBe("working");
    expect(loadedTask?.workspace).toBe(workspace);
  });
});

describe("Integration: Multiple Projects", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;

  beforeEach(async () => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "orange-multiproj-")));
    mockGit = new MockGit();

    deps = {
      tmux: new MockTmux(),
      git: mockGit,
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: join(tempDir, "orange"),
      logger: new NullLogger(),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("multiple projects with separate worktree pools", async () => {
    // Create two repos (mock)
    const repo1Path = join(tempDir, "repo1");
    const repo2Path = join(tempDir, "repo2");
    
    mockGit.initRepo(repo1Path, "main");
    mockGit.initRepo(repo2Path, "main");

    const project1: Project = {
      name: "repo1",
      path: repo1Path,
      default_branch: "main",
      pool_size: 2,
    };
    const project2: Project = {
      name: "repo2",
      path: repo2Path,
      default_branch: "main",
      pool_size: 1,
    };

    await saveProjects(deps, [project1, project2]);
    await initWorkspacePool(deps, project1);
    await initWorkspacePool(deps, project2);

    // Verify separate workspaces
    const workspacesDir = join(deps.dataDir, "workspaces");
    expect(existsSync(join(workspacesDir, "repo1--1"))).toBe(true);
    expect(existsSync(join(workspacesDir, "repo1--2"))).toBe(true);
    expect(existsSync(join(workspacesDir, "repo2--1"))).toBe(true);
    expect(existsSync(join(workspacesDir, "repo2--2"))).toBe(false); // pool_size=1

    // Verify stats
    const stats1 = await getPoolStats(deps, "repo1");
    const stats2 = await getPoolStats(deps, "repo2");

    expect(stats1.total).toBe(2);
    expect(stats2.total).toBe(1);
  });

  test("tasks from different projects are isolated", async () => {
    const repo1Path = join(tempDir, "repo1");
    const repo2Path = join(tempDir, "repo2");
    
    mockGit.initRepo(repo1Path, "main");
    mockGit.initRepo(repo2Path, "main");

    const project1: Project = { name: "repo1", path: repo1Path, default_branch: "main", pool_size: 1 };
    const project2: Project = { name: "repo2", path: repo2Path, default_branch: "main", pool_size: 1 };
    await saveProjects(deps, [project1, project2]);

    // Create tasks for different projects
    const task1 = {
      id: "t1", project: "repo1", branch: "feat1", harness: "claude" as const, status: "pending" as const,
      workspace: null, tmux_session: null, summary: "Repo 1 task", body: "",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };
    const task2 = {
      id: "t2", project: "repo2", branch: "feat2", harness: "claude" as const, status: "working" as const,
      workspace: null, tmux_session: null, summary: "Repo 2 task", body: "",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      review_harness: "claude" as const,
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    };

    await saveTask(deps, task1);
    await saveTask(deps, task2);

    // Filter by project
    const repo1Tasks = await listTasks(deps, { project: "repo1" });
    const repo2Tasks = await listTasks(deps, { project: "repo2" });
    const allTasks = await listTasks(deps, {});

    expect(repo1Tasks).toHaveLength(1);
    expect(repo1Tasks[0].id).toBe("t1");

    expect(repo2Tasks).toHaveLength(1);
    expect(repo2Tasks[0].id).toBe("t2");

    expect(allTasks).toHaveLength(2);
  });
});
