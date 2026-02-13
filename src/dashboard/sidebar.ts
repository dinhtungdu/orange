/**
 * Sidebar component for workspace view.
 *
 * Read-only context HUD with sections:
 * - Header: task name, status, session, harness, PR info, commit stats
 * - Files: changed files vs default branch
 * - History: recent events from history.jsonl
 * - Task: first lines of TASK.md body
 *
 * Data pipeline: file watcher (chokidar, 100ms debounce) + polling.
 */

import { watch, type FSWatcher } from "chokidar";
import { join } from "node:path";
import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { Deps, Task, HistoryEvent, PRStatus } from "../core/types.js";
import { loadTask, loadHistory } from "../core/state.js";
import { getWorkspacePath } from "../core/workspace.js";
import { STATUS_COLOR, SESSION_ICON, SESSION_COLOR, type SessionState } from "./state.js";

// Polling intervals per workspace.md spec
const SESSION_POLL_INTERVAL = 10_000;  // 10s
const PR_POLL_INTERVAL = 30_000;       // 30s
const GIT_POLL_INTERVAL = 10_000;      // 10s
const PR_BACKOFF_INTERVAL = 60_000;    // 60s on failure

export interface SidebarOptions {
  deps: Deps;
  project: string;
  taskId: string;
  defaultBranch: string;
}

export interface SidebarData {
  task: Task | null;
  sessionAlive: boolean;
  prStatus: PRStatus | null;
  commits: number;
  diffAdded: number;
  diffRemoved: number;
  changedFiles: string[];
  historyEvents: HistoryEvent[];
}

/**
 * Sidebar component — read-only context HUD.
 */
export class Sidebar {
  private deps: Deps;
  private project: string;
  private taskId: string;
  private defaultBranch: string;

  private container: BoxRenderable;
  private headerText: TextRenderable;
  private filesText: TextRenderable;
  private historyText: TextRenderable;
  private taskText: TextRenderable;

  private watcher: FSWatcher | null = null;
  private sessionPoll: ReturnType<typeof setInterval> | null = null;
  private prPoll: ReturnType<typeof setInterval> | null = null;
  private gitPoll: ReturnType<typeof setInterval> | null = null;
  private prPollInterval = PR_POLL_INTERVAL;

  readonly data: SidebarData = {
    task: null,
    sessionAlive: false,
    prStatus: null,
    commits: 0,
    diffAdded: 0,
    diffRemoved: 0,
    changedFiles: [],
    historyEvents: [],
  };

  private onChange: (() => void) | null = null;

  constructor(renderer: CliRenderer, options: SidebarOptions) {
    this.deps = options.deps;
    this.project = options.project;
    this.taskId = options.taskId;
    this.defaultBranch = options.defaultBranch;

    this.container = new BoxRenderable(renderer, {
      id: "sidebar",
      flexDirection: "column",
      paddingLeft: 1,
      paddingRight: 1,
    });

    this.headerText = new TextRenderable(renderer, {
      id: "sidebar-header",
      content: "",
      fg: "#CCCCCC",
    });

    this.filesText = new TextRenderable(renderer, {
      id: "sidebar-files",
      content: "",
      fg: "#CCCCCC",
    });

    this.historyText = new TextRenderable(renderer, {
      id: "sidebar-history",
      content: "",
      fg: "#888888",
    });

    this.taskText = new TextRenderable(renderer, {
      id: "sidebar-task",
      content: "",
      fg: "#888888",
      flexGrow: 1,
    });

    this.container.add(this.headerText);
    this.container.add(this.filesText);
    this.container.add(this.historyText);
    this.container.add(this.taskText);
  }

  /**
   * Get the container renderable for layout.
   */
  getRenderable(): BoxRenderable {
    return this.container;
  }

  /**
   * Set change listener for re-render coordination.
   */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /**
   * Start data pipeline (watchers + polls).
   */
  async start(): Promise<void> {
    // Initial data load
    await this.refreshTaskData();
    await this.refreshGitData();
    await this.refreshSessionAlive();
    await this.refreshPRStatus();
    this.render();

    // File watcher for TASK.md and history.jsonl
    this.startFileWatcher();

    // Polling timers
    this.sessionPoll = setInterval(() => {
      this.refreshSessionAlive().then(() => this.render());
    }, SESSION_POLL_INTERVAL);

    this.gitPoll = setInterval(() => {
      this.refreshGitData().then(() => this.render());
    }, GIT_POLL_INTERVAL);

    this.startPRPoll();
  }

  /**
   * Stop all watchers and polls.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionPoll) {
      clearInterval(this.sessionPoll);
      this.sessionPoll = null;
    }
    if (this.prPoll) {
      clearInterval(this.prPoll);
      this.prPoll = null;
    }
    if (this.gitPoll) {
      clearInterval(this.gitPoll);
      this.gitPoll = null;
    }
  }

  /**
   * Cleanup resources.
   */
  async destroy(): Promise<void> {
    await this.stop();
    this.container.destroyRecursively();
  }

  // --- Private: Data refresh ---

  private async refreshTaskData(): Promise<void> {
    const task = await loadTask(this.deps, this.project, this.taskId);
    if (task) {
      this.data.task = task;
    }
    this.data.historyEvents = await loadHistory(this.deps, this.project, this.taskId);
  }

  private async refreshSessionAlive(): Promise<void> {
    const task = this.data.task;
    if (!task?.tmux_session) {
      this.data.sessionAlive = false;
      return;
    }
    this.data.sessionAlive = await this.deps.tmux.sessionExists(task.tmux_session);
  }

  private async refreshPRStatus(): Promise<void> {
    const task = this.data.task;
    if (!task) return;

    try {
      const ghAvailable = await this.deps.github.isAvailable();
      if (!ghAvailable) return;

      const projects = await import("../core/state.js").then(m => m.loadProjects(this.deps));
      const project = projects.find(p => p.name === this.project);
      if (!project) return;

      const status = await this.deps.github.getPRStatus(project.path, task.branch);
      if (status.exists) {
        this.data.prStatus = status;
      }
      // Reset to normal interval on success
      this.prPollInterval = PR_POLL_INTERVAL;
    } catch {
      // Backoff on failure
      this.prPollInterval = PR_BACKOFF_INTERVAL;
    }
  }

  private async refreshGitData(): Promise<void> {
    const task = this.data.task;
    if (!task?.workspace) {
      this.data.commits = 0;
      this.data.diffAdded = 0;
      this.data.diffRemoved = 0;
      this.data.changedFiles = [];
      return;
    }

    const cwd = getWorkspacePath(this.deps, task.workspace);
    try {
      const [diff, commits] = await Promise.all([
        this.deps.git.getDiffStats(cwd, this.defaultBranch),
        this.deps.git.getCommitCount(cwd, this.defaultBranch),
      ]);
      this.data.commits = commits;
      this.data.diffAdded = diff.added;
      this.data.diffRemoved = diff.removed;

      // Get changed files
      this.data.changedFiles = await this.getChangedFiles(cwd);
    } catch {
      // Workspace may not exist or git error
      this.data.changedFiles = [];
    }
  }

  private async getChangedFiles(cwd: string): Promise<string[]> {
    try {
      // Use git diff --name-status against default branch
      const proc = Bun.spawn(
        ["git", "diff", "--name-status", `origin/${this.defaultBranch}...HEAD`],
        { cwd, stdout: "pipe", stderr: "pipe" }
      );
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) return [];

      return stdout.trim().split("\n")
        .filter(line => line.length > 0)
        .map(line => {
          const [status, ...parts] = line.split("\t");
          const file = parts.join("\t");
          const prefix = status.startsWith("R") ? "R" : status.charAt(0);
          return `${prefix} ${file}`;
        });
    } catch {
      return [];
    }
  }

  // --- Private: File watcher ---

  private startFileWatcher(): void {
    const taskDir = join(this.deps.dataDir, "tasks", this.project, this.taskId);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      this.watcher = watch(taskDir, {
        ignoreInitial: true,
        depth: 0,
      });

      this.watcher.on("all", () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          this.refreshTaskData().then(() => this.render());
        }, 100);
      });

      this.watcher.on("error", () => {
        // Fall back to polling on watcher error
        if (this.watcher) {
          this.watcher.close();
          this.watcher = null;
        }
        // Refresh on a 10s interval instead
        const fallback = setInterval(() => {
          this.refreshTaskData().then(() => this.render());
        }, 10_000);
        // Store for cleanup (reuse gitPoll slot since we need to clean up on stop)
        this.sessionPoll = fallback;
      });
    } catch {
      // chokidar init failed — use polling fallback
    }
  }

  private startPRPoll(): void {
    this.prPoll = setInterval(() => {
      this.refreshPRStatus().then(() => {
        this.render();
        // Re-schedule with potentially updated interval
        if (this.prPoll) {
          clearInterval(this.prPoll);
          this.startPRPoll();
        }
      });
    }, this.prPollInterval);
  }

  // --- Private: Rendering ---

  private render(): void {
    this.renderHeader();
    this.renderFiles();
    this.renderHistory();
    this.renderTaskBody();
    if (this.onChange) this.onChange();
  }

  private renderHeader(): void {
    const task = this.data.task;
    if (!task) {
      this.headerText.content = "(loading...)";
      return;
    }

    const sessionState: SessionState = task.tmux_session
      ? this.data.sessionAlive ? "alive" : "dead"
      : "none";
    const icon = SESSION_ICON[sessionState];
    const statusColor = STATUS_COLOR[task.status] || "#888888";

    const lines: string[] = [];
    lines.push(`${task.project}/${task.branch}`);
    lines.push(`Status: ${task.status} ${icon}`);
    lines.push(`Harness: ${task.harness}`);

    // PR info
    if (this.data.prStatus?.exists && this.data.prStatus.url) {
      const prNum = this.data.prStatus.url.match(/\/pull\/(\d+)/)?.[1];
      const state = this.data.prStatus.state?.toLowerCase() ?? "open";
      const checks = this.data.prStatus.checks === "pass" ? " \u2713" : "";
      lines.push(`PR: #${prNum ?? "?"} ${state}${checks}`);
    }

    // Commit stats
    if (this.data.commits > 0) {
      lines.push(`Commits: ${this.data.commits}  +${this.data.diffAdded} -${this.data.diffRemoved}`);
    }

    this.headerText.content = lines.join("\n");
  }

  private renderFiles(): void {
    const files = this.data.changedFiles;
    if (files.length === 0) {
      this.filesText.content = "";
      this.filesText.visible = false;
      return;
    }

    this.filesText.visible = true;
    const header = `\n\u2500\u2500 Files (${files.length}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`;
    const fileLines = files.map(f => ` ${f}`);
    this.filesText.content = header + "\n" + fileLines.join("\n");
  }

  private renderHistory(): void {
    const events = this.data.historyEvents;
    if (events.length === 0) {
      this.historyText.content = "";
      this.historyText.visible = false;
      return;
    }

    this.historyText.visible = true;
    const header = `\n\u2500\u2500 History \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`;
    // Show most recent events first, limited to 10
    const recent = [...events].reverse().slice(0, 10);
    const lines = recent.map(e => {
      const age = this.formatAge(e.timestamp);
      const desc = this.formatEvent(e);
      return ` ${age}  ${desc}`;
    });
    this.historyText.content = header + "\n" + lines.join("\n");
  }

  private renderTaskBody(): void {
    const task = this.data.task;
    if (!task?.body) {
      this.taskText.content = "";
      this.taskText.visible = false;
      return;
    }

    this.taskText.visible = true;
    const header = `\n\u2500\u2500 Task \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`;
    // Show first lines of body, fills remaining height
    const bodyLines = task.body.split("\n").slice(0, 20);
    this.taskText.content = header + "\n" + bodyLines.map(l => ` ${l}`).join("\n");
  }

  private formatAge(timestamp: string): string {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    return `${diffDay}d ago`;
  }

  private formatEvent(event: HistoryEvent): string {
    switch (event.type) {
      case "status.changed":
        return `status \u2192 ${event.to}`;
      case "agent.spawned":
        return "spawned";
      case "agent.crashed":
        return `crashed (#${event.crash_count})`;
      case "auto.advanced":
        return `auto: ${event.from} \u2192 ${event.to}`;
      case "task.created":
        return "created";
      case "task.merged":
        return "merged";
      case "task.cancelled":
        return "cancelled";
      case "pr.created":
        return "PR created";
      case "pr.merged":
        return "PR merged";
      default:
        return event.type;
    }
  }
}
