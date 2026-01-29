/**
 * Task queries - reads directly from TASK.md files.
 *
 * No caching - scans task folders on every query.
 * Source of truth is the file-based TASK.md files.
 *
 * Task directories are named by task ID (nanoid).
 * Branch name is stored in TASK.md frontmatter.
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { Deps, Task, TaskStatus } from "./types.js";
import { loadTask } from "./state.js";

/**
 * List tasks with optional filters.
 * Scans task folders and reads TASK.md files directly.
 *
 * Directory names are task IDs.
 * Branch name is read from TASK.md frontmatter.
 */
export async function listTasks(
  deps: Deps,
  filters: { project?: string; status?: TaskStatus }
): Promise<Task[]> {
  const tasks: Task[] = [];
  const tasksDir = join(deps.dataDir, "tasks");

  try {
    const projects = await readdir(tasksDir);

    for (const project of projects) {
      // Skip if filtering by project and doesn't match
      if (filters.project && project !== filters.project) {
        continue;
      }

      const projectDir = join(tasksDir, project);

      try {
        const taskIds = await readdir(projectDir);

        for (const taskId of taskIds) {
          const task = await loadTask(deps, project, taskId);
          if (task) {
            // Skip if filtering by status and doesn't match
            if (filters.status && task.status !== filters.status) {
              continue;
            }
            tasks.push(task);
          }
        }
      } catch {
        // Skip non-directory entries or read errors
      }
    }
  } catch {
    // No tasks directory yet
  }

  // Sort by created_at DESC (newest first)
  tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return tasks;
}

/**
 * Get a task by ID.
 * Scans all projects since we don't know which project the task belongs to.
 */
export async function getTaskById(deps: Deps, id: string): Promise<Task | null> {
  const tasksDir = join(deps.dataDir, "tasks");

  try {
    const projects = await readdir(tasksDir);

    for (const project of projects) {
      const task = await loadTask(deps, project, id);
      if (task) {
        return task;
      }
    }
  } catch {
    // No tasks directory yet
  }

  return null;
}

/**
 * Get a task by branch name within a project.
 * Used for uniqueness validation when creating tasks.
 */
export async function getTaskByBranch(
  deps: Deps,
  project: string,
  branch: string
): Promise<Task | null> {
  const tasks = await listTasks(deps, { project });
  return tasks.find((t) => t.branch === branch) ?? null;
}
