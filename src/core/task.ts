/**
 * Core task operations shared between CLI and dashboard.
 */

import { mkdir } from "node:fs/promises";
import { customAlphabet } from "nanoid";
import type { Deps, Task, Project, Harness } from "./types.js";
import { saveTask, appendHistory, getTaskDir } from "./state.js";
import { getTaskByBranch } from "./db.js";
import { loadProjects } from "./state.js";
import { resolveHarness } from "./harness.js";

export interface CreateTaskOptions {
  project: Project;
  branch: string;
  summary: string;
  /** Optional context to include in body as ## Context section */
  context?: string | null;
  /** Initial status. Defaults to "pending". "clarification" auto-set for empty summary. */
  status?: "pending" | "clarification" | "agent-review" | "reviewing";
  /** Harness to use. If omitted, auto-detects first installed. */
  harness?: Harness | string;
  /** Task ID. If omitted, auto-generates. */
  id?: string;
}

export interface CreateTaskResult {
  task: Task;
}

/**
 * Create a new task record.
 *
 * Validates uniqueness, fetches latest remote state, creates task directory,
 * saves TASK.md and initial history event.
 *
 * @throws Error if a task already exists for the branch
 */
export async function createTaskRecord(
  deps: Deps,
  options: CreateTaskOptions
): Promise<CreateTaskResult> {
  const { project, branch, summary, context = null } = options;
  // Empty summary auto-sets clarification status
  const status = options.status ?? (summary.trim() === "" ? "clarification" : "pending");
  const log = deps.logger.child("task");

  // Check if an orange task already exists for this branch
  const existingTask = await getTaskByBranch(deps, project.name, branch);
  if (existingTask) {
    throw new Error(`Task already exists for branch '${branch}' in project '${project.name}'`);
  }

  // Resolve harness (validates and auto-detects if not specified)
  const harness = await resolveHarness(options.harness as string | undefined);

  // Fetch latest remote state
  await deps.git.fetch(project.path);

  const now = deps.clock.now();
  // Use provided ID or generate one
  // Alphanumeric-only alphabet to avoid IDs starting with '-' which breaks CLI arg parsing
  const id = options.id || customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 21)();

  log.info("Creating task", { taskId: id, project: project.name, branch, summary, harness });

  // Build body from context (if provided)
  const body = context ? `## Context\n\n${context}` : "";

  const task: Task = {
    id,
    project: project.name,
    branch,
    harness,
    review_harness: "claude",
    status,
    review_round: 0,
    crash_count: 0,
    workspace: null,
    tmux_session: null,
    summary,
    body,
    created_at: now,
    updated_at: now,
    pr_url: null,
    pr_state: null,
  };

  // Create task directory
  const taskDir = getTaskDir(deps, project.name, id);
  await mkdir(taskDir, { recursive: true });

  // Save task and initial history event
  await saveTask(deps, task);
  await appendHistory(deps, project.name, id, {
    type: "task.created",
    timestamp: now,
    task_id: id,
    project: project.name,
    branch,
    summary,
    status,
  });

  log.info("Task created", { taskId: id, project: project.name, branch });

  // Check if branch already has a PR on GitHub
  try {
    const ghAvailable = await deps.github.isAvailable(project.path);
    if (ghAvailable) {
      const prStatus = await deps.github.getPRStatus(project.path, branch);
      if (prStatus.exists && prStatus.url) {
        task.pr_url = prStatus.url;
        task.updated_at = deps.clock.now();
        await saveTask(deps, task);
        log.info("Linked existing PR", { taskId: id, prUrl: prStatus.url });
      }
    }
  } catch {
    // Ignore errors — PR detection is best-effort
  }

  return { task };
}

/**
 * Refresh PR status for a task.
 * Checks GitHub for PR existence and updates task.pr_url if found.
 *
 * @returns Updated task, or null if task/project not found
 */
export async function refreshTaskPR(
  deps: Deps,
  taskId: string
): Promise<Task | null> {
  const log = deps.logger.child("task");

  // Find task by ID across all projects
  const projects = await loadProjects(deps);
  let task: Task | null = null;
  let project: Project | null = null;

  for (const p of projects) {
    // Need to scan tasks — loadTask requires branch, not ID
    const { listTasks } = await import("./db.js");
    const tasks = await listTasks(deps, { project: p.name });
    const found = tasks.find((t) => t.id === taskId);
    if (found) {
      task = found;
      project = p;
      break;
    }
  }

  if (!task || !project) {
    log.warn("Task not found for PR refresh", { taskId });
    return null;
  }

  const ghAvailable = await deps.github.isAvailable(project.path);
  if (!ghAvailable) {
    log.debug("GitHub not available for PR refresh", { taskId });
    return task;
  }

  try {
    const prStatus = await deps.github.getPRStatus(project.path, task.branch);
    if (prStatus.exists && prStatus.url && task.pr_url !== prStatus.url) {
      task.pr_url = prStatus.url;
      task.updated_at = deps.clock.now();
      await saveTask(deps, task);
      log.info("PR URL updated", { taskId, prUrl: prStatus.url });
    }
  } catch (err) {
    log.warn("PR refresh failed", { taskId, error: err instanceof Error ? err.message : String(err) });
  }

  return task;
}
