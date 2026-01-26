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
import {
  initWorkspacePool,
  acquireWorkspace,
  releaseWorkspace,
  loadPoolState,
} from "./workspace.js";

describe("Workspace Pool", () => {
  let tempDir: string;
  let deps: Deps;
  let mockGit: MockGit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockGit = new MockGit();

    deps = {
      tmux: new MockTmux(),
      git: mockGit,
      clock: new MockClock(),
      dataDir: tempDir,
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const testProject: Project = {
    name: "test-project",
    path: "/tmp/test-repo",
    default_branch: "main",
    pool_size: 2,
  };

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
    ).rejects.toThrow("No available workspace");
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
