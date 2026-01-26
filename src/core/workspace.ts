/**
 * Workspace pool management.
 *
 * Manages git worktrees as a reusable resource pool.
 * Uses file locking to prevent race conditions.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { Deps, Project, PoolState, WorkspaceEntry } from "./types.js";

/**
 * Get the path to the workspaces directory.
 */
function getWorkspacesDir(deps: Deps): string {
  return join(deps.dataDir, "workspaces");
}

/**
 * Get the path to .pool.json.
 */
function getPoolPath(deps: Deps): string {
  return join(getWorkspacesDir(deps), ".pool.json");
}

/**
 * Get the lock file path.
 */
function getLockPath(deps: Deps): string {
  return join(getWorkspacesDir(deps), ".pool.lock");
}

/**
 * Load pool state from .pool.json.
 */
export async function loadPoolState(deps: Deps): Promise<PoolState> {
  try {
    const content = await readFile(getPoolPath(deps), "utf-8");
    return JSON.parse(content) as PoolState;
  } catch {
    return { workspaces: {} };
  }
}

/**
 * Save pool state to .pool.json.
 */
async function savePoolState(deps: Deps, state: PoolState): Promise<void> {
  await writeFile(getPoolPath(deps), JSON.stringify(state, null, 2));
}

/**
 * Ensure workspaces directory exists.
 */
async function ensureWorkspacesDir(deps: Deps): Promise<void> {
  await mkdir(getWorkspacesDir(deps), { recursive: true });
}

/**
 * Initialize workspace pool for a project.
 * Creates worktrees based on pool_size.
 */
export async function initWorkspacePool(deps: Deps, project: Project): Promise<void> {
  await ensureWorkspacesDir(deps);

  const poolState = await loadPoolState(deps);

  for (let i = 1; i <= project.pool_size; i++) {
    const name = `${project.name}--${i}`;
    const worktreePath = join(getWorkspacesDir(deps), name);

    // Skip if already exists
    if (poolState.workspaces[name]) {
      continue;
    }

    // Create worktree
    await deps.git.addWorktree(project.path, worktreePath, project.default_branch);

    // Add to pool state
    poolState.workspaces[name] = { status: "available" };
  }

  await savePoolState(deps, poolState);
}

/**
 * Acquire an available workspace for a project.
 * Uses file locking to prevent race conditions.
 */
export async function acquireWorkspace(
  deps: Deps,
  project: string,
  task: string
): Promise<string> {
  await ensureWorkspacesDir(deps);

  // Create lock file if it doesn't exist
  const lockPath = getLockPath(deps);
  await writeFile(lockPath, "", { flag: "a" });

  // Acquire lock
  const release = await lock(lockPath, { retries: 5 });

  try {
    const poolState = await loadPoolState(deps);

    // Find first available workspace for this project
    const prefix = `${project}--`;
    const available = Object.entries(poolState.workspaces).find(
      ([name, entry]) => name.startsWith(prefix) && entry.status === "available"
    );

    if (!available) {
      throw new Error(`No available workspace for project '${project}'`);
    }

    const [name] = available;

    // Mark as bound
    poolState.workspaces[name] = { status: "bound", task };
    await savePoolState(deps, poolState);

    return name;
  } finally {
    await release();
  }
}

/**
 * Release a workspace back to the pool.
 * Cleans git state before making it available.
 * After release, auto-spawns the next pending task for this project.
 */
export async function releaseWorkspace(deps: Deps, workspace: string): Promise<void> {
  await ensureWorkspacesDir(deps);

  // Create lock file if it doesn't exist
  const lockPath = getLockPath(deps);
  await writeFile(lockPath, "", { flag: "a" });

  // Extract project name before lock (needed for auto-spawn)
  const projectName = workspace.split("--")[0];

  // Acquire lock
  const release = await lock(lockPath, { retries: 5 });

  try {
    const poolState = await loadPoolState(deps);

    if (!poolState.workspaces[workspace]) {
      throw new Error(`Workspace '${workspace}' not found in pool`);
    }

    // Clean workspace
    const workspacePath = join(getWorkspacesDir(deps), workspace);

    // Try to checkout main, fall back to master if needed
    try {
      await deps.git.checkout(workspacePath, "main");
    } catch {
      await deps.git.checkout(workspacePath, "master");
    }

    await deps.git.clean(workspacePath);

    // Mark as available
    poolState.workspaces[workspace] = { status: "available" };
    await savePoolState(deps, poolState);
  } finally {
    await release();
  }

  // Auto-spawn next pending task for this project (outside lock)
  // Imported dynamically to avoid circular dependency
  const { spawnNextPending } = await import("./spawn.js");
  await spawnNextPending(deps, projectName);
}

/**
 * Get workspace path.
 */
export function getWorkspacePath(deps: Deps, workspace: string): string {
  return join(getWorkspacesDir(deps), workspace);
}
