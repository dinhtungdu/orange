/**
 * File-based state management.
 *
 * Handles:
 * - projects.json: Project registry
 * - TASK.md: Task frontmatter and description
 * - history.jsonl: Append-only event log
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import type { Deps, Project, Task, HistoryEvent, Harness } from "./types.js";

/**
 * Get the path to projects.json.
 */
function getProjectsPath(deps: Deps): string {
  return join(deps.dataDir, "projects.json");
}

/**
 * Get the task directory for a project/task ID.
 */
export function getTaskDir(deps: Deps, project: string, taskId: string): string {
  return join(deps.dataDir, "tasks", project, taskId);
}

/**
 * Get the TASK.md path for a project/task ID.
 */
export function getTaskPath(deps: Deps, project: string, taskId: string): string {
  return join(getTaskDir(deps, project, taskId), "TASK.md");
}

/**
 * Get the history.jsonl path for a project/task ID.
 */
function getHistoryPath(deps: Deps, project: string, taskId: string): string {
  return join(getTaskDir(deps, project, taskId), "history.jsonl");
}

/**
 * Load projects from projects.json.
 */
export async function loadProjects(deps: Deps): Promise<Project[]> {
  try {
    const content = await readFile(getProjectsPath(deps), "utf-8");
    return JSON.parse(content) as Project[];
  } catch {
    return [];
  }
}

/**
 * Save projects to projects.json.
 */
export async function saveProjects(deps: Deps, projects: Project[]): Promise<void> {
  await mkdir(deps.dataDir, { recursive: true });
  await writeFile(getProjectsPath(deps), JSON.stringify(projects, null, 2));
}

/**
 * Load a task from TASK.md by task ID.
 *
 * Format:
 * ---
 * description: Short task description
 * ...other frontmatter...
 * ---
 * 
 * Free-form body (context, questions, notes)
 */
export async function loadTask(
  deps: Deps,
  project: string,
  taskId: string
): Promise<Task | null> {
  try {
    const content = await readFile(getTaskPath(deps, project, taskId), "utf-8");
    const { data, content: body } = matter(content);

    return {
      id: data.id as string,
      project: data.project as string,
      branch: data.branch as string,
      harness: (data.harness as Harness) ?? "claude", // Default for backward compat
      status: data.status as Task["status"],
      workspace: (data.workspace as string) ?? null,
      tmux_session: (data.tmux_session as string) ?? null,
      description: (data.description as string) ?? "",
      body: body.trim(),
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
      pr_url: (data.pr_url as string) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Save a task to TASK.md.
 *
 * Format:
 * ---
 * description: Short task description
 * ...other frontmatter...
 * ---
 * 
 * Free-form body (context, questions, notes)
 */
export async function saveTask(deps: Deps, task: Task): Promise<void> {
  const taskDir = getTaskDir(deps, task.project, task.id);
  await mkdir(taskDir, { recursive: true });

  const frontmatter: Record<string, unknown> = {
    id: task.id,
    project: task.project,
    branch: task.branch,
    harness: task.harness,
    status: task.status,
    description: task.description,
    workspace: task.workspace,
    tmux_session: task.tmux_session,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
  if (task.pr_url) {
    frontmatter.pr_url = task.pr_url;
  }

  const content = matter.stringify(task.body, frontmatter);
  await writeFile(getTaskPath(deps, task.project, task.id), content);
}

/**
 * Append an event to history.jsonl.
 */
export async function appendHistory(
  deps: Deps,
  project: string,
  taskId: string,
  event: HistoryEvent
): Promise<void> {
  const historyPath = getHistoryPath(deps, project, taskId);
  const line = JSON.stringify(event) + "\n";
  await appendFile(historyPath, line);
}

/**
 * Load all history events for a task.
 */
export async function loadHistory(
  deps: Deps,
  project: string,
  taskId: string
): Promise<HistoryEvent[]> {
  try {
    const content = await readFile(getHistoryPath(deps, project, taskId), "utf-8");
    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as HistoryEvent);
  } catch {
    return [];
  }
}
