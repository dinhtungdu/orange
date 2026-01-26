/**
 * Log viewing command.
 *
 * Provides easy access to Orange log files with filtering options.
 *
 * Commands:
 * - orange log                    # tail -f the log
 * - orange log --level error      # filter by level
 * - orange log --component spawn  # filter by component
 * - orange log --lines 100        # show last N lines
 * - orange log --grep "pattern"   # search for pattern
 */

import { join } from "node:path";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ParsedArgs } from "../args.js";
import type { Deps } from "../../core/types.js";
import type { LogLevel, LogEntry } from "../../core/logger.js";
import chalk from "chalk";

/**
 * Color for each log level.
 */
const LEVEL_COLOR: Record<LogLevel, (s: string) => string> = {
  error: chalk.red,
  warn: chalk.yellow,
  info: chalk.white,
  debug: chalk.gray,
};

/**
 * Priority for filtering.
 */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Format a log entry for display.
 */
function formatEntry(entry: LogEntry): string {
  const time = entry.ts.split("T")[1]?.slice(0, 12) ?? entry.ts;
  const level = entry.level.toUpperCase().padEnd(5);
  const color = LEVEL_COLOR[entry.level] ?? chalk.white;

  // Extract known fields, put rest in context
  const { ts, level: _l, component, msg, ...context } = entry;
  const contextStr = Object.keys(context).length > 0
    ? " " + Object.entries(context)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
    : "";

  return `${chalk.dim(time)} ${color(level)} ${chalk.cyan(`[${component}]`)} ${msg}${chalk.dim(contextStr)}`;
}

/**
 * Parse a JSON line into a LogEntry, returning null if invalid.
 */
function parseLine(line: string): LogEntry | null {
  try {
    return JSON.parse(line) as LogEntry;
  } catch {
    return null;
  }
}

/**
 * Check if an entry passes the filters.
 */
function passesFilters(
  entry: LogEntry,
  options: {
    level?: LogLevel;
    component?: string;
    grep?: string;
  }
): boolean {
  // Level filter: show entries at or above the specified level
  if (options.level) {
    const entryPriority = LEVEL_PRIORITY[entry.level] ?? 3;
    const filterPriority = LEVEL_PRIORITY[options.level] ?? 2;
    if (entryPriority > filterPriority) {
      return false;
    }
  }

  // Component filter
  if (options.component && entry.component !== options.component) {
    return false;
  }

  // Grep filter (searches the entire JSON line)
  if (options.grep) {
    const line = JSON.stringify(entry);
    if (!line.toLowerCase().includes(options.grep.toLowerCase())) {
      return false;
    }
  }

  return true;
}

/**
 * Read last N lines from a file.
 */
async function readLastLines(filePath: string, n: number): Promise<string[]> {
  const lines: string[] = [];

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lines.push(line);
    if (lines.length > n) {
      lines.shift();
    }
  }

  return lines;
}

/**
 * Tail a file (follow mode).
 */
async function tailFile(
  filePath: string,
  options: {
    level?: LogLevel;
    component?: string;
    grep?: string;
  }
): Promise<void> {
  // First show last 20 lines
  if (existsSync(filePath)) {
    const lastLines = await readLastLines(filePath, 20);
    for (const line of lastLines) {
      const entry = parseLine(line);
      if (entry && passesFilters(entry, options)) {
        console.log(formatEntry(entry));
      }
    }
  }

  console.log(chalk.dim("--- Following log (Ctrl+C to exit) ---"));

  // Use tail -f for following
  const proc = Bun.spawn(["tail", "-f", filePath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = parseLine(line);
      if (entry && passesFilters(entry, options)) {
        console.log(formatEntry(entry));
      }
    }
  }
}

/**
 * Run the log command.
 */
export async function runLogCommand(parsed: ParsedArgs, deps: Deps): Promise<void> {
  const logPath = join(deps.dataDir, "orange.log");

  if (!existsSync(logPath)) {
    console.log(chalk.yellow("No log file found. Run some commands first."));
    console.log(chalk.dim(`Expected location: ${logPath}`));
    return;
  }

  const level = parsed.options.level as LogLevel | undefined;
  const component = parsed.options.component as string | undefined;
  const grep = parsed.options.grep as string | undefined;
  const lines = parseInt(parsed.options.lines as string) || 0;
  const follow = !lines; // If no --lines, follow mode

  const filterOptions = { level, component, grep };

  if (follow) {
    // Follow mode (tail -f)
    await tailFile(logPath, filterOptions);
  } else {
    // Show last N lines
    const lastLines = await readLastLines(logPath, lines);
    for (const line of lastLines) {
      const entry = parseLine(line);
      if (entry && passesFilters(entry, filterOptions)) {
        console.log(formatEntry(entry));
      }
    }
  }
}
