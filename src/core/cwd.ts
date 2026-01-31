/**
 * CWD detection utilities for project-aware commands.
 *
 * Commands detect the current project by:
 * 1. Finding git root of current directory
 * 2. Looking up path in projects.json
 * 3. Auto-registering if needed (for `orange`)
 */

import { execSync } from "node:child_process";
import { resolve, basename, normalize, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { Deps, Project } from "./types.js";
import { loadProjects, saveProjects } from "./state.js";
import { listTasks } from "./db.js";
import { getWorkspacesDir } from "./workspace.js";

/**
 * Normalize a path, resolving symlinks (handles macOS /var -> /private/var).
 */
function normalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Result of project detection.
 */
export interface ProjectDetection {
  /** The detected project, or null if not found/registered */
  project: Project | null;
  /** The git root path, or null if not in a git repo */
  gitRoot: string | null;
  /** Error message if detection failed */
  error?: string;
}

/**
 * Detect project when running inside a workspace directory.
 * Maps workspace -> task -> project.
 */
async function detectProjectFromWorkspace(
  deps: Deps,
  cwd: string
): Promise<Project | null> {
  const normalizedCwd = normalizePath(cwd);
  const normalizedWorkspacesDir = normalizePath(getWorkspacesDir(deps));
  const prefix = normalizedWorkspacesDir.endsWith(sep)
    ? normalizedWorkspacesDir
    : `${normalizedWorkspacesDir}${sep}`;

  if (!normalizedCwd.startsWith(prefix)) {
    return null;
  }

  const workspaceName = normalizedCwd.slice(prefix.length).split(sep)[0];
  if (!workspaceName) {
    return null;
  }

  const tasks = await listTasks(deps, {});
  const task = tasks.find((t) => t.workspace === workspaceName);
  if (!task) {
    return null;
  }

  const projects = await loadProjects(deps);
  return projects.find((p) => p.name === task.project) ?? null;
}

/**
 * Get the git repository root from a directory.
 * Returns null if not in a git repository.
 * Path is normalized to handle symlinks (e.g., /var -> /private/var on macOS).
 */
export function getGitRoot(cwd: string): string | null {
  try {
    const result = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return normalizePath(result.trim());
  } catch {
    return null;
  }
}

/**
 * Get the default branch name for a git repository.
 */
export function getDefaultBranch(cwd: string): string {
  try {
    // Try to get the default branch from remote HEAD
    const result = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // refs/remotes/origin/main -> main
    return result.trim().replace("refs/remotes/origin/", "");
  } catch {
    // Fallback to checking if main or master exists
    try {
      execSync("git rev-parse --verify main", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return "main";
    } catch {
      return "master";
    }
  }
}

/**
 * Detect project from current working directory.
 *
 * @param deps - Dependencies
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Project detection result
 */
export async function detectProject(
  deps: Deps,
  cwd: string = process.cwd()
): Promise<ProjectDetection> {
  const workspaceProject = await detectProjectFromWorkspace(deps, cwd);
  if (workspaceProject) {
    return {
      project: workspaceProject,
      gitRoot: normalizePath(workspaceProject.path),
    };
  }

  const gitRoot = getGitRoot(cwd);

  if (!gitRoot) {
    return {
      project: null,
      gitRoot: null,
      error: "Not a git repository. Run from a project directory.",
    };
  }

  const projects = await loadProjects(deps);
  const normalizedGitRoot = normalizePath(gitRoot);

  // Find project by path (normalize both sides)
  const project = projects.find(
    (p) => normalizePath(p.path) === normalizedGitRoot
  );

  return {
    project: project ?? null,
    gitRoot: normalizedGitRoot,
  };
}

/**
 * Require a project from current working directory.
 * Throws if not in a registered project.
 *
 * @param deps - Dependencies
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns The detected project
 * @throws Error if not in a git repo or project not registered
 */
export async function requireProject(
  deps: Deps,
  cwd: string = process.cwd()
): Promise<Project> {
  const detection = await detectProject(deps, cwd);

  if (detection.error) {
    throw new Error(detection.error);
  }

  if (!detection.project) {
    throw new Error(
      `Project not registered. Run 'orange' from this directory to register it, ` +
      `or use 'orange project add ${detection.gitRoot}'.`
    );
  }

  return detection.project;
}

/**
 * Auto-register a project if not already registered.
 * Used by `orange` for seamless project setup.
 *
 * @param deps - Dependencies
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns The project (existing or newly registered)
 * @throws Error if not in a git repository
 */
export async function autoRegisterProject(
  deps: Deps,
  cwd: string = process.cwd()
): Promise<Project> {
  const detection = await detectProject(deps, cwd);

  if (!detection.gitRoot) {
    throw new Error("Not a git repository. Run from a project directory.");
  }

  // Already registered
  if (detection.project) {
    return detection.project;
  }

  // Auto-register with defaults
  const name = basename(detection.gitRoot);
  const defaultBranch = getDefaultBranch(detection.gitRoot);

  const project: Project = {
    name,
    path: detection.gitRoot,
    default_branch: defaultBranch,
    pool_size: 2,
  };

  // Check for name conflicts
  const projects = await loadProjects(deps);
  const existingWithName = projects.find((p) => p.name === name);
  if (existingWithName) {
    // Use path-based name to avoid conflict
    project.name = `${name}-${Date.now()}`;
  }

  projects.push(project);
  await saveProjects(deps, projects);

  console.log(`Auto-registered project '${project.name}' (${detection.gitRoot})`);

  return project;
}

/**
 * Find a project by name.
 */
export async function findProjectByName(
  deps: Deps,
  name: string
): Promise<Project | null> {
  const projects = await loadProjects(deps);
  return projects.find((p) => p.name === name) ?? null;
}
