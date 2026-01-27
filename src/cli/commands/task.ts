/**
 * Task management commands.
 *
 * All commands are CWD-aware - project is inferred from current directory.
 *
 * Commands:
 * - orange task create <branch> <description>
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

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { customAlphabet } from "nanoid";

// Custom alphabet without - to avoid CLI parsing issues
const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 8);
import type { ParsedArgs } from "../args.js";
import type { Deps, Task, TaskStatus, Logger } from "../../core/types.js";
import {
  loadProjects,
  saveTask,
  appendHistory,
  getTaskDir,
} from "../../core/state.js";
import { listTasks } from "../../core/db.js";
import { releaseWorkspace } from "../../core/workspace.js";
import { spawnTaskById } from "../../core/spawn.js";
import { requireProject, detectProject } from "../../core/cwd.js";

import { buildPRBody } from "../../core/github.js";

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

    case "approve":
      await approveTask(parsed, deps);
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

    case "attach":
      await attachTask(parsed, deps);
      break;

    case "respawn":
      await respawnTask(parsed, deps);
      break;

    default:
      console.error(
        `Unknown task subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error(
        "Usage: orange task <create|list|spawn|attach|respawn|complete|approve|stuck|merge|cancel|delete>"
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
      console.error(`Project '${projectName}' not found`);
      process.exit(1);
    }
  } else {
    project = await requireProject(deps);
  }

  // Find unique branch name (append -2, -3, etc. if exists)
  await deps.git.fetch(project.path);
  let finalBranch = branch;
  let suffix = 1;
  while (await deps.git.branchExists(project.path, finalBranch)) {
    suffix++;
    finalBranch = `${branch}-${suffix}`;
  }
  if (finalBranch !== branch) {
    log.info("Branch exists, using new name", { original: branch, branch: finalBranch });
  }

  const now = deps.clock.now();
  const id = nanoid();

  log.info("Creating task", { taskId: id, project: project.name, branch: finalBranch, description });

  const task: Task = {
    id,
    project: project.name,
    branch: finalBranch,
    status: "pending",
    workspace: null,
    tmux_session: null,
    description,
    context,
    created_at: now,
    updated_at: now,
    pr_url: null,
  };

  // Create task directory
  const taskDir = getTaskDir(deps, project.name, finalBranch);
  await mkdir(taskDir, { recursive: true });

  // Save task and initial history event
  await saveTask(deps, task);
  await appendHistory(deps, project.name, finalBranch, {
    type: "task.created",
    timestamp: now,
    task_id: id,
    project: project.name,
    branch: finalBranch,
    description,
  });

  log.info("Task created", { taskId: id, project: project.name, branch: finalBranch });
  console.log(`Created task ${id} (${project.name}/${finalBranch})`);

  // Auto-spawn agent unless --no-spawn flag
  if (!parsed.options["no-spawn"]) {
    await spawnTaskById(deps, id);
    console.log(`Spawned agent in ${project.name}/${finalBranch}`);
  }
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
    reviewing: "◉",
    reviewed: "◈",
    stuck: "⚠",
    done: "✓",
    failed: "✗",
    cancelled: "⊘",
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
 * Attach to task's tmux session.
 * Only works for active tasks (working, reviewing, stuck).
 */
async function attachTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange task attach <task_id>");
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

  // Check task has an active session
  const activeStatuses: TaskStatus[] = ["working", "reviewing", "reviewed", "stuck"];
  if (!activeStatuses.includes(task.status)) {
    console.error(`Task '${taskId}' is ${task.status}, not active`);
    console.error("Use 'orange task log <id>' to view completed task output");
    process.exit(1);
  }

  if (!task.tmux_session) {
    console.error(`Task '${taskId}' has no session`);
    process.exit(1);
  }

  // Check session exists
  const exists = await deps.tmux.sessionExists(task.tmux_session);
  if (!exists) {
    console.error(`Session '${task.tmux_session}' no longer exists`);
    process.exit(1);
  }

  // Use switch-client if inside tmux, attach if outside
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
 * Reuses the existing workspace and branch, just starts a new agent session.
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

  // Must be an active task (working/reviewing/stuck)
  const activeStatuses: TaskStatus[] = ["working", "reviewing", "reviewed", "stuck"];
  if (!activeStatuses.includes(task.status)) {
    console.error(`Task '${taskId}' is ${task.status}, cannot respawn`);
    process.exit(1);
  }

  // Must have a workspace assigned
  if (!task.workspace) {
    console.error(`Task '${taskId}' has no workspace. Use 'spawn' instead.`);
    process.exit(1);
  }

  // Check session is actually dead
  if (task.tmux_session) {
    const exists = await deps.tmux.sessionExists(task.tmux_session);
    if (exists) {
      console.error(`Task '${taskId}' session is still active. Use 'attach' instead.`);
      process.exit(1);
    }
  }

  // Get project for prompt building
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    console.error(`Project '${task.project}' not found`);
    process.exit(1);
  }

  // Get workspace path
  const workspacePath = join(deps.dataDir, "workspaces", task.workspace);

  // Create new tmux session
  const tmuxSession = `${task.project}/${task.branch}`;
  const { buildRespawnPrompt } = await import("../../core/agent.js");
  const prompt = buildRespawnPrompt(task);
  const command = `claude --permission-mode acceptEdits "${prompt.replace(/"/g, '\\"')}"`;

  log.info("Respawning task", { taskId, session: tmuxSession });
  await deps.tmux.newSession(tmuxSession, workspacePath, command);

  // Update task
  const now = deps.clock.now();
  task.tmux_session = tmuxSession;
  task.status = "working";
  task.updated_at = now;

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.branch, {
    type: "agent.spawned",
    timestamp: now,
    workspace: task.workspace,
    tmux_session: tmuxSession,
  });

  console.log(`Respawned agent for task ${taskId} in ${tmuxSession}`);
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
  task.status = "reviewing";
  task.updated_at = now;

  log.info("Task completed", { taskId, from: previousStatus, to: "reviewing" });

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
    to: "reviewing",
  });

  console.log(`Task ${taskId} marked as reviewing`);
}

/**
 * Mark task as reviewed (human approved).
 * Also pushes branch and creates a GitHub PR if gh is available.
 */
async function approveTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("task");

  if (parsed.args.length < 1) {
    console.error("Usage: orange task approve <task_id>");
    process.exit(1);
  }

  const taskId = parsed.args[0];

  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    log.error("Task not found for approve", { taskId });
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  if (task.status !== "reviewing") {
    log.error("Task not in reviewing status", { taskId, status: task.status });
    console.error(`Task '${taskId}' is not in reviewing status (status: ${task.status})`);
    process.exit(1);
  }

  // Get project for PR creation
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) {
    log.error("Project not found for approve", { project: task.project });
    console.error(`Project '${task.project}' not found`);
    process.exit(1);
  }

  const now = deps.clock.now();
  task.status = "reviewed";
  task.updated_at = now;

  await saveTask(deps, task);
  await appendHistory(deps, task.project, task.branch, {
    type: "status.changed",
    timestamp: now,
    from: "reviewing",
    to: "reviewed",
  });

  log.info("Task approved", { taskId });
  console.log(`Task ${taskId} approved (reviewed)`);

  // Push branch and create PR if gh is available
  const ghAvailable = await deps.github.isAvailable();
  if (!ghAvailable) {
    log.debug("gh CLI not available, skipping PR creation");
    return;
  }

  // Push from workspace
  if (task.workspace) {
    const workspacePath = join(deps.dataDir, "workspaces", task.workspace);
    try {
      log.debug("Pushing branch to remote", { branch: task.branch });
      await deps.git.push(workspacePath, "origin", task.branch);
    } catch (err) {
      log.warn("Push failed, skipping PR creation", { error: String(err) });
      console.error(`Push failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  // Create PR
  try {
    const title = task.description.split("\n")[0];
    const body = await buildPRBody(project.path, task.description, task.context);

    log.debug("Creating PR", { branch: task.branch, base: project.default_branch });
    const prUrl = await deps.github.createPR(project.path, {
      branch: task.branch,
      base: project.default_branch,
      title,
      body,
    });

    task.pr_url = prUrl;
    task.updated_at = deps.clock.now();
    await saveTask(deps, task);
    await appendHistory(deps, task.project, task.branch, {
      type: "pr.created",
      timestamp: deps.clock.now(),
      url: prUrl,
    });

    log.info("PR created", { taskId, prUrl });
    console.log(`PR created: ${prUrl}`);
  } catch (err) {
    log.warn("PR creation failed", { error: String(err) });
    console.error(`PR creation failed: ${err instanceof Error ? err.message : String(err)}`);
    // Task is still approved, just no PR
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
      await appendHistory(deps, task.project, task.branch, {
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
  await appendHistory(deps, task.project, task.branch, {
    type: "task.merged",
    timestamp: now,
    commit_hash: commitHash!,
    strategy: mergeVia === "pr" ? "merge" : (strategy as "ff" | "merge"),
  });
  await appendHistory(deps, task.project, task.branch, {
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
  task.status = "cancelled";
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
    to: "cancelled",
  });

  log.info("Task cancelled", { taskId, from: previousStatus });
  console.log(`Task ${taskId} cancelled`);
}

/**
 * Delete task permanently.
 * Only allowed for done/failed tasks - active tasks must be cancelled first.
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

  // Only allow deleting done/failed tasks
  if (task.status !== "done" && task.status !== "failed" && task.status !== "cancelled") {
    log.error("Cannot delete active task", { taskId, status: task.status });
    console.error(`Cannot delete task '${taskId}' with status '${task.status}'`);
    console.error("Only done or failed tasks can be deleted. Use 'orange task cancel' first.");
    process.exit(1);
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
  const taskDir = getTaskDir(deps, task.project, task.branch);
  await rm(taskDir, { recursive: true, force: true });

  log.info("Task deleted", { taskId, project: task.project, branch: task.branch });
  console.log(`Task ${taskId} deleted`);
}
