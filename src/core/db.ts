/**
 * Task queries - reads directly from TASK.md files.
 *
 * No caching - scans task folders on every query.
 * Source of truth is the file-based TASK.md files.
 */

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { Deps, Task, TaskStatus } from "./types.js";
import { loadTask } from "./state.js";

/**
 * List tasks with optional filters.
 * Scans task folders and reads TASK.md files directly.
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
        const branches = await readdir(projectDir);

        for (const branch of branches) {
          const task = await loadTask(deps, project, branch);
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
 */
export async function getTaskById(deps: Deps, id: string): Promise<Task | null> {
  const tasks = await listTasks(deps, {});
  return tasks.find((t) => t.id === id) ?? null;
}
