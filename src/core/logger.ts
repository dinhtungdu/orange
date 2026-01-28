/**
 * Structured logging for Orange.
 *
 * Provides file-based logging separate from console output.
 * Supports log levels, components, and structured context.
 *
 * Log location: ~/orange/orange.log
 * Format: JSON Lines (one JSON object per line)
 */

import { appendFileSync, existsSync, renameSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Logger } from "./types.js";

/**
 * Log levels in order of severity.
 */
export type LogLevel = "error" | "warn" | "info" | "debug";

/**
 * Log entry structure written to file.
 */
export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  [key: string]: unknown;
}

/**
 * Logger configuration.
 */
export interface LoggerConfig {
  /** Data directory (log file will be at dataDir/orange.log) */
  dataDir: string;
  /** Minimum log level (default: info, overridden by ORANGE_LOG_LEVEL) */
  level?: LogLevel;
  /** Max file size in bytes before rotation (default: 10MB) */
  maxSize?: number;
  /** Number of rotated files to keep (default: 3) */
  maxFiles?: number;
}

/**
 * Priority order for log levels (lower = more severe).
 */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Parse log level from string, with fallback.
 */
function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (!value) return fallback;
  const lower = value.toLowerCase();
  if (lower in LEVEL_PRIORITY) {
    return lower as LogLevel;
  }
  return fallback;
}

/**
 * File-based logger implementation.
 *
 * Features:
 * - Writes JSON Lines to ~/orange/orange.log
 * - Auto-rotates when file exceeds maxSize
 * - Respects ORANGE_LOG_LEVEL environment variable
 * - Creates child loggers with component prefix
 */
export class FileLogger implements Logger {
  private logPath: string;
  private level: LogLevel;
  private maxSize: number;
  private maxFiles: number;
  private component: string;

  constructor(config: LoggerConfig, component = "root") {
    this.logPath = join(config.dataDir, "orange.log");
    this.level = parseLogLevel(process.env.ORANGE_LOG_LEVEL, config.level ?? "info");
    this.maxSize = config.maxSize ?? 10 * 1024 * 1024; // 10MB
    this.maxFiles = config.maxFiles ?? 3;
    this.component = component;

    // Ensure log directory exists
    const logDir = dirname(this.logPath);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Check if a message at the given level should be logged.
   */
  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[this.level];
  }

  /**
   * Get current file size, or 0 if file doesn't exist.
   */
  private getFileSize(): number {
    try {
      return statSync(this.logPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Rotate log files: .log → .log.1 → .log.2 → .log.3 (deleted)
   */
  private rotate(): void {
    // Delete oldest if at max
    const oldest = `${this.logPath}.${this.maxFiles}`;
    if (existsSync(oldest)) {
      try {
        Bun.spawnSync(["rm", oldest]);
      } catch {
        // Ignore deletion errors
      }
    }

    // Shift existing rotated files (.log.2 → .log.3, .log.1 → .log.2)
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = `${this.logPath}.${i}`;
      const to = `${this.logPath}.${i + 1}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          // Ignore rename errors
        }
      }
    }

    // Rotate current log (.log → .log.1)
    if (existsSync(this.logPath)) {
      try {
        renameSync(this.logPath, `${this.logPath}.1`);
      } catch {
        // Ignore rename errors
      }
    }
  }

  /**
   * Write a log entry to file.
   */
  private write(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...context,
    };

    const line = JSON.stringify(entry) + "\n";

    // Check rotation before write
    if (this.getFileSize() + line.length > this.maxSize) {
      this.rotate();
    }

    try {
      appendFileSync(this.logPath, line);
    } catch {
      // Silently ignore write errors - logging should never crash the app
    }
  }

  error(msg: string, context?: Record<string, unknown>): void {
    this.write("error", msg, context);
  }

  warn(msg: string, context?: Record<string, unknown>): void {
    this.write("warn", msg, context);
  }

  info(msg: string, context?: Record<string, unknown>): void {
    this.write("info", msg, context);
  }

  debug(msg: string, context?: Record<string, unknown>): void {
    this.write("debug", msg, context);
  }

  /**
   * Create a child logger with a different component name.
   * Shares the same configuration and log file.
   */
  child(component: string): Logger {
    const child = new FileLogger(
      {
        dataDir: dirname(this.logPath),
        level: this.level,
        maxSize: this.maxSize,
        maxFiles: this.maxFiles,
      },
      component
    );
    return child;
  }
}

/**
 * Mock logger for testing.
 *
 * Collects log entries in memory for assertions.
 * Child loggers share the same entries array.
 */
export class MockLogger implements Logger {
  entries: LogEntry[] = [];
  private component: string;

  constructor(component = "test") {
    this.component = component;
  }

  private log(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    this.entries.push({
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...context,
    });
  }

  error(msg: string, context?: Record<string, unknown>): void {
    this.log("error", msg, context);
  }

  warn(msg: string, context?: Record<string, unknown>): void {
    this.log("warn", msg, context);
  }

  info(msg: string, context?: Record<string, unknown>): void {
    this.log("info", msg, context);
  }

  debug(msg: string, context?: Record<string, unknown>): void {
    this.log("debug", msg, context);
  }

  /**
   * Create a child logger that shares the entries array.
   */
  child(component: string): Logger {
    const child = new MockLogger(component);
    child.entries = this.entries; // Share entries
    return child;
  }

  // Test helpers

  /**
   * Clear all collected entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Check if any entry matches the given level and message substring.
   */
  has(level: LogLevel, msgSubstr: string): boolean {
    return this.entries.some((e) => e.level === level && e.msg.includes(msgSubstr));
  }

  /**
   * Get all entries for a specific component.
   */
  forComponent(component: string): LogEntry[] {
    return this.entries.filter((e) => e.component === component);
  }

  /**
   * Get all entries at a specific level.
   */
  forLevel(level: LogLevel): LogEntry[] {
    return this.entries.filter((e) => e.level === level);
  }
}

/**
 * No-op logger that discards all messages.
 * Useful for tests that don't care about logging.
 */
export class NullLogger implements Logger {
  error(_msg: string, _context?: Record<string, unknown>): void {}
  warn(_msg: string, _context?: Record<string, unknown>): void {}
  info(_msg: string, _context?: Record<string, unknown>): void {}
  debug(_msg: string, _context?: Record<string, unknown>): void {}
  child(_component: string): Logger {
    return this;
  }
}

/**
 * Create a file logger for production use.
 */
export function createLogger(config: LoggerConfig): Logger {
  return new FileLogger(config);
}
