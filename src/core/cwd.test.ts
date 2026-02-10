/**
 * Tests for CWD detection utilities.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

/**
 * Normalize path for comparison (handles macOS /var -> /private/var).
 */
function normalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
import {
  getGitRoot,
  getDefaultBranch,
  detectProject,
  requireProject,
  autoRegisterProject,
  findProjectByName,
} from "./cwd.js";
import { createTestDeps } from "./deps.js";
import { saveProjects, saveTask } from "./state.js";
import type { Project, Task } from "./types.js";

describe("CWD detection", () => {
  let tempDir: string;
  let gitRepoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-cwd-test-"));
    gitRepoDir = join(tempDir, "test-repo");
    mkdirSync(gitRepoDir);

    // Initialize a git repository
    execSync("git init", { cwd: gitRepoDir, stdio: "pipe" });
    execSync("git config user.email 'test@test.com'", { cwd: gitRepoDir, stdio: "pipe" });
    execSync("git config user.name 'Test User'", { cwd: gitRepoDir, stdio: "pipe" });

    // Create initial commit so we have a valid branch
    writeFileSync(join(gitRepoDir, "README.md"), "# Test");
    execSync("git add .", { cwd: gitRepoDir, stdio: "pipe" });
    execSync("git commit -m 'Initial commit'", { cwd: gitRepoDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true });
  });

  describe("getGitRoot", () => {
    it("returns git root for a git repository", () => {
      const root = getGitRoot(gitRepoDir);
      expect(root).toBe(normalizePath(gitRepoDir));
    });

    it("returns git root from subdirectory", () => {
      const subdir = join(gitRepoDir, "src", "lib");
      mkdirSync(subdir, { recursive: true });

      const root = getGitRoot(subdir);
      expect(root).toBe(normalizePath(gitRepoDir));
    });

    it("returns null for non-git directory", () => {
      const nonGitDir = join(tempDir, "not-a-repo");
      mkdirSync(nonGitDir);

      const root = getGitRoot(nonGitDir);
      expect(root).toBeNull();
    });
  });

  describe("getDefaultBranch", () => {
    it("returns branch name from git repo", () => {
      const branch = getDefaultBranch(gitRepoDir);
      // Should be either 'main' or 'master' depending on git config
      expect(["main", "master"]).toContain(branch);
    });
  });

  describe("detectProject", () => {
    it("returns null project when not in git repo", async () => {
      const nonGitDir = join(tempDir, "not-a-repo");
      mkdirSync(nonGitDir);

      const deps = createTestDeps(tempDir);
      const result = await detectProject(deps, nonGitDir);

      expect(result.project).toBeNull();
      expect(result.gitRoot).toBeNull();
      expect(result.error).toBeDefined();
    });

    it("returns null project when in unregistered git repo", async () => {
      const deps = createTestDeps(tempDir);
      const result = await detectProject(deps, gitRepoDir);

      expect(result.project).toBeNull();
      expect(result.gitRoot).toBe(normalizePath(gitRepoDir));
      expect(result.error).toBeUndefined();
    });

    it("returns project when in registered git repo", async () => {
      const deps = createTestDeps(tempDir);
      const project: Project = {
        name: "test-repo",
        path: normalizePath(gitRepoDir),
        default_branch: "main",
        pool_size: 2,
      };
      await saveProjects(deps, [project]);

      const result = await detectProject(deps, gitRepoDir);

      expect(result.project).not.toBeNull();
      expect(result.project?.name).toBe("test-repo");
      expect(result.gitRoot).toBe(normalizePath(gitRepoDir));
    });

    it("maps workspace path to project", async () => {
      const deps = createTestDeps(tempDir);
      const project: Project = {
        name: "test-repo",
        path: normalizePath(gitRepoDir),
        default_branch: "main",
        pool_size: 2,
      };
      await saveProjects(deps, [project]);

      const task: Task = {
        id: "task-1",
        project: "test-repo",
        branch: "feature",
        harness: "claude",
        status: "working",
        workspace: "test-repo--1",
        tmux_session: null,
        summary: "Test task",
        body: "",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        review_harness: "claude",
    review_round: 0,
    pr_url: null,
      };
      await saveTask(deps, task);

      const workspaceSubdir = join(
        deps.dataDir,
        "workspaces",
        "test-repo--1",
        "src"
      );
      mkdirSync(workspaceSubdir, { recursive: true });

      const result = await detectProject(deps, workspaceSubdir);

      expect(result.project?.name).toBe("test-repo");
      expect(result.gitRoot).toBe(normalizePath(gitRepoDir));
    });
  });

  describe("requireProject", () => {
    it("throws when not in git repo", async () => {
      const nonGitDir = join(tempDir, "not-a-repo");
      mkdirSync(nonGitDir);

      const deps = createTestDeps(tempDir);

      expect(requireProject(deps, nonGitDir)).rejects.toThrow("Not a git repository");
    });

    it("throws when in unregistered project", async () => {
      const deps = createTestDeps(tempDir);

      expect(requireProject(deps, gitRepoDir)).rejects.toThrow("Project not registered");
    });

    it("returns project when in registered project", async () => {
      const deps = createTestDeps(tempDir);
      const project: Project = {
        name: "test-repo",
        path: normalizePath(gitRepoDir),
        default_branch: "main",
        pool_size: 2,
      };
      await saveProjects(deps, [project]);

      const result = await requireProject(deps, gitRepoDir);

      expect(result.name).toBe("test-repo");
    });
  });

  describe("autoRegisterProject", () => {
    it("throws when not in git repo", async () => {
      const nonGitDir = join(tempDir, "not-a-repo");
      mkdirSync(nonGitDir);

      const deps = createTestDeps(tempDir);

      expect(autoRegisterProject(deps, nonGitDir)).rejects.toThrow("Not a git repository");
    });

    it("returns existing project if already registered", async () => {
      const deps = createTestDeps(tempDir);
      const project: Project = {
        name: "existing-name",
        path: normalizePath(gitRepoDir),
        default_branch: "main",
        pool_size: 3,
      };
      await saveProjects(deps, [project]);

      const result = await autoRegisterProject(deps, gitRepoDir);

      expect(result.name).toBe("existing-name");
      expect(result.pool_size).toBe(3);
    });

    it("auto-registers new project with defaults", async () => {
      const deps = createTestDeps(tempDir);

      const result = await autoRegisterProject(deps, gitRepoDir);

      expect(result.name).toBe("test-repo");
      expect(result.path).toBe(normalizePath(gitRepoDir));
      expect(result.pool_size).toBe(2);
    });

    it("handles name conflicts by appending timestamp", async () => {
      const deps = createTestDeps(tempDir);

      // Create another repo with the same folder name
      const anotherDir = join(tempDir, "other", "test-repo");
      mkdirSync(anotherDir, { recursive: true });
      execSync("git init", { cwd: anotherDir, stdio: "pipe" });
      execSync("git config user.email 'test@test.com'", { cwd: anotherDir, stdio: "pipe" });
      execSync("git config user.name 'Test User'", { cwd: anotherDir, stdio: "pipe" });
      writeFileSync(join(anotherDir, "README.md"), "# Test 2");
      execSync("git add .", { cwd: anotherDir, stdio: "pipe" });
      execSync("git commit -m 'Initial commit'", { cwd: anotherDir, stdio: "pipe" });

      // Register first repo
      await autoRegisterProject(deps, gitRepoDir);

      // Register second repo with same name - should get modified name
      const result = await autoRegisterProject(deps, anotherDir);

      expect(result.name).not.toBe("test-repo");
      expect(result.name).toMatch(/^test-repo-\d+$/);
    });
  });

  describe("findProjectByName", () => {
    it("returns null when project not found", async () => {
      const deps = createTestDeps(tempDir);

      const result = await findProjectByName(deps, "nonexistent");

      expect(result).toBeNull();
    });

    it("returns project when found", async () => {
      const deps = createTestDeps(tempDir);
      const project: Project = {
        name: "my-project",
        path: normalizePath(gitRepoDir),
        default_branch: "main",
        pool_size: 2,
      };
      await saveProjects(deps, [project]);

      const result = await findProjectByName(deps, "my-project");

      expect(result).not.toBeNull();
      expect(result?.path).toBe(normalizePath(gitRepoDir));
    });
  });
});
