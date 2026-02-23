/**
 * Workspace pool management.
 *
 * Manages git worktrees as a reusable resource pool.
 * Uses file locking to prevent race conditions.
 *
 * Pool state is tracked in .pool.json (per data.md spec).
 * acquire marks a workspace as bound, release marks it as available.
 */

import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import type { Deps, Project, PoolState } from "./types.js";
import { loadProjects } from "./state.js";
import { getAllGitExcludes } from "./harness.js";

const POOL_FILE = ".pool.json";

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
 * Get the .pool.json file path.
 */
function getPoolPath(deps: Deps): string {
  return join(getWorkspacesDir(deps), POOL_FILE);
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
        const [projA, numA] = a.split("--");
        const [projB, numB] = b.split("--");
        if (projA !== projB) return projA.localeCompare(projB);
        return parseInt(numA, 10) - parseInt(numB, 10);
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
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
  await ensureWorkspacesDir(deps);
  await writeFile(getPoolPath(deps), JSON.stringify(state, null, 2));
}

/**
 * Ensure workspaces directory exists.
 */
async function ensureWorkspacesDir(deps: Deps): Promise<void> {
  await mkdir(getWorkspacesDir(deps), { recursive: true });
}

/**
 * Count existing workspaces for a project in pool state.
 */
function countProjectWorkspaces(state: PoolState, projectName: string): number {
  const prefix = `${projectName}--`;
  return Object.keys(state.workspaces).filter((name) => name.startsWith(prefix)).length;
}

/**
 * Get the next workspace number for a project.
 * Considers both pool state AND directories on disk to avoid collisions.
 */
function getNextWorkspaceNumber(
  state: PoolState,
  projectName: string,
  existingDirs: string[]
): number {
  const prefix = `${projectName}--`;

  // Collect numbers from both pool state and disk
  const stateNumbers = Object.keys(state.workspaces)
    .filter((name) => name.startsWith(prefix))
    .map((name) => parseInt(name.slice(prefix.length), 10));
  const diskNumbers = existingDirs
    .filter((name) => name.startsWith(prefix))
    .map((name) => parseInt(name.slice(prefix.length), 10));

  const numbers = [...new Set([...stateNumbers, ...diskNumbers])].filter(
    (n) => !isNaN(n)
  );

  if (numbers.length === 0) return 1;
  return Math.max(...numbers) + 1;
}

/**
 * Create a single worktree for a project.
 * Returns the workspace name.
 */
async function createWorktree(
  deps: Deps,
  project: Project,
  state: PoolState
): Promise<string> {
  const existingDirs = await getExistingWorkspaces(deps);
  const number = getNextWorkspaceNumber(state, project.name, existingDirs);
  const name = `${project.name}--${number}`;
  const worktreePath = join(getWorkspacesDir(deps), name);

  console.log(`Creating workspace ${name}...`);
  await deps.git.addWorktree(project.path, worktreePath, project.default_branch);
  await addGitExcludes(project.path);

  return name;
}

/**
 * Add orange-managed files to the main repo's .git/info/exclude.
 * Worktrees share the main repo's exclude file.
 */
export async function addGitExcludes(projectPath: string): Promise<void> {
  try {
    const gitDir = join(projectPath, ".git");
    const excludeDir = join(gitDir, "info");
    await mkdir(excludeDir, { recursive: true });
    const excludePath = join(excludeDir, "exclude");

    let excludeContent = "";
    try {
      const { readFile: rf } = await import("node:fs/promises");
      excludeContent = await rf(excludePath, "utf-8");
    } catch {
      // File doesn't exist
    }

    const entries = getAllGitExcludes();
    for (const entry of entries) {
      if (!excludeContent.includes(entry)) {
        const newLine = excludeContent.endsWith("\n") || excludeContent === "" ? "" : "\n";
        excludeContent += `${newLine}${entry}\n`;
      }
    }
    await writeFile(excludePath, excludeContent);
  } catch {
    // Best-effort
  }
}

/**
 * Initialize workspace pool for a project.
 * Creates worktrees based on pool_size and writes to .pool.json.
 */
export async function initWorkspacePool(deps: Deps, project: Project): Promise<void> {
  await ensureWorkspacesDir(deps);

  const state = await loadPoolState(deps);
  const existingDirs = await getExistingWorkspaces(deps);

  for (let i = 1; i <= project.pool_size; i++) {
    const name = `${project.name}--${i}`;

    // Skip if already tracked in pool state
    if (state.workspaces[name]) {
      continue;
    }

    const worktreePath = join(getWorkspacesDir(deps), name);

    // Create worktree if directory doesn't exist
    if (!existingDirs.includes(name)) {
      await deps.git.addWorktree(project.path, worktreePath, project.default_branch);
      await addGitExcludes(project.path);
    }

    state.workspaces[name] = { status: "available" };
  }

  await savePoolState(deps, state);
}

/**
 * Acquire an available workspace for a project.
 * Uses file locking to prevent race conditions.
 *
 * Marks the workspace as bound in .pool.json.
 * If pool is exhausted, throws an error.
 */
export async function acquireWorkspace(
  deps: Deps,
  projectName: string,
  task: string
): Promise<string> {
  const log = deps.logger.child("workspace");

  log.debug("Acquiring workspace", { project: projectName });
  await ensureWorkspacesDir(deps);

  // Create lock file if it doesn't exist
  const lockPath = getLockPath(deps);
  await writeFile(lockPath, "", { flag: "a" });

  log.debug("Acquiring pool lock");
  const release = await lock(lockPath, { retries: 5 });

  try {
    const state = await loadPoolState(deps);

    // Find first available workspace for this project
    const prefix = `${projectName}--`;
    const available = Object.entries(state.workspaces)
      .find(([name, entry]) => name.startsWith(prefix) && entry.status === "available");

    log.debug("Workspace pool state", {
      project: projectName,
      available: available?.[0] ?? null,
    });

    if (available) {
      const [name] = available;
      state.workspaces[name] = { status: "bound", task };
      await savePoolState(deps, state);
      log.info("Workspace acquired", { workspace: name, project: projectName });
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

    const existingCount = countProjectWorkspaces(state, projectName);
    if (existingCount >= project.pool_size) {
      log.warn("Pool exhausted", { project: projectName, existing: existingCount, poolSize: project.pool_size });
      throw new Error(
        `No available workspace for project '${projectName}' (pool exhausted: ${existingCount}/${project.pool_size})`
      );
    }

    // Create new worktree (lazy init)
    log.info("Creating new worktree (lazy init)", { project: projectName });
    const name = await createWorktree(deps, project, state);

    // Mark as bound in pool state
    state.workspaces[name] = { status: "bound", task };
    await savePoolState(deps, state);

    log.info("Workspace acquired (new)", { workspace: name, project: projectName });
    return name;
  } finally {
    log.debug("Releasing pool lock");
    await release();
  }
}

/**
 * Release a workspace back to the pool.
 * Cleans git state and marks as available in .pool.json.
 *
 * Release never auto-spawns. The spawn_next hook handles that separately.
 */
export async function releaseWorkspace(
  deps: Deps,
  workspace: string,
  options?: { force?: boolean }
): Promise<void> {
  const log = deps.logger.child("workspace");

  log.debug("Releasing workspace", { workspace });
  await ensureWorkspacesDir(deps);

  // Create lock file if it doesn't exist
  const lockPath = getLockPath(deps);
  await writeFile(lockPath, "", { flag: "a" });

  const projectName = workspace.split("--")[0];

  log.debug("Acquiring pool lock for release");
  const release = await lock(lockPath, { retries: 5 });

  try {
    // Verify workspace is tracked
    const state = await loadPoolState(deps);
    if (!state.workspaces[workspace]) {
      // Check if directory exists on disk but not tracked
      const existingDirs = await getExistingWorkspaces(deps);
      if (!existingDirs.includes(workspace)) {
        log.error("Workspace not found", { workspace });
        throw new Error(`Workspace '${workspace}' not found`);
      }
    }

    // Clean workspace
    const workspacePath = join(getWorkspacesDir(deps), workspace);
    log.debug("Cleaning workspace", { workspace, path: workspacePath });

    // Check for uncommitted changes (skip when force — e.g. PR already merged)
    if (!options?.force) {
      const isDirty = await deps.git.isDirty(workspacePath);
      if (isDirty) {
        throw new Error(
          `Workspace has uncommitted changes. Review the workspace before merging.`
        );
      }
    }

    // Get project's default branch
    const projects = await loadProjects(deps);
    const project = projects.find((p) => p.name === projectName);
    const defaultBranch = project?.default_branch ?? "main";

    // Fetch latest refs
    try {
      await deps.git.fetch(workspacePath);
    } catch {
      // No remote
    }

    // Reset to default branch
    try {
      await deps.git.resetHard(workspacePath, `origin/${defaultBranch}`);
    } catch {
      await deps.git.resetHard(workspacePath, defaultBranch);
    }

    // Clean untracked files
    await deps.git.clean(workspacePath);

    // Remove TASK.md symlink and orange files
    const taskSymlink = join(workspacePath, "TASK.md");
    const outcomeFile = join(workspacePath, ".orange-outcome");
    for (const file of [taskSymlink, outcomeFile]) {
      try {
        await unlink(file);
      } catch {
        // File may not exist
      }
    }

    // Mark as available in .pool.json
    state.workspaces[workspace] = { status: "available" };
    await savePoolState(deps, state);

    log.info("Workspace released", { workspace, project: projectName });
  } finally {
    log.debug("Releasing pool lock");
    await release();
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
 */
export async function getPoolStats(
  deps: Deps,
  projectName: string
): Promise<{ total: number; available: number; bound: number; poolSize: number }> {
  const state = await loadPoolState(deps);
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === projectName);

  const prefix = `${projectName}--`;
  const projectEntries = Object.entries(state.workspaces)
    .filter(([name]) => name.startsWith(prefix));

  const bound = projectEntries.filter(([, e]) => e.status === "bound").length;
  const available = projectEntries.length - bound;

  return {
    total: projectEntries.length,
    available,
    bound,
    poolSize: project?.pool_size ?? 0,
  };
}
