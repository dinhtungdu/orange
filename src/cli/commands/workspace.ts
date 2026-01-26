/**
 * Workspace management commands.
 *
 * Commands:
 * - orange workspace init <project>
 * - orange workspace list
 */

import type { ParsedArgs } from "../args.js";
import type { Deps } from "../../core/types.js";
import { loadProjects } from "../../core/state.js";
import { initWorkspacePool, loadPoolState } from "../../core/workspace.js";

/**
 * Run a workspace subcommand.
 */
export async function runWorkspaceCommand(
  parsed: ParsedArgs,
  deps: Deps
): Promise<void> {
  switch (parsed.subcommand) {
    case "init":
      await initWorkspace(parsed, deps);
      break;

    case "list":
      await listWorkspaces(deps);
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
 * Initialize workspaces for a project.
 */
async function initWorkspace(parsed: ParsedArgs, deps: Deps): Promise<void> {
  if (parsed.args.length < 1) {
    console.error("Usage: orange workspace init <project>");
    process.exit(1);
  }

  const projectName = parsed.args[0];

  // Find project
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === projectName);
  if (!project) {
    console.error(`Project '${projectName}' not found`);
    process.exit(1);
  }

  await initWorkspacePool(deps, project);
  console.log(
    `Initialized ${project.pool_size} workspaces for project '${projectName}'`
  );
}

/**
 * List workspace pool status.
 */
async function listWorkspaces(deps: Deps): Promise<void> {
  const poolState = await loadPoolState(deps);

  const workspaces = Object.entries(poolState.workspaces);
  if (workspaces.length === 0) {
    console.log("No workspaces initialized. Use 'orange workspace init <project>' to create some.");
    return;
  }

  console.log("Workspace Pool:\n");

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
