/**
 * File-based state management.
 *
 * Handles:
 * - projects.json: Project registry
 * - TASK.md: Task frontmatter and summary
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
 * summary: Short task summary
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
      harness: (data.harness as Harness) ?? "claude",
      review_harness: (data.review_harness as Harness) ?? "claude",
      status: data.status as Task["status"],
      review_round: (data.review_round as number) ?? 0,
      crash_count: (data.crash_count as number) ?? 0,
      workspace: (data.workspace as string) ?? null,
      tmux_session: (data.tmux_session as string) ?? null,
      summary: (data.summary as string) ?? "",
      body: body.trim(),
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
      pr_url: (data.pr_url as string) ?? null,
      pr_state: (data.pr_state as Task["pr_state"]) ?? null,
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
 * summary: Short task summary
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
    review_harness: task.review_harness,
    status: task.status,
    review_round: task.review_round,
    crash_count: task.crash_count,
    summary: task.summary,
    workspace: task.workspace,
    tmux_session: task.tmux_session,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
  if (task.pr_url) {
    frontmatter.pr_url = task.pr_url;
  }
  if (task.pr_state) {
    frontmatter.pr_state = task.pr_state;
  }

  const content = matter.stringify(task.body, frontmatter);
  await writeFile(getTaskPath(deps, task.project, task.id), content);
}

// --- Section Parsing ---

/**
 * Extract a named section from the markdown body.
 * Returns the content between the section header and the next ## header (or end of body).
 * Returns null if section not found.
 */
export function extractSection(body: string, sectionName: string): string | null {
  const pattern = new RegExp(`^## ${sectionName}\\s*$`, "m");
  const match = pattern.exec(body);
  if (!match) return null;

  const start = match.index + match[0].length;
  const nextSection = body.indexOf("\n## ", start);
  const content = nextSection === -1
    ? body.slice(start)
    : body.slice(start, nextSection);

  return content.trim();
}

/**
 * Parsed Plan section fields.
 */
export interface PlanFields {
  approach?: string;
  touching?: string;
  risks?: string;
}

/**
 * Parse ## Plan section. Extracts APPROACH, TOUCHING, RISKS fields.
 */
export function parsePlanSection(body: string): PlanFields | null {
  const section = extractSection(body, "Plan");
  if (section === null) return null;

  const fields: PlanFields = {};
  const approachMatch = /^APPROACH:\s*(.+)$/m.exec(section);
  if (approachMatch) fields.approach = approachMatch[1].trim();
  const touchingMatch = /^TOUCHING:\s*(.+)$/m.exec(section);
  if (touchingMatch) fields.touching = touchingMatch[1].trim();
  const risksMatch = /^RISKS:\s*(.+)$/m.exec(section);
  if (risksMatch) fields.risks = risksMatch[1].trim();

  return fields;
}

/**
 * Parsed Handoff section fields.
 */
export interface HandoffFields {
  done?: string;
  remaining?: string;
  decisions?: string;
  uncertain?: string;
}

/**
 * Parse ## Handoff section. Extracts DONE, REMAINING, DECISIONS, UNCERTAIN fields.
 */
export function parseHandoffSection(body: string): HandoffFields | null {
  const section = extractSection(body, "Handoff");
  if (section === null) return null;

  const fields: HandoffFields = {};
  const doneMatch = /^DONE:\s*(.+)$/m.exec(section);
  if (doneMatch) fields.done = doneMatch[1].trim();
  const remainingMatch = /^REMAINING:\s*(.+)$/m.exec(section);
  if (remainingMatch) fields.remaining = remainingMatch[1].trim();
  const decisionsMatch = /^DECISIONS:\s*(.+)$/m.exec(section);
  if (decisionsMatch) fields.decisions = decisionsMatch[1].trim();
  const uncertainMatch = /^UNCERTAIN:\s*(.+)$/m.exec(section);
  if (uncertainMatch) fields.uncertain = uncertainMatch[1].trim();

  return fields;
}

/**
 * Parsed Review section.
 */
export interface ReviewFields {
  verdict: "PASS" | "FAIL";
  feedback: string;
}

/**
 * Parse ## Review section. Extracts Verdict line and feedback.
 */
export function parseReviewSection(body: string): ReviewFields | null {
  const section = extractSection(body, "Review");
  if (section === null) return null;

  // First non-empty line must be Verdict: PASS or Verdict: FAIL
  const lines = section.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const verdictMatch = /^Verdict:\s*(PASS|FAIL)\s*$/i.exec(lines[0]);
  if (!verdictMatch) return null;

  const verdict = verdictMatch[1].toUpperCase() as "PASS" | "FAIL";
  const feedback = lines.slice(1).join("\n").trim();

  return { verdict, feedback };
}

// --- Artifact Gate Validation ---

/**
 * Validate ## Plan gate: section exists with at least APPROACH or TOUCHING field with content.
 */
export function validatePlanGate(body: string): boolean {
  const plan = parsePlanSection(body);
  if (!plan) return false;
  return !!(plan.approach || plan.touching);
}

/**
 * Validate ## Handoff gate: section exists with at least one field with content.
 */
export function validateHandoffGate(body: string): boolean {
  const handoff = parseHandoffSection(body);
  if (!handoff) return false;
  return !!(handoff.done || handoff.remaining || handoff.decisions || handoff.uncertain);
}

/**
 * Validate ## Review gate: section exists with correct verdict line.
 */
export function validateReviewGate(body: string, expectedVerdict: "PASS" | "FAIL"): boolean {
  const review = parseReviewSection(body);
  if (!review) return false;
  return review.verdict === expectedVerdict;
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
