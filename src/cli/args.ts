/**
 * CLI argument parsing for the orange command.
 *
 * Routes commands to appropriate handlers:
 * - project: Project management (add, list)
 * - task: Task management (create, list, spawn, peek, complete, stuck, merge, cancel)
 * - workspace: Workspace pool management (init, list)
 * - start: Start orchestrator session
 * - install: Install orchestrator skill
 * - (no args): Launch dashboard
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
    project: ["add", "list"],
    task: [
      "create",
      "list",
      "spawn",
      "peek",
      "complete",
      "stuck",
      "merge",
      "cancel",
    ],
    workspace: ["init", "list"],
  };

  return subcommands[command]?.includes(arg) ?? false;
}

/**
 * Print usage information.
 */
export function printUsage(): void {
  console.log(`
orange - Agent orchestration system

Usage:
  orange                              Launch dashboard
  orange start                        Create orchestrator session
  orange install                      Install orchestrator skill

Project Management:
  orange project add <path> [options] Add a project
    --name <name>                     Custom project name
    --pool-size <n>                   Worktree pool size (default: 2)
  orange project list                 List all projects

Task Management:
  orange task create <project> <branch> <description>
                                      Create a new task
  orange task list [options]          List tasks
    --project <project>               Filter by project
    --status <status>                 Filter by status
  orange task spawn <task_id>         Spawn agent for task
  orange task peek <task_id> [options] Show agent output
    --lines <n>                       Number of lines (default: 50)
  orange task complete <task_id>      Mark task complete (hook)
  orange task stuck <task_id>         Mark task stuck (hook)
  orange task merge <task_id> [options] Merge and cleanup
    --strategy <ff|merge>             Merge strategy (default: ff)
  orange task cancel <task_id>        Cancel task

Workspace Management:
  orange workspace init <project>     Create worktrees for project
  orange workspace list               Show workspace pool status
`);
}
