/**
 * Project management commands.
 *
 * Commands:
 * - orange project add [path] [--name <name>] [--pool-size <n>]
 * - orange project list
 * - orange project remove <name>
 */

import { basename, resolve } from "node:path";
import type { ParsedArgs } from "../args.js";
import type { Deps, Project } from "../../core/types.js";
import { loadProjects, saveProjects } from "../../core/state.js";
import { getGitRoot, getDefaultBranch, detectProject } from "../../core/cwd.js";

/**
 * Run a project subcommand.
 */
export async function runProjectCommand(
  parsed: ParsedArgs,
  deps: Deps
): Promise<void> {
  switch (parsed.subcommand) {
    case "add":
      await addProject(parsed, deps);
      break;

    case "list":
      await listProjects(deps);
      break;

    case "update":
      await updateProject(parsed, deps);
      break;

    case "remove":
      await removeProject(parsed, deps);
      break;

    default:
      console.error(
        `Unknown project subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error("Usage: orange project <add|list|update|remove>");
      process.exit(1);
  }
}

/**
 * Add a new project.
 * Path defaults to current directory if not provided.
 */
async function addProject(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("project");

  // Path defaults to current directory
  const inputPath = parsed.args[0] ?? process.cwd();
  const resolvedPath = resolve(inputPath);

  // Verify it's a git repository
  const gitRoot = getGitRoot(resolvedPath);
  if (!gitRoot) {
    log.error("Not a git repository", { path: resolvedPath });
    console.error(`Error: '${resolvedPath}' is not a git repository`);
    process.exit(1);
  }

  const path = gitRoot; // Use git root, not the input path
  const name = (parsed.options.name as string) ?? basename(path);
  const poolSize = parseInt(parsed.options["pool-size"] as string) || 2;
  const defaultBranch = getDefaultBranch(path);

  log.info("Adding project", { name, path, defaultBranch, poolSize });

  // Load existing projects
  const projects = await loadProjects(deps);

  // Check if project already exists by name or path
  if (projects.some((p) => p.name === name)) {
    log.error("Project name already exists", { name });
    console.error(`Project '${name}' already exists`);
    process.exit(1);
  }

  if (projects.some((p) => resolve(p.path) === path)) {
    const existing = projects.find((p) => resolve(p.path) === path);
    log.error("Project path already registered", { path, existingName: existing?.name });
    console.error(`Path '${path}' is already registered as project '${existing?.name}'`);
    process.exit(1);
  }

  // Create new project
  const project: Project = {
    name,
    path,
    default_branch: defaultBranch,
    pool_size: poolSize,
  };

  projects.push(project);
  await saveProjects(deps, projects);

  log.info("Project added", { name, path, defaultBranch, poolSize });
  console.log(`Added project '${name}' at ${path}`);
  console.log(`  Default branch: ${defaultBranch}`);
  console.log(`  Pool size: ${poolSize}`);
}

/**
 * List all projects.
 */
async function listProjects(deps: Deps): Promise<void> {
  const log = deps.logger.child("project");

  const projects = await loadProjects(deps);

  log.debug("Listing projects", { count: projects.length });

  if (projects.length === 0) {
    console.log("No projects registered.");
    console.log("Use 'orange project add' from a project directory, or 'orange start' to auto-register.");
    return;
  }

  console.log("Projects:\n");
  for (const project of projects) {
    console.log(`  ${project.name}`);
    console.log(`    Path: ${project.path}`);
    console.log(`    Default branch: ${project.default_branch}`);
    console.log(`    Pool size: ${project.pool_size}`);
    console.log();
  }
}

/**
 * Update a project's settings.
 */
async function updateProject(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("project");

  let name = parsed.args[0] ?? null;

  // Infer project from CWD if name not provided
  if (!name) {
    const detection = await detectProject(deps);
    if (!detection.project) {
      console.error("Usage: orange project update <name> [--pool-size <n>]");
      console.error("Or run from a project directory to infer the project.");
      process.exit(1);
    }
    name = detection.project.name;
  }

  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === name);

  if (!project) {
    log.error("Project not found for update", { name });
    console.error(`Project '${name}' not found`);
    process.exit(1);
  }

  let updated = false;

  if (parsed.options["pool-size"] !== undefined) {
    const poolSize = parseInt(parsed.options["pool-size"] as string);
    if (isNaN(poolSize) || poolSize < 1) {
      console.error("Error: pool-size must be a positive integer");
      process.exit(1);
    }
    const oldPoolSize = project.pool_size;
    project.pool_size = poolSize;
    updated = true;
    log.info("Updating project pool size", { name, from: oldPoolSize, to: poolSize });
  }

  if (!updated) {
    console.error("Nothing to update. Use --pool-size <n> to change pool size.");
    process.exit(1);
  }

  await saveProjects(deps, projects);
  log.info("Project updated", { name, poolSize: project.pool_size });
  console.log(`Updated project '${name}'`);
  console.log(`  Pool size: ${project.pool_size}`);
}

/**
 * Remove a project.
 */
async function removeProject(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("project");

  if (parsed.args.length < 1) {
    console.error("Usage: orange project remove <name>");
    process.exit(1);
  }

  const name = parsed.args[0];

  log.info("Removing project", { name });

  // Load existing projects
  const projects = await loadProjects(deps);

  // Find project
  const index = projects.findIndex((p) => p.name === name);
  if (index === -1) {
    log.error("Project not found for removal", { name });
    console.error(`Project '${name}' not found`);
    process.exit(1);
  }

  // Remove project
  projects.splice(index, 1);
  await saveProjects(deps, projects);

  log.info("Project removed", { name });
  console.log(`Removed project '${name}'`);
  console.log("Note: Workspaces and tasks are not deleted. Clean them up manually if needed.");
}
