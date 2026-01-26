/**
 * Dashboard TUI for Orange agent orchestration.
 *
 * Built with pi-tui, provides:
 * - Task list with status indicators
 * - Keyboard navigation
 * - Real-time status updates via file watching
 */

import { TUI, ProcessTerminal, type Component } from "@mariozechner/pi-tui";
import { watch } from "chokidar";
import { join } from "node:path";
import chalk from "chalk";
import type { Deps, Task, TaskStatus } from "../core/types.js";
import { listTasks } from "../core/db.js";

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
 * Dashboard state.
 */
interface DashboardState {
  tasks: Task[];
  cursor: number;
  lastOutput: Map<string, string>;
  pendingOps: Set<string>;
  error: string | null;
  width: number;
}

/**
 * Dashboard component.
 */
class DashboardComponent implements Component {
  private state: DashboardState = {
    tasks: [],
    cursor: 0,
    lastOutput: new Map(),
    pendingOps: new Set(),
    error: null,
    width: 80,
  };

  private deps: Deps;
  private tui: TUI | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private captureInterval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  async init(tui: TUI): Promise<void> {
    this.tui = tui;

    // Load initial tasks
    await this.refreshTasks();

    // Watch task folders for changes
    const tasksDir = join(this.deps.dataDir, "tasks");
    this.watcher = watch(tasksDir, {
      ignoreInitial: true,
      depth: 2,
    });

    this.watcher.on("all", () => {
      this.refreshTasks().then(() => tui.requestRender());
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

  private async refreshTasks(): Promise<void> {
    try {
      this.state.tasks = await listTasks(this.deps, {});
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

  private async captureOutputs(): Promise<void> {
    for (const task of this.state.tasks) {
      if (task.tmux_session && task.status === "working") {
        try {
          const output = await this.deps.tmux.capturePane(task.tmux_session, 5);
          const lastLine = output.trim().split("\n").pop() ?? "";
          this.state.lastOutput.set(task.id, lastLine);
        } catch {
          // Session might not exist anymore
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

      case "o":
        this.openPR();
        break;

      case "q":
        this.dispose().then(() => process.exit(0));
        break;
    }
  }

  invalidate(): void {
    // Nothing cached to invalidate
  }

  private attachToTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task?.tmux_session) return;

    // Exit TUI and attach to tmux session
    this.tui?.stop();
    const proc = Bun.spawn(["tmux", "attach", "-t", task.tmux_session], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    proc.exited.then(() => {
      // Re-enter TUI after detaching
      this.tui?.start();
    });
  }

  private peekTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task?.tmux_session) return;

    // Fire async peek
    this.deps.tmux.capturePane(task.tmux_session, 50)
      .then((output) => {
        // Show in a temporary view
        console.clear();
        console.log(chalk.bold(`Task: ${task.project}/${task.branch}`));
        console.log(chalk.dim("─".repeat(60)));
        console.log(output);
        console.log(chalk.dim("─".repeat(60)));
        console.log(chalk.gray("Press any key to return..."));
      })
      .catch((err) => {
        this.state.error = `Failed to peek: ${err.message}`;
        this.tui?.requestRender();
      });
  }

  private mergeTask(): void {
    const task = this.state.tasks[this.state.cursor];
    if (!task || this.state.pendingOps.has(task.id)) return;

    this.state.pendingOps.add(task.id);

    // Fire async merge
    const proc = Bun.spawn(["orange", "task", "merge", task.id], {
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
    const proc = Bun.spawn(["orange", "task", "cancel", task.id], {
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

    // Header
    lines.push(chalk.bold.cyan(" Orange Dashboard"));
    lines.push(chalk.dim("─".repeat(width)));

    // Error message
    if (this.state.error) {
      lines.push(chalk.red(` Error: ${this.state.error}`));
      lines.push("");
    }

    // Task list
    if (this.state.tasks.length === 0) {
      lines.push(
        chalk.gray(" No tasks. Use 'orange task create' to add one.")
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
          lines.push(chalk.gray(`   ${task.description}`));
          if (lastOutput) {
            lines.push(chalk.dim(`   > ${lastOutput.slice(0, width - 6)}`));
          }
        }
      }
    }

    // Footer with keybindings
    lines.push("");
    lines.push(chalk.dim("─".repeat(width)));
    lines.push(
      chalk.gray(
        " j/k:navigate  Enter:attach  p:peek  m:merge  x:cancel  o:PR  q:quit"
      )
    );

    return lines;
  }
}

/**
 * Run the dashboard.
 */
export async function runDashboard(deps: Deps): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const dashboard = new DashboardComponent(deps);

  tui.addChild(dashboard);
  tui.setFocus(dashboard);

  await dashboard.init(tui);
  tui.start();
}
