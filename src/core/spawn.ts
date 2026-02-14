/**
 * Task spawning logic.
 *
 * Extracted from CLI to allow auto-spawning from workspace release.
 * The spawnTaskById function validates and delegates to the transition engine
 * or direct hook calls for non-transitioning spawns.
 */

import { join } from "node:path";
import { writeFile, symlink, readFile, unlink, stat } from "node:fs/promises";
import type { Deps } from "./types.js";
import { loadProjects, saveTask, appendHistory, getTaskPath } from "./state.js";
import { listTasks } from "./db.js";
import { acquireWorkspace, releaseWorkspace, addGitExcludes, getWorkspacePath } from "./workspace.js";
import { executeTransition } from "./transitions.js";
import { createHookExecutor, acquireWorkspaceHook, spawnAgentHook } from "./hooks.js";

/**
 * Get the actual git directory path.
 * In worktrees, .git is a file pointing to the real git dir.
 */
export async function getGitDir(workspacePath: string): Promise<string> {
  const gitPath = join(workspacePath, ".git");
  const stats = await stat(gitPath);

  if (stats.isDirectory()) {
    return gitPath;
  }

  // Worktree: .git is a file containing "gitdir: /path/to/actual/git/dir"
  const content = await readFile(gitPath, "utf-8");
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) {
    throw new Error(`Invalid .git file at ${gitPath}`);
  }
  return match[1].trim();
}

/**
 * Symlink TASK.md to worktree.
 */
export async function linkTaskFile(
  deps: Deps,
  workspacePath: string,
  project: string,
  taskId: string
): Promise<void> {
  const taskMdPath = getTaskPath(deps, project, taskId);
  const symlinkPath = join(workspacePath, "TASK.md");

  // Remove existing symlink if present
  try {
    await unlink(symlinkPath);
  } catch {
    // Doesn't exist, fine
  }

  // Create symlink
  await symlink(taskMdPath, symlinkPath);
}



/**
 * Spawn an agent for a task by ID.
 *
 * Routes through the transition engine for pending tasks,
 * or calls hooks directly for non-transitioning spawns
 * (clarification, agent-review).
 *
 * @throws Error if tmux not available, task not found, or not spawnable
 */
export async function spawnTaskById(deps: Deps, taskId: string): Promise<void> {
  const log = deps.logger.child("spawn");

  log.info("Spawning task", { taskId });

  // Check tmux
  const tmuxAvailable = await deps.tmux.isAvailable();
  if (!tmuxAvailable) {
    throw new Error("tmux is not installed or not in PATH. Install tmux to spawn agents.");
  }

  // Load task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status === "pending") {
    // pending → planning via transition engine
    await executeTransition(task, "planning", deps, createHookExecutor(deps));
    return;
  }

  if (task.status === "clarification") {
    // No status change — just ensure workspace + spawn interactive agent
    await acquireWorkspaceHook(deps, task);
    await spawnAgentHook(deps, task, "worker");
    return;
  }

  if (task.status === "agent-review") {
    // No status change — spawn review agent for review-type tasks
    await acquireWorkspaceHook(deps, task);
    task.review_round += 1;
    await saveTask(deps, task);
    await spawnAgentHook(deps, task, "reviewer");
    return;
  }

  throw new Error(`Task '${taskId}' is not pending, clarification, or agent-review (status: ${task.status})`);
}

/**
 * Spawn the next pending task for a project (FIFO order).
 *
 * Called after workspace release to auto-spawn queued work.
 * Silently returns if no pending tasks or spawn fails.
 */
export async function spawnNextPending(deps: Deps, projectName: string): Promise<void> {
  const log = deps.logger.child("spawn");

  try {
    // Get pending tasks for this project
    const pendingTasks = await listTasks(deps, {
      project: projectName,
      status: "pending",
    });

    if (pendingTasks.length === 0) {
      log.debug("No pending tasks to auto-spawn", { project: projectName });
      return;
    }

    // Tasks are ordered by created_at DESC, so last one is oldest (FIFO)
    const nextTask = pendingTasks[pendingTasks.length - 1];

    log.info("Auto-spawning next pending task", { taskId: nextTask.id, project: projectName, branch: nextTask.branch });
    await spawnTaskById(deps, nextTask.id);
    console.log(`Auto-spawned pending task ${nextTask.id} (${projectName}/${nextTask.branch})`);
  } catch (err) {
    // Silently ignore errors - auto-spawn is best-effort
    // Common case: no available workspace (already in use by another task)
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn("Auto-spawn failed", { project: projectName, error: errorMsg });
    console.error(`Auto-spawn failed for ${projectName}:`, errorMsg);
  }
}
