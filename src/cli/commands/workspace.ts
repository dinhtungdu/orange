/**
 * Workspace management commands.
 *
 * All commands are CWD-aware - project is inferred from current directory.
 *
 * Commands:
 * - orange workspace init
 * - orange workspace list [--all]
 * - orange workspace gc
 */

import type { ParsedArgs } from "../args.js";
import type { Deps } from "../../core/types.js";
import { initWorkspacePool, loadPoolState, releaseWorkspace } from "../../core/workspace.js";
import { requireProject, detectProject } from "../../core/cwd.js";
import { listTasks } from "../../core/db.js";

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

    case "gc":
      await gcWorkspaces(deps);
      break;

    default:
      console.error(
        `Unknown workspace subcommand: ${parsed.subcommand ?? "(none)"}`
      );
      console.error("Usage: orange workspace <init|list|gc>");
      process.exit(1);
  }
}

/**
 * Initialize workspaces for the current project.
 */
async function initWorkspace(deps: Deps): Promise<void> {
  const log = deps.logger.child("workspace");

  // Get project from cwd
  const project = await requireProject(deps);

  log.info("Initializing workspace pool", { project: project.name, poolSize: project.pool_size });
  await initWorkspacePool(deps, project);
  log.info("Workspace pool initialized", { project: project.name, poolSize: project.pool_size });
  console.log(
    `Initialized ${project.pool_size} workspaces for project '${project.name}'`
  );
}

/**
 * List workspace pool status.
 */
async function listWorkspaces(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const log = deps.logger.child("workspace");
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

  log.debug("Listing workspaces", { count: workspaces.length, showAll });

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

/**
 * Garbage collect orphaned workspaces.
 * Releases workspaces bound to non-existent tasks.
 */
async function gcWorkspaces(deps: Deps): Promise<void> {
  const log = deps.logger.child("workspace");

  log.info("Starting workspace garbage collection");
  const poolState = await loadPoolState(deps);
  const tasks = await listTasks(deps, {});

  // Build set of active task identifiers (project/branch)
  const activeTasks = new Set(tasks.map((t) => `${t.project}/${t.branch}`));

  // Find orphaned workspaces (bound to non-existent tasks)
  const orphaned: string[] = [];
  for (const [name, entry] of Object.entries(poolState.workspaces)) {
    if (entry.status === "bound" && entry.task && !activeTasks.has(entry.task)) {
      orphaned.push(name);
    }
  }

  if (orphaned.length === 0) {
    log.debug("No orphaned workspaces found");
    console.log("No orphaned workspaces found.");
    return;
  }

  log.info("Found orphaned workspaces", { count: orphaned.length, workspaces: orphaned });
  console.log(`Found ${orphaned.length} orphaned workspace(s):\n`);
  for (const name of orphaned) {
    const entry = poolState.workspaces[name];
    console.log(`  ${name}: bound → ${entry.task} (task not found)`);
  }
  console.log();

  // Release each orphaned workspace
  for (const name of orphaned) {
    log.info("Releasing orphaned workspace", { workspace: name });
    await releaseWorkspace(deps, name, { force: true });
    console.log(`Released ${name}`);
  }

  log.info("Workspace GC complete", { released: orphaned.length });
  console.log(`\nReleased ${orphaned.length} workspace(s).`);
}
