/**
 * Task management commands.
 *
 * All commands are CWD-aware - project is inferred from current directory.
 *
 * Commands:
 * - orange task create <branch> <description>
 * - orange task list [--status <status>] [--all]
 * - orange task spawn <task_id>
 * - orange task peek <task_id> [--lines N]
 * - orange task complete <task_id>
 * - orange task stuck <task_id>
 * - orange task merge <task_id> [--strategy ff|merge]
 * - orange task cancel <task_id>
 */

import { mkdir } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { ParsedArgs } from "../args.js";
import type { Deps, Task, TaskStatus, Logger } from "../../core/types.js";
import {
  loadProjects,
  saveTask,
  appendHistory,
  getTaskDir,
} from "../../core/state.js";
import { listTasks, updateTaskInDb } from "../../core/db.js";
import { releaseWorkspace } from "../../core/workspace.js";
import { spawnTaskById } from "../../core/spawn.js";
import { requireProject, detectProject } from "../../core/cwd.js";

/**
 * Check if a PR exists for a branch and whether it's merged.
 * Returns: { exists: false } | { exists: true, merged: boolean }
 */
async function checkPRStatus(
  cwd: string,
  branch: string
): Promise<{ exists: boolean; merged: boolean; mergeCommit?: string }> {
  try {
    const proc = Bun.spawn(
      ["gh", "pr", "view", branch, "--json", "state,mergeCommit"],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // No PR exists for this branch
      return { exists: false, merged: false };
    }

    const stdout = await new Response(proc.stdout).text();
    const data = JSON.parse(stdout);

    const merged = data.state === "MERGED";
    return {
      exists: true,
      merged,
      mergeCommit: merged ? data.mergeCommit?.oid : undefined,
    };
  } catch {
    // gh CLI not available or other error - assume no PR
    return { exists: false, merged: false };
  }
}

/**
 * Run a task subcommand.
 */
export async function runTaskCommand(
  parsed: ParsedArgs,
  deps: Deps
): Promise<void> {
  switch (parsed.subcommand) {
    case "create":
      await createTask(parsed, deps);
      break;

    case "list":
      await listTasksCommand(parsed, deps);
      break;

    case "spawn":
      await spawnTask(parsed, deps);
      break;

    case "peek":
      await peekTask(parsed, deps);
      break;

    case "complete":
      await completeTask(parsed, deps);
      break;

    case "stuck":
      await stuckTask(parsed, deps);
      break;

    case "merge":
      await mergeTask(parsed, deps);
      break;

    case "cancel":
      await cancelTask(parsed, deps);
      break;

    default:
      console.error(
        `Unknown task subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error(
        "Usage: orange task <create|list|spawn|peek|complete|stuck|merge|cancel>"
      );
      process.exit(1);
  }
}

/**
 * Create a new task.
 * Project is inferred from current working directory, or can be specified with --project.
 */
async function createTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 2) {
    console.error("Usage: orange task create <branch> <description>");
    process.exit(1);
  }

  const [branch, ...descParts] = parsed.args;
  const description = descParts.join(" ");

  // Get project from --project flag or infer from cwd
  let projectName: string;
  if (parsed.options.project) {
    projectName = parsed.options.project as string;
    // Validate project exists
    const projects = await loadProjects(deps);
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      log.error("Project not found", { project: projectName });
      console.error(`Project '${projectName}' not found`);
      process.exit(1);
    }
  } else {
    const project = await requireProject(deps);
    projectName = project.name;
  }

  const now = deps.clock.now();
  const id = nanoid(8);

  log.info("Creating task", { taskId: id, project: projectName, branch, description });

  const task: Task = {
    id,
    project: projectName,
    branch,
    status: "pending",
    workspace: null,
    tmux_session: null,
    description,
    created_at: now,
    updated_at: now,
  };

  // Create task directory
  const taskDir = getTaskDir(deps, projectName, branch);
  await mkdir(taskDir, { recursive: true });

  // Save task and initial history event
  await saveTask(deps, task);
  await appendHistory(deps, projectName, branch, {
    type: "task.created",
    timestamp: now,
    task_id: id,
    project: projectName,
    branch,
    description,
  });

  // Update SQLite index
  await updateTaskInDb(deps, task);

  log.info("Task created", { taskId: id, project: projectName, branch });
  console.log(`Created task ${id} (${projectName}/${branch})`);
}

/**
 * List tasks.
 * Scoped to current project by default, use --all for global view.
 * Can also filter by explicit --project flag.
 */
async function listTasksCommand(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const showAll = parsed.options.all === true;
  const statusFilter = parsed.options.status as TaskStatus | undefined;
  const explicitProject = parsed.options.project as string | undefined;

  let projectFilter: string | undefined;

  if (explicitProject) {
    // Explicit --project flag takes precedence
    projectFilter = explicitProject;
  } else if (!showAll) {
    // Try to get project from cwd, but don't error if not in a project
    const detection = await detectProject(deps);
    if (detection.project) {
      projectFilter = detection.project.name;
    }
    // If not in a project and no --all, show all tasks (global view)
  }

  const tasks = await listTasks(deps, { project: projectFilter, status: statusFilter });

  if (tasks.length === 0) {
    if (projectFilter) {
      console.log(`No tasks found for project '${projectFilter}'.`);
    } else {
      console.log("No tasks found.");
    }
    return;
  }

  // Status indicators
  const statusIcon: Record<TaskStatus, string> = {
    pending: "○",
    working: "●",
    needs_human: "◉",
    stuck: "⚠",
    done: "✓",
    failed: "✗",
  };

  const header = projectFilter ? `Tasks (${projectFilter}):` : "Tasks (all projects):";
  console.log(`${header}\n`);
  for (const task of tasks) {
    const icon = statusIcon[task.status];
    console.log(`  ${icon} ${task.id} [${task.status}] ${task.project}/${task.branch}`);
    console.log(`    ${task.description}`);
    console.log();
  }
}

/**
 * Spawn an agent for a task.
 */
async function spawnTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange task spawn <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  try {
    await spawnTaskById(deps, taskId);

    // Fetch the task again to get the tmux session name
    const tasks = await listTasks(deps, {});
    const task = tasks.find((t) => t.id === taskId);
    console.log(`Spawned agent for task ${taskId} in ${task?.tmux_session ?? "unknown"}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Peek at agent output.
 */
async function peekTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange task peek <task_id> [--lines N]");
    process.exit(1);
  }

  const taskId = parsed.args[0];
  const lines = parseInt(parsed.options.lines as string) || 50;

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  if (!task.tmux_session) {
    console.error(`Task '${taskId}' has no active session`);
    process.exit(1);
  }

  // Use safe capture to handle case where session may have disappeared
  const output = await deps.tmux.capturePaneSafe(task.tmux_session, lines);
  if (output === null) {
    console.error(`Session '${task.tmux_session}' no longer exists`);
    console.error("The task's tmux session may have been terminated");
    process.exit(1);
  }

  console.log(output);
}

/**
 * Mark task as complete (called by hook).
 */
async function completeTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task complete <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  // Find and update task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for complete", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  const now = deps.clock.now();
  const previousStatus = task.status;
  task.status = "needs_human";
  task.updated_at = now;

  log.info("Task completed", { taskId, from: previousStatus, to: "needs_human" });

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.branch, {
    type: "agent.stopped",
    timestamp: now,
    outcome: "passed",
  });
  await appendHistory(deps, task.project, task.branch, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "needs_human",
  });
  await updateTaskInDb(deps, task);

  console.log(`Task ${taskId} marked as needs_human`);
}

/**
 * Mark task as stuck (called by hook).
 */
async function stuckTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task stuck <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  // Find and update task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for stuck", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  const now = deps.clock.now();
  const previousStatus = task.status;
  task.status = "stuck";
  task.updated_at = now;

  log.warn("Task stuck", { taskId, from: previousStatus, to: "stuck" });

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.branch, {
    type: "agent.stopped",
    timestamp: now,
    outcome: "stuck",
  });
  await appendHistory(deps, task.project, task.branch, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "stuck",
  });
  await updateTaskInDb(deps, task);

  console.log(`Task ${taskId} marked as stuck`);
}

/**
 * Merge task and cleanup.
 *
 * Auto-detects workflow:
 * 1. Check if PR exists and is merged via `gh pr view`
 * 2. If PR merged → skip local merge, use PR's merge commit
 * 3. If no PR or PR open → do local merge
 * 4. Cleanup: release workspace, delete remote branch, kill tmux session
 */
async function mergeTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task merge <task_id> [--strategy ff|merge]");
    process.exit(1);
  }

  const taskId = parsed.args[0];
  const strategy = (parsed.options.strategy as string) || "ff";

  if (strategy !== "ff" && strategy !== "merge") {
    console.error("Invalid merge strategy. Use 'ff' or 'merge'");
    process.exit(1);
  }

  log.info("Merging task", { taskId, strategy });

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for merge", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  // Get project
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    log.error("Project not found for merge", { project: task.project });
    console.error(`Project '${task.project}' not found`);
    process.exit(1);
  }

  let commitHash: string;
  let mergeVia: "local" | "pr" = "local";

  // Check if PR exists and is already merged
  log.debug("Checking PR status", { branch: task.branch });
  const prStatus = await checkPRStatus(project.path, task.branch);

  if (prStatus.merged && prStatus.mergeCommit) {
    // PR was merged on GitHub - skip local merge, use PR's merge commit
    log.info("PR already merged on GitHub", { branch: task.branch, commit: prStatus.mergeCommit });
    console.log(`PR for ${task.branch} already merged on GitHub`);
    commitHash = prStatus.mergeCommit;
    mergeVia = "pr";

    // Fetch to get the latest changes from merged PR
    await deps.git.fetch(project.path);
    await deps.git.checkout(project.path, project.default_branch);
    await deps.git.resetHard(project.path, `origin/${project.default_branch}`);
  } else {
    // No PR or PR not merged - do local merge
    log.debug("Performing local merge", { branch: task.branch, strategy });
    await deps.git.checkout(project.path, project.default_branch);
    await deps.git.merge(project.path, task.branch, strategy as "ff" | "merge");
    commitHash = await deps.git.getCommitHash(project.path);
  }

  // Delete remote branch
  try {
    log.debug("Deleting remote branch", { branch: task.branch });
    await deps.git.deleteRemoteBranch(project.path, task.branch);
  } catch {
    log.debug("Remote branch deletion failed (may not exist)", { branch: task.branch });
    // Ignore errors - remote branch may not exist
  }

  // Release workspace
  if (task.workspace) {
    log.debug("Releasing workspace", { workspace: task.workspace });
    await releaseWorkspace(deps, task.workspace);
  }

  // Kill tmux session (safe - ignores errors if session already gone)
  if (task.tmux_session) {
    log.debug("Killing tmux session", { session: task.tmux_session });
    await deps.tmux.killSessionSafe(task.tmux_session);
  }

  // Update task
  const now = deps.clock.now();
  const previousStatus = task.status;
  task.status = "done";
  task.workspace = null;
  task.tmux_session = null;
  task.updated_at = now;

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.branch, {
    type: "task.merged",
    timestamp: now,
    commit_hash: commitHash,
    strategy: mergeVia === "pr" ? "merge" : (strategy as "ff" | "merge"),
  });
  await appendHistory(deps, task.project, task.branch, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "done",
  });
  await updateTaskInDb(deps, task);

  log.info("Task merged", { taskId, mergeVia, commitHash });
  const mergeMsg = mergeVia === "pr" ? "via PR" : "locally";
  console.log(`Task ${taskId} merged ${mergeMsg} and cleaned up`);
}

/**
 * Cancel task.
 */
async function cancelTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task cancel <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  log.info("Cancelling task", { taskId });

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for cancel", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  // Release workspace
  if (task.workspace) {
    log.debug("Releasing workspace", { workspace: task.workspace });
    await releaseWorkspace(deps, task.workspace);
  }

  // Kill tmux session (safe - ignores errors if session already gone)
  if (task.tmux_session) {
    log.debug("Killing tmux session", { session: task.tmux_session });
    await deps.tmux.killSessionSafe(task.tmux_session);
  }

  // Update task
  const now = deps.clock.now();
  const previousStatus = task.status;
  task.status = "failed";
  task.workspace = null;
  task.tmux_session = null;
  task.updated_at = now;

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.branch, {
    type: "task.cancelled",
    timestamp: now,
    reason: "User cancelled",
  });
  await appendHistory(deps, task.project, task.branch, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "failed",
  });
  await updateTaskInDb(deps, task);

  log.info("Task cancelled", { taskId, from: previousStatus });
  console.log(`Task ${taskId} cancelled`);
}
