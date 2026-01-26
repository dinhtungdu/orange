/**
 * Project management commands.
 *
 * Commands:
 * - orange project add <path> [--name <name>] [--pool-size <n>]
 * - orange project list
 */

import { basename, resolve } from "node:path";
import type { ParsedArgs } from "../args.js";
import type { Deps, Project } from "../../core/types.js";
import { loadProjects, saveProjects } from "../../core/state.js";

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

    default:
      console.error(
        `Unknown project subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error("Usage: orange project <add|list>");
      process.exit(1);
  }
}

/**
 * Add a new project.
 */
async function addProject(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange project add <path> [--name <name>] [--pool-size <n>]");
    process.exit(1);
  }

  const path = resolve(parsed.args[0]);
  const name = (parsed.options.name as string) ?? basename(path);
  const poolSize = parseInt(parsed.options["pool-size"] as string) || 2;

  // Load existing projects
  const projects = await loadProjects(deps);

  // Check if project already exists
  if (projects.some((p) => p.name === name)) {
    console.error(`Project '${name}' already exists`);
    process.exit(1);
  }

  // Create new project
  const project: Project = {
    name,
    path,
    default_branch: "main",
    pool_size: poolSize,
  };

  projects.push(project);
  await saveProjects(deps, projects);

  console.log(`Added project '${name}' at ${path} (pool size: ${poolSize})`);
}

/**
 * List all projects.
 */
async function listProjects(deps: Deps): Promise<void> {
  const projects = await loadProjects(deps);

  if (projects.length === 0) {
    console.log("No projects registered. Use 'orange project add <path>' to add one.");
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
