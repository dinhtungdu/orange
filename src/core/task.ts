/**
 * Core task operations shared between CLI and dashboard.
 */

import { mkdir } from "node:fs/promises";
import { nanoid } from "nanoid";
import type { Deps, Task, Project } from "./types.js";
import { loadTask, saveTask, appendHistory, getTaskDir } from "./state.js";

export interface CreateTaskOptions {
  project: Project;
  branch: string;
  description: string;
  context?: string | null;
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
  const { project, branch, description, context = null } = options;
  const log = deps.logger.child("task");

  // Check if an orange task already exists for this branch
  const existingTask = await loadTask(deps, project.name, branch);
  if (existingTask) {
    throw new Error(`Task already exists for branch '${branch}' in project '${project.name}'`);
  }

  // Fetch latest remote state
  await deps.git.fetch(project.path);

  const now = deps.clock.now();
  const id = nanoid();

  log.info("Creating task", { taskId: id, project: project.name, branch, description });

  const task: Task = {
    id,
    project: project.name,
    branch,
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
  const taskDir = getTaskDir(deps, project.name, branch);
  await mkdir(taskDir, { recursive: true });

  // Save task and initial history event
  await saveTask(deps, task);
  await appendHistory(deps, project.name, branch, {
    type: "task.created",
    timestamp: now,
    task_id: id,
    project: project.name,
    branch,
    description,
  });

  log.info("Task created", { taskId: id, project: project.name, branch });

  return { task };
}
