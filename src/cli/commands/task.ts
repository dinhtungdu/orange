/**
 * Task management commands.
 *
 * All commands are CWD-aware - project is inferred from current directory.
 *
 * Commands:
 * - orange task create <branch> <summary>
 * - orange task list [--status <status>] [--all]
 * - orange task spawn <task_id>
 * - orange task attach <task_id>            (attach to running session)
 * - orange task respawn <task_id>           (restart dead session)
 * - orange task complete <task_id>
 * - orange task stuck <task_id>
 * - orange task merge <task_id> [--strategy ff|merge]
 * - orange task cancel <task_id>
 * - orange task delete <task_id>
 */

import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

import type { ParsedArgs } from "../args.js";
import type { Deps, Task, TaskStatus } from "../../core/types.js";
import {
  loadProjects,
  saveTask,
  appendHistory,
  loadHistory,
  getTaskDir,
} from "../../core/state.js";
import { createTaskRecord } from "../../core/task.js";
import { listTasks } from "../../core/db.js";
import { releaseWorkspace } from "../../core/workspace.js";
import { spawnTaskById } from "../../core/spawn.js";
import { requireProject, detectProject } from "../../core/cwd.js";

/**
 * Spawn review agent in a new tmux window for a task in agent-review status.
 * Increments review_round and saves task.
 */
async function spawnReviewWindow(deps: Deps, task: Task, log: ReturnType<typeof deps.logger.child>): Promise<void> {
  if (!task.tmux_session || !task.workspace) return;

  const { buildReviewPrompt } = await import("../../core/agent.js");
  const { HARNESSES } = await import("../../core/harness.js");

  task.review_round += 1;
  task.updated_at = deps.clock.now();
  await saveTask(deps, task);

  const prompt = buildReviewPrompt(task);
  const harnessConfig = HARNESSES[task.review_harness];
  const command = harnessConfig.spawnCommand(prompt);
  const workspacePath = join(deps.dataDir, "workspaces", task.workspace);
  const windowName = `review-${task.review_round}`;

  // Kill existing session to clean up stale windows from previous agents
  await deps.tmux.killSessionSafe(task.tmux_session);

  await deps.tmux.newSession(task.tmux_session, workspacePath, command);
  try { await deps.tmux.renameWindow(task.tmux_session, windowName); } catch { /* best-effort */ }

  await appendHistory(deps, task.project, task.id, {
    type: "review.started",
    timestamp: deps.clock.now(),
    attempt: task.review_round,
  });

  log.info("Review agent spawned", { taskId: task.id, round: task.review_round });
  console.log(`Review agent spawned (round ${task.review_round})`);
}

/**
 * Respawn worker agent in a new tmux window after review failure.
 */
async function spawnWorkerWindow(deps: Deps, task: Task, log: ReturnType<typeof deps.logger.child>): Promise<void> {
  if (!task.tmux_session || !task.workspace) return;

  const { buildRespawnPrompt } = await import("../../core/agent.js");
  const { HARNESSES } = await import("../../core/harness.js");

  const prompt = buildRespawnPrompt(task);
  const harnessConfig = HARNESSES[task.harness];
  const command = prompt ? harnessConfig.respawnCommand(prompt) : harnessConfig.binary;
  const workspacePath = join(deps.dataDir, "workspaces", task.workspace);
  const windowName = `worker-${task.review_round + 1}`;

  // Kill existing session to clean up stale windows from previous agents
  await deps.tmux.killSessionSafe(task.tmux_session);

  await deps.tmux.newSession(task.tmux_session, workspacePath, command);
  try { await deps.tmux.renameWindow(task.tmux_session, windowName); } catch { /* best-effort */ }

  log.info("Worker respawned after review", { taskId: task.id, round: task.review_round });
  console.log(`Worker respawned (fix round ${task.review_round})`);
}

import { buildPRBody } from "../../core/github.js";

/**
 * Output JSON to stdout and exit.
 */
function outputJson(data: unknown, exitCode = 0): never {
  console.log(JSON.stringify(data));
  process.exit(exitCode);
}

/**
 * Output JSON error and exit with non-zero code.
 */
function outputJsonError(message: string): never {
  outputJson({ error: message }, 1);
}

/**
 * Prompt user for confirmation. Returns true if user confirms.
 */
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
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

    case "delete":
      await deleteTask(parsed, deps);
      break;

    case "create-pr":
      await createPRCommand(parsed, deps);
      break;

    case "attach":
      await attachTask(parsed, deps);
      break;

    case "respawn":
      await respawnTask(parsed, deps);
      break;

    case "request-changes":
      await requestChanges(parsed, deps);
      break;

    case "update":
      await updateTask(parsed, deps);
      break;

    case "show":
      await showTask(parsed, deps);
      break;

    default:
      console.error(
        `Unknown task subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error(
        "Usage: orange task <create|list|show|spawn|attach|respawn|update|complete|stuck|merge|cancel|delete|create-pr|request-changes>"
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
  const jsonOutput = parsed.options.json === true;

  // Branch and summary are optional
  // If branch not provided, use auto-generated task ID
  // If summary not provided, task starts in clarification status
  const { customAlphabet } = await import("nanoid");
  const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 21);
  const taskId = nanoid();

  const [inputBranch, ...summaryParts] = parsed.args;
  const branch = inputBranch || `orange-tasks/${taskId}`;
  const summary = summaryParts.join(" ");

  // Parse --status flag (default: pending, auto-set to clarification if empty summary)
  const statusArg = parsed.options.status as string | undefined;
  let status: "pending" | "clarification" | "agent-review" | "reviewing" | undefined;
  if (statusArg) {
    if (statusArg !== "pending" && statusArg !== "clarification" && statusArg !== "agent-review" && statusArg !== "reviewing") {
      if (jsonOutput) outputJsonError("Invalid status. Use 'pending', 'clarification', 'agent-review', or 'reviewing'");
      console.error("Invalid status. Use 'pending', 'clarification', 'agent-review', or 'reviewing'");
      process.exit(1);
    }
    status = statusArg;
  }
  // Empty summary auto-sets clarification status (handled in createTaskRecord)

  // Parse --harness flag (optional, auto-detects if not specified)
  const harnessArg = parsed.options.harness as string | undefined;

  // Read context from stdin if --context - is passed
  let context: string | null = null;
  if (parsed.options.context === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const stdinContent = Buffer.concat(chunks).toString("utf-8").trim();
    if (stdinContent) {
      context = stdinContent;
    }
  }

  // Get project from --project flag or infer from cwd
  let project;
  if (parsed.options.project) {
    const projectName = parsed.options.project as string;
    const projects = await loadProjects(deps);
    project = projects.find((p) => p.name === projectName);
    if (!project) {
      log.error("Project not found", { project: projectName });
      if (jsonOutput) outputJsonError(`Project '${projectName}' not found`);
      console.error(`Project '${projectName}' not found`);
      process.exit(1);
    }
  } else {
    try {
      project = await requireProject(deps);
    } catch (err) {
      if (jsonOutput) outputJsonError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  let task: Task;
  try {
    const result = await createTaskRecord(deps, { id: taskId, project, branch, summary, context, status, harness: harnessArg });
    task = result.task;
  } catch (err) {
    log.error("Failed to create task", { error: String(err) });
    if (jsonOutput) outputJsonError(err instanceof Error ? err.message : String(err));
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`Use 'orange task list' to see existing tasks.`);
    process.exit(1);
  }

  const message = `Created task ${task.id} (${project.name}/${branch}) [${task.status}] [${task.harness}]`;
  if (!jsonOutput) console.log(message);

  // Auto-spawn agent unless --no-spawn or reviewing
  // agent-review: spawn with review agent via spawnTaskById
  if (task.status !== "reviewing" && !parsed.options["no-spawn"]) {
    await spawnTaskById(deps, task.id);
    if (!jsonOutput) console.log(`Spawned agent in ${project.name}/${branch}`);
  }

  if (jsonOutput) {
    // Re-read task to get updated state after spawn
    const tasks = await listTasks(deps, {});
    const updatedTask = tasks.find((t) => t.id === task.id) ?? task;
    outputJson({ task: updatedTask, message });
  }
}

/**
 * List tasks.
 * Scoped to current project by default, use --all for global view.
 * Can also filter by explicit --project flag.
 */
async function listTasksCommand(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");
  const showAll = parsed.options.all === true;
  const jsonOutput = parsed.options.json === true;
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

  log.debug("Listing tasks", { project: projectFilter, status: statusFilter, count: tasks.length });

  if (jsonOutput) {
    outputJson({ tasks });
  }

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
    planning: "◐",
    clarification: "?",
    working: "●",
    "agent-review": "◎",
    reviewing: "◉",
    stuck: "⚠",
    done: "✓",
    cancelled: "⊘",
  };

  const header = projectFilter ? `Tasks (${projectFilter}):` : "Tasks (all projects):";
  console.log(`${header}\n`);
  for (const task of tasks) {
    const icon = statusIcon[task.status];
    console.log(`  ${icon} ${task.id} [${task.status}] ${task.project}/${task.branch}`);
    console.log(`    ${task.summary}`);
    console.log();
  }
}

/**
 * Show detailed task information including TASK.md content and history.
 */
async function showTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");
  const jsonOutput = parsed.options.json === true;

  if (parsed.args.length < 1) {
    if (jsonOutput) outputJsonError("Usage: orange task show <task_id>");
    console.error("Usage: orange task show <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found", { taskId });
    if (jsonOutput) outputJsonError(`Task '${taskId}' not found`);
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  if (jsonOutput) {
    outputJson({ task });
  }

  // Load history
  const history = await loadHistory(deps, task.project, task.id);

  // Output task details
  console.log("═".repeat(60));
  console.log(`TASK: ${task.id}`);
  console.log("═".repeat(60));
  console.log();

  // Metadata
  console.log("## Metadata");
  console.log();
  console.log(`Project:     ${task.project}`);
  console.log(`Branch:      ${task.branch}`);
  console.log(`Status:      ${task.status}`);
  console.log(`Harness:     ${task.harness}`);
  console.log(`Workspace:   ${task.workspace ?? "(none)"}`);
  console.log(`Session:     ${task.tmux_session ?? "(none)"}`);
  console.log(`PR:          ${task.pr_url ?? "(none)"}`);
  console.log(`Created:     ${task.created_at}`);
  console.log(`Updated:     ${task.updated_at}`);
  console.log();

  // Summary
  console.log("## Summary");
  console.log();
  console.log(task.summary || "(no summary)");
  console.log();

  // Body (Context, Questions, Notes)
  if (task.body) {
    console.log("## Content");
    console.log();
    console.log(task.body);
    console.log();
  }

  // History
  if (history.length > 0) {
    console.log("## History");
    console.log();
    for (const event of history) {
      const time = event.timestamp.split("T")[1]?.slice(0, 8) ?? event.timestamp;
      const { type, timestamp, ...rest } = event;
      const details = Object.entries(rest)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      console.log(`  ${time} ${type}${details ? " " + details : ""}`);
    }
    console.log();
  }

  console.log("═".repeat(60));
}

/**
 * Spawn an agent for a task.
 */
async function spawnTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");
  const jsonOutput = parsed.options.json === true;

  if (parsed.args.length < 1) {
    if (jsonOutput) outputJsonError("Usage: orange task spawn <task_id>");
    console.error("Usage: orange task spawn <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  log.info("Spawning task", { taskId });

  try {
    await spawnTaskById(deps, taskId);

    // Fetch the task again to get the tmux session name
    const tasks = await listTasks(deps, {});
    const task = tasks.find((t) => t.id === taskId);
    log.info("Task spawned", { taskId, session: task?.tmux_session });
    const message = `Spawned agent for task ${taskId} in ${task?.tmux_session ?? "unknown"}`;

    if (jsonOutput) {
      outputJson({ task, message });
    }
    console.log(message);
  } catch (err) {
    log.error("Spawn failed", { taskId, error: String(err) });
    if (jsonOutput) outputJsonError(err instanceof Error ? err.message : String(err));
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Attach to task's tmux session.
 * Only works for active tasks (working, reviewing, stuck).
 */
async function attachTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task attach <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  log.info("Attaching to task", { taskId });

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for attach", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  // Check task has an active session
  const activeStatuses: TaskStatus[] = ["working", "agent-review", "reviewing", "stuck"];
  if (!activeStatuses.includes(task.status)) {
    log.error("Task not active for attach", { taskId, status: task.status });
    console.error(`Task '${taskId}' is ${task.status}, not active`);
    console.error("Use 'orange task log <id>' to view completed task output");
    process.exit(1);
  }

  if (!task.tmux_session) {
    log.error("Task has no session", { taskId });
    console.error(`Task '${taskId}' has no session`);
    process.exit(1);
  }

  // Check session exists
  const exists = await deps.tmux.sessionExists(task.tmux_session);
  if (!exists) {
    log.error("Session no longer exists", { taskId, session: task.tmux_session });
    console.error(`Session '${task.tmux_session}' no longer exists`);
    process.exit(1);
  }

  // Use switch-client if inside tmux, attach if outside
  log.debug("Attaching to session", { session: task.tmux_session, insideTmux: !!process.env.TMUX });
  const insideTmux = !!process.env.TMUX;
  const cmd = insideTmux
    ? ["tmux", "switch-client", "-t", task.tmux_session]
    : ["tmux", "attach-session", "-t", task.tmux_session];

  const proc = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

/**
 * Respawn a task whose session died.
 *
 * Routes through transition engine for stuck/cancelled,
 * or calls hooks directly for dead session recovery.
 */
async function respawnTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task respawn <task_id>");
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

  if (task.status === "done") {
    console.error(`Task '${taskId}' is done, cannot respawn`);
    process.exit(1);
  }

  if (task.status === "pending") {
    console.error(`Task '${taskId}' is pending. Use 'spawn' instead.`);
    process.exit(1);
  }

  // Check if session is still active
  if (task.tmux_session) {
    const exists = await deps.tmux.sessionExists(task.tmux_session);
    if (exists) {
      console.error(`Task '${taskId}' session is still active. Use 'attach' instead.`);
      process.exit(1);
    }
  }

  const { executeTransition } = await import("../../core/transitions.js");
  const { createHookExecutor, acquireWorkspaceHook, spawnAgentHook } = await import("../../core/hooks.js");
  const hookExecutor = createHookExecutor(deps);

  if (task.status === "stuck") {
    // stuck → working via transition engine (runs spawn_agent(stuck_fix) hook)
    await executeTransition(task, "working", deps, hookExecutor);
    console.log(`Respawned agent for task ${taskId} in ${task.tmux_session}`);
    return;
  }

  if (task.status === "cancelled") {
    // Reactivate: set to pending, then spawn via transition engine
    task.status = "pending";
    task.updated_at = deps.clock.now();
    await saveTask(deps, task);
    await appendHistory(deps, task.project, task.id, {
      type: "status.changed",
      timestamp: deps.clock.now(),
      from: "cancelled",
      to: "pending",
    });
    await executeTransition(task, "planning", deps, hookExecutor);
    console.log(`Respawned agent for task ${taskId} in ${task.tmux_session}`);
    return;
  }

  // Dead session recovery (working/planning/agent-review/reviewing/clarification)
  // No status change — just re-establish workspace + session
  await acquireWorkspaceHook(deps, task);

  type VariantType = "worker" | "worker_respawn" | "reviewer";
  const variantMap: Record<string, VariantType> = {
    working: "worker_respawn",
    planning: "worker_respawn",
    "agent-review": "reviewer",
    reviewing: "worker_respawn",
    clarification: "worker",
  };
  const variant = variantMap[task.status] ?? "worker_respawn";
  await spawnAgentHook(deps, task, variant);

  console.log(`Respawned agent for task ${taskId} in ${task.tmux_session}`);
}

/**
 * Get task ID from current workspace directory.
 * Returns null if not inside a workspace.
 */
async function getTaskIdFromWorkspace(deps: Deps): Promise<string | null> {
  const cwd = process.cwd();
  const { getWorkspacesDir } = await import("../../core/workspace.js");
  const workspacesDir = getWorkspacesDir(deps);

  // Check if cwd is inside workspaces directory
  if (!cwd.startsWith(workspacesDir)) {
    return null;
  }

  // Extract workspace name from path
  const relativePath = cwd.slice(workspacesDir.length + 1); // +1 for trailing slash
  const workspaceName = relativePath.split("/")[0];
  if (!workspaceName) {
    return null;
  }

  // Find task with this workspace
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.workspace === workspaceName);
  return task?.id ?? null;
}

/**
 * Request changes on a reviewing task (reviewing → working).
 * Runs the transition engine which spawns worker_fix agent.
 */
async function requestChanges(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task request-changes <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  if (task.status !== "reviewing") {
    console.error(`Task '${taskId}' is not reviewing (status: ${task.status})`);
    process.exit(1);
  }

  const { executeTransition } = await import("../../core/transitions.js");
  const { createHookExecutor } = await import("../../core/hooks.js");
  const hookExecutor = createHookExecutor(deps);

  await executeTransition(task, "working", deps, hookExecutor);

  log.info("Requested changes", { taskId });
  console.log(`Task ${taskId} moved to working (fix agent spawned)`);
}

/**
 * Update task branch and/or summary.
 */
async function updateTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");
  const jsonOutput = parsed.options.json === true;

  let branchOption = parsed.options.branch;
  const newSummary = parsed.options.summary as string | undefined;
  const newStatus = parsed.options.status as string | undefined;

  if (!branchOption && newSummary === undefined && !newStatus) {
    if (jsonOutput) outputJsonError("At least one of --branch, --summary, or --status is required");
    console.error("At least one of --branch, --summary, or --status is required");
    process.exit(1);
  }

  // Validate status if provided
  if (newStatus) {
    const validStatuses = ["clarification", "working", "agent-review", "reviewing", "stuck"];
    if (!validStatuses.includes(newStatus)) {
      if (jsonOutput) outputJsonError(`Invalid status. Use: ${validStatuses.join(", ")}`);
      console.error(`Invalid status. Use: ${validStatuses.join(", ")}`);
      process.exit(1);
    }
  }

  // Get task ID from args or detect from workspace
  let taskId = parsed.args[0];
  if (!taskId) {
    taskId = await getTaskIdFromWorkspace(deps) ?? "";
    if (!taskId) {
      if (jsonOutput) outputJsonError("Task ID required when not running inside a workspace");
      console.error("Usage: orange task update [task_id] --branch [name] --summary <text> --status <status>");
      console.error("Task ID required when not running inside a workspace");
      process.exit(1);
    }
  }

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    if (jsonOutput) outputJsonError(`Task '${taskId}' not found`);
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

  const oldBranch = task.branch;
  let workspacePath: string | null = null;

  // Get workspace path if task has one
  if (task.workspace) {
    const { getWorkspacePath } = await import("../../core/workspace.js");
    workspacePath = getWorkspacePath(deps, task.workspace);
  }

  // If --branch without value, use current git branch
  let newBranch: string | undefined;
  if (branchOption === true) {
    // --branch flag without value: use current git branch
    if (!workspacePath) {
      console.error("Cannot detect branch: task has no workspace");
      process.exit(1);
    }
    newBranch = await deps.git.currentBranch(workspacePath);
    log.info("Using current git branch", { branch: newBranch });
  } else if (typeof branchOption === "string") {
    newBranch = branchOption;
  }

  // Handle branch change
  if (newBranch && newBranch !== oldBranch) {
    if (workspacePath) {
      const branchExists = await deps.git.branchExists(workspacePath, newBranch);
      
      if (branchExists) {
        // Switch mode: checkout existing branch + delete old
        log.info("Switching to existing branch", { from: oldBranch, to: newBranch });
        await deps.git.checkout(workspacePath, newBranch);
        
        // Delete old branch (orphan cleanup)
        try {
          await deps.git.deleteBranch(workspacePath, oldBranch);
          log.info("Deleted orphan branch", { branch: oldBranch });
        } catch (err) {
          // May fail if branch has unmerged commits, log but continue
          log.warn("Could not delete old branch", { branch: oldBranch, error: String(err) });
        }
      } else {
        // Rename mode: rename current branch
        log.info("Renaming branch", { from: oldBranch, to: newBranch });
        await deps.git.renameBranch(workspacePath, oldBranch, newBranch);
      }
    }

    // Rename tmux session if exists
    if (task.tmux_session) {
      const newSession = `${task.project}/${newBranch}`;
      const sessionExists = await deps.tmux.sessionExists(task.tmux_session);
      if (sessionExists) {
        log.info("Renaming tmux session", { from: task.tmux_session, to: newSession });
        await deps.tmux.renameSession(task.tmux_session, newSession);
      }
      task.tmux_session = newSession;
    }

    task.branch = newBranch;
  }

  // Update summary
  if (newSummary !== undefined) {
    task.summary = newSummary;
  }

  // Update status
  const oldStatus = task.status;
  if (newStatus && newStatus !== oldStatus) {
    task.status = newStatus as Task["status"];
    await appendHistory(deps, task.project, task.id, {
      type: "status.changed",
      timestamp: deps.clock.now(),
      from: oldStatus,
      to: task.status,
    });
  }

  // Save task
  task.updated_at = deps.clock.now();
  await saveTask(deps, task);

  // Log history for branch/summary changes
  if ((newBranch && newBranch !== oldBranch) || newSummary !== undefined) {
    await appendHistory(deps, task.project, task.id, {
      type: "task.updated",
      timestamp: task.updated_at,
      changes: {
        ...(newBranch && newBranch !== oldBranch ? { branch: { from: oldBranch, to: newBranch } } : {}),
        ...(newSummary !== undefined ? { summary: true } : {}),
      },
    });
  }

  // Auto-spawn on status transitions
  if (newStatus && newStatus !== oldStatus) {
    // working → agent-review: spawn review agent in new window
    if (newStatus === "agent-review") {
      try {
        await spawnReviewWindow(deps, task, log);
      } catch (err) {
        console.error(`Warning: failed to spawn review agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // agent-review → working (review failed): respawn worker in new window
    if (newStatus === "working" && oldStatus === "agent-review" && task.review_round > 0) {
      try {
        await spawnWorkerWindow(deps, task, log);
      } catch (err) {
        console.error(`Warning: failed to respawn worker: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const changes: string[] = [];
  if (newBranch && newBranch !== oldBranch) changes.push(`branch: ${oldBranch} → ${newBranch}`);
  if (newSummary !== undefined) changes.push("summary updated");
  if (newStatus && newStatus !== oldStatus) changes.push(`status: ${oldStatus} → ${newStatus}`);
  const message = `Updated task ${taskId}: ${changes.join(", ")}`;

  if (jsonOutput) {
    outputJson({ task, message });
  }
  console.log(message);
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
  task.status = "agent-review";
  task.updated_at = now;

  log.info("Task completed", { taskId, from: previousStatus, to: "agent-review" });

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.id, {
    type: "agent.stopped",
    timestamp: now,
    outcome: "passed",
  });
  await appendHistory(deps, task.project, task.id, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "agent-review",
  });

  console.log(`Task ${taskId} marked as agent-review`);

  // Auto-spawn review agent
  try {
    await spawnReviewWindow(deps, task, log);
  } catch (err) {
    console.error(`Warning: failed to spawn review agent: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  await appendHistory(deps, task.project, task.id, {
    type: "agent.stopped",
    timestamp: now,
    outcome: "stuck",
  });
  await appendHistory(deps, task.project, task.id, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "stuck",
  });

  console.log(`Task ${taskId} marked as stuck`);
}

/**
 * Merge task and cleanup.
 *
 * When task has pr_url:
 * - PR merged → fetch latest, cleanup
 * - PR still open → error (merge on GitHub or use --local)
 * - PR closed → error
 * - --local flag → force local merge
 *
 * When task has no pr_url:
 * - Local merge + push + cleanup (original behavior)
 */
/**
 * Create a PR for an approved task.
 * Used when approve didn't create a PR (e.g. gh was unavailable) or for retry.
 */
async function createPRCommand(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task create-pr <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for create-pr", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  if (task.status !== "reviewing") {
    console.error(`Task '${taskId}' is not ready for PR (status: ${task.status})`);
    process.exit(1);
  }

  if (task.pr_url) {
    console.error(`Task '${taskId}' already has a PR: ${task.pr_url}`);
    process.exit(1);
  }

  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    console.error(`Project '${task.project}' not found`);
    process.exit(1);
  }

  const ghAvailable = await deps.github.isAvailable(project.path);
  if (!ghAvailable) {
    console.error("gh CLI is not available or not authenticated for this repository");
    process.exit(1);
  }

  // Push branch from workspace
  if (task.workspace) {
    const workspacePath = join(deps.dataDir, "workspaces", task.workspace);
    try {
      await deps.git.push(workspacePath, "origin", task.branch);
    } catch (err) {
      console.error(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // Create PR
  const title = task.summary.split("\n")[0];
  const body = await buildPRBody(project.path, task.summary, task.body);

  const prUrl = await deps.github.createPR(project.path, {
    branch: task.branch,
    base: project.default_branch,
    title,
    body,
  });

  task.pr_url = prUrl;
  task.updated_at = deps.clock.now();
  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.id, {
    type: "pr.created",
    timestamp: deps.clock.now(),
    url: prUrl,
  });

  log.info("PR created", { taskId, prUrl });
  console.log(`PR created: ${prUrl}`);
}

async function mergeTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task merge <task_id> [--strategy ff|merge] [--local]");
    process.exit(1);
  }

  const taskId = parsed.args[0];
  const strategy = (parsed.options.strategy as string) || "ff";
  const forceLocal = parsed.options.local === true;

  if (strategy !== "ff" && strategy !== "merge") {
    console.error("Invalid merge strategy. Use 'ff' or 'merge'");
    process.exit(1);
  }

  log.info("Merging task", { taskId, strategy, forceLocal });

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

  if (task.pr_url && !forceLocal) {
    // PR-based flow: check PR status via GitHub executor
    log.debug("Checking PR status", { branch: task.branch });
    const prStatus = await deps.github.getPRStatus(project.path, task.branch);

    if (!prStatus.exists) {
      // PR was deleted or gh unavailable — fall through to local merge
      log.warn("PR not found, falling back to local merge", { prUrl: task.pr_url });
    } else if (prStatus.state === "MERGED" && prStatus.mergeCommit) {
      // PR merged on GitHub
      log.info("PR merged on GitHub", { branch: task.branch, commit: prStatus.mergeCommit });
      console.log(`PR for ${task.branch} already merged on GitHub`);
      commitHash = prStatus.mergeCommit;
      mergeVia = "pr";

      await deps.git.fetch(project.path);
      await deps.git.checkout(project.path, project.default_branch);
      await deps.git.resetHard(project.path, `origin/${project.default_branch}`);

      // Log PR merged event
      await appendHistory(deps, task.project, task.id, {
        type: "pr.merged",
        timestamp: deps.clock.now(),
        url: task.pr_url,
        merge_commit: commitHash,
      });
    } else if (prStatus.state === "OPEN") {
      console.error(`PR is still open at ${prStatus.url ?? task.pr_url}. Merge on GitHub or use --local to merge locally.`);
      process.exit(1);
    } else if (prStatus.state === "CLOSED") {
      console.error(`PR was closed without merging.`);
      process.exit(1);
    }
  }

  // Local merge (no PR, or PR not found, or --local)
  if (mergeVia === "local") {
    log.debug("Performing local merge", { branch: task.branch, strategy });
    await deps.git.checkout(project.path, project.default_branch);
    await deps.git.merge(project.path, task.branch, strategy as "ff" | "merge");
    commitHash = await deps.git.getCommitHash(project.path);

    try {
      await deps.git.push(project.path);
      log.info("Pushed to remote", { branch: project.default_branch });
    } catch {
      log.debug("Push failed (may be local-only repo)");
    }
  }

  // Delete remote branch
  try {
    log.debug("Deleting remote branch", { branch: task.branch });
    await deps.git.deleteRemoteBranch(project.path, task.branch);
  } catch {
    log.debug("Remote branch deletion failed (may not exist)", { branch: task.branch });
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
  await appendHistory(deps, task.project, task.id, {
    type: "task.merged",
    timestamp: now,
    commit_hash: commitHash!,
    strategy: mergeVia === "pr" ? "merge" : (strategy as "ff" | "merge"),
  });
  await appendHistory(deps, task.project, task.id, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "done",
  });

  log.info("Task merged", { taskId, mergeVia, commitHash: commitHash! });
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

  // Confirm unless --yes
  if (!parsed.options.yes) {
    const confirmed = await confirm(`Cancel task ${task.project}/${task.branch}?`);
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  // Release workspace (no auto-spawn - cancelled is terminal, not a trigger for next task)
  if (task.workspace) {
    log.debug("Releasing workspace", { workspace: task.workspace });
    await releaseWorkspace(deps, task.workspace, false);
  }

  // Kill tmux session (safe - ignores errors if session already gone)
  if (task.tmux_session) {
    log.debug("Killing tmux session", { session: task.tmux_session });
    await deps.tmux.killSessionSafe(task.tmux_session);
  }

  // Update task
  const now = deps.clock.now();
  const previousStatus = task.status;
  task.status = "cancelled";
  task.workspace = null;
  task.tmux_session = null;
  task.updated_at = now;

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.id, {
    type: "task.cancelled",
    timestamp: now,
    reason: "User cancelled",
  });
  await appendHistory(deps, task.project, task.id, {
    type: "status.changed",
    timestamp: now,
    from: previousStatus,
    to: "cancelled",
  });

  log.info("Task cancelled", { taskId, from: previousStatus });
  console.log(`Task ${taskId} cancelled`);
}

/**
 * Delete task permanently.
 * Only allowed for terminal tasks (done/cancelled) - active tasks must be cancelled first.
 */
async function deleteTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task delete <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  log.info("Deleting task", { taskId });

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for delete", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  // Only allow deleting terminal tasks (done/cancelled)
  if (task.status !== "done" && task.status !== "cancelled") {
    log.error("Cannot delete active task", { taskId, status: task.status });
    console.error(`Cannot delete task '${taskId}' with status '${task.status}'`);
    console.error("Only done or cancelled tasks can be deleted. Use 'orange task cancel' first.");
    process.exit(1);
  }

  // Confirm unless --yes
  if (!parsed.options.yes) {
    const confirmed = await confirm(`Delete task ${task.project}/${task.branch}?`);
    if (!confirmed) {
      console.log("Aborted.");
      return;
    }
  }

  // Release workspace if still bound (defensive - should already be released)
  if (task.workspace) {
    log.debug("Releasing workspace", { workspace: task.workspace });
    await releaseWorkspace(deps, task.workspace);
  }

  // Kill tmux session if still exists (defensive)
  if (task.tmux_session) {
    log.debug("Killing tmux session", { session: task.tmux_session });
    await deps.tmux.killSessionSafe(task.tmux_session);
  }

  // Delete task folder
  const taskDir = getTaskDir(deps, task.project, task.id);
  await rm(taskDir, { recursive: true, force: true });

  log.info("Task deleted", { taskId, project: task.project, branch: task.branch });
  console.log(`Task ${taskId} deleted`);
}
