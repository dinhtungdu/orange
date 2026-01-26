/**
 * Workspace management commands.
 *
 * All commands are CWD-aware - project is inferred from current directory.
 *
 * Commands:
 * - orange workspace init
 * - orange workspace list [--all]
 */

import type { ParsedArgs } from "../args.js";
import type { Deps } from "../../core/types.js";
import { initWorkspacePool, loadPoolState } from "../../core/workspace.js";
import { requireProject, detectProject } from "../../core/cwd.js";

/**
 * Run a workspace subcommand.
 */
export async function runWorkspaceCommand(
  parsed: ParsedArgs,
  deps: Deps
): Promise<void> {
  switch (parsed.subcommand) {
    case "init":
      await initWorkspace(deps);
      break;

    case "list":
      await listWorkspaces(parsed, deps);
      break;

    default:
      console.error(
        `Unknown workspace subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error("Usage: orange workspace <init|list>");
      process.exit(1);
  }
}

/**
 * Initialize workspaces for the current project.
 */
async function initWorkspace(deps: Deps): Promise<void> {
  // Get project from cwd
  const project = await requireProject(deps);

  await initWorkspacePool(deps, project);
  console.log(
    `Initialized ${project.pool_size} workspaces for project '${project.name}'`
  );
}

/**
 * List workspace pool status.
 */
async function listWorkspaces(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const showAll = parsed.options.all === true;
  const poolState = await loadPoolState(deps);

  let workspaces = Object.entries(poolState.workspaces);

  // Filter by project if not showing all
  if (!showAll) {
    const detection = await detectProject(deps);
    if (detection.project) {
      const projectName = detection.project.name;
      workspaces = workspaces.filter(([name]) => name.startsWith(`${projectName}--`));
    }
    // If not in a project and no --all, show all workspaces (global view)
  }

  if (workspaces.length === 0) {
    const detection = await detectProject(deps);
    if (detection.project && !showAll) {
      console.log(`No workspaces for project '${detection.project.name}'.`);
      console.log("Use 'orange workspace init' to create some.");
    } else {
      console.log("No workspaces initialized.");
      console.log("Use 'orange workspace init' from a project directory to create some.");
    }
    return;
  }

  const header = showAll ? "Workspace Pool (all projects):" : "Workspace Pool:";
  console.log(`${header}\n`);

  // Group by project
  const byProject = new Map<string, typeof workspaces>();
  for (const [name, entry] of workspaces) {
    const project = name.split("--")[0];
    if (!byProject.has(project)) {
      byProject.set(project, []);
    }
    byProject.get(project)!.push([name, entry]);
  }

  for (const [project, projectWorkspaces] of byProject) {
    console.log(`  ${project}:`);
    for (const [name, entry] of projectWorkspaces) {
      const status = entry.status === "available" ? "○ available" : `● bound → ${entry.task}`;
      console.log(`    ${name}: ${status}`);
    }
    console.log();
  }
}
