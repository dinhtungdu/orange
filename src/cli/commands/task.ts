/**
 * Task management commands.
 *
 * Commands:
 * - orange task create <project> <branch> <description>
 * - orange task list [--project <project>] [--status <status>]
 * - orange task spawn <task_id>
 * - orange task peek <task_id> [--lines N]
 * - orange task complete <task_id>
 * - orange task stuck <task_id>
 * - orange task merge <task_id> [--strategy ff|merge]
 * - orange task cancel <task_id>
 */

import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { ParsedArgs } from "../args.js";
import type { Deps, Task, TaskStatus } from "../../core/types.js";
import {
  loadProjects,
  saveTask,
  loadTask,
  appendHistory,
  getTaskDir,
} from "../../core/state.js";
import { listTasks, updateTaskInDb } from "../../core/db.js";
import { acquireWorkspace, releaseWorkspace } from "../../core/workspace.js";
import { buildAgentPrompt } from "../../core/agent.js";

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
 */
async function createTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 3) {
    console.error(
      "Usage: orange task create <project> <branch> <description>"
    );
    process.exit(1);
  }

  const [projectName, branch, ...descParts] = parsed.args;
  const description = descParts.join(" ");

  // Validate project exists
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    console.error(`Project '${projectName}' not found`);
    process.exit(1);
  }

  const now = deps.clock.now();
  const id = nanoid(8);

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

  console.log(`Created task ${id} (${projectName}/${branch})`);
}

/**
 * List tasks.
 */
async function listTasksCommand(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const projectFilter = parsed.options.project as string | undefined;
  const statusFilter = parsed.options.status as TaskStatus | undefined;

  const tasks = await listTasks(deps, { project: projectFilter, status: statusFilter });

  if (tasks.length === 0) {
    console.log("No tasks found.");
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

  console.log("Tasks:\n");
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

  // Find task by ID
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  if (task.status !== "pending") {
    console.error(`Task '${taskId}' is not pending (status: ${task.status})`);
    process.exit(1);
  }

  // Get project for workspace
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    console.error(`Project '${task.project}' not found`);
    process.exit(1);
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
  // Agent will update this file when done; hook reads it to call orange task complete/stuck
  const orangeTaskFile = join(workspacePath, ".orange-task");
  await writeFile(orangeTaskFile, JSON.stringify({ id: task.id }), "utf-8");

  // Create tmux session
  const tmuxSession = `${task.project}/${task.branch}`;
  const prompt = buildAgentPrompt(task, workspacePath);
  const command = `claude --prompt "${prompt.replace(/"/g, '\\"')}"`;

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

  console.log(`Spawned agent for task ${taskId} in ${tmuxSession}`);
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

  const output = await deps.tmux.capturePane(task.tmux_session, lines);
  console.log(output);
}

/**
 * Mark task as complete (called by hook).
 */
async function completeTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange task complete <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  // Find and update task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  const now = deps.clock.now();
  const previousStatus = task.status;
  task.status = "needs_human";
  task.updated_at = now;

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
  if (parsed.args.length < 1) {
    console.error("Usage: orange task stuck <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  // Find and update task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  const now = deps.clock.now();
  const previousStatus = task.status;
  task.status = "stuck";
  task.updated_at = now;

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
 */
async function mergeTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
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

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  // Get project
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    console.error(`Project '${task.project}' not found`);
    process.exit(1);
  }

  // Merge branch in source repo
  await deps.git.checkout(project.path, project.default_branch);
  await deps.git.merge(project.path, task.branch, strategy as "ff" | "merge");

  // Get commit hash after merge
  const commitHash = await deps.git.getCommitHash(project.path);

  // Delete remote branch
  try {
    await deps.git.deleteRemoteBranch(project.path, task.branch);
  } catch (_) {
    // Ignore errors - remote branch may not exist
  }

  // Release workspace
  if (task.workspace) {
    await releaseWorkspace(deps, task.workspace);
  }

  // Kill tmux session
  if (task.tmux_session) {
    await deps.tmux.killSession(task.tmux_session);
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
    strategy: strategy as "ff" | "merge",
  });
  await appendHistory(deps, task.project, task.branch, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "done",
  });
  await updateTaskInDb(deps, task);

  console.log(`Task ${taskId} merged and cleaned up`);
}

/**
 * Cancel task.
 */
async function cancelTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange task cancel <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  // Release workspace
  if (task.workspace) {
    await releaseWorkspace(deps, task.workspace);
  }

  // Kill tmux session
  if (task.tmux_session) {
    await deps.tmux.killSession(task.tmux_session);
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

  console.log(`Task ${taskId} cancelled`);
}
