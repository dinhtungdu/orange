/**
 * Task spawning logic.
 *
 * Extracted from CLI to allow auto-spawning from workspace release.
 * The spawnTaskById function handles acquiring workspace, setting up git,
 * creating tmux session, and updating task state.
 */

import { join } from "node:path";
import { writeFile, symlink, readFile, unlink, stat } from "node:fs/promises";
import type { Deps } from "./types.js";
import { loadProjects, saveTask, appendHistory, getTaskPath } from "./state.js";
import { listTasks } from "./db.js";
import { acquireWorkspace, releaseWorkspace, addGitExcludes, getWorkspacePath } from "./workspace.js";
import { buildAgentPrompt, buildReviewPrompt } from "./agent.js";
import { HARNESSES } from "./harness.js";

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

  // Allow spawning pending, clarification, or agent-review tasks
  // clarification = empty summary, agent will ask user what to work on
  // agent-review = spawn review agent directly (e.g., review coworker's PR)
  if (task.status !== "pending" && task.status !== "clarification" && task.status !== "agent-review") {
    log.error("Task not spawnable", { taskId, status: task.status });
    throw new Error(`Task '${taskId}' is not pending, clarification, or agent-review (status: ${task.status})`);
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

  try {
    // Setup git branch in workspace
    const workspacePath = getWorkspacePath(deps, workspace);
    log.debug("Setting up git branch", { workspacePath, branch: task.branch });

    // Pull latest default branch from origin if available
    try {
      await deps.git.fetch(workspacePath);
      await deps.git.resetHard(workspacePath, `origin/${project.default_branch}`);
    } catch {
      // No remote — use local default branch as-is
    }

    // Create or checkout branch
    const branchExists = await deps.git.branchExists(workspacePath, task.branch);
    if (branchExists) {
      // Branch exists locally or remotely — check it out
      try {
        await deps.git.checkout(workspacePath, task.branch);
      } catch (e) {
        // Check if this is a worktree conflict
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes("already used by worktree")) {
          throw new Error(
            `Branch '${task.branch}' is already checked out in another worktree. ` +
            `Switch the main repo to a different branch first.`
          );
        }
        // Local branch doesn't exist but remote does — create tracking branch
        await deps.git.createBranch(workspacePath, task.branch, `origin/${task.branch}`);
      }
      log.debug("Checked out existing branch", { branch: task.branch });
    } else {
      await deps.git.createBranch(workspacePath, task.branch);
      log.debug("Created new branch", { branch: task.branch });
    }

    // Ensure git excludes are set (idempotent, covers pre-existing workspaces)
    await addGitExcludes(project.path);

    // Symlink TASK.md to worktree
    await linkTaskFile(deps, workspacePath, task.project, task.id);
    log.debug("Linked task file to worktree", { workspacePath });

    // Determine if this is a review spawn or worker spawn
    const isReview = task.status === "agent-review";
    const harness = isReview ? task.review_harness : task.harness;
    const harnessConfig = HARNESSES[harness];

    // Run harness-specific workspace setup
    if (harnessConfig.workspaceSetup) {
      await harnessConfig.workspaceSetup(workspacePath);
      log.debug("Harness workspace setup complete", { harness });
    }

    // Create tmux session
    const tmuxSession = `${task.project}/${task.branch}`;

    let prompt: string;
    let windowName: string;
    if (isReview) {
      task.review_round += 1;
      prompt = buildReviewPrompt(task);
      windowName = `review-${task.review_round}`;
    } else {
      prompt = buildAgentPrompt(task);
      windowName = "worker";
    }

    // Empty prompt = interactive session, just spawn harness without args
    const command = prompt ? harnessConfig.spawnCommand(prompt) : harnessConfig.binary;

    log.debug("Creating tmux session", { session: tmuxSession, interactive: !prompt, isReview });
    await deps.tmux.newSession(tmuxSession, workspacePath, command);

    // Name the initial window
    try {
      await deps.tmux.renameWindow(tmuxSession, windowName);
    } catch {
      // Non-critical — window naming is best-effort
    }

    // Update task
    const now = deps.clock.now();
    const previousStatus = task.status;
    // Keep clarification/agent-review status; otherwise set to working
    const newStatus = previousStatus === "clarification" ? "clarification"
      : previousStatus === "agent-review" ? "agent-review"
      : "working";
    task.status = newStatus;
    task.workspace = workspace;
    task.tmux_session = tmuxSession;
    task.updated_at = now;

    await saveTask(deps, task);
    await appendHistory(deps, task.project, task.id, {
      type: "agent.spawned",
      timestamp: now,
      workspace,
      tmux_session: tmuxSession,
    });
    if (previousStatus !== newStatus) {
      await appendHistory(deps, task.project, task.id, {
        type: "status.changed",
        timestamp: now,
        from: previousStatus,
        to: newStatus,
      });
    }

    log.info("Task spawned", { taskId, workspace, session: tmuxSession });
  } catch (err) {
    // Release workspace on failure to prevent leaks
    log.error("Spawn failed, releasing workspace", { workspace, error: String(err) });
    await releaseWorkspace(deps, workspace);
    throw err;
  }
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
