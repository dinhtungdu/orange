/**
 * Task spawning logic.
 *
 * Extracted from CLI to allow auto-spawning from workspace release.
 * The spawnTaskById function handles acquiring workspace, setting up git,
 * creating tmux session, and updating task state.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Deps, Task, Project } from "./types.js";
import { loadProjects, saveTask, appendHistory } from "./state.js";
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
 * 1. Validates the task exists and is pending
 * 2. Acquires a workspace from the pool
 * 3. Sets up the git branch
 * 4. Writes the .orange-task file
 * 5. Creates a tmux session with Claude
 * 6. Updates task state to "working"
 *
 * @throws Error if task not found, not pending, or no workspace available
 */
export async function spawnTaskById(deps: Deps, taskId: string): Promise<void> {
  // Find task by ID
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  if (task.status !== "pending") {
    throw new Error(`Task '${taskId}' is not pending (status: ${task.status})`);
  }

  // Get project for workspace
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    throw new Error(`Project '${task.project}' not found`);
  }

  // Acquire workspace
  const workspace = await acquireWorkspace(deps, task.project, `${task.project}/${task.branch}`);

  // Setup git branch in workspace
  const workspacePath = join(deps.dataDir, "workspaces", workspace);
  await deps.git.fetch(workspacePath);
  await deps.git.checkout(workspacePath, project.default_branch);
  await deps.git.resetHard(workspacePath, `origin/${project.default_branch}`);
  await deps.git.createBranch(workspacePath, task.branch);

  // Write .orange-task file for hook integration
  const orangeTaskFile = join(workspacePath, ".orange-task");
  await writeFile(orangeTaskFile, JSON.stringify({ id: task.id }), "utf-8");

  // Create tmux session
  const tmuxSession = `${task.project}/${task.branch}`;
  const prompt = buildAgentPrompt(task, workspacePath);
  const command = `claude --prompt "${shellEscape(prompt)}"`;

  await deps.tmux.newSession(tmuxSession, workspacePath, command);

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
}

/**
 * Spawn the next pending task for a project (FIFO order).
 *
 * Called after workspace release to auto-spawn queued work.
 * Silently returns if no pending tasks or spawn fails.
 */
export async function spawnNextPending(deps: Deps, projectName: string): Promise<void> {
  try {
    // Get pending tasks for this project
    const pendingTasks = await listTasks(deps, {
      project: projectName,
      status: "pending",
    });

    if (pendingTasks.length === 0) {
      return;
    }

    // Tasks are ordered by created_at DESC, so last one is oldest (FIFO)
    const nextTask = pendingTasks[pendingTasks.length - 1];

    await spawnTaskById(deps, nextTask.id);
    console.log(`Auto-spawned pending task ${nextTask.id} (${projectName}/${nextTask.branch})`);
  } catch (err) {
    // Silently ignore errors - auto-spawn is best-effort
    // Common case: no available workspace (already in use by another task)
    console.error(`Auto-spawn failed for ${projectName}:`, err instanceof Error ? err.message : err);
  }
}
