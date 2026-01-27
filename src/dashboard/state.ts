/**
 * Dashboard state machine.
 *
 * Pure state + logic, no TUI dependencies.
 * Testable independently from rendering.
 */

import { watch } from "chokidar";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { customAlphabet } from "nanoid";
import type { Deps, Task, TaskStatus } from "../core/types.js";
import { listTasks } from "../core/db.js";
import { detectProject } from "../core/cwd.js";
import { loadProjects, saveTask, appendHistory, getTaskDir } from "../core/state.js";
import { getWorkspacePath } from "../core/workspace.js";
import { spawnTaskById } from "../core/spawn.js";

const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 8);

/**
 * Clean up nested error messages for display.
 */
function cleanErrorMessage(raw: string): string {
  let msg = raw.trim();
  while (msg.toLowerCase().startsWith("error: ")) {
    msg = msg.slice(7);
  }
  const lastErrorIdx = msg.toLowerCase().lastIndexOf("error: ");
  if (lastErrorIdx > 0) {
    msg = msg.slice(lastErrorIdx + 7);
  }
  if (msg.length > 0) {
    msg = msg.charAt(0).toUpperCase() + msg.slice(1);
  }
  return msg;
}

/** Status indicator icons. */
export const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "○",
  working: "●",
  reviewing: "◉",
  reviewed: "◈",
  stuck: "⚠",
  done: "✓",
  failed: "✗",
  cancelled: "⊘",
};

/** Status colors (hex). */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "#888888",
  working: "#5599FF",
  reviewing: "#FFFF00",
  reviewed: "#44FF44",
  stuck: "#FF4444",
  done: "#44FF44",
  failed: "#FF4444",
  cancelled: "#888888",
};

export type StatusFilter = "all" | "active" | "done";

const ACTIVE_STATUSES: TaskStatus[] = ["pending", "working", "reviewing", "reviewed", "stuck"];
const DONE_STATUSES: TaskStatus[] = ["done", "failed", "cancelled"];

export interface DashboardOptions {
  all?: boolean;
  project?: string;
}

export interface DiffStats {
  added: number;
  removed: number;
  commits: number;
}

/** Which field is focused in create mode. */
export type CreateField = "branch" | "description";

export interface CreateModeData {
  active: boolean;
  branch: string;
  description: string;
  focusedField: CreateField;
}

export interface DashboardStateData {
  tasks: Task[];
  allTasks: Task[];
  cursor: number;
  lastOutput: Map<string, string>;
  pendingOps: Set<string>;
  deadSessions: Set<string>;
  error: string | null;
  message: string | null;
  statusFilter: StatusFilter;
  projectFilter: string | null;
  projectLabel: string;
  diffStats: Map<string, DiffStats>;
  createMode: CreateModeData;
}

type ChangeListener = () => void;

/**
 * Dashboard state machine.
 * Emits change events when state mutates.
 */
export class DashboardState {
  readonly data: DashboardStateData = {
    tasks: [],
    allTasks: [],
    cursor: 0,
    lastOutput: new Map(),
    pendingOps: new Set(),
    deadSessions: new Set(),
    error: null,
    message: null,
    statusFilter: "all",
    projectFilter: null,
    projectLabel: "all",
    diffStats: new Map(),
    createMode: {
      active: false,
      branch: "",
      description: "",
      focusedField: "branch",
    },
  };

  private deps: Deps;
  private listeners: ChangeListener[] = [];
  private watcher: ReturnType<typeof watch> | null = null;
  private captureInterval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: Deps, options: DashboardOptions = {}) {
    this.deps = deps;
    if (options.project) {
      this.data.projectFilter = options.project;
      this.data.projectLabel = options.project;
    } else if (!options.all) {
      this.data.projectFilter = null;
      this.data.projectLabel = "all";
    }
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  async init(options: DashboardOptions = {}): Promise<void> {
    if (!options.project && !options.all) {
      const detection = await detectProject(this.deps);
      if (detection.project) {
        this.data.projectFilter = detection.project.name;
        this.data.projectLabel = detection.project.name;
      }
    }

    await this.refreshTasks();
    await this.captureOutputs();

    const tasksDir = join(this.deps.dataDir, "tasks");
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    this.watcher = watch(tasksDir, {
      ignoreInitial: true,
      depth: 3,
      ignored: (path: string) => {
        if (!path.includes(".")) return false;
        return !path.endsWith("TASK.md");
      },
    });

    this.watcher.on("all", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.data.message = null;
        this.data.error = null;
        this.refreshTasks().then(() => this.emit());
        debounceTimer = null;
      }, 100);
    });

    this.captureInterval = setInterval(() => {
      this.captureOutputs().then(() => this.emit());
    }, 5000);
  }

  async dispose(): Promise<void> {
    if (this.watcher) await this.watcher.close();
    if (this.captureInterval) clearInterval(this.captureInterval);
  }

  /** Load tasks without starting watchers. For testing. */
  async loadTasks(): Promise<void> {
    await this.refreshTasks();
  }

  getCursor(): number {
    return this.data.cursor;
  }

  getStatusFilter(): StatusFilter {
    return this.data.statusFilter;
  }

  getSelectedTask(): Task | undefined {
    return this.data.tasks[this.data.cursor];
  }

  isCreateMode(): boolean {
    return this.data.createMode.active;
  }

  // --- Input handling ---

  handleInput(key: string): void {
    if (this.data.createMode.active) {
      this.handleCreateInput(key);
      return;
    }

    switch (key) {
      case "j":
      case "down":
        if (this.data.cursor < this.data.tasks.length - 1) {
          this.data.cursor++;
          this.emit();
        }
        break;
      case "k":
      case "up":
        if (this.data.cursor > 0) {
          this.data.cursor--;
          this.emit();
        }
        break;
      case "enter":
        this.attachToTask();
        break;
      case "c":
        this.enterCreateMode();
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
      case "r":
        this.respawnTask();
        break;
      case "s":
        this.spawnTask();
        break;
      case "o":
        this.openPR();
        break;
      case "f":
        this.cycleStatusFilter();
        break;
    }
  }

  // --- Create mode ---

  private enterCreateMode(): void {
    if (!this.data.projectFilter) {
      this.data.error = "Task creation requires a project scope. Use --project or run from a project directory.";
      this.emit();
      return;
    }
    this.data.createMode = {
      active: true,
      branch: "",
      description: "",
      focusedField: "branch",
    };
    this.emit();
  }

  private exitCreateMode(): void {
    this.data.createMode = {
      active: false,
      branch: "",
      description: "",
      focusedField: "branch",
    };
    this.emit();
  }

  private handleCreateInput(key: string): void {
    const cm = this.data.createMode;

    switch (key) {
      case "escape":
        this.exitCreateMode();
        return;
      case "tab":
        cm.focusedField = cm.focusedField === "branch" ? "description" : "branch";
        this.emit();
        return;
      case "enter":
        this.submitCreateTask();
        return;
      case "backspace": {
        if (cm.focusedField === "branch") {
          cm.branch = cm.branch.slice(0, -1);
        } else {
          cm.description = cm.description.slice(0, -1);
        }
        this.emit();
        return;
      }
      default:
        // Append printable characters
        if (key.length === 1 && key >= " ") {
          if (cm.focusedField === "branch") {
            // Branch: allow alphanumeric, hyphens, underscores, slashes, dots
            if (/[a-zA-Z0-9\-_/.]/.test(key)) {
              cm.branch += key;
            }
          } else {
            cm.description += key;
          }
          this.emit();
        }
        return;
    }
  }

  private async submitCreateTask(): Promise<void> {
    const cm = this.data.createMode;
    const branch = cm.branch.trim();
    const description = cm.description.trim();

    if (!branch || !description) {
      this.data.error = "Both branch and description are required.";
      this.emit();
      return;
    }

    const projectName = this.data.projectFilter!;
    const projects = await loadProjects(this.deps);
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      this.data.error = `Project '${projectName}' not found.`;
      this.exitCreateMode();
      return;
    }

    // Exit create mode but don't emit yet — wait until task is saved
    this.data.createMode = {
      active: false,
      branch: "",
      description: "",
      focusedField: "branch",
    };

    try {
      // Find unique branch name
      await this.deps.git.fetch(project.path);
      let finalBranch = branch;
      let suffix = 1;
      while (await this.deps.git.branchExists(project.path, finalBranch)) {
        suffix++;
        finalBranch = `${branch}-${suffix}`;
      }

      const now = this.deps.clock.now();
      const id = nanoid();

      const task: Task = {
        id,
        project: project.name,
        branch: finalBranch,
        status: "pending",
        workspace: null,
        tmux_session: null,
        description,
        context: null,
        created_at: now,
        updated_at: now,
      };

      const taskDir = getTaskDir(this.deps, project.name, finalBranch);
      await mkdir(taskDir, { recursive: true });

      await saveTask(this.deps, task);
      await appendHistory(this.deps, project.name, finalBranch, {
        type: "task.created",
        timestamp: now,
        task_id: id,
        project: project.name,
        branch: finalBranch,
        description,
      });

      // Refresh immediately so the new task shows up before spawning
      this.data.message = `Created ${project.name}/${finalBranch}`;
      await this.refreshTasks();
      this.emit();

      // Auto-spawn agent (may take time; task already visible)
      try {
        await spawnTaskById(this.deps, id);
        await this.refreshTasks();
        this.emit();
      } catch (spawnErr) {
        // Spawn failed but task was created successfully — show warning, keep task
        this.data.error = `Task created but spawn failed: ${spawnErr instanceof Error ? spawnErr.message : "Unknown error"}`;
        this.emit();
      }
    } catch (err) {
      this.data.error = `Create failed: ${err instanceof Error ? err.message : "Unknown error"}`;
      await this.refreshTasks();
      this.emit();
    }
  }

  // --- Private ---

  private async refreshTasks(): Promise<void> {
    try {
      this.data.allTasks = await listTasks(this.deps, {
        project: this.data.projectFilter ?? undefined,
      });
      this.applyStatusFilter();
      if (this.data.cursor >= this.data.tasks.length) {
        this.data.cursor = Math.max(0, this.data.tasks.length - 1);
      }
      this.refreshDiffStats();
    } catch (err) {
      this.data.error =
        err instanceof Error ? err.message : "Failed to load tasks";
    }
  }

  private async refreshDiffStats(): Promise<void> {
    const projects = await loadProjects(this.deps);
    const projectMap = new Map(projects.map((p) => [p.name, p]));

    await Promise.all(
      this.data.tasks.map(async (task) => {
        if (!task.workspace) return;
        const project = projectMap.get(task.project);
        if (!project) return;
        try {
          const cwd = getWorkspacePath(this.deps, task.workspace);
          const [diff, commits] = await Promise.all([
            this.deps.git.getDiffStats(cwd, project.default_branch),
            this.deps.git.getCommitCount(cwd, project.default_branch),
          ]);
          this.data.diffStats.set(task.id, {
            added: diff.added,
            removed: diff.removed,
            commits,
          });
        } catch {
          // Workspace may not exist
        }
      })
    );
    this.emit();
  }

  private applyStatusFilter(): void {
    switch (this.data.statusFilter) {
      case "active":
        this.data.tasks = this.data.allTasks.filter((t) =>
          ACTIVE_STATUSES.includes(t.status)
        );
        break;
      case "done":
        this.data.tasks = this.data.allTasks.filter((t) =>
          DONE_STATUSES.includes(t.status)
        );
        break;
      default:
        this.data.tasks = [...this.data.allTasks];
    }
  }

  private cycleStatusFilter(): void {
    const filters: StatusFilter[] = ["all", "active", "done"];
    const currentIndex = filters.indexOf(this.data.statusFilter);
    this.data.statusFilter = filters[(currentIndex + 1) % filters.length];
    this.applyStatusFilter();
    if (this.data.cursor >= this.data.tasks.length) {
      this.data.cursor = Math.max(0, this.data.tasks.length - 1);
    }
    this.emit();
  }

  private async captureOutputs(): Promise<void> {
    const activeStatuses: TaskStatus[] = ["working", "reviewing", "reviewed", "stuck"];
    for (const task of this.data.tasks) {
      if (task.tmux_session && activeStatuses.includes(task.status)) {
        const exists = await this.deps.tmux.sessionExists(task.tmux_session);
        if (!exists) {
          this.data.deadSessions.add(task.id);
        } else {
          this.data.deadSessions.delete(task.id);
          if (task.status === "working") {
            const output = await this.deps.tmux.capturePaneSafe(task.tmux_session, 5);
            if (output !== null) {
              const lastLine = output.trim().split("\n").pop() ?? "";
              this.data.lastOutput.set(task.id, lastLine);
            }
          }
        }
      }
    }
  }

  private getOrangeCommand(args: string[]): string[] {
    const scriptPath = process.argv[1];
    if (scriptPath.endsWith(".ts")) {
      return ["bun", "run", scriptPath, ...args];
    }
    return [scriptPath, ...args];
  }

  private async attachToTask(): Promise<void> {
    const task = this.data.tasks[this.data.cursor];
    if (!task?.tmux_session) return;

    const tmuxAvailable = await this.deps.tmux.isAvailable();
    if (!tmuxAvailable) {
      this.data.error = "tmux is not installed or not in PATH";
      this.emit();
      return;
    }

    const sessionExists = await this.deps.tmux.sessionExists(task.tmux_session);
    if (!sessionExists) {
      this.data.error = "Session no longer exists.";
      this.emit();
      return;
    }

    const insideTmux = !!process.env.TMUX;
    if (insideTmux) {
      const proc = Bun.spawn(["tmux", "switch-client", "-t", task.tmux_session], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = stderr.trim() || `switch-client failed (exit code: ${exitCode})`;
        this.emit();
      }
    }
    // Note: non-tmux attach requires TUI suspend/resume — handled by the view layer
  }

  private mergeTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "merge", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = `Merge failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.data.message = `Merged ${taskBranch}`;
      }
      await this.refreshTasks();
      this.emit();
    });
  }

  private cancelTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "cancel", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = `Cancel failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.data.message = `Cancelled ${taskBranch}`;
      }
      await this.refreshTasks();
      this.emit();
    });
  }

  private deleteTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    if (task.status !== "done" && task.status !== "failed" && task.status !== "cancelled") {
      this.data.error = `Cannot delete task with status '${task.status}'. Use cancel first.`;
      this.emit();
      return;
    }

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "delete", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = `Delete failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.data.message = `Deleted ${taskBranch}`;
      }
      await this.refreshTasks();
      this.emit();
    });
  }

  private respawnTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    if (!this.data.deadSessions.has(task.id)) {
      this.data.error = "Task session is still active. Use 'x' to cancel first.";
      this.emit();
      return;
    }

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "respawn", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(task.id);
      this.data.deadSessions.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = `Respawn failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.data.message = `Respawned ${taskBranch}`;
      }
      await this.refreshTasks();
      this.emit();
    });
  }

  private spawnTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    if (task.status !== "pending") {
      this.data.error = "Only pending tasks can be spawned.";
      this.emit();
      return;
    }

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    spawnTaskById(this.deps, task.id).then(async () => {
      this.data.pendingOps.delete(task.id);
      this.data.message = `Spawned ${taskBranch}`;
      await this.refreshTasks();
      this.emit();
    }).catch(async (err) => {
      this.data.pendingOps.delete(task.id);
      this.data.error = `Spawn failed: ${err instanceof Error ? err.message : "Unknown error"}`;
      await this.refreshTasks();
      this.emit();
    });
  }

  private openPR(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task) return;
    Bun.spawn(["gh", "pr", "view", "--web", "-H", task.branch], {
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  /**
   * Get context-aware keybindings label based on selected task.
   */
  getContextKeys(): string {
    if (this.data.createMode.active) {
      return " Tab:switch field  Enter:submit  Escape:cancel";
    }

    const task = this.data.tasks[this.data.cursor];
    const createKey = this.data.projectFilter ? "  c:create" : "";

    if (!task) return ` j/k:nav${createKey}  f:filter  q:quit`;

    const isDead = this.data.deadSessions.has(task.id);
    const activeStatuses: TaskStatus[] = ["working", "reviewing", "reviewed", "stuck"];
    const completedStatuses: TaskStatus[] = ["done", "failed", "cancelled"];

    let keys = " j/k:nav";
    if (activeStatuses.includes(task.status)) {
      if (isDead) {
        keys += "  r:respawn  x:cancel";
      } else {
        keys += "  Enter:attach  m:merge  x:cancel";
      }
    } else if (completedStatuses.includes(task.status)) {
      keys += "  d:del";
    } else if (task.status === "pending") {
      keys += "  s:spawn  x:cancel";
    }
    keys += `${createKey}  f:filter  q:quit`;
    return keys;
  }

  /**
   * Format relative time.
   */
  formatRelativeTime(isoDate: string): string {
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
}
