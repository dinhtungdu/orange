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
  StyledText,
  bold,
  dim,
  fg,
  green,
  red,
  yellow,
  cyan,
  t,
  type CliRenderer,
} from "@opentui/core";
import type { Deps, Task, HistoryEvent, PRStatus } from "../core/types.js";
import { loadTask, loadHistory } from "../core/state.js";
import { getWorkspacePath } from "../core/workspace.js";
import { STATUS_COLOR, SESSION_ICON, SESSION_COLOR, type SessionState } from "./state.js";

type TextChunk = StyledText["chunks"][number];

/** Color map for file status prefixes. */
const FILE_PREFIX_COLOR: Record<string, (input: string) => TextChunk> = {
  A: green,
  M: yellow,
  D: red,
  R: cyan,
};

/** Color map for history event types. */
const EVENT_COLOR: Record<string, string> = {
  "agent.spawned": "#5599FF",
  "agent.crashed": "#FF5555",
  "status.changed": "#D4A000",
  "auto.advanced": "#00BBCC",
};

/** Border color for section boxes. */
const SECTION_BORDER_COLOR = "#333333";
/** Border color for header box. */
const HEADER_BORDER_COLOR = "#5599FF";

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

  // Section widgets — each a rounded box with text content
  readonly headerBox: BoxRenderable;
  private headerText: TextRenderable;

  readonly filesBox: BoxRenderable;
  private filesText: TextRenderable;

  readonly historyBox: BoxRenderable;
  private historyText: TextRenderable;

  readonly taskBox: BoxRenderable;
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

  // Per-section scroll offsets
  private scrollOffset = { files: 0, history: 0, task: 0 };
  // Content line counts (set during render)
  private contentLines = { files: 0, history: 0, task: 0 };

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
      gap: 1,
      width: "100%",
      height: "100%",
    });

    // Header section
    this.headerBox = new BoxRenderable(renderer, {
      id: "sidebar-header-box",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: HEADER_BORDER_COLOR,
      flexShrink: 0,
    });
    this.headerText = new TextRenderable(renderer, {
      id: "sidebar-header",
      content: "",
      fg: "#CCCCCC",
    });
    this.headerBox.add(this.headerText);

    // Files section
    this.filesBox = new BoxRenderable(renderer, {
      id: "sidebar-files-box",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: SECTION_BORDER_COLOR,
      title: "Files",
      visible: false,
      flexShrink: 0,
    });
    this.filesText = new TextRenderable(renderer, {
      id: "sidebar-files",
      content: "",
      fg: "#AAAAAA",
    });
    this.filesBox.add(this.filesText);

    // History section
    this.historyBox = new BoxRenderable(renderer, {
      id: "sidebar-history-box",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: SECTION_BORDER_COLOR,
      title: "History",
      visible: false,
      flexShrink: 0,
    });
    this.historyText = new TextRenderable(renderer, {
      id: "sidebar-history",
      content: "",
      fg: "#AAAAAA",
    });
    this.historyBox.add(this.historyText);

    // Task section
    this.taskBox = new BoxRenderable(renderer, {
      id: "sidebar-task-box",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: SECTION_BORDER_COLOR,
      title: "Task",
      visible: false,
      flexGrow: 1,
    });
    this.taskText = new TextRenderable(renderer, {
      id: "sidebar-task",
      content: "",
      fg: "#AAAAAA",
    });
    this.taskBox.add(this.taskText);

    this.container.add(this.headerBox);
    this.container.add(this.filesBox);
    this.container.add(this.historyBox);
    this.container.add(this.taskBox);
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
   * Handle scroll event at a given screen row.
   * Returns true if the scroll was handled.
   */
  handleScroll(row: number, direction: "up" | "down"): boolean {
    const section = this.sectionAtRow(row);
    if (!section) return false;

    const delta = direction === "up" ? -1 : 1;
    const maxOffset = Math.max(0, this.contentLines[section] - this.sectionVisibleLines(section));
    this.scrollOffset[section] = Math.max(0, Math.min(maxOffset, this.scrollOffset[section] + delta));
    this.render();
    return true;
  }

  /** Determine which scrollable section contains the given screen row. */
  private sectionAtRow(row: number): "files" | "history" | "task" | null {
    const sections = [
      { key: "files" as const, box: this.filesBox },
      { key: "history" as const, box: this.historyBox },
      { key: "task" as const, box: this.taskBox },
    ];

    // Check if layout coords are computed (at least one visible box has height > 0)
    const hasLayout = sections.some(({ box }) => box.visible && box.height > 0);

    if (!hasLayout) {
      // Fallback: return first visible section (coords not yet computed)
      for (const { key, box } of sections) {
        if (box.visible) return key;
      }
      return null;
    }

    for (const { key, box } of sections) {
      if (!box.visible) continue;
      // opentui layout coords: y is top edge, height is total height (1-based row → 0-based y)
      const top = box.y;
      const bottom = top + box.height;
      if (row - 1 >= top && row - 1 < bottom) return key;
    }
    return null;
  }

  /** Visible content lines in a section (box height minus border). */
  private sectionVisibleLines(section: "files" | "history" | "task"): number {
    const box = section === "files" ? this.filesBox
      : section === "history" ? this.historyBox
      : this.taskBox;
    // Box has border (2 rows) — visible content = height - 2
    return Math.max(1, box.height - 2);
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

  /** Join multiple StyledText lines with newlines. */
  private joinLines(lines: StyledText[]): StyledText {
    const chunks: TextChunk[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) chunks.push({ __isChunk: true, text: "\n" });
      chunks.push(...lines[i].chunks);
    }
    return new StyledText(chunks);
  }

  /** Truncate file path, stripping common prefix and ellipsizing. */
  private truncPath(path: string, max: number): string {
    if (path.length <= max) return path;
    const parts = path.split("/");
    while (parts.length > 1 && parts.join("/").length > max - 1) {
      parts.shift();
    }
    const shortened = parts.join("/");
    if (shortened.length <= max) return "…" + shortened;
    return "…" + shortened.slice(-(max - 1));
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
    const sessionColor = SESSION_COLOR[sessionState];

    const lines: StyledText[] = [];
    lines.push(t`${bold(`${task.project}/${task.branch}`)}`);
    lines.push(t`${dim(this.taskId.slice(0, 8))}  ${fg(statusColor)(task.status)} ${fg(sessionColor)(icon)}  ${task.harness}`);

    // PR info
    if (this.data.prStatus?.exists && this.data.prStatus.url) {
      const prNum = this.data.prStatus.url.match(/\/pull\/(\d+)/)?.[1];
      const state = this.data.prStatus.state?.toLowerCase() ?? "open";
      const stateColor = state === "merged" ? "#8B5CF6" : state === "closed" ? "#FF5555" : "#22BB22";
      const checks = this.data.prStatus.checks === "pass" ? " ✓" : "";
      lines.push(t`${dim("PR")} #${prNum ?? "?"} ${fg(stateColor)(state + checks)}`);
    }

    // Commit stats
    if (this.data.commits > 0) {
      lines.push(t`${this.data.commits} ${dim("commits")}  ${green(`+${this.data.diffAdded}`)} ${red(`-${this.data.diffRemoved}`)}`);
    }

    this.headerText.content = this.joinLines(lines);
  }

  private renderFiles(): void {
    const files = this.data.changedFiles;
    if (files.length === 0) {
      this.filesBox.visible = false;
      return;
    }

    this.filesBox.visible = true;
    this.filesBox.title = `Files (${files.length})`;

    const lines: StyledText[] = [];
    for (const f of files) {
      const prefix = f.charAt(0);
      const path = f.slice(2);
      const colorFn = FILE_PREFIX_COLOR[prefix] ?? dim;
      const truncated = this.truncPath(path, 30);
      lines.push(t`${colorFn(prefix)} ${truncated}`);
    }

    this.contentLines.files = lines.length;
    this.filesText.content = this.joinLines(lines);
  }

  private renderHistory(): void {
    const events = this.data.historyEvents;
    if (events.length === 0) {
      this.historyBox.visible = false;
      return;
    }

    this.historyBox.visible = true;

    const recent = [...events].reverse().slice(0, 10);
    const lines: StyledText[] = [];
    for (const e of recent) {
      const age = this.formatAge(e.timestamp);
      const desc = this.formatEvent(e);
      const color = EVENT_COLOR[e.type];
      lines.push(
        color
          ? t`${dim(age)}  ${fg(color)(desc)}`
          : t`${dim(age)}  ${desc}`
      );
    }

    this.contentLines.history = lines.length;
    this.historyText.content = this.joinLines(lines);
  }

  private renderTaskBody(): void {
    const task = this.data.task;
    if (!task?.body) {
      this.taskBox.visible = false;
      return;
    }

    this.taskBox.visible = true;

    const bodyLines = task.body.split("\n");
    const lines: StyledText[] = [];
    for (const l of bodyLines) {
      lines.push(t`${l}`);
    }

    this.contentLines.task = lines.length;
    const visibleLines = this.sectionVisibleLines("task");
    const offset = Math.min(this.scrollOffset.task, Math.max(0, lines.length - visibleLines));
    this.scrollOffset.task = offset;
    this.taskText.content = this.joinLines(lines.slice(offset, offset + visibleLines));
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
