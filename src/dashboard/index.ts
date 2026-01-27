/**
 * Dashboard TUI for Orange agent orchestration.
 *
 * Built with pi-tui, provides:
 * - Task list with status indicators
 * - Keyboard navigation
 * - Real-time status updates via file watching
 *
 * Scoping:
 * - In a project directory: shows only that project's tasks
 * - With --all flag: shows all tasks
 * - With --project flag: shows specific project's tasks
 */

import { TUI, ProcessTerminal, type Component } from "@mariozechner/pi-tui";
import { watch } from "chokidar";
import { join } from "node:path";
import chalk from "chalk";
import type { Deps, Task, TaskStatus } from "../core/types.js";
import { listTasks } from "../core/db.js";
import { detectProject } from "../core/cwd.js";

/**
 * Clean up nested error messages for display.
 * "Error: Merge failed: Error: git checkout 'x' failed: error: pathspec..."
 * → "git checkout 'x' failed: pathspec..."
 */
function cleanErrorMessage(raw: string): string {
  // Strip "Error: " prefixes and collapse nested errors
  let msg = raw.trim();

  // Remove leading "Error: " repeatedly
  while (msg.toLowerCase().startsWith("error: ")) {
    msg = msg.slice(7);
  }

  // Find the last "Error: " and take everything after it (the root cause)
  const lastErrorIdx = msg.toLowerCase().lastIndexOf("error: ");
  if (lastErrorIdx > 0) {
    msg = msg.slice(lastErrorIdx + 7);
  }

  // Capitalize first letter
  if (msg.length > 0) {
    msg = msg.charAt(0).toUpperCase() + msg.slice(1);
  }

  return msg;
}

/**
 * Status indicator icons.
 */
const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "○",
  working: "●",
  needs_human: "◉",
  stuck: "⚠",
  done: "✓",
  failed: "✗",
};

/**
 * Status colors.
 */
const STATUS_COLOR: Record<TaskStatus, (s: string) => string> = {
  pending: chalk.gray,
  working: chalk.blue,
  needs_human: chalk.yellow,
  stuck: chalk.red,
  done: chalk.green,
  failed: chalk.red,
};

/**
 * Status filter type for dashboard.
 * - all: Show all tasks
 * - active: Show pending, working, needs_human, stuck tasks
 * - done: Show done and failed tasks
 */
type StatusFilter = "all" | "active" | "done";

/**
 * Active statuses for filtering.
 */
const ACTIVE_STATUSES: TaskStatus[] = ["pending", "working", "needs_human", "stuck"];

/**
 * Done statuses for filtering.
 */
const DONE_STATUSES: TaskStatus[] = ["done", "failed"];

/**
 * Dashboard options.
 */
export interface DashboardOptions {
  /** Show all projects (global view) */
  all?: boolean;
  /** Show specific project's tasks */
  project?: string;
}

/**
 * Dashboard state.
 */
interface DashboardState {
  tasks: Task[];
  allTasks: Task[];  // Unfiltered by status
  cursor: number;
  lastOutput: Map<string, string>;
  pendingOps: Set<string>;
  deadSessions: Set<string>;  // Task IDs with dead tmux sessions
  error: string | null;
  message: string | null;  // Success message (auto-clears on next poll)
  width: number;
  statusFilter: StatusFilter;
  projectFilter: string | null;  // null = global view
  projectLabel: string;  // Display label for header
}

/**
 * Dashboard component.
 * Exported for testing.
 */
export class DashboardComponent implements Component {
  private state: DashboardState = {
    tasks: [],
    allTasks: [],
    cursor: 0,
    lastOutput: new Map(),
    pendingOps: new Set(),
    deadSessions: new Set(),
    error: null,
    message: null,
    width: 80,
    statusFilter: "all",
    projectFilter: null,
    projectLabel: "all",
  };

  private deps: Deps;
  private tui: TUI | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private captureInterval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: Deps, options: DashboardOptions = {}) {
    this.deps = deps;

    // Set project filter based on options
    if (options.project) {
      this.state.projectFilter = options.project;
      this.state.projectLabel = options.project;
    } else if (!options.all) {
      // Will be set in init() based on cwd detection
      this.state.projectFilter = null;
      this.state.projectLabel = "all";
    }
  }

  async init(tui: TUI, options: DashboardOptions = {}): Promise<void> {
    this.tui = tui;

    // If no explicit project/all option, detect from cwd
    if (!options.project && !options.all) {
      const detection = await detectProject(this.deps);
      if (detection.project) {
        this.state.projectFilter = detection.project.name;
        this.state.projectLabel = detection.project.name;
      }
    }

    // Load initial tasks
    await this.refreshTasks();

    // Check for dead sessions immediately (don't wait for first interval)
    await this.captureOutputs();

    // Watch task folders for changes with efficient patterns:
    // - Only watch TASK.md files (source of truth for task state)
    // - Debounce rapid changes to avoid unnecessary rebuilds
    const tasksDir = join(this.deps.dataDir, "tasks");
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    this.watcher = watch(tasksDir, {
      ignoreInitial: true,
      depth: 3,
      // Only watch TASK.md files - ignore history.jsonl and other files
      ignored: (path: string) => {
        // Allow directories
        if (!path.includes(".")) return false;
        // Only allow TASK.md files
        return !path.endsWith("TASK.md");
      },
    });

    this.watcher.on("all", (_event, path) => {
      // Debounce: wait 100ms after last change before refreshing
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        // Clear transient messages/errors on refresh
        this.state.message = null;
        this.state.error = null;
        this.refreshTasks().then(() => tui.requestRender());
        debounceTimer = null;
      }, 100);
    });

    // Periodically capture tmux output
    this.captureInterval = setInterval(() => {
      this.captureOutputs().then(() => tui.requestRender());
    }, 5000);
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
    }
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
    }
  }

  /**
   * Load tasks without starting watchers. For testing.
   */
  async loadTasks(): Promise<void> {
    await this.refreshTasks();
  }

  /**
   * Get current cursor position. For testing.
   */
  getCursor(): number {
    return this.state.cursor;
  }

  /**
   * Get current status filter. For testing.
   */
  getStatusFilter(): StatusFilter {
    return this.state.statusFilter;
  }

  private async refreshTasks(): Promise<void> {
    try {
      this.state.allTasks = await listTasks(this.deps, {
        project: this.state.projectFilter ?? undefined,
      });
      this.applyStatusFilter();

      // Clamp cursor
      if (this.state.cursor >= this.state.tasks.length) {
        this.state.cursor = Math.max(0, this.state.tasks.length - 1);
      }
    } catch (err) {
      this.state.error =
        err instanceof Error ? err.message : "Failed to load tasks";
    }
  }

  private applyStatusFilter(): void {
    switch (this.state.statusFilter) {
      case "active":
        this.state.tasks = this.state.allTasks.filter((t) =>
          ACTIVE_STATUSES.includes(t.status)
        );
        break;
      case "done":
        this.state.tasks = this.state.allTasks.filter((t) =>
          DONE_STATUSES.includes(t.status)
        );
        break;
      default:
        this.state.tasks = [...this.state.allTasks];
    }
  }

  private cycleStatusFilter(): void {
    const filters: StatusFilter[] = ["all", "active", "done"];
    const currentIndex = filters.indexOf(this.state.statusFilter);
    this.state.statusFilter = filters[(currentIndex + 1) % filters.length];
    this.applyStatusFilter();

    // Clamp cursor after filter change
    if (this.state.cursor >= this.state.tasks.length) {
      this.state.cursor = Math.max(0, this.state.tasks.length - 1);
    }

    this.tui?.requestRender(true);
  }

  private async captureOutputs(): Promise<void> {
    const activeStatuses: TaskStatus[] = ["working", "needs_human", "stuck"];
    for (const task of this.state.tasks) {
      if (task.tmux_session && activeStatuses.includes(task.status)) {
        // Check if session still exists
        const exists = await this.deps.tmux.sessionExists(task.tmux_session);
        if (!exists) {
          this.state.deadSessions.add(task.id);
        } else {
          this.state.deadSessions.delete(task.id);
          // Capture output for working tasks
          if (task.status === "working") {
            const output = await this.deps.tmux.capturePaneSafe(task.tmux_session, 5);
            if (output !== null) {
              const lastLine = output.trim().split("\n").pop() ?? "";
              this.state.lastOutput.set(task.id, lastLine);
            }
          }
        }
      }
    }
  }

  handleInput(data: string): void {
    switch (data) {
      case "j":
      case "\x1b[B": // Down arrow
        if (this.state.cursor < this.state.tasks.length - 1) {
          this.state.cursor++;
          this.tui?.requestRender(true);
        }
        break;

      case "k":
      case "\x1b[A": // Up arrow
        if (this.state.cursor > 0) {
          this.state.cursor--;
          this.tui?.requestRender(true);
        }
        break;

      case "\r": // Enter
        this.attachToTask();
        break;

      case "m":
        this.mergeTask();
        break;

      case "x":
        this.cancelTask();
        break;

      case "d":
        this.deleteTask();
        break;

      case "l":
        this.viewLog();
        break;

      case "r":
        this.respawnTask();
        break;

      case "o":
        this.openPR();
        break;

      case "f":
        this.cycleStatusFilter();
        break;

      case "q":
        this.tui?.stop();
        this.dispose().then(() => process.exit(0));
        break;
    }
  }

  invalidate(): void {
    // Nothing cached to invalidate
  }

  private async attachToTask(): Promise<void> {
    const task = this.state.tasks[this.state.cursor];
    if (!task?.tmux_session) return;

    // Check if tmux is available before attempting attach
    const tmuxAvailable = await this.deps.tmux.isAvailable();
    if (!tmuxAvailable) {
      this.state.error = "tmux is not installed or not in PATH";
      this.tui?.requestRender(true);
      return;
    }

    // Check if session still exists
    const sessionExists = await this.deps.tmux.sessionExists(task.tmux_session);
    if (!sessionExists) {
      this.state.error = `Session no longer exists. Press 'l' to view output log.`;
      this.tui?.requestRender(true);
      return;
    }

    // Use switch-client if inside tmux, attach if outside
    const insideTmux = !!process.env.TMUX;

    if (insideTmux) {
      // Switch to task session - dashboard keeps running in background
      const proc = Bun.spawn(["tmux", "switch-client", "-t", task.tmux_session], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = stderr.trim() || `switch-client failed (exit code: ${exitCode})`;
        this.tui?.requestRender(true);
      }
      // Dashboard stays running - user sees it when they switch back
    } else {
      // Attach to session, restart TUI after detach
      this.tui?.stop();
      const proc = Bun.spawn(["tmux", "attach", "-t", task.tmux_session], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "pipe",
      });
      proc.exited.then(async (exitCode) => {
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          this.state.error = stderr.trim() || `Failed to attach (exit code: ${exitCode})`;
        }
        this.tui?.start();
        this.tui?.requestRender(true); // Force full redraw
      });
    }
  }

  /**
   * Get the command to run orange CLI.
   * Works with both `bun run src/index.ts` and compiled binary.
   */
  private getOrangeCommand(args: string[]): string[] {
    const scriptPath = process.argv[1];
    if (scriptPath.endsWith('.ts')) {
      return ["bun", "run", scriptPath, ...args];
    }
    return [scriptPath, ...args];
  }

  private mergeTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task || this.state.pendingOps.has(task.id)) return;

    const taskBranch = task.branch;
    this.state.pendingOps.add(task.id);
    this.tui?.requestRender(true);

    // Fire async merge
    const proc = Bun.spawn(this.getOrangeCommand(["task", "merge", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.state.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = `Merge failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.state.message = `Merged ${taskBranch}`;
      }
      await this.refreshTasks();
      this.tui?.requestRender(true);
    });
  }

  private cancelTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task || this.state.pendingOps.has(task.id)) return;

    const taskBranch = task.branch;
    this.state.pendingOps.add(task.id);
    this.tui?.requestRender(true);

    // Fire async cancel
    const proc = Bun.spawn(this.getOrangeCommand(["task", "cancel", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.state.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = `Cancel failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.state.message = `Cancelled ${taskBranch}`;
      }
      await this.refreshTasks();
      this.tui?.requestRender(true);
    });
  }

  private deleteTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task || this.state.pendingOps.has(task.id)) return;

    // Only allow deleting done/failed tasks
    if (task.status !== "done" && task.status !== "failed") {
      this.state.error = `Cannot delete task with status '${task.status}'. Use cancel first.`;
      this.tui?.requestRender(true);
      return;
    }

    const taskBranch = task.branch;
    this.state.pendingOps.add(task.id);
    this.tui?.requestRender(true);

    // Fire async delete
    const proc = Bun.spawn(this.getOrangeCommand(["task", "delete", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.state.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = `Delete failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.state.message = `Deleted ${taskBranch}`;
      }
      await this.refreshTasks();
      this.tui?.requestRender(true);
    });
  }

  private viewLog(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task) return;

    // Allow viewing log for any task that has an output.log file
    // This handles the case where a "working" task's session died but log exists

    // Exit TUI and show log using less
    this.tui?.stop();
    const proc = Bun.spawn(this.getOrangeCommand(["task", "log", task.id]), {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    proc.exited.then(async () => {
      // Restart TUI after viewing
      if (this.tui) {
        await this.init(this.tui, { project: this.state.projectFilter ?? undefined });
        this.tui.start();
      }
    });
  }

  private respawnTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task || this.state.pendingOps.has(task.id)) return;

    // Only allow respawn for dead sessions
    if (!this.state.deadSessions.has(task.id)) {
      this.state.error = "Task session is still active. Use 'x' to cancel first.";
      this.tui?.requestRender(true);
      return;
    }

    const taskBranch = task.branch;
    this.state.pendingOps.add(task.id);
    this.tui?.requestRender(true);

    // Fire async respawn
    const proc = Bun.spawn(this.getOrangeCommand(["task", "respawn", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.state.pendingOps.delete(task.id);
      this.state.deadSessions.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = `Respawn failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.state.message = `Respawned ${taskBranch}`;
      }
      await this.refreshTasks();
      this.tui?.requestRender(true);
    });
  }

  private openPR(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task) return;

    // Open GitHub PR page (assumes gh CLI is available)
    Bun.spawn(["gh", "pr", "view", "--web", "-H", task.branch], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /**
   * Get context-aware keybindings based on selected task
   */
  private getContextKeys(): string {
    const task = this.state.tasks[this.state.cursor];
    if (!task) {
      return " j/k:nav  f:filter  q:quit";
    }

    const isDead = this.state.deadSessions.has(task.id);
    const activeStatuses: TaskStatus[] = ["working", "needs_human", "stuck"];
    const completedStatuses: TaskStatus[] = ["done", "failed"];

    let keys = " j/k:nav";

    if (activeStatuses.includes(task.status)) {
      if (isDead) {
        // Dead session: can view log, respawn, or cancel
        keys += "  l:log  r:respawn  x:cancel";
      } else {
        // Live session: can attach, merge, or cancel
        keys += "  Enter:attach  m:merge  x:cancel";
      }
    } else if (completedStatuses.includes(task.status)) {
      // Completed: can view log or delete
      keys += "  l:log  d:del";
    } else if (task.status === "pending") {
      // Pending: no actions in dashboard (spawn via CLI)
      keys += "  (spawn via CLI)";
    }

    keys += "  f:filter  q:quit";
    return keys;
  }

  /**
   * Format relative time (e.g., "2m ago", "3h ago")
   */
  private formatRelativeTime(isoDate: string): string {
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    return `${diffDay}d ago`;
  }

  /**
   * Pad or truncate string to exact width
   */
  private fitWidth(str: string, w: number, align: "left" | "right" = "left"): string {
    // Strip ANSI codes for length calculation
    const plainLen = str.replace(/\x1b\[[0-9;]*m/g, "").length;
    if (plainLen > w) {
      // Truncate (need to be careful with ANSI codes)
      let visible = 0;
      let result = "";
      let i = 0;
      while (i < str.length && visible < w - 1) {
        if (str[i] === "\x1b") {
          // ANSI escape - copy until 'm'
          const end = str.indexOf("m", i);
          if (end !== -1) {
            result += str.slice(i, end + 1);
            i = end + 1;
            continue;
          }
        }
        result += str[i];
        visible++;
        i++;
      }
      return result + "…";
    }
    const padding = " ".repeat(w - plainLen);
    return align === "right" ? padding + str : str + padding;
  }

  render(width: number): string[] {
    this.state.width = width;
    const lines: string[] = [];

    // Column widths (adjust based on terminal width)
    const colActivity = 9;  // "12h ago" + padding
    const colStatus = 12;   // "needs_human" is longest
    const colTask = Math.max(20, width - colStatus - colActivity - 4); // rest for task

    // Header with project and filter indicator
    const statusLabel = this.state.statusFilter === "all"
      ? ""
      : ` [${this.state.statusFilter}]`;
    const header = this.state.projectLabel === "all"
      ? `Orange Dashboard (all)${statusLabel}`
      : `${this.state.projectLabel}${statusLabel}`;
    lines.push(chalk.bold.cyan(` ${header}`));
    
    // Column headers
    const headerLine = " " + 
      this.fitWidth(chalk.dim("Task"), colTask) +
      this.fitWidth(chalk.dim("Status"), colStatus) +
      this.fitWidth(chalk.dim("Activity"), colActivity, "right");
    lines.push(headerLine);
    lines.push(chalk.dim("─".repeat(width)));

    // Error message
    if (this.state.error) {
      lines.push(chalk.red(` Error: ${this.state.error}`));
      lines.push("");
    }

    // Success message
    if (this.state.message) {
      lines.push(chalk.green(` ✓ ${this.state.message}`));
      lines.push("");
    }

    // Task list
    if (this.state.tasks.length === 0) {
      const projectMsg = this.state.projectFilter
        ? ` for project '${this.state.projectFilter}'`
        : "";
      lines.push(
        chalk.gray(` No tasks${projectMsg}. Use 'orange task create' to add one.`)
      );
    } else {
      for (let i = 0; i < this.state.tasks.length; i++) {
        const task = this.state.tasks[i];
        const selected = i === this.state.cursor;
        const pending = this.state.pendingOps.has(task.id);
        const isDead = this.state.deadSessions.has(task.id);

        // If session is dead, show as failed
        const displayStatus = isDead ? "failed" as TaskStatus : task.status;
        const icon = STATUS_ICON[displayStatus];
        const color = isDead ? STATUS_COLOR.failed : STATUS_COLOR[task.status];
        const activity = this.formatRelativeTime(task.updated_at);

        // Task column: icon + branch (or project/branch if showing all)
        const taskName = this.state.projectFilter 
          ? task.branch 
          : `${task.project}/${task.branch}`;
        const taskCol = `${icon} ${taskName}`;
        
        // Status column - show "dead" if session died unexpectedly
        let statusCol: string = isDead ? "dead" : task.status;
        if (pending) {
          statusCol = "processing…";
        }

        // Build the row
        let row = " " +
          this.fitWidth(color(taskCol), colTask) +
          this.fitWidth(color(statusCol), colStatus) +
          this.fitWidth(chalk.dim(activity), colActivity, "right");

        if (selected) {
          row = chalk.inverse(row);
        }

        lines.push(row);

        // Show description for selected task
        if (selected) {
          const descMaxLen = width - 4;
          const desc = task.description.length > descMaxLen
            ? task.description.slice(0, descMaxLen - 1) + "…"
            : task.description;
          lines.push(chalk.gray(` └ ${desc}`));
        }
      }
    }

    // Footer with context-aware keybindings
    lines.push("");
    lines.push(chalk.dim("─".repeat(width)));
    const keys = this.getContextKeys();
    lines.push(chalk.gray(keys.length > width ? keys.slice(0, width - 1) + "…" : keys));

    return lines;
  }
}

/**
 * Run the dashboard.
 */
export async function runDashboard(deps: Deps, options: DashboardOptions = {}): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const dashboard = new DashboardComponent(deps, options);

  tui.addChild(dashboard);
  tui.setFocus(dashboard);

  // Enter alternate screen buffer (like vim/less) and clear
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");

  // Restore main screen on exit
  const cleanup = () => {
    process.stdout.write("\x1b[?1049l");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  await dashboard.init(tui, options);
  tui.start();
}
