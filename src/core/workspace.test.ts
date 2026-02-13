/**
 * Tests for workspace pool management.
 *
 * Tests the acquire/release lifecycle with mocked git executor.
 * Pool state is tracked in .pool.json (per data.md spec).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Project } from "./types.js";
import { MockGit } from "./git.js";
import { MockGitHub } from "./github.js";
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
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

    // Register project
    await saveProjects(deps, [testProject]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("initWorkspacePool creates worktrees and writes .pool.json", async () => {
    await initWorkspacePool(deps, testProject);

    const state = await loadPoolState(deps);
    expect(Object.keys(state.workspaces)).toHaveLength(2);
    expect(state.workspaces["test-project--1"]).toEqual({ status: "available" });
    expect(state.workspaces["test-project--2"]).toEqual({ status: "available" });
  });

  test("acquireWorkspace marks as bound in .pool.json", async () => {
    await initWorkspacePool(deps, testProject);

    const workspace = await acquireWorkspace(deps, "test-project", "test-project/feature");

    expect(workspace).toBe("test-project--1");

    // Should be marked bound in .pool.json
    const state = await loadPoolState(deps);
    expect(state.workspaces["test-project--1"]).toEqual({
      status: "bound",
      task: "test-project/feature",
    });
  });

  test("acquireWorkspace returns second workspace when first is bound", async () => {
    await initWorkspacePool(deps, testProject);

    // Acquire first
    await acquireWorkspace(deps, "test-project", "test-project/feature-1");

    // Acquire second
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

  test("releaseWorkspace marks as available in .pool.json", async () => {
    const workspacePath = join(tempDir, "workspaces", "test-project--1");
    mockGit.initRepo(workspacePath, "main");

    await initWorkspacePool(deps, testProject);
    await acquireWorkspace(deps, "test-project", "test-project/feature");

    // Verify it's bound
    let state = await loadPoolState(deps);
    expect(state.workspaces["test-project--1"].status).toBe("bound");

    // Release
    await releaseWorkspace(deps, "test-project--1");

    state = await loadPoolState(deps);
    expect(state.workspaces["test-project--1"]).toEqual({ status: "available" });
  });

  test("acquire after release works correctly", async () => {
    const workspacePath1 = join(tempDir, "workspaces", "test-project--1");
    const workspacePath2 = join(tempDir, "workspaces", "test-project--2");
    mockGit.initRepo(workspacePath1, "main");
    mockGit.initRepo(workspacePath2, "main");

    await initWorkspacePool(deps, testProject);

    // Acquire both
    await acquireWorkspace(deps, "test-project", "test-project/feature-1");
    await acquireWorkspace(deps, "test-project", "test-project/feature-2");

    // Release first
    await releaseWorkspace(deps, "test-project--1");

    // Acquire again — should get the released one
    const ws3 = await acquireWorkspace(deps, "test-project", "test-project/feature-3");
    expect(ws3).toBe("test-project--1");
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

    await saveProjects(deps, [testProject, project2]);

    await initWorkspacePool(deps, testProject);
    await initWorkspacePool(deps, project2);

    const state = await loadPoolState(deps);
    expect(Object.keys(state.workspaces)).toHaveLength(3);

    // Acquire from test-project
    const ws1 = await acquireWorkspace(deps, "test-project", "test-project/feature");
    expect(ws1).toBe("test-project--1");

    // Acquire from other-project — should still work
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
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

    await saveProjects(deps, [testProject]);

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

  test("acquireWorkspace creates worktree on-demand and marks bound", async () => {
    const workspace = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");

    expect(workspace).toBe("lazy-project--1");
    expect(consoleLogs.join("\n")).toContain("Creating workspace lazy-project--1");

    // Should be immediately bound in .pool.json
    const state = await loadPoolState(deps);
    expect(state.workspaces["lazy-project--1"]).toEqual({
      status: "bound",
      task: "lazy-project/feature-1",
    });
  });

  test("acquireWorkspace creates second worktree when first is bound", async () => {
    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");
    consoleLogs = [];

    const ws2 = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-2");
    expect(ws2).toBe("lazy-project--2");
    expect(consoleLogs.join("\n")).toContain("Creating workspace lazy-project--2");

    const state = await loadPoolState(deps);
    expect(Object.keys(state.workspaces)).toHaveLength(2);
    expect(state.workspaces["lazy-project--1"].status).toBe("bound");
    expect(state.workspaces["lazy-project--2"].status).toBe("bound");
  });

  test("acquireWorkspace throws when pool_size reached via lazy init", async () => {
    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");
    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-2");

    await expect(
      acquireWorkspace(deps, "lazy-project", "lazy-project/feature-3")
    ).rejects.toThrow("pool exhausted: 2/2");
  });

  test("acquireWorkspace uses available workspace before creating new one", async () => {
    const workspacePath = join(tempDir, "workspaces", "lazy-project--1");
    mockGit.initRepo(workspacePath, "main");
    await initWorkspacePool(deps, { ...testProject, pool_size: 1 });

    consoleLogs = [];

    const ws = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature");
    expect(ws).toBe("lazy-project--1");
    expect(consoleLogs.join("\n")).not.toContain("Creating workspace");
  });

  test("getPoolStats returns correct statistics", async () => {
    let stats = await getPoolStats(deps, "lazy-project");
    expect(stats).toEqual({ total: 0, available: 0, bound: 0, poolSize: 2 });

    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");

    stats = await getPoolStats(deps, "lazy-project");
    expect(stats).toEqual({ total: 1, available: 0, bound: 1, poolSize: 2 });

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
    await initWorkspacePool(deps, { ...testProject, pool_size: 1 });

    const state1 = await loadPoolState(deps);
    expect(Object.keys(state1.workspaces)).toHaveLength(1);

    await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-1");
    consoleLogs = [];

    // Lazy creates second since pool_size is 2 in registered project
    const ws2 = await acquireWorkspace(deps, "lazy-project", "lazy-project/feature-2");
    expect(ws2).toBe("lazy-project--2");
    expect(consoleLogs.join("\n")).toContain("Creating workspace lazy-project--2");
  });
});
