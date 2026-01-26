/**
 * Tests for workspace pool management.
 *
 * Tests the acquire/release lifecycle with mocked git executor.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Project } from "./types.js";
import { MockGit } from "./git.js";
import { MockTmux } from "./tmux.js";
import { MockClock } from "./clock.js";
import { NullLogger } from "./logger.js";
import {
  initWorkspacePool,
  acquireWorkspace,
  releaseWorkspace,
  loadPoolState,
  getPoolStats,
} from "./workspace.js";
import { saveProjects } from "./state.js";

describe("Workspace Pool", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;

  const testProject: Project = {
    name: "test-project",
    path: "/tmp/test-repo",
    default_branch: "main",
    pool_size: 2,
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();

    deps = {
      tmux: new MockTmux(),
      git: mockGit,
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

    // Register project (needed for lazy init pool_size check)
    await saveProjects(deps, [testProject]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("initWorkspacePool creates worktrees", async () => {
    await initWorkspacePool(deps, testProject);

    const state = await loadPoolState(deps);
    expect(Object.keys(state.workspaces)).toHaveLength(2);
    expect(state.workspaces["test-project--1"]).toEqual({ status: "available" });
    expect(state.workspaces["test-project--2"]).toEqual({ status: "available" });
  });

  test("acquireWorkspace returns first available workspace", async () => {
    await initWorkspacePool(deps, testProject);

    const workspace = await acquireWorkspace(deps, "test-project", "test-project/feature");

    expect(workspace).toBe("test-project--1");

    const state = await loadPoolState(deps);
    expect(state.workspaces["test-project--1"]).toEqual({
      status: "bound",
      task: "test-project/feature",
    });
    expect(state.workspaces["test-project--2"]).toEqual({ status: "available" });
  });

  test("acquireWorkspace returns second workspace when first is bound", async () => {
    await initWorkspacePool(deps, testProject);

    await acquireWorkspace(deps, "test-project", "test-project/feature-1");
    const workspace2 = await acquireWorkspace(deps, "test-project", "test-project/feature-2");

    expect(workspace2).toBe("test-project--2");

    const state = await loadPoolState(deps);
    expect(state.workspaces["test-project--1"].status).toBe("bound");
    expect(state.workspaces["test-project--2"].status).toBe("bound");
  });

  test("acquireWorkspace throws when pool exhausted", async () => {
    await initWorkspacePool(deps, testProject);

    await acquireWorkspace(deps, "test-project", "test-project/feature-1");
    await acquireWorkspace(deps, "test-project", "test-project/feature-2");

    await expect(
      acquireWorkspace(deps, "test-project", "test-project/feature-3")
    ).rejects.toThrow("pool exhausted");
  });

  test("releaseWorkspace makes workspace available again", async () => {
    // Initialize mock repo for checkout
    const workspacePath = join(tempDir, "workspaces", "test-project--1");
    mockGit.initRepo(workspacePath, "main");

    await initWorkspacePool(deps, testProject);

    const workspace = await acquireWorkspace(deps, "test-project", "test-project/feature");
    expect(workspace).toBe("test-project--1");

    await releaseWorkspace(deps, workspace);

    const state = await loadPoolState(deps);
    expect(state.workspaces["test-project--1"]).toEqual({ status: "available" });
  });

  test("acquire after release works correctly", async () => {
    // Initialize mock repo for checkout
    const workspacePath1 = join(tempDir, "workspaces", "test-project--1");
    const workspacePath2 = join(tempDir, "workspaces", "test-project--2");
    mockGit.initRepo(workspacePath1, "main");
    mockGit.initRepo(workspacePath2, "main");

    await initWorkspacePool(deps, testProject);

    // Acquire both
    const ws1 = await acquireWorkspace(deps, "test-project", "test-project/feature-1");
    const ws2 = await acquireWorkspace(deps, "test-project", "test-project/feature-2");

    // Release first
    await releaseWorkspace(deps, ws1);

    // Acquire again - should get the released one
    const ws3 = await acquireWorkspace(deps, "test-project", "test-project/feature-3");
    expect(ws3).toBe("test-project--1");

    const state = await loadPoolState(deps);
    expect(state.workspaces["test-project--1"]).toEqual({
      status: "bound",
      task: "test-project/feature-3",
    });
  });

  test("initWorkspacePool is idempotent", async () => {
    await initWorkspacePool(deps, testProject);
    await initWorkspacePool(deps, testProject);

    const state = await loadPoolState(deps);
    expect(Object.keys(state.workspaces)).toHaveLength(2);
  });

  test("workspaces for different projects are independent", async () => {
    const project2: Project = {
      name: "other-project",
      path: "/tmp/other-repo",
      default_branch: "main",
      pool_size: 1,
    };

    // Register second project
    await saveProjects(deps, [testProject, project2]);

    await initWorkspacePool(deps, testProject);
    await initWorkspacePool(deps, project2);

    const state = await loadPoolState(deps);
    expect(Object.keys(state.workspaces)).toHaveLength(3);

    // Acquire from test-project
    const ws1 = await acquireWorkspace(deps, "test-project", "test-project/feature");
    expect(ws1).toBe("test-project--1");

    // Acquire from other-project
    const ws2 = await acquireWorkspace(deps, "other-project", "other-project/feature");
    expect(ws2).toBe("other-project--1");
  });
});

describe("Lazy Workspace Initialization", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;
  let consoleLogs: string[];
  let originalLog: typeof console.log;

  const testProject: Project = {
    name: "lazy-project",
    path: "/tmp/lazy-repo",
    default_branch: "main",
    pool_size: 2,
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();

    deps = {
      tmux: new MockTmux(),
      git: mockGit,
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

    // Register the project (required for lazy init to find pool_size)
    await saveProjects(deps, [testProject]);

    // Capture console output
    consoleLogs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
  });

  test("acquireWorkspace creates worktree on-demand if pool is empty", async () => {
    // Don't call initWorkspacePool - simulate fresh project

    const workspace = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");

    expect(workspace).toBe("lazy-project--1");
    expect(consoleLogs.join("\n")).toContain("Creating workspace lazy-project--1");

    const state = await loadPoolState(deps);
    expect(state.workspaces["lazy-project--1"]).toEqual({
      status: "bound",
      task: "lazy-project/feature-1",
    });
  });

  test("acquireWorkspace creates second worktree when first is bound", async () => {
    // Acquire first (lazy creates)
    const ws1 = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");
    expect(ws1).toBe("lazy-project--1");

    consoleLogs = [];

    // Acquire second (should lazy create another)
    const ws2 = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-2");
    expect(ws2).toBe("lazy-project--2");
    expect(consoleLogs.join("\n")).toContain("Creating workspace lazy-project--2");

    const state = await loadPoolState(deps);
    expect(Object.keys(state.workspaces)).toHaveLength(2);
    expect(state.workspaces["lazy-project--1"].status).toBe("bound");
    expect(state.workspaces["lazy-project--2"].status).toBe("bound");
  });

  test("acquireWorkspace throws when pool_size reached via lazy init", async () => {
    // Acquire up to pool_size (2) via lazy init
    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");
    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-2");

    // Third should fail
    await expect(
      acquireWorkspace(deps, "lazy-project", "lazy-project/feature-3")
    ).rejects.toThrow("pool exhausted: 2/2");
  });

  test("acquireWorkspace uses available workspace before creating new one", async () => {
    // Initialize one workspace
    const workspacePath = join(tempDir, "workspaces", "lazy-project--1");
    mockGit.initRepo(workspacePath, "main");
    await initWorkspacePool(deps, { ...testProject, pool_size: 1 });

    consoleLogs = [];

    // Acquire - should use existing, not create new
    const ws = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature");
    expect(ws).toBe("lazy-project--1");
    expect(consoleLogs.join("\n")).not.toContain("Creating workspace");
  });

  test("getPoolStats returns correct statistics", async () => {
    // Start with empty pool
    let stats = await getPoolStats(deps, "lazy-project");
    expect(stats).toEqual({ total: 0, available: 0, bound: 0, poolSize: 2 });

    // Acquire one (lazy creates)
    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");

    stats = await getPoolStats(deps, "lazy-project");
    expect(stats).toEqual({ total: 1, available: 0, bound: 1, poolSize: 2 });

    // Acquire another
    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-2");

    stats = await getPoolStats(deps, "lazy-project");
    expect(stats).toEqual({ total: 2, available: 0, bound: 2, poolSize: 2 });

    // Release one
    const workspacePath = join(tempDir, "workspaces", "lazy-project--1");
    mockGit.initRepo(workspacePath, "main");
    await releaseWorkspace(deps, "lazy-project--1");

    stats = await getPoolStats(deps, "lazy-project");
    expect(stats).toEqual({ total: 2, available: 1, bound: 1, poolSize: 2 });
  });

  test("lazy init works after partial explicit init", async () => {
    // Explicitly init just one workspace
    await initWorkspacePool(deps, { ...testProject, pool_size: 1 });

    const state1 = await loadPoolState(deps);
    expect(Object.keys(state1.workspaces)).toHaveLength(1);

    // Acquire first (uses existing)
    const ws1 = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");
    expect(ws1).toBe("lazy-project--1");

    consoleLogs = [];

    // Acquire second (lazy creates since pool_size is 2 in registered project)
    const ws2 = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-2");
    expect(ws2).toBe("lazy-project--2");
    expect(consoleLogs.join("\n")).toContain("Creating workspace lazy-project--2");
  });
});
