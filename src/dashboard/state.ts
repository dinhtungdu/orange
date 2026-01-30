/**
 * Dashboard state machine.
 *
 * Pure state + logic, no TUI dependencies.
 * Testable independently from rendering.
 */

import { watch } from "chokidar";
import { join } from "node:path";
import type { Deps, Task, TaskStatus, PRStatus, Harness } from "../core/types.js";
import { listTasks } from "../core/db.js";
import { detectProject } from "../core/cwd.js";
import { loadProjects, getOutcomePath, saveTask, appendHistory } from "../core/state.js";
import { parseAgentOutcome } from "../core/agent.js";
import { readFile } from "node:fs/promises";
import { createTaskRecord } from "../core/task.js";
import { getWorkspacePath, loadPoolState } from "../core/workspace.js";
import { spawnTaskById } from "../core/spawn.js";
import { refreshTaskPR } from "../core/task.js";
import { getInstalledHarnesses } from "../core/harness.js";

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

// =============================================================================
// Session Status (icon before task name) - Is the agent running?
// =============================================================================

/** Session state: alive (running), dead (crashed), none (inactive) */
export type SessionState = "alive" | "dead" | "none";

/** Session state icons. */
export const SESSION_ICON: Record<SessionState, string> = {
  alive: "●",  // tmux session exists
  dead: "✗",   // session died unexpectedly
  none: "○",   // no session (pending, finished, cancelled)
};

/** Session state colors. */
export const SESSION_COLOR: Record<SessionState, string> = {
  alive: "#55CC55",  // green
  dead: "#FF5555",   // red
  none: "#666666",   // gray
};

// =============================================================================
// Task Status (Status column) - Where is the task in the workflow?
// =============================================================================

/** Task status colors (hex). */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  pending: "#888888",
  working: "#5599FF",
  reviewing: "#D4A000",
  reviewed: "#22BB22",
  stuck: "#DD4444",
  done: "#22BB22",
  failed: "#DD4444",
  cancelled: "#888888",
};

// =============================================================================
// PR Status (shown in Status column when PR exists)
// =============================================================================

/** CI checks icons. */
export const CHECKS_ICON: Record<string, string> = {
  pass: "✓",
  fail: "✗",
  pending: "⏳",
  none: "",
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
export type CreateField = "branch" | "description" | "harness" | "status";

/** Initial status options for task creation. */
export type CreateStatus = "pending" | "reviewing";

export interface CreateModeData {
  active: boolean;
  branch: string;
  description: string;
  harness: Harness;
  installedHarnesses: Harness[];
  status: CreateStatus;
  focusedField: CreateField;
}

export interface ConfirmModeData {
  active: boolean;
  message: string;
  action: (() => void) | null;
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
  prStatuses: Map<string, PRStatus>;
  poolUsed: number;
  poolTotal: number;
  /** Cached installed harnesses (loaded once during init) */
  installedHarnesses: Harness[];
  createMode: CreateModeData;
  confirmMode: ConfirmModeData;
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
    prStatuses: new Map(),
    poolUsed: 0,
    poolTotal: 0,
    installedHarnesses: [],
    createMode: {
      active: false,
      branch: "",
      description: "",
      harness: "claude", // Will be updated when entering create mode
      installedHarnesses: [],
      status: "pending",
      focusedField: "branch",
    },
    confirmMode: {
      active: false,
      message: "",
      action: null,
    },
  };

  private deps: Deps;
  private listeners: ChangeListener[] = [];
  private watcher: ReturnType<typeof watch> | null = null;
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private prPollInterval: ReturnType<typeof setInterval> | null = null;

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

    // Load installed harnesses (cached for create mode)
    this.data.installedHarnesses = await getInstalledHarnesses();

    await this.refreshTasks();
    await this.captureOutputs();

    const tasksDir = join(this.deps.dataDir, "tasks");
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    this.watcher = watch(tasksDir, {
      ignoreInitial: true,
      depth: 3,
      ignored: (path: string) => {
        if (!path.includes(".")) return false;
        // Watch TASK.md and .orange-outcome files
        return !path.endsWith("TASK.md") && !path.endsWith(".orange-outcome");
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

    // Health check for dead sessions (30s is fine, not time-critical)
    this.captureInterval = setInterval(() => {
      this.captureOutputs().then(() => this.emit());
    }, 30000);

    // Poll PR statuses every 30s
    await this.refreshPRStatuses();
    this.prPollInterval = setInterval(() => {
      this.refreshPRStatuses().then(() => this.emit());
    }, 30000);
  }

  async dispose(): Promise<void> {
    if (this.watcher) await this.watcher.close();
    if (this.captureInterval) clearInterval(this.captureInterval);
    if (this.prPollInterval) clearInterval(this.prPollInterval);
  }

  /** Load tasks without starting watchers. For testing. */
  async loadTasks(): Promise<void> {
    // Also load installed harnesses if not already loaded
    if (this.data.installedHarnesses.length === 0) {
      this.data.installedHarnesses = await getInstalledHarnesses();
    }
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

  isConfirmMode(): boolean {
    return this.data.confirmMode.active;
  }

  // --- Input handling ---

  handleInput(key: string): void {
    if (this.data.confirmMode.active) {
      this.handleConfirmInput(key);
      return;
    }

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
      case "a":
        this.approveTask();
        break;
      case "u":
        this.unapproveTask();
        break;
      case "p":
        this.createOrOpenPR();
        break;
      case "R":
        this.refreshPR();
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

    // Use cached installed harnesses
    const installed = this.data.installedHarnesses;

    if (installed.length === 0) {
      this.data.error = "No coding agent harness installed. Install one of: pi, opencode, claude, codex";
      this.emit();
      return;
    }

    this.data.createMode = {
      active: true,
      branch: "",
      description: "",
      harness: installed[0],
      installedHarnesses: installed,
      status: "pending",
      focusedField: "branch",
    };
    this.emit();
  }

  private handleConfirmInput(key: string): void {
    if (key === "y") {
      const action = this.data.confirmMode.action;
      this.data.confirmMode = { active: false, message: "", action: null };
      if (action) action();
    } else {
      // Any other key (n, escape, etc.) cancels
      this.data.confirmMode = { active: false, message: "", action: null };
      this.emit();
    }
  }

  private exitCreateMode(): void {
    this.data.createMode = {
      active: false,
      branch: "",
      description: "",
      harness: "claude",
      installedHarnesses: [],
      status: "pending",
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
      case "tab": {
        // Cycle through fields: branch → description → harness → status → branch
        const fields: CreateField[] = ["branch", "description", "harness", "status"];
        const currentIdx = fields.indexOf(cm.focusedField);
        cm.focusedField = fields[(currentIdx + 1) % fields.length];
        this.emit();
        return;
      }
      case "enter":
        this.submitCreateTask();
        return;
      case "backspace": {
        if (cm.focusedField === "branch") {
          cm.branch = cm.branch.slice(0, -1);
        } else if (cm.focusedField === "description") {
          cm.description = cm.description.slice(0, -1);
        }
        // No backspace for harness/status fields
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
          } else if (cm.focusedField === "description") {
            cm.description += key;
          } else if (cm.focusedField === "harness") {
            // Cycle through installed harnesses on any key press
            const idx = cm.installedHarnesses.indexOf(cm.harness);
            cm.harness = cm.installedHarnesses[(idx + 1) % cm.installedHarnesses.length];
          } else if (cm.focusedField === "status") {
            // Toggle status on any key press (space or arrow-like behavior)
            cm.status = cm.status === "pending" ? "reviewing" : "pending";
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
    const harness = cm.harness;
    const status = cm.status;

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
      harness: "claude",
      installedHarnesses: [],
      status: "pending",
      focusedField: "branch",
    };

    try {
      const { task } = await createTaskRecord(this.deps, {
        project,
        branch,
        description,
        harness,
        status,
      });

      // Refresh immediately so the new task shows up before spawning
      this.data.message = `Created ${project.name}/${branch} [${status}] [${harness}]`;
      await this.refreshTasks();
      this.emit();

      // Auto-spawn agent only for pending tasks
      if (status === "pending") {
        try {
          await spawnTaskById(this.deps, task.id);
          await this.refreshTasks();
          this.emit();
        } catch (spawnErr) {
          // Spawn failed but task was created successfully — show warning, keep task
          this.data.error = `Task created but spawn failed: ${spawnErr instanceof Error ? spawnErr.message : "Unknown error"}`;
          this.emit();
        }
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
      // Check outcome files and update statuses (harness-agnostic)
      await this.checkOutcomeFiles();
      this.applyStatusFilter();
      if (this.data.cursor >= this.data.tasks.length) {
        this.data.cursor = Math.max(0, this.data.tasks.length - 1);
      }
      this.refreshDiffStats();
      this.refreshPoolStatus();
    } catch (err) {
      this.data.error =
        err instanceof Error ? err.message : "Failed to load tasks";
    }
  }

  /**
   * Check .orange-outcome files for working tasks and update status.
   * This is harness-agnostic: any agent that writes to .orange-outcome
   * will have its status updated automatically.
   */
  private async checkOutcomeFiles(): Promise<void> {
    const workingTasks = this.data.allTasks.filter((t) => t.status === "working");

    for (const task of workingTasks) {
      try {
        const outcomePath = getOutcomePath(this.deps, task.project, task.id);
        const content = await readFile(outcomePath, "utf-8");
        const outcome = parseAgentOutcome(content);

        if (!outcome || outcome.id !== task.id) continue;

        // Update status based on outcome
        if (outcome.outcome === "passed" || outcome.outcome === "reviewing") {
          const now = this.deps.clock.now();
          const previousStatus = task.status;
          task.status = "reviewing";
          task.updated_at = now;
          await saveTask(this.deps, task);
          await appendHistory(this.deps, task.project, task.id, {
            type: "agent.stopped",
            timestamp: now,
            outcome: "passed",
          });
          await appendHistory(this.deps, task.project, task.id, {
            type: "status.changed",
            timestamp: now,
            from: previousStatus,
            to: "reviewing",
          });
        } else if (outcome.outcome === "stuck") {
          const now = this.deps.clock.now();
          const previousStatus = task.status;
          task.status = "stuck";
          task.updated_at = now;
          await saveTask(this.deps, task);
          await appendHistory(this.deps, task.project, task.id, {
            type: "agent.stopped",
            timestamp: now,
            outcome: "stuck",
            reason: outcome.reason,
          });
          await appendHistory(this.deps, task.project, task.id, {
            type: "status.changed",
            timestamp: now,
            from: previousStatus,
            to: "stuck",
          });
        }
      } catch {
        // File doesn't exist or can't be read - agent still working
      }
    }
  }

  private async refreshPoolStatus(): Promise<void> {
    try {
      const poolState = await loadPoolState(this.deps);
      const projects = await loadProjects(this.deps);
      const projectFilter = this.data.projectFilter;

      if (projectFilter) {
        // Project-scoped: show that project's pool_size and used count
        const project = projects.find((p) => p.name === projectFilter);
        if (project) {
          const relevant = Object.entries(poolState.workspaces).filter(([name]) =>
            name.startsWith(`${projectFilter}--`)
          );
          this.data.poolTotal = project.pool_size;
          this.data.poolUsed = relevant.filter(([, e]) => e.status === "bound").length;
        }
      } else {
        // Global: sum all projects' pool_size and used count
        this.data.poolTotal = projects.reduce((sum, p) => sum + p.pool_size, 0);
        this.data.poolUsed = Object.values(poolState.workspaces).filter(
          (e) => e.status === "bound"
        ).length;
      }
    } catch {
      // Pool not initialized yet
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

  private async refreshPRStatuses(): Promise<void> {
    const tasksWithPR = this.data.tasks.filter((t) => t.pr_url);
    if (tasksWithPR.length === 0) return;

    const projects = await loadProjects(this.deps);
    const projectMap = new Map(projects.map((p) => [p.name, p]));

    // Check gh availability per-project (different hosts may have different auth)
    const ghAvailableByProject = new Map<string, boolean>();

    const mergedTasks: Task[] = [];

    await Promise.all(
      tasksWithPR.map(async (task) => {
        const project = projectMap.get(task.project);
        if (!project) return;

        // Check gh availability for this project's host (cached per project)
        if (!ghAvailableByProject.has(task.project)) {
          const available = await this.deps.github.isAvailable(project.path);
          ghAvailableByProject.set(task.project, available);
        }
        if (!ghAvailableByProject.get(task.project)) return;

        try {
          const status = await this.deps.github.getPRStatus(project.path, task.branch);
          this.data.prStatuses.set(task.id, status);

          // Auto-cleanup when PR is merged
          if (status.state === "MERGED" && task.status === "reviewed") {
            mergedTasks.push(task);
          }
        } catch {
          // Ignore errors
        }
      })
    );

    // Auto-merge tasks whose PRs were merged on GitHub
    for (const task of mergedTasks) {
      if (this.data.pendingOps.has(task.id)) continue;
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
          this.data.error = `Auto-merge failed for ${task.branch}: ${cleanErrorMessage(stderr) || "Unknown error"}`;
        } else {
          this.data.message = `Auto-merged ${task.branch} (PR merged on GitHub)`;
        }
        await this.refreshTasks();
        this.emit();
      });
    }
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
    const activeTasks = this.data.tasks.filter(
      (t) => t.tmux_session && activeStatuses.includes(t.status)
    );

    if (activeTasks.length === 0) return;

    // Single tmux call to get all sessions
    const liveSessions = new Set(await this.deps.tmux.listSessions());

    // Check dead sessions and capture outputs in parallel
    await Promise.all(
      activeTasks.map(async (task) => {
        const exists = liveSessions.has(task.tmux_session!);
        if (!exists) {
          this.data.deadSessions.add(task.id);
        } else {
          this.data.deadSessions.delete(task.id);
          if (task.status === "working") {
            const output = await this.deps.tmux.capturePaneSafe(task.tmux_session!, 5);
            if (output !== null) {
              const lastLine = output.trim().split("\n").pop() ?? "";
              this.data.lastOutput.set(task.id, lastLine);
            }
          }
        }
      })
    );
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
    if (!task || this.data.pendingOps.has(task.id)) return;

    // Session dead only matters for "working" tasks
    const isDead = this.data.deadSessions.has(task.id) && task.status === "working";

    // Done tasks: no-op
    if (task.status === "done") {
      return;
    }

    // Pending: spawn
    if (task.status === "pending") {
      this.spawnTask();
      return;
    }

    // Cancelled/failed: reactivate via respawn
    if (task.status === "cancelled" || task.status === "failed") {
      this.respawnTask();
      return;
    }

    // Working task with dead session: respawn
    if (isDead) {
      this.respawnTask();
      return;
    }

    // No session to attach to (reviewing/reviewed with closed session)
    if (!task.tmux_session) {
      this.data.error = "No session to attach. Use 'r' to run agent if needed.";
      this.emit();
      return;
    }

    // Check session still exists
    const sessionExists = await this.deps.tmux.sessionExists(task.tmux_session);
    if (!sessionExists) {
      // Mark as dead for working tasks, show error for others
      this.data.deadSessions.add(task.id);
      if (task.status === "working") {
        this.respawnTask();
      } else {
        this.data.error = "Session closed. Use 'r' to run agent if needed.";
        this.emit();
      }
      return;
    }

    // Attach to live session
    await this.attachToSession(task.tmux_session);
  }

  private async attachToSession(session: string): Promise<void> {
    const tmuxAvailable = await this.deps.tmux.isAvailable();
    if (!tmuxAvailable) {
      this.data.error = "tmux is not installed or not in PATH";
      this.emit();
      return;
    }

    const insideTmux = !!process.env.TMUX;
    if (insideTmux) {
      const proc = Bun.spawn(["tmux", "switch-client", "-t", session], {
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

  private approveTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    if (task.status !== "reviewing") {
      this.data.error = "Only reviewing tasks can be approved.";
      this.emit();
      return;
    }

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "approve", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = `Approve failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.data.message = `Approved ${taskBranch}`;
      }
      await this.refreshTasks();
      this.emit();
    });
  }

  private unapproveTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    if (task.status !== "reviewed") {
      this.data.error = "Only reviewed tasks can be unapproved.";
      this.emit();
      return;
    }

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "unapprove", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = `Unapprove failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.data.message = `Unapproved ${taskBranch}`;
      }
      await this.refreshTasks();
      this.emit();
    });
  }

  private mergeTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    if (task.status !== "reviewed") {
      this.data.error = "Only reviewed tasks can be merged.";
      this.emit();
      return;
    }

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

    // Show confirmation
    this.data.confirmMode = {
      active: true,
      message: `Cancel task ${task.project}/${task.branch}?`,
      action: () => this.executeCancelTask(task.id, task.branch),
    };
    this.emit();
  }

  private executeCancelTask(taskId: string, taskBranch: string): void {
    this.data.pendingOps.add(taskId);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "cancel", taskId, "--yes"]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(taskId);
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

    // Show confirmation
    this.data.confirmMode = {
      active: true,
      message: `Delete task ${task.project}/${task.branch}?`,
      action: () => this.executeDeleteTask(task.id, task.branch),
    };
    this.emit();
  }

  private executeDeleteTask(taskId: string, taskBranch: string): void {
    this.data.pendingOps.add(taskId);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "delete", taskId, "--yes"]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(taskId);
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

    // Raw dead session check - for respawn, any dead session is valid
    const sessionDead = this.data.deadSessions.has(task.id);
    const noWorkspace = !task.workspace;
    const isCancelledOrFailed = task.status === "cancelled" || task.status === "failed";
    const isStuck = task.status === "stuck";
    const isWorking = task.status === "working";
    const isReviewing = task.status === "reviewing";

    // Allow: working with dead session, stuck, cancelled/failed, or reviewing without workspace
    const canRespawn = (isWorking && sessionDead) || isStuck || isCancelledOrFailed || (isReviewing && noWorkspace);
    if (!canRespawn) {
      this.data.error = "Cannot respawn this task. Use 'r' to run agent interactively.";
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
        this.data.error = `Run failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
        await this.refreshTasks();
        this.emit();
      } else {
        // Refresh to get new tmux_session, then attach
        await this.refreshTasks();
        this.emit();
        // Re-fetch task to get updated tmux_session
        const updatedTask = this.data.tasks.find((t) => t.id === task.id);
        if (updatedTask?.tmux_session) {
          await this.attachToSession(updatedTask.tmux_session);
        }
      }
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

  private createOrOpenPR(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    // If PR exists, open in browser
    if (task.pr_url) {
      Bun.spawn(["open", task.pr_url], {
        stdout: "pipe",
        stderr: "pipe",
      });
      return;
    }

    // Create PR — only for reviewed tasks without a PR
    if (task.status !== "reviewed") {
      this.data.error = "Only reviewed tasks can have PRs created.";
      this.emit();
      return;
    }

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    const proc = Bun.spawn(this.getOrangeCommand(["task", "create-pr", task.id]), {
      stdout: "pipe",
      stderr: "pipe",
    });

    proc.exited.then(async (exitCode) => {
      this.data.pendingOps.delete(task.id);
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        this.data.error = `PR creation failed: ${cleanErrorMessage(stderr) || "Unknown error"}`;
      } else {
        this.data.message = `PR created for ${taskBranch}`;
      }
      await this.refreshTasks();
      this.emit();
    });
  }

  private async refreshPR(): Promise<void> {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    const taskBranch = task.branch;
    this.data.pendingOps.add(task.id);
    this.emit();

    try {
      const updated = await refreshTaskPR(this.deps, task.id);
      this.data.pendingOps.delete(task.id);

      if (updated?.pr_url && updated.pr_url !== task.pr_url) {
        this.data.message = `PR linked: ${taskBranch}`;
      } else if (updated?.pr_url) {
        this.data.message = `PR status refreshed: ${taskBranch}`;
      } else {
        this.data.message = `No PR found for ${taskBranch}`;
      }

      await this.refreshTasks();
      await this.refreshPRStatuses();
      this.emit();
    } catch (err) {
      this.data.pendingOps.delete(task.id);
      this.data.error = `PR refresh failed: ${err instanceof Error ? err.message : "Unknown error"}`;
      this.emit();
    }
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

    // Session dead only matters for "working" tasks - reviewing/reviewed tasks finished naturally
    const isDead = this.data.deadSessions.has(task.id) && task.status === "working";
    const hasLiveSession = task.tmux_session && !isDead;

    let keys = " j/k:nav";
    if (task.status === "pending") {
      keys += "  Enter:spawn  x:cancel";
    } else if (task.status === "done") {
      keys += "  d:del";
    } else if (task.status === "cancelled" || task.status === "failed") {
      keys += "  Enter:reactivate  d:del";
    } else if (isDead) {
      // Working task with dead session - needs respawn
      keys += "  Enter:respawn  x:cancel";
    } else if (task.status === "reviewed") {
      keys += "  Enter:attach  u:unapprove";
      keys += task.pr_url ? "  p:open PR" : "  m:merge  p:create PR";
      keys += "  x:cancel";
    } else if (task.status === "stuck") {
      keys += "  Enter:attach  x:cancel";
    } else if (task.status === "reviewing") {
      keys += "  Enter:attach";
      keys += task.pr_url ? "  p:open PR" : "  a:approve";
      keys += "  x:cancel";
    } else {
      // working
      keys += "  Enter:attach  x:cancel";
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
