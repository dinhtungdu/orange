/**
 * CLI argument parsing for the orange command.
 *
 * All commands are CWD-aware - they infer project from current directory.
 *
 * Routes commands to appropriate handlers:
 * - (no args or flags only): Dashboard (auto-register if in git repo, fallback to global)
 * - project: Project management (add, list, remove)
 * - task: Task management (create, list, spawn, attach, respawn, complete, approve, stuck, merge, cancel, delete, create-pr)
 * - workspace: Workspace pool management (init, list)
 * - install: Install orchestrator skill
 */

export interface ParsedArgs {
  command: string;
  subcommand: string | null;
  args: string[];
  options: Record<string, string | boolean>;
}

const COMMANDS = ["project", "task", "workspace", "install", "log", "help", "--help", "-h"];

/**
 * Parse command line arguments.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // Skip 'bun' and script path if present
  const args = argv.slice(2);

  // No args → dashboard
  if (args.length === 0) {
    return {
      command: "dashboard",
      subcommand: null,
      args: [],
      options: {},
    };
  }

  // Help flags at root level
  if (args[0] === "--help" || args[0] === "-h") {
    return {
      command: args[0],
      subcommand: null,
      args: [],
      options: {},
    };
  }

  const command = args[0];

  // Unknown command → treat as dashboard (error will be shown later if truly invalid)
  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
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
 * Parse options from an array of arguments.
 */
function parseOptions(args: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        options[key] = nextArg;
        i += 2;
      } else {
        options[key] = true;
        i += 1;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        options[key] = nextArg;
        i += 2;
      } else {
        options[key] = true;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return options;
}

/**
 * Check if an argument is a valid subcommand for the given command.
 */
function isSubcommand(command: string, arg: string): boolean {
  const subcommands: Record<string, string[]> = {
    project: ["add", "list", "remove", "update"],
    task: [
      "create",
      "list",
      "spawn",
      "attach",
      "respawn",
      "update",
      "complete",
      "approve",
      "unapprove",
      "stuck",
      "merge",
      "cancel",
      "delete",
      "create-pr",
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
  orange                              Launch dashboard (auto-register if in git repo, global if not)
  orange install                      Install agent skill

Project Management:
  orange project add [path] [options] Add a project (defaults to current directory)
    --name <name>                     Custom project name
    --pool-size <n>                   Worktree pool size (default: 2)
  orange project list                 List all projects
  orange project update [name] [options] Update project settings (name inferred from cwd)
    --pool-size <n>                   Worktree pool size
  orange project remove <name>        Remove a project

Task Management (project inferred from cwd):
  orange task create [branch] [description]
                                      Create a new task (both optional)
                                      Empty branch: auto-generates from task ID
                                      Empty description: interactive session
  orange task list [options]          List tasks
    --status <status>                 Filter by status
    --all                             Show all projects' tasks
  orange task spawn <task_id>         Spawn agent for task
  orange task attach <task_id>        Attach to task's tmux session
  orange task respawn <task_id>       Restart dead session
  orange task update <task_id> [options] Update task branch/description
    --branch <name>                   Rename branch (fails if exists)
    --description <text>              Update description
  orange task complete <task_id>      Mark task complete (hook)
  orange task approve <task_id>       Approve task (reviewing → reviewed)
  orange task unapprove <task_id>     Unapprove task (reviewed → reviewing)
  orange task stuck <task_id>         Mark task stuck (hook)
  orange task merge <task_id> [options] Merge and cleanup
    --strategy <ff|merge>             Merge strategy (default: ff)
    --local                           Force local merge, bypass PR check
  orange task cancel <task_id> [--yes] Cancel task (prompts for confirmation)
  orange task delete <task_id> [--yes] Delete task (only done/failed/cancelled)
  orange task create-pr <task_id>     Create PR for reviewed task

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
