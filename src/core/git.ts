/**
 * Git abstraction layer for repository operations.
 *
 * Provides both real git execution and mock implementation for testing.
 * All operations are async and work with a specified working directory.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitExecutor } from "./types.js";

/**
 * Execute a shell command and return result.
 */
async function exec(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * RealGit implements GitExecutor using actual git commands.
 */
export class RealGit implements GitExecutor {
  async fetch(cwd: string): Promise<void> {
    const { exitCode, stderr } = await exec("git", ["fetch", "--all"], cwd);
    if (exitCode !== 0) {
      throw new Error(`git fetch failed: ${stderr}`);
    }
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    const { exitCode, stderr } = await exec("git", ["checkout", branch], cwd);
    if (exitCode !== 0) {
      throw new Error(`git checkout '${branch}' failed: ${stderr}`);
    }
  }

  async resetHard(cwd: string, ref: string): Promise<void> {
    const { exitCode, stderr } = await exec(
      "git",
      ["reset", "--hard", ref],
      cwd
    );
    if (exitCode !== 0) {
      throw new Error(`git reset --hard '${ref}' failed: ${stderr}`);
    }
  }

  async createBranch(cwd: string, branch: string, startPoint?: string): Promise<void> {
    const args = startPoint
      ? ["checkout", "-b", branch, startPoint]
      : ["checkout", "-b", branch];
    const { exitCode, stderr } = await exec("git", args, cwd);
    if (exitCode !== 0) {
      throw new Error(`git checkout -b '${branch}' failed: ${stderr}`);
    }
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    // Check local branch
    const local = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
    if (local.exitCode === 0) return true;
    // Check remote branch
    const remote = await exec("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], cwd);
    return remote.exitCode === 0;
  }

  async deleteBranch(cwd: string, branch: string): Promise<void> {
    const { exitCode, stderr } = await exec(
      "git",
      ["branch", "-D", branch],
      cwd
    );
    if (exitCode !== 0) {
      throw new Error(`git branch -D '${branch}' failed: ${stderr}`);
    }
  }

  async deleteRemoteBranch(cwd: string, branch: string, remote: string = "origin"): Promise<void> {
    const { exitCode, stderr } = await exec(
      "git",
      ["push", remote, "--delete", branch],
      cwd
    );
    if (exitCode !== 0) {
      throw new Error(`git push --delete '${branch}' failed: ${stderr}`);
    }
  }

  async merge(cwd: string, branch: string, strategy: "ff" | "merge" = "ff"): Promise<void> {
    const args = strategy === "ff"
      ? ["merge", "--ff-only", branch]
      : ["merge", "--no-ff", branch];
    const { exitCode, stderr } = await exec("git", args, cwd);
    if (exitCode !== 0) {
      throw new Error(`git merge '${branch}' failed: ${stderr}`);
    }
  }

  async currentBranch(cwd: string): Promise<string> {
    const { stdout, exitCode, stderr } = await exec(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd
    );
    if (exitCode !== 0) {
      throw new Error(`git rev-parse failed: ${stderr}`);
    }
    return stdout.trim();
  }

  async clean(cwd: string): Promise<void> {
    const { exitCode, stderr } = await exec("git", ["clean", "-fd"], cwd);
    if (exitCode !== 0) {
      throw new Error(`git clean failed: ${stderr}`);
    }
  }

  async addWorktree(cwd: string, path: string, branch: string): Promise<void> {
    // Use --detach to avoid "branch already checked out" error when creating
    // worktrees for the same branch that's checked out in the main repo.
    // We point at origin/<branch> to get the latest remote state.
    const { exitCode, stderr } = await exec(
      "git",
      ["worktree", "add", "--detach", path, `origin/${branch}`],
      cwd
    );
    if (exitCode !== 0) {
      throw new Error(`git worktree add failed: ${stderr}`);
    }
  }

  async removeWorktree(cwd: string, path: string): Promise<void> {
    const { exitCode, stderr } = await exec(
      "git",
      ["worktree", "remove", path, "--force"],
      cwd
    );
    if (exitCode !== 0) {
      throw new Error(`git worktree remove failed: ${stderr}`);
    }
  }

  async getCommitHash(cwd: string, short: boolean = true): Promise<string> {
    const args = short
      ? ["rev-parse", "--short", "HEAD"]
      : ["rev-parse", "HEAD"];
    const { stdout, exitCode, stderr } = await exec("git", args, cwd);
    if (exitCode !== 0) {
      throw new Error(`git rev-parse HEAD failed: ${stderr}`);
    }
    return stdout.trim();
  }
}

/**
 * MockGit implements GitExecutor for testing.
 * Tracks git state in memory without actually running git.
 */
export class MockGit implements GitExecutor {
  /** Track branches per repository */
  branches: Map<string, Set<string>> = new Map();
  /** Track current branch per repository */
  currentBranches: Map<string, string> = new Map();
  /** Track worktrees */
  worktrees: Map<string, string> = new Map();

  /**
   * Initialize a mock repository with a default branch.
   * Also adds origin/<branch> ref for release operations.
   */
  initRepo(cwd: string, defaultBranch: string = "main"): void {
    this.branches.set(cwd, new Set([defaultBranch, `origin/${defaultBranch}`]));
    this.currentBranches.set(cwd, defaultBranch);
  }

  async fetch(_cwd: string): Promise<void> {
    // No-op in mock
  }

  async checkout(cwd: string, branch: string): Promise<void> {
    const repoBranches = this.branches.get(cwd);
    if (!repoBranches?.has(branch)) {
      throw new Error(`Branch '${branch}' not found`);
    }
    this.currentBranches.set(cwd, branch);
  }

  async resetHard(_cwd: string, _ref: string): Promise<void> {
    // No-op in mock
  }

  async createBranch(cwd: string, branch: string, _startPoint?: string): Promise<void> {
    let repoBranches = this.branches.get(cwd);
    if (!repoBranches) {
      repoBranches = new Set(["main"]);
      this.branches.set(cwd, repoBranches);
    }
    if (repoBranches.has(branch)) {
      throw new Error(`Branch '${branch}' already exists`);
    }
    repoBranches.add(branch);
    this.currentBranches.set(cwd, branch);
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    const repoBranches = this.branches.get(cwd);
    if (!repoBranches) return false;
    return repoBranches.has(branch) || repoBranches.has(`origin/${branch}`);
  }

  async deleteBranch(cwd: string, branch: string): Promise<void> {
    const repoBranches = this.branches.get(cwd);
    if (!repoBranches?.has(branch)) {
      throw new Error(`Branch '${branch}' not found`);
    }
    repoBranches.delete(branch);
  }

  async deleteRemoteBranch(_cwd: string, _branch: string, _remote: string = "origin"): Promise<void> {
    // No-op in mock - remote branches not tracked
  }

  async merge(cwd: string, branch: string, _strategy: "ff" | "merge" = "ff"): Promise<void> {
    const repoBranches = this.branches.get(cwd);
    if (!repoBranches?.has(branch)) {
      throw new Error(`Branch '${branch}' not found`);
    }
    // Mock merge is a no-op but validates branch exists
  }

  async currentBranch(cwd: string): Promise<string> {
    const branch = this.currentBranches.get(cwd);
    if (!branch) {
      throw new Error(`No repository initialized at '${cwd}'`);
    }
    return branch;
  }

  async clean(_cwd: string): Promise<void> {
    // No-op in mock
  }

  async addWorktree(cwd: string, path: string, branch: string): Promise<void> {
    // Create the directory to simulate real git worktree behavior
    await mkdir(path, { recursive: true });
    this.worktrees.set(path, branch);

    // Create .git file pointing to fake gitdir inside workspace (like real worktrees)
    // Use .git-actual inside workspace to avoid needing to write to project path
    const fakeGitDir = join(path, ".git-actual");
    await writeFile(join(path, ".git"), `gitdir: ${fakeGitDir}\n`);
    // Create the info directory for exclude file
    await mkdir(join(fakeGitDir, "info"), { recursive: true });

    // Copy branches from source repo to worktree path, including origin refs
    const srcBranches = this.branches.get(cwd);
    if (srcBranches) {
      const worktreeBranches = new Set(srcBranches);
      // Add origin/ refs for any local branches
      for (const b of srcBranches) {
        worktreeBranches.add(`origin/${b}`);
      }
      this.branches.set(path, worktreeBranches);
      this.currentBranches.set(path, branch);
    }
  }

  async removeWorktree(_cwd: string, path: string): Promise<void> {
    this.worktrees.delete(path);
  }

  async getCommitHash(_cwd: string, short: boolean = true): Promise<string> {
    // Return a mock commit hash
    return short ? "abc1234" : "abc1234567890abcdef1234567890abcdef12345";
  }

  /**
   * Test helper: Clear all state.
   */
  clear(): void {
    this.branches.clear();
    this.currentBranches.clear();
    this.worktrees.clear();
  }
}

/**
 * Create a real git executor for production use.
 */
export function createGit(): GitExecutor {
  return new RealGit();
}
