#!/usr/bin/env bun
/**
 * Orange - Agent orchestration system
 *
 * Entry point that dispatches to CLI commands or dashboard based on arguments.
 *
 * All commands are CWD-aware - they infer project from current directory.
 */

import { parseArgs, printUsage } from "./cli/args.js";
import { runProjectCommand } from "./cli/commands/project.js";
import { runTaskCommand } from "./cli/commands/task.js";
import { runWorkspaceCommand } from "./cli/commands/workspace.js";
import { runStartCommand } from "./cli/commands/start.js";
import { runInstallCommand } from "./cli/commands/install.js";
import { runLogCommand } from "./cli/commands/log.js";
import { runDashboard } from "./dashboard/index.js";
import { createDeps } from "./core/deps.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const deps = createDeps();
  const log = deps.logger.child("cli");

  // Log command start (except for log command to avoid noise)
  if (parsed.command !== "log") {
    log.info("Command start", {
      command: parsed.command,
      subcommand: parsed.subcommand,
      args: parsed.args,
    });
  }

  const startTime = Date.now();

  try {
    switch (parsed.command) {
      case "dashboard":
        await runDashboard(deps, {
          all: parsed.options.all === true,
          project: parsed.options.project as string | undefined,
        });
        break;

      case "project":
        await runProjectCommand(parsed, deps);
        break;

      case "task":
        await runTaskCommand(parsed, deps);
        break;

      case "workspace":
        await runWorkspaceCommand(parsed, deps);
        break;

      case "start":
        await runStartCommand(deps);
        break;

      case "install":
        await runInstallCommand();
        break;

      case "log":
        await runLogCommand(parsed, deps);
        break;

      case "help":
      case "--help":
      case "-h":
        printUsage();
        break;

      default:
        console.error(`Unknown command: ${parsed.command}`);
        printUsage();
        process.exit(1);
    }

    // Log command end (except for log command and dashboard which runs indefinitely)
    if (parsed.command !== "log" && parsed.command !== "dashboard") {
      log.info("Command end", {
        command: parsed.command,
        subcommand: parsed.subcommand,
        durationMs: Date.now() - startTime,
        exitCode: 0,
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    log.error("Command failed", {
      command: parsed.command,
      subcommand: parsed.subcommand,
      error: errorMsg,
      durationMs: Date.now() - startTime,
    });

    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("An unexpected error occurred");
    }
    process.exit(1);
  }
}

main();
