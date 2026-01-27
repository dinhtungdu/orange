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
import type { Deps, Project, Task, HistoryEvent } from "./types.js";

/**
 * Get the path to projects.json.
 */
function getProjectsPath(deps: Deps): string {
  return join(deps.dataDir, "projects.json");
}

/**
 * Get the task directory for a project/branch.
 */
export function getTaskDir(deps: Deps, project: string, branch: string): string {
  return join(deps.dataDir, "tasks", project, branch);
}

/**
 * Get the TASK.md path for a project/branch.
 */
export function getTaskPath(deps: Deps, project: string, branch: string): string {
  return join(getTaskDir(deps, project, branch), "TASK.md");
}

/**
 * Get the history.jsonl path for a project/branch.
 */
function getHistoryPath(deps: Deps, project: string, branch: string): string {
  return join(getTaskDir(deps, project, branch), "history.jsonl");
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
 * Load a task from TASK.md.
 */
export async function loadTask(
  deps: Deps,
  project: string,
  branch: string
): Promise<Task | null> {
  try {
    const content = await readFile(getTaskPath(deps, project, branch), "utf-8");
    const { data, content: description } = matter(content);

    // Parse description and context from body
    // Format: description\n\n---\n\ncontext (if context exists)
    const body = description.trim();
    const separator = "\n\n---\n\n";
    const sepIndex = body.indexOf(separator);
    const desc = sepIndex >= 0 ? body.slice(0, sepIndex) : body;
    const ctx = sepIndex >= 0 ? body.slice(sepIndex + separator.length) : null;

    return {
      id: data.id as string,
      project: data.project as string,
      branch: data.branch as string,
      status: data.status as Task["status"],
      workspace: (data.workspace as string) ?? null,
      tmux_session: (data.tmux_session as string) ?? null,
      description: desc,
      context: ctx,
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
    };
  } catch {
    return null;
  }
}

/**
 * Save a task to TASK.md.
 */
export async function saveTask(deps: Deps, task: Task): Promise<void> {
  const taskDir = getTaskDir(deps, task.project, task.branch);
  await mkdir(taskDir, { recursive: true });

  const frontmatter = {
    id: task.id,
    project: task.project,
    branch: task.branch,
    status: task.status,
    workspace: task.workspace,
    tmux_session: task.tmux_session,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };

  // Combine description and context in body
  const body = task.context
    ? `${task.description}\n\n---\n\n${task.context}`
    : task.description;
  const content = matter.stringify(body, frontmatter);
  await writeFile(getTaskPath(deps, task.project, task.branch), content);
}

/**
 * Append an event to history.jsonl.
 */
export async function appendHistory(
  deps: Deps,
  project: string,
  branch: string,
  event: HistoryEvent
): Promise<void> {
  const historyPath = getHistoryPath(deps, project, branch);
  const line = JSON.stringify(event) + "\n";
  await appendFile(historyPath, line);
}

/**
 * Load all history events for a task.
 */
export async function loadHistory(
  deps: Deps,
  project: string,
  branch: string
): Promise<HistoryEvent[]> {
  try {
    const content = await readFile(getHistoryPath(deps, project, branch), "utf-8");
    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as HistoryEvent);
  } catch {
    return [];
  }
}
