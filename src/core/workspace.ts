/**
 * Workspace pool management.
 *
 * Manages git worktrees as a reusable resource pool.
 * Uses file locking to prevent race conditions.
 *
 * Supports lazy initialization - worktrees are created on-demand
 * when task spawn requests a workspace and none are available.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { Deps, Project, PoolState, WorkspaceEntry, Logger } from "./types.js";
import { loadProjects } from "./state.js";

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
 * Count existing workspaces for a project.
 */
function countProjectWorkspaces(poolState: PoolState, projectName: string): number {
  const prefix = `${projectName}--`;
  return Object.keys(poolState.workspaces).filter((name) =>
    name.startsWith(prefix)
  ).length;
}

/**
 * Get the next workspace number for a project.
 */
function getNextWorkspaceNumber(poolState: PoolState, projectName: string): number {
  const prefix = `${projectName}--`;
  const numbers = Object.keys(poolState.workspaces)
    .filter((name) => name.startsWith(prefix))
    .map((name) => parseInt(name.slice(prefix.length), 10))
    .filter((n) => !isNaN(n));

  if (numbers.length === 0) return 1;
  return Math.max(...numbers) + 1;
}

/**
 * Default Claude settings for autonomous agents.
 * Pre-allows common dev commands to avoid permission prompts.
 */
const AGENT_SETTINGS = {
  permissions: {
    allow: [
      "Bash(bun run check:*)",
      "Bash(bunx tsc:*)",
      "Bash(bun test:*)",
      "Bash(bun install)",
      "Bash(git stash:*)",
    ],
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
  },
};

/**
 * Create a single worktree for a project.
 * Returns the workspace name.
 */
async function createWorktree(
  deps: Deps,
  project: Project,
  poolState: PoolState
): Promise<string> {
  const number = getNextWorkspaceNumber(poolState, project.name);
  const name = `${project.name}--${number}`;
  const worktreePath = join(getWorkspacesDir(deps), name);

  console.log(`Creating workspace ${name}...`);
  await deps.git.addWorktree(project.path, worktreePath, project.default_branch);

  // Create .claude/settings.local.json for autonomous agent permissions
  const claudeDir = join(worktreePath, ".claude");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    join(claudeDir, "settings.local.json"),
    JSON.stringify(AGENT_SETTINGS, null, 2)
  );

  return name;
}

/**
 * Initialize workspace pool for a project.
 * Creates worktrees based on pool_size.
 *
 * This is optional - workspaces can be created lazily on first spawn.
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

    // Create .claude/settings.local.json for autonomous agent permissions
    const claudeDir = join(worktreePath, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "settings.local.json"),
      JSON.stringify(AGENT_SETTINGS, null, 2)
    );

    // Add to pool state
    poolState.workspaces[name] = { status: "available" };
  }

  await savePoolState(deps, poolState);
}

/**
 * Acquire an available workspace for a project.
 * Uses file locking to prevent race conditions.
 *
 * If no workspace is available but pool_size allows, creates a new worktree (lazy init).
 * If pool is exhausted (all workspaces bound and at pool_size), throws an error.
 */
export async function acquireWorkspace(
  deps: Deps,
  projectName: string,
  task: string
): Promise<string> {
  const log = deps.logger.child("workspace");

  log.debug("Acquiring workspace", { project: projectName, task });
  await ensureWorkspacesDir(deps);

  // Create lock file if it doesn't exist
  const lockPath = getLockPath(deps);
  await writeFile(lockPath, "", { flag: "a" });

  // Acquire lock
  log.debug("Acquiring pool lock");
  const release = await lock(lockPath, { retries: 5 });

  try {
    const poolState = await loadPoolState(deps);

    // Find first available workspace for this project
    const prefix = `${projectName}--`;
    const available = Object.entries(poolState.workspaces).find(
      ([name, entry]) => name.startsWith(prefix) && entry.status === "available"
    );

    if (available) {
      // Use existing available workspace
      const [name] = available;
      poolState.workspaces[name] = { status: "bound", task };
      await savePoolState(deps, poolState);
      log.info("Workspace acquired", { workspace: name, project: projectName, task });
      return name;
    }

    // No available workspace - try lazy init
    log.debug("No available workspace, attempting lazy init", { project: projectName });
    const projects = await loadProjects(deps);
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      log.error("Project not found for lazy init", { project: projectName });
      throw new Error(`Project '${projectName}' not found`);
    }

    const existingCount = countProjectWorkspaces(poolState, projectName);
    if (existingCount >= project.pool_size) {
      log.warn("Pool exhausted", { project: projectName, existing: existingCount, poolSize: project.pool_size });
      throw new Error(
        `No available workspace for project '${projectName}' (pool exhausted: ${existingCount}/${project.pool_size})`
      );
    }

    // Create new worktree (lazy init)
    log.info("Creating new worktree (lazy init)", { project: projectName });
    const name = await createWorktree(deps, project, poolState);

    // Mark as bound immediately
    poolState.workspaces[name] = { status: "bound", task };
    await savePoolState(deps, poolState);

    log.info("Workspace acquired (new)", { workspace: name, project: projectName, task });
    return name;
  } finally {
    log.debug("Releasing pool lock");
    await release();
  }
}

/**
 * Release a workspace back to the pool.
 * Cleans git state before making it available.
 * After release, auto-spawns the next pending task for this project.
 */
export async function releaseWorkspace(deps: Deps, workspace: string): Promise<void> {
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
    const poolState = await loadPoolState(deps);

    if (!poolState.workspaces[workspace]) {
      log.error("Workspace not found in pool", { workspace });
      throw new Error(`Workspace '${workspace}' not found in pool`);
    }

    // Clean workspace
    const workspacePath = join(getWorkspacesDir(deps), workspace);
    log.debug("Cleaning workspace", { workspace, path: workspacePath });

    // Checkout detached HEAD at origin/main (or origin/master)
    // Worktrees are created detached, so there's no local main branch
    try {
      await deps.git.checkout(workspacePath, "origin/main");
    } catch {
      await deps.git.checkout(workspacePath, "origin/master");
    }

    await deps.git.clean(workspacePath);

    // Mark as available
    poolState.workspaces[workspace] = { status: "available" };
    await savePoolState(deps, poolState);

    log.info("Workspace released", { workspace, project: projectName });
  } finally {
    log.debug("Releasing pool lock");
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

/**
 * Get pool statistics for a project.
 */
export async function getPoolStats(
  deps: Deps,
  projectName: string
): Promise<{ total: number; available: number; bound: number; poolSize: number }> {
  const poolState = await loadPoolState(deps);
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === projectName);

  const prefix = `${projectName}--`;
  const workspaces = Object.entries(poolState.workspaces).filter(([name]) =>
    name.startsWith(prefix)
  );

  const available = workspaces.filter(([, entry]) => entry.status === "available").length;
  const bound = workspaces.filter(([, entry]) => entry.status === "bound").length;

  return {
    total: workspaces.length,
    available,
    bound,
    poolSize: project?.pool_size ?? 0,
  };
}
