/**
 * Task spawning logic.
 *
 * Extracted from CLI to allow auto-spawning from workspace release.
 * The spawnTaskById function handles acquiring workspace, setting up git,
 * creating tmux session, and updating task state.
 */

import { join } from "node:path";
import { writeFile, symlink, appendFile, readFile, unlink, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Deps, Task, Project, Logger } from "./types.js";
import { loadProjects, saveTask, appendHistory, getTaskPath } from "./state.js";
import { listTasks } from "./db.js";
import { acquireWorkspace } from "./workspace.js";
import { buildAgentPrompt } from "./agent.js";

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
 * Symlink TASK.md to worktree and add orange files to git exclude.
 */
async function linkTaskFile(
  deps: Deps,
  workspacePath: string,
  project: string,
  branch: string
): Promise<void> {
  const taskMdPath = getTaskPath(deps, project, branch);
  const symlinkPath = join(workspacePath, "TASK.md");
  const gitDir = await getGitDir(workspacePath);
  const excludePath = join(gitDir, "info", "exclude");

  // Remove existing symlink if present
  try {
    await unlink(symlinkPath);
  } catch {
    // Doesn't exist, fine
  }

  // Create symlink
  await symlink(taskMdPath, symlinkPath);

  // Add orange files to .git/info/exclude
  const excludeDir = join(gitDir, "info");
  await mkdir(excludeDir, { recursive: true });

  let excludeContent = "";
  try {
    excludeContent = await readFile(excludePath, "utf-8");
  } catch {
    // File doesn't exist, will create
  }

  const excludeEntries = ["TASK.md", ".orange-outcome"];
  for (const entry of excludeEntries) {
    if (!excludeContent.includes(entry)) {
      const newLine = excludeContent.endsWith("\n") || excludeContent === "" ? "" : "\n";
      excludeContent += `${newLine}${entry}\n`;
    }
  }
  await writeFile(excludePath, excludeContent);
}

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
  await deps.git.createBranch(workspacePath, task.branch, `origin/${project.default_branch}`);
  log.debug("Created branch", { branch: task.branch });

  // Symlink TASK.md to worktree
  await linkTaskFile(deps, workspacePath, task.project, task.branch);
  log.debug("Linked task file to worktree", { workspacePath });

  // Write .orange-outcome file for hook integration (agent writes outcome here)
  const outcomeFile = join(workspacePath, ".orange-outcome");
  await writeFile(outcomeFile, JSON.stringify({ id: task.id }), "utf-8");

  // Create tmux session
  const tmuxSession = `${task.project}/${task.branch}`;
  const prompt = buildAgentPrompt(task);
  const command = `claude --permission-mode acceptEdits "${shellEscape(prompt)}"`;

  log.debug("Creating tmux session", { session: tmuxSession });
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
