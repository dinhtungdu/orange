/**
 * CLI argument parsing for the orange command.
 *
 * All commands are CWD-aware - they infer project from current directory.
 *
 * Routes commands to appropriate handlers:
 * - project: Project management (add, list, remove)
 * - task: Task management (create, list, spawn, peek, complete, stuck, merge, cancel)
 * - workspace: Workspace pool management (init, list)
 * - start: Start orchestrator session (must be in project directory)
 * - install: Install orchestrator skill
 * - dashboard: Launch dashboard (scoped to project if in project directory)
 * - (no args): Same as dashboard
 */

export interface ParsedArgs {
  command: string;
  subcommand: string | null;
  args: string[];
  options: Record<string, string | boolean>;
}

/**
 * Parse command line arguments.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // Skip 'bun' and script path if present
  const args = argv.slice(2);

  if (args.length === 0) {
    return {
      command: "dashboard",
      subcommand: null,
      args: [],
      options: {},
    };
  }

  const command = args[0];
  const remaining = args.slice(1);

  // Parse options and positional args
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let subcommand: string | null = null;

  let i = 0;
  while (i < remaining.length) {
    const arg = remaining[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = remaining[i + 1];

      // Check if next arg is a value or another flag
      if (nextArg && !nextArg.startsWith("-")) {
        options[key] = nextArg;
        i += 2;
      } else {
        options[key] = true;
        i += 1;
      }
    } else if (arg.startsWith("-")) {
      // Short option
      const key = arg.slice(1);
      const nextArg = remaining[i + 1];

      if (nextArg && !nextArg.startsWith("-")) {
        options[key] = nextArg;
        i += 2;
      } else {
        options[key] = true;
        i += 1;
      }
    } else {
      // Positional argument
      if (subcommand === null && isSubcommand(command, arg)) {
        subcommand = arg;
      } else {
        positional.push(arg);
      }
      i += 1;
    }
  }

  return {
    command,
    subcommand,
    args: positional,
    options,
  };
}

/**
 * Check if an argument is a valid subcommand for the given command.
 */
function isSubcommand(command: string, arg: string): boolean {
  const subcommands: Record<string, string[]> = {
    project: ["add", "list", "remove"],
    task: [
      "create",
      "list",
      "spawn",
      "attach",
      "log",
      "respawn",
      "peek",
      "complete",
      "stuck",
      "merge",
      "cancel",
      "delete",
    ],
    workspace: ["init", "list", "gc"],
  };

  return subcommands[command]?.includes(arg) ?? false;
}

/**
 * Print usage information.
 */
export function printUsage(): void {
  console.log(`
orange - Agent orchestration system

All commands are CWD-aware - they infer project from current directory.

Usage:
  orange                              Launch dashboard (project-scoped if in project)
  orange dashboard [options]          Launch dashboard
    --all                             Show all tasks (global view)
    --project <name>                  Show specific project's tasks
  orange start                        Start orchestrator for current project
  orange install                      Install orchestrator skill

Project Management:
  orange project add [path] [options] Add a project (defaults to current directory)
    --name <name>                     Custom project name
    --pool-size <n>                   Worktree pool size (default: 2)
  orange project list                 List all projects
  orange project remove <name>        Remove a project

Task Management (project inferred from cwd):
  orange task create <branch> <description>
                                      Create a new task
  orange task list [options]          List tasks
    --status <status>                 Filter by status
    --all                             Show all projects' tasks
  orange task spawn <task_id>         Spawn agent for task
  orange task attach <task_id>        Attach to task's tmux session
  orange task log <task_id> [options] View task's output log
    --lines <n>                       Last N lines (default: all)
  orange task respawn <task_id>       Restart dead session
  orange task complete <task_id>      Mark task complete (hook)
  orange task stuck <task_id>         Mark task stuck (hook)
  orange task merge <task_id> [options] Merge and cleanup
    --strategy <ff|merge>             Merge strategy (default: ff)
  orange task cancel <task_id>        Cancel task
  orange task delete <task_id>        Delete task (only done/failed tasks)

Workspace Management (project inferred from cwd):
  orange workspace init               Create worktrees for current project
  orange workspace list [options]     Show workspace pool status
    --all                             Show all projects' workspaces
  orange workspace gc                 Release orphaned workspaces

Logging:
  orange log [options]                View application logs
    --level <level>                   Filter by level (error|warn|info|debug)
    --component <name>                Filter by component
    --grep <pattern>                  Search for pattern
    --lines <n>                       Show last N lines (default: follow mode)

Environment Variables:
  ORANGE_LOG_LEVEL                    Set log level (default: info)
`);
}
