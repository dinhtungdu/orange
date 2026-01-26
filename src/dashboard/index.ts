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
  error: string | null;
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
    error: null,
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
      this.state.error = null;

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

    this.tui?.requestRender();
  }

  private async captureOutputs(): Promise<void> {
    for (const task of this.state.tasks) {
      if (task.tmux_session && task.status === "working") {
        // Use safe capture to handle case where session may have disappeared
        const output = await this.deps.tmux.capturePaneSafe(task.tmux_session, 5);
        if (output !== null) {
          const lastLine = output.trim().split("\n").pop() ?? "";
          this.state.lastOutput.set(task.id, lastLine);
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
          this.tui?.requestRender();
        }
        break;

      case "k":
      case "\x1b[A": // Up arrow
        if (this.state.cursor > 0) {
          this.state.cursor--;
          this.tui?.requestRender();
        }
        break;

      case "\r": // Enter
        this.attachToTask();
        break;

      case "p":
        this.peekTask();
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
      this.tui?.requestRender();
      return;
    }

    // Check if session still exists
    const sessionExists = await this.deps.tmux.sessionExists(task.tmux_session);
    if (!sessionExists) {
      this.state.error = `Session no longer exists. Press 'l' to view output log.`;
      this.tui?.requestRender();
      return;
    }

    // Exit TUI and attach to tmux session
    this.tui?.stop();
    const proc = Bun.spawn(["tmux", "attach", "-t", task.tmux_session], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.exited.then((exitCode) => {
      // Re-enter TUI after detaching
      if (exitCode !== 0) {
        this.state.error = `Failed to attach to session (exit code: ${exitCode})`;
      }
      this.tui?.start();
    });
  }

  private peekTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task?.tmux_session) return;

    // Fire async peek using safe capture
    this.deps.tmux.capturePaneSafe(task.tmux_session, 50)
      .then((output) => {
        if (output === null) {
          this.state.error = `Session '${task.tmux_session}' no longer exists`;
          this.tui?.requestRender();
          return;
        }
        // Show in a temporary view
        console.clear();
        console.log(chalk.bold(`Task: ${task.project}/${task.branch}`));
        console.log(chalk.dim("─".repeat(60)));
        console.log(output);
        console.log(chalk.dim("─".repeat(60)));
        console.log(chalk.gray("Press any key to return..."));
      });
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

    this.state.pendingOps.add(task.id);

    // Fire async merge
    const proc = Bun.spawn(this.getOrangeCommand(["task", "merge", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.state.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = `Merge failed: ${stderr.trim() || "Unknown error"}`;
      }
      await this.refreshTasks();
      this.tui?.requestRender();
    });
  }

  private cancelTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task || this.state.pendingOps.has(task.id)) return;

    this.state.pendingOps.add(task.id);

    // Fire async cancel
    const proc = Bun.spawn(this.getOrangeCommand(["task", "cancel", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.state.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = `Cancel failed: ${stderr.trim() || "Unknown error"}`;
      }
      await this.refreshTasks();
      this.tui?.requestRender();
    });
  }

  private deleteTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task || this.state.pendingOps.has(task.id)) return;

    // Only allow deleting done/failed tasks
    if (task.status !== "done" && task.status !== "failed") {
      this.state.error = `Cannot delete task with status '${task.status}'. Use cancel first.`;
      this.tui?.requestRender();
      return;
    }

    this.state.pendingOps.add(task.id);

    // Fire async delete
    const proc = Bun.spawn(this.getOrangeCommand(["task", "delete", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.state.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.state.error = `Delete failed: ${stderr.trim() || "Unknown error"}`;
      }
      await this.refreshTasks();
      this.tui?.requestRender();
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

  private openPR(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task) return;

    // Open GitHub PR page (assumes gh CLI is available)
    Bun.spawn(["gh", "pr", "view", "--web", "-H", task.branch], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  render(width: number): string[] {
    this.state.width = width;
    const lines: string[] = [];

    // Header with project and filter indicator
    const statusLabel = this.state.statusFilter === "all"
      ? ""
      : ` [${this.state.statusFilter}]`;
    const header = this.state.projectLabel === "all"
      ? `Orange Dashboard (all)${statusLabel}`
      : `${this.state.projectLabel}${statusLabel}`;
    lines.push(chalk.bold.cyan(` ${header}`));
    lines.push(chalk.dim("─".repeat(width)));

    // Error message
    if (this.state.error) {
      lines.push(chalk.red(` Error: ${this.state.error}`));
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

        const icon = STATUS_ICON[task.status];
        const color = STATUS_COLOR[task.status];
        const lastOutput = this.state.lastOutput.get(task.id) ?? "";

        let line = ` ${icon} ${task.project}/${task.branch}`;
        line = color(line);

        if (pending) {
          line += chalk.yellow(" [processing...]");
        }

        if (selected) {
          line = chalk.inverse(line);
        }

        lines.push(line);

        // Show description and last output for selected task
        if (selected) {
          const desc = task.description.length > width - 3
            ? task.description.slice(0, width - 4) + "…"
            : task.description;
          lines.push(chalk.gray(`   ${desc}`));
          if (lastOutput) {
            lines.push(chalk.dim(`   > ${lastOutput.slice(0, width - 6)}`));
          }
        }
      }
    }

    // Footer with keybindings
    lines.push("");
    lines.push(chalk.dim("─".repeat(width)));
    const keys = " j/k:nav  Enter:attach  p:peek  l:log  m:merge  x:cancel  d:del  f:filter  q:quit";
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

  await dashboard.init(tui, options);
  tui.start();
}
