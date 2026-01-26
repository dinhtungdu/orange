/**
 * Task spawning logic.
 *
 * Extracted from CLI to allow auto-spawning from workspace release.
 * The spawnTaskById function handles acquiring workspace, setting up git,
 * creating tmux session, and updating task state.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Deps, Task, Project, Logger } from "./types.js";
import { loadProjects, saveTask, appendHistory, getTaskDir } from "./state.js";
import { listTasks, updateTaskInDb } from "./db.js";
import { acquireWorkspace } from "./workspace.js";
import { buildAgentPrompt } from "./agent.js";

/**
 * Escape a string for use in a shell double-quoted context.
 */
function shellEscape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n");
}

/**
 * Spawn an agent for a task by ID.
 *
 * This function:
 * 1. Validates tmux is available
 * 2. Validates the task exists and is pending
 * 3. Acquires a workspace from the pool
 * 4. Sets up the git branch
 * 5. Writes the .orange-task file
 * 6. Creates a tmux session with Claude
 * 7. Updates task state to "working"
 *
 * @throws Error if tmux not available, task not found, not pending, or no workspace available
 */
export async function spawnTaskById(deps: Deps, taskId: string): Promise<void> {
  const log = deps.logger.child("spawn");

  log.info("Spawning task", { taskId });

  // Check if tmux is available before spawning
  const tmuxAvailable = await deps.tmux.isAvailable();
  if (!tmuxAvailable) {
    log.error("tmux not available");
    throw new Error("tmux is not installed or not in PATH. Install tmux to spawn agents.");
  }

  // Find task by ID
  log.debug("Loading task", { taskId });
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found", { taskId });
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== "pending") {
    log.error("Task not pending", { taskId, status: task.status });
    throw new Error(`Task '${taskId}' is not pending (status: ${task.status})`);
  }

  log.debug("Task loaded", { taskId, project: task.project, branch: task.branch });

  // Get project for workspace
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    log.error("Project not found", { project: task.project });
    throw new Error(`Project '${task.project}' not found`);
  }

  // Acquire workspace
  const workspace = await acquireWorkspace(deps, task.project, `${task.project}/${task.branch}`);
  log.debug("Workspace acquired", { workspace, project: task.project });

  // Setup git branch in workspace
  const workspacePath = join(deps.dataDir, "workspaces", workspace);
  log.debug("Setting up git branch", { workspacePath, branch: task.branch });

  await deps.git.fetch(workspacePath);
  // Create feature branch directly from origin/<default_branch>
  // Workspace is in detached HEAD state, so no need to checkout first
  await deps.git.createBranch(workspacePath, task.branch, `origin/${project.default_branch}`);

  // Write .orange-task file for hook integration
  const orangeTaskFile = join(workspacePath, ".orange-task");
  await writeFile(orangeTaskFile, JSON.stringify({ id: task.id }), "utf-8");

  // Create tmux session with output logging
  const tmuxSession = `${task.project}/${task.branch}`;
  const prompt = buildAgentPrompt(task, workspacePath);
  const command = `claude --prompt "${shellEscape(prompt)}"`;
  const taskDir = getTaskDir(deps, task.project, task.branch);
  const logFile = join(taskDir, "output.log");

  log.debug("Creating tmux session", { session: tmuxSession, logFile });
  await deps.tmux.newSession(tmuxSession, workspacePath, command, logFile);

  // Update task
  const now = deps.clock.now();
  task.status = "working";
  task.workspace = workspace;
  task.tmux_session = tmuxSession;
  task.updated_at = now;

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.branch, {
    type: "agent.spawned",
    timestamp: now,
    workspace,
    tmux_session: tmuxSession,
  });
  await appendHistory(deps, task.project, task.branch, {
    type: "status.changed",
    timestamp: now,
    from: "pending",
    to: "working",
  });
  await updateTaskInDb(deps, task);

  log.info("Task spawned", { taskId, workspace, session: tmuxSession });
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
