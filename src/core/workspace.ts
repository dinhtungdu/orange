/**
 * Workspace pool management.
 *
 * Manages git worktrees as a reusable resource pool.
 * Uses file locking to prevent race conditions.
 *
 * TASK.md is the single source of truth for workspace allocation.
 * A workspace is "bound" if any TASK.md has `workspace: <name>` in frontmatter.
 * A workspace is "available" if no TASK.md references it.
 *
 * Supports lazy initialization - worktrees are created on-demand
 * when task spawn requests a workspace and none are available.
 */

import { writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { Deps, Project, PoolState, Task } from "./types.js";
import { loadProjects } from "./state.js";
import { getAllGitExcludes } from "./harness.js";
import { listTasks } from "./db.js";

/**
 * Get the path to the workspaces directory.
 */
export function getWorkspacesDir(deps: Deps): string {
  return join(deps.dataDir, "workspaces");
}

/**
 * Get the lock file path.
 */
function getLockPath(deps: Deps): string {
  return join(getWorkspacesDir(deps), ".pool.lock");
}

/**
 * Get all workspace directories that exist on disk.
 * Returns sorted list for deterministic ordering.
 */
async function getExistingWorkspaces(deps: Deps): Promise<string[]> {
  const workspacesDir = getWorkspacesDir(deps);
  try {
    const entries = await readdir(workspacesDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.includes("--"))
      .map((e) => e.name)
      .sort((a, b) => {
        // Sort by project name first, then by number
        const [projA, numA] = a.split("--");
        const [projB, numB] = b.split("--");
        if (projA !== projB) return projA.localeCompare(projB);
        return parseInt(numA, 10) - parseInt(numB, 10);
      });
  } catch (err) {
    // Directory doesn't exist yet - this is expected on first run
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    // Other errors (permissions, etc.) should propagate
    throw err;
  }
}

/**
 * Get bound workspaces from TASK.md files (single source of truth).
 * Returns a map of workspace name → task reference (project/branch).
 */
async function getBoundWorkspaces(deps: Deps): Promise<Map<string, string>> {
  const tasks = await listTasks(deps, {});
  const bound = new Map<string, string>();
  
  for (const task of tasks) {
    if (task.workspace) {
      bound.set(task.workspace, `${task.project}/${task.branch}`);
    }
  }
  
  return bound;
}

/**
 * Load pool state derived from TASK.md files and existing workspace directories.
 * This is the single source of truth - no .pool.json needed.
 */
export async function loadPoolState(deps: Deps): Promise<PoolState> {
  const existingWorkspaces = await getExistingWorkspaces(deps);
  const boundWorkspaces = await getBoundWorkspaces(deps);
  
  const workspaces: PoolState["workspaces"] = {};
  
  for (const name of existingWorkspaces) {
    const task = boundWorkspaces.get(name);
    if (task) {
      workspaces[name] = { status: "bound", task };
    } else {
      workspaces[name] = { status: "available" };
    }
  }
  
  return { workspaces };
}

/**
 * Ensure workspaces directory exists.
 */
async function ensureWorkspacesDir(deps: Deps): Promise<void> {
  await mkdir(getWorkspacesDir(deps), { recursive: true });
}

/**
 * Count existing workspaces for a project.
 */
function countProjectWorkspaces(existingWorkspaces: string[], projectName: string): number {
  const prefix = `${projectName}--`;
  return existingWorkspaces.filter((name) => name.startsWith(prefix)).length;
}

/**
 * Get the next workspace number for a project.
 */
function getNextWorkspaceNumber(existingWorkspaces: string[], projectName: string): number {
  const prefix = `${projectName}--`;
  const numbers = existingWorkspaces
    .filter((name) => name.startsWith(prefix))
    .map((name) => parseInt(name.slice(prefix.length), 10))
    .filter((n) => !isNaN(n));

  if (numbers.length === 0) return 1;
  return Math.max(...numbers) + 1;
}

/**
 * Create a single worktree for a project.
 * Returns the workspace name.
 *
 * Note: Harness-specific setup happens at spawn time, not here.
 * This allows different tasks to use different harnesses in the same worktree pool.
 */
async function createWorktree(
  deps: Deps,
  project: Project,
  existingWorkspaces: string[]
): Promise<string> {
  const number = getNextWorkspaceNumber(existingWorkspaces, project.name);
  const name = `${project.name}--${number}`;
  const worktreePath = join(getWorkspacesDir(deps), name);

  // Safety check: verify the directory doesn't already exist
  // This catches stale state / race conditions
  const { stat } = await import("node:fs/promises");
  try {
    await stat(worktreePath);
    // If we get here, the path exists but wasn't in existingWorkspaces
    throw new Error(
      `Workspace directory '${worktreePath}' already exists but wasn't detected. ` +
      `This may indicate stale state. Try running 'orange workspace gc'.`
    );
  } catch (err) {
    // ENOENT is expected - directory doesn't exist, we can create it
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  console.log(`Creating workspace ${name}...`);
  await deps.git.addWorktree(project.path, worktreePath, project.default_branch);

  // Add orange files to main repo's .git/info/exclude
  await addGitExcludes(project.path);

  return name;
}

/**
 * Add orange-managed files to the main repo's .git/info/exclude.
 * Worktrees share the main repo's exclude file — worktree-specific
 * git dirs don't support their own info/exclude.
 *
 * @param projectPath - Path to the main project repo (not the worktree)
 */
export async function addGitExcludes(projectPath: string): Promise<void> {
  try {
    const gitDir = join(projectPath, ".git");
    const excludeDir = join(gitDir, "info");
    await mkdir(excludeDir, { recursive: true });
    const excludePath = join(excludeDir, "exclude");

    let excludeContent = "";
    try {
      const { readFile } = await import("node:fs/promises");
      excludeContent = await readFile(excludePath, "utf-8");
    } catch {
      // File doesn't exist
    }

    // Get all excludes from all harnesses
    const entries = getAllGitExcludes();
    for (const entry of entries) {
      if (!excludeContent.includes(entry)) {
        const newLine = excludeContent.endsWith("\n") || excludeContent === "" ? "" : "\n";
        excludeContent += `${newLine}${entry}\n`;
      }
    }
    await writeFile(excludePath, excludeContent);
  } catch {
    // Best-effort — project path may not be a real git repo in tests
  }
}

/**
 * Initialize workspace pool for a project.
 * Creates worktrees based on pool_size.
 *
 * This is optional - workspaces can be created lazily on first spawn.
 * Note: Harness-specific setup happens at spawn time, not here.
 */
export async function initWorkspacePool(deps: Deps, project: Project): Promise<void> {
  await ensureWorkspacesDir(deps);

  const existingWorkspaces = await getExistingWorkspaces(deps);

  for (let i = 1; i <= project.pool_size; i++) {
    const name = `${project.name}--${i}`;
    const worktreePath = join(getWorkspacesDir(deps), name);

    // Skip if already exists
    if (existingWorkspaces.includes(name)) {
      continue;
    }

    // Create worktree
    await deps.git.addWorktree(project.path, worktreePath, project.default_branch);

    // Add orange files to main repo's .git/info/exclude
    await addGitExcludes(project.path);
  }
}

/**
 * Acquire an available workspace for a project.
 * Uses file locking to prevent race conditions.
 *
 * If no workspace is available but pool_size allows, creates a new worktree (lazy init).
 * If pool is exhausted (all workspaces bound and at pool_size), throws an error.
 *
 * Note: This only returns the workspace name. The caller must update TASK.md
 * with `workspace: <name>` to mark it as bound (TASK.md is source of truth).
 */
export async function acquireWorkspace(
  deps: Deps,
  projectName: string,
  _task: string  // Kept for API compatibility, but not stored in pool.json anymore
): Promise<string> {
  const log = deps.logger.child("workspace");

  log.debug("Acquiring workspace", { project: projectName });
  await ensureWorkspacesDir(deps);

  // Create lock file if it doesn't exist
  const lockPath = getLockPath(deps);
  await writeFile(lockPath, "", { flag: "a" });

  // Acquire lock
  log.debug("Acquiring pool lock");
  const release = await lock(lockPath, { retries: 5 });

  try {
    const existingWorkspaces = await getExistingWorkspaces(deps);
    const boundWorkspaces = await getBoundWorkspaces(deps);

    // Find first available workspace for this project
    const prefix = `${projectName}--`;
    const projectWorkspaces = existingWorkspaces.filter((name) => name.startsWith(prefix));
    const available = projectWorkspaces.find((name) => !boundWorkspaces.has(name));

    log.debug("Workspace pool state", {
      project: projectName,
      existing: projectWorkspaces,
      bound: Array.from(boundWorkspaces.keys()).filter((name) => name.startsWith(prefix)),
      available,
    });

    if (available) {
      log.info("Workspace acquired", { workspace: available, project: projectName });
      return available;
    }

    // No available workspace - try lazy init
    log.debug("No available workspace, attempting lazy init", { project: projectName });
    const projects = await loadProjects(deps);
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      log.error("Project not found for lazy init", { project: projectName });
      throw new Error(`Project '${projectName}' not found`);
    }

    const existingCount = countProjectWorkspaces(existingWorkspaces, projectName);
    if (existingCount >= project.pool_size) {
      log.warn("Pool exhausted", { project: projectName, existing: existingCount, poolSize: project.pool_size });
      throw new Error(
        `No available workspace for project '${projectName}' (pool exhausted: ${existingCount}/${project.pool_size})`
      );
    }

    // Create new worktree (lazy init)
    log.info("Creating new worktree (lazy init)", { project: projectName });
    const name = await createWorktree(deps, project, existingWorkspaces);

    log.info("Workspace acquired (new)", { workspace: name, project: projectName });
    return name;
  } finally {
    log.debug("Releasing pool lock");
    await release();
  }
}

/**
 * Release a workspace back to the pool.
 * Cleans git state to prepare for reuse.
 *
 * Note: The caller must clear `workspace` in TASK.md to mark it as available
 * (TASK.md is the source of truth for allocation).
 *
 * After release, optionally auto-spawns the next pending task for this project.
 *
 * @param autoSpawn - Whether to auto-spawn next pending task (default: true)
 */
export async function releaseWorkspace(deps: Deps, workspace: string, autoSpawn = true): Promise<void> {
  const log = deps.logger.child("workspace");

  log.debug("Releasing workspace", { workspace });
  await ensureWorkspacesDir(deps);

  // Create lock file if it doesn't exist
  const lockPath = getLockPath(deps);
  await writeFile(lockPath, "", { flag: "a" });

  // Extract project name before lock (needed for auto-spawn)
  const projectName = workspace.split("--")[0];

  // Acquire lock
  log.debug("Acquiring pool lock for release");
  const release = await lock(lockPath, { retries: 5 });

  try {
    // Verify workspace exists
    const existingWorkspaces = await getExistingWorkspaces(deps);
    if (!existingWorkspaces.includes(workspace)) {
      log.error("Workspace not found", { workspace });
      throw new Error(`Workspace '${workspace}' not found`);
    }

    // Clean workspace
    const workspacePath = join(getWorkspacesDir(deps), workspace);
    log.debug("Cleaning workspace", { workspace, path: workspacePath });

    // Check for uncommitted changes - fail if dirty so user can review
    const isDirty = await deps.git.isDirty(workspacePath);
    if (isDirty) {
      throw new Error(
        `Workspace has uncommitted changes. Review the workspace before merging.`
      );
    }

    // Get project's default branch
    const projects = await loadProjects(deps);
    const project = projects.find((p) => p.name === projectName);
    const defaultBranch = project?.default_branch ?? "main";

    // Fetch latest refs (ignore error for local-only repos)
    try {
      await deps.git.fetch(workspacePath);
    } catch {
      // No remote - local-only repo
    }

    // Reset to default branch - try origin/<branch> first, fallback to local branch
    try {
      await deps.git.resetHard(workspacePath, `origin/${defaultBranch}`);
    } catch {
      await deps.git.resetHard(workspacePath, defaultBranch);
    }

    // Clean untracked files
    await deps.git.clean(workspacePath);

    // Remove orange-specific files (excluded from git, so git clean won't remove them)
    const outcomeFile = join(workspacePath, ".orange-outcome");
    const taskSymlink = join(workspacePath, "TASK.md");
    for (const file of [outcomeFile, taskSymlink]) {
      try {
        await unlink(file);
      } catch {
        // File may not exist
      }
    }

    log.info("Workspace released", { workspace, project: projectName });
  } finally {
    log.debug("Releasing pool lock");
    await release();
  }

  // Auto-spawn next pending task for this project (outside lock)
  if (autoSpawn) {
    // Imported dynamically to avoid circular dependency
    const { spawnNextPending } = await import("./spawn.js");
    await spawnNextPending(deps, projectName);
  }
}

/**
 * Get workspace path.
 */
export function getWorkspacePath(deps: Deps, workspace: string): string {
  return join(getWorkspacesDir(deps), workspace);
}

/**
 * Get pool statistics for a project.
 * Derived from TASK.md files (single source of truth).
 */
export async function getPoolStats(
  deps: Deps,
  projectName: string
): Promise<{ total: number; available: number; bound: number; poolSize: number }> {
  const existingWorkspaces = await getExistingWorkspaces(deps);
  const boundWorkspaces = await getBoundWorkspaces(deps);
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === projectName);

  const prefix = `${projectName}--`;
  const projectWorkspaces = existingWorkspaces.filter((name) => name.startsWith(prefix));

  const bound = projectWorkspaces.filter((name) => boundWorkspaces.has(name)).length;
  const available = projectWorkspaces.length - bound;

  return {
    total: projectWorkspaces.length,
    available,
    bound,
    poolSize: project?.pool_size ?? 0,
  };
}
