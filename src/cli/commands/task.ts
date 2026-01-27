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
 * - orange task log <task_id> [--lines N]   (view task output log)
 * - orange task respawn <task_id>           (restart dead session)
 * - orange task complete <task_id>
 * - orange task stuck <task_id>
 * - orange task merge <task_id> [--strategy ff|merge]
 * - orange task cancel <task_id>
 * - orange task delete <task_id>
 */

import { mkdir, rm, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
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

    case "attach":
      await attachTask(parsed, deps);
      break;

    case "log":
      await logTask(parsed, deps);
      break;

    case "respawn":
      await respawnTask(parsed, deps);
      break;

    default:
      console.error(
        `Unknown task subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error(
        "Usage: orange task <create|list|spawn|attach|log|respawn|complete|stuck|merge|cancel|delete>"
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
  const id = nanoid();

  log.info("Creating task", { taskId: id, project: projectName, branch, description });

  const task: Task = {
    id,
    project: projectName,
    branch,
    status: "pending",
    workspace: null,
    tmux_session: null,
    description,
    context,
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

  log.info("Task created", { taskId: id, project: projectName, branch });
  console.log(`Created task ${id} (${projectName}/${branch})`);

  // Auto-spawn agent unless --no-spawn flag
  if (!parsed.options["no-spawn"]) {
    await spawnTaskById(deps, id);
    console.log(`Spawned agent in ${projectName}/${branch}`);
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
 * Attach to task's tmux session.
 * Only works for active tasks (working, needs_human, stuck).
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
  const activeStatuses: TaskStatus[] = ["working", "needs_human", "stuck"];
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
 * Convert workspace path to Claude project folder name.
 * Example: /Users/tung/orange/workspaces/orange--1 → -Users-tung-orange-workspaces-orange--1
 */
function workspaceToClaudeProjectPath(workspacePath: string): string {
  return "-" + workspacePath.slice(1).replace(/\//g, "-");
}

/**
 * Truncate string to max length with ellipsis.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

/**
 * Format a conversation entry for display.
 */
function formatEntry(entry: ConversationEntry): string | null {
  // Skip queue operations
  if (entry.type === "queue-operation") return null;

  // Handle user messages
  if (entry.type === "user" && entry.message) {
    const content = entry.message.content;
    if (typeof content === "string") {
      // Regular user text message
      const text = content.replace(/\n/g, " ").trim();
      return `[user] ${truncate(text, 80)}`;
    } else if (Array.isArray(content)) {
      // Tool result - skip, shown contextually with tool call
      return null;
    }
  }

  // Handle assistant messages
  if (entry.type === "assistant" && entry.message?.content) {
    const content = entry.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        // Skip thinking blocks
        if (block.type === "thinking") continue;

        // Text responses
        if (block.type === "text" && block.text) {
          const text = block.text.replace(/\n/g, " ").trim();
          return `[assistant] ${truncate(text, 80)}`;
        }

        // Tool calls
        if (block.type === "tool_use") {
          const toolName = block.name || "unknown";
          const input = block.input || {};
          // Extract brief description from tool input
          let desc = "";
          if (input.file_path) desc = input.file_path as string;
          else if (input.command) desc = truncate(input.command as string, 40);
          else if (input.pattern) desc = input.pattern as string;
          else if (input.description) desc = input.description as string;

          return `[tool] ${toolName}${desc ? `: ${desc}` : ""}`;
        }
      }
    }
  }

  return null;
}

interface ConversationEntry {
  type: "user" | "assistant" | "queue-operation";
  message?: {
    role?: string;
    content?: string | ContentBlock[];
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface SessionIndexEntry {
  sessionId: string;
  gitBranch: string;
  modified: string;
}

interface SessionsIndex {
  entries: SessionIndexEntry[];
}

/**
 * View task's conversation history from Claude's project folder.
 */
async function logTask(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange task log <task_id> [--lines N]");
    process.exit(1);
  }

  const taskId = parsed.args[0];
  const maxEntries = parseInt(parsed.options.lines as string) || 0; // 0 means all

  // Find task
  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    console.error(`Task '${taskId}' not found`);
    process.exit(1);
  }

  // Must have a workspace to get Claude history
  if (!task.workspace) {
    console.error(`Task '${taskId}' has no workspace assigned`);
    process.exit(1);
  }

  // Build Claude project path
  const workspacePath = join(deps.dataDir, "workspaces", task.workspace);
  const claudeProjectName = workspaceToClaudeProjectPath(workspacePath);
  const claudeDir = join(process.env.HOME || "", ".claude", "projects", claudeProjectName);

  // Read sessions index
  const indexPath = join(claudeDir, "sessions-index.json");
  if (!existsSync(indexPath)) {
    console.error(`No Claude conversation history found for task '${taskId}'`);
    console.error(`Expected: ${indexPath}`);
    process.exit(1);
  }

  const indexContent = await readFile(indexPath, "utf-8");
  const index: SessionsIndex = JSON.parse(indexContent);

  // Find sessions for this task's branch
  const branchSessions = index.entries
    .filter((e) => e.gitBranch === task.branch)
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  if (branchSessions.length === 0) {
    console.error(`No sessions found for branch '${task.branch}'`);
    process.exit(1);
  }

  // Get the most recent session
  const session = branchSessions[0];
  const sessionPath = join(claudeDir, `${session.sessionId}.jsonl`);

  if (!existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    process.exit(1);
  }

  // Parse JSONL and format entries
  const sessionContent = await readFile(sessionPath, "utf-8");
  const lines = sessionContent.trim().split("\n");
  const formatted: string[] = [];

  for (const line of lines) {
    try {
      const entry: ConversationEntry = JSON.parse(line);
      const output = formatEntry(entry);
      if (output) formatted.push(output);
    } catch {
      // Skip malformed lines
    }
  }

  // Apply --lines limit (last N entries)
  const output = maxEntries > 0 ? formatted.slice(-maxEntries) : formatted;
  console.log(output.join("\n"));
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

  // Must be an active task (working/needs_human/stuck)
  const activeStatuses: TaskStatus[] = ["working", "needs_human", "stuck"];
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
  const taskDir = getTaskDir(deps, task.project, task.branch);

  // Create new tmux session
  const tmuxSession = `${task.project}/${task.branch}`;
  const { buildRespawnPrompt } = await import("../../core/agent.js");
  const prompt = buildRespawnPrompt(task, workspacePath, taskDir);
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
  if (task.status !== "done" && task.status !== "failed") {
    log.error("Cannot delete active task", { taskId, status: task.status });
    console.error(`Cannot delete task '${taskId}' with status '${task.status}'`);
    console.error("Only done or failed tasks can be deleted. Use 'orange task cancel' first.");
    process.exit(1);
  }

  // Delete task folder
  const taskDir = getTaskDir(deps, task.project, task.branch);
  await rm(taskDir, { recursive: true, force: true });

  log.info("Task deleted", { taskId, project: task.project, branch: task.branch });
  console.log(`Task ${taskId} deleted`);
}
