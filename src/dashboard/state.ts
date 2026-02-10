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
import { loadProjects, saveTask, appendHistory } from "../core/state.js";
import { createTaskRecord } from "../core/task.js";
import { getWorkspacePath, loadPoolState, releaseWorkspace } from "../core/workspace.js";
import { spawnTaskById } from "../core/spawn.js";
import { refreshTaskPR } from "../core/task.js";
import { getInstalledHarnesses } from "../core/harness.js";

/** Terminal task statuses — task is finished, no more work expected */
const TERMINAL_STATUSES: TaskStatus[] = ["done", "cancelled"];

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
  clarification: "#FF8800", // Orange — needs attention
  working: "#5599FF",
  "agent-review": "#CC8800", // Orange — review in progress
  reviewing: "#D4A000",     // Yellow — needs human review
  stuck: "#DD4444",
  done: "#22BB22",
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

const ACTIVE_STATUSES: TaskStatus[] = ["pending", "clarification", "working", "agent-review", "reviewing", "stuck"];
const DONE_STATUSES: TaskStatus[] = ["done", "cancelled"];

/** Sort tasks: active first, terminal last, by updated_at within groups */
function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const aTerminal = DONE_STATUSES.includes(a.status);
    const bTerminal = DONE_STATUSES.includes(b.status);
    if (aTerminal !== bTerminal) {
      return aTerminal ? 1 : -1;
    }
    // Within same group, sort by updated_at descending
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
}

export interface DashboardOptions {
  all?: boolean;
  project?: string;
  exitOnAttach?: boolean;
}

export interface DiffStats {
  added: number;
  removed: number;
  commits: number;
}

/** Which field is focused in create mode. */
export type CreateField = "branch" | "summary" | "harness" | "status";

/** Initial status options for task creation. */
export type CreateStatus = "pending" | "reviewing";

export interface CreateModeData {
  active: boolean;
  branch: string;
  summary: string;
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

export interface ViewModeData {
  active: boolean;
  task: Task | null;
  scrollOffset: number;
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
  viewMode: ViewModeData;
}

type ChangeListener = () => void;
type AttachListener = () => void;

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
      summary: "",
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
    viewMode: {
      active: false,
      task: null,
      scrollOffset: 0,
    },
  };

  private deps: Deps;
  private listeners: ChangeListener[] = [];
  private attachListeners: AttachListener[] = [];
  private watcher: ReturnType<typeof watch> | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** Track previous status per task to detect transitions */
  private previousStatuses: Map<string, TaskStatus> = new Map();

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

  onAttach(fn: AttachListener): () => void {
    this.attachListeners.push(fn);
    return () => {
      this.attachListeners = this.attachListeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private emitAttach(): void {
    for (const fn of this.attachListeners) fn();
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

    // Poll loop: health check, orphan cleanup, PR sync (30s interval)
    this.pollInterval = setInterval(() => {
      Promise.all([
        this.captureOutputs(),
        this.cleanupOrphans(),
        this.refreshPRStatuses(),
      ]).then(() => this.emit());
    }, 30000);

    // Initial PR status refresh
    await this.refreshPRStatuses();
  }

  async dispose(): Promise<void> {
    if (this.watcher) await this.watcher.close();
    if (this.pollInterval) clearInterval(this.pollInterval);
  }

  /** Load tasks without starting watchers. For testing. */
  async loadTasks(): Promise<void> {
    // Also load installed harnesses if not already loaded
    if (this.data.installedHarnesses.length === 0) {
      this.data.installedHarnesses = await getInstalledHarnesses();
    }
    await this.refreshTasks();
  }

  /** Run poll cycle manually. For testing. */
  async runPollCycle(): Promise<void> {
    await Promise.all([
      this.captureOutputs(),
      this.cleanupOrphans(),
      this.refreshPRStatuses(),
    ]);
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

  isViewMode(): boolean {
    return this.data.viewMode.active;
  }

  // --- Input handling ---

  handleInput(key: string): void {
    if (this.data.viewMode.active) {
      this.handleViewInput(key);
      return;
    }

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
      case "p":
        this.createOrOpenPR();
        break;
      case "R":
        this.refreshPR();
        break;
      case "y":
        this.copyTaskId();
        break;
      case "f":
        this.cycleStatusFilter();
        break;
      case "v":
        this.enterViewMode();
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
      summary: "",
      harness: installed[0],
      installedHarnesses: installed,
      status: "pending",
      focusedField: "branch",
    };
    this.emit();
  }

  // --- View mode ---

  private enterViewMode(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task) return;

    this.data.viewMode = {
      active: true,
      task,
      scrollOffset: 0,
    };
    this.emit();
  }

  private exitViewMode(): void {
    this.data.viewMode = {
      active: false,
      task: null,
      scrollOffset: 0,
    };
    this.emit();
  }

  private handleViewInput(key: string): void {
    switch (key) {
      case "escape":
      case "v":
      case "q":
        this.exitViewMode();
        break;
      case "j":
      case "down":
        this.data.viewMode.scrollOffset++;
        this.emit();
        break;
      case "k":
      case "up":
        if (this.data.viewMode.scrollOffset > 0) {
          this.data.viewMode.scrollOffset--;
          this.emit();
        }
        break;
    }
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
      summary: "",
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
        // Cycle through fields: branch → summary → harness → status → branch
        const fields: CreateField[] = ["branch", "summary", "harness", "status"];
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
        } else if (cm.focusedField === "summary") {
          cm.summary = cm.summary.slice(0, -1);
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
          } else if (cm.focusedField === "summary") {
            cm.summary += key;
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
    const inputBranch = cm.branch.trim();
    const summary = cm.summary.trim();
    const harness = cm.harness;
    const status = cm.status;

    // Generate task ID first (needed if branch is empty)
    const { customAlphabet } = await import("nanoid");
    const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 21);
    const taskId = nanoid();

    // Branch defaults to orange-tasks/<id> if empty
    const branch = inputBranch || `orange-tasks/${taskId}`;

    const projectName = this.data.projectFilter!;
    const projects = await loadProjects(this.deps);
    const project = projects.find((p) => p.name === projectName);
    if (!project) {
      this.data.error = `Project '${projectName}' not found.`;
      this.exitCreateMode();
      return;
    }

    // Exit create mode and show progress
    this.data.createMode = {
      active: false,
      branch: "",
      summary: "",
      harness: "claude",
      installedHarnesses: [],
      status: "pending",
      focusedField: "branch",
    };
    this.data.message = `Creating ${branch}...`;
    this.emit();

    try {
      const { task } = await createTaskRecord(this.deps, {
        id: taskId,
        project,
        branch,
        summary,
        harness,
        status,
      });

      // Refresh immediately so the new task shows up before spawning
      this.data.message = `Created ${project.name}/${branch} [${task.status}] [${harness}]`;
      await this.refreshTasks();
      this.emit();

      // Auto-spawn agent unless status is reviewing
      if (task.status !== "reviewing") {
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

      // Detect tasks that just entered agent-review and auto-spawn review agent
      for (const task of this.data.allTasks) {
        const prevStatus = this.previousStatuses.get(task.id);
        if (task.status === "agent-review" && prevStatus !== "agent-review") {
          this.spawnReviewAgent(task);
        }
        // Detect review failed → working transition, auto-respawn worker
        if (task.status === "working" && prevStatus === "agent-review" && task.review_round > 0) {
          this.respawnWorkerAfterReview(task);
        }
        this.previousStatuses.set(task.id, task.status);
      }

      this.applyStatusFilter();
      if (this.data.cursor >= this.data.tasks.length) {
        this.data.cursor = Math.max(0, this.data.tasks.length - 1);
      }
      this.pruneStaleEntries();
      this.refreshDiffStats();
      this.refreshPoolStatus();
    } catch (err) {
      this.data.error =
        err instanceof Error ? err.message : "Failed to load tasks";
    }
  }

  /** Remove map entries for tasks that no longer exist. */
  private pruneStaleEntries(): void {
    const taskIds = new Set(this.data.allTasks.map((t) => t.id));
    for (const id of this.data.lastOutput.keys()) {
      if (!taskIds.has(id)) this.data.lastOutput.delete(id);
    }
    for (const id of this.data.diffStats.keys()) {
      if (!taskIds.has(id)) this.data.diffStats.delete(id);
    }
    for (const id of this.data.prStatuses.keys()) {
      if (!taskIds.has(id)) this.data.prStatuses.delete(id);
    }
    for (const id of this.data.deadSessions) {
      if (!taskIds.has(id)) this.data.deadSessions.delete(id);
    }
    for (const id of this.data.pendingOps) {
      if (!taskIds.has(id)) this.data.pendingOps.delete(id);
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
    const log = this.deps.logger.child("dashboard");
    const projects = await loadProjects(this.deps);
    const projectMap = new Map(projects.map((p) => [p.name, p]));

    // Check gh availability per-project (different hosts may have different auth)
    const ghAvailableByProject = new Map<string, boolean>();

    const mergedTasks: Task[] = [];
    const closedTasks: Task[] = [];
    const discoveredPRs: Array<{ task: Task; url: string }> = [];

    // Process all non-terminal tasks (both with and without PR)
    // Use allTasks, not filtered tasks, so PR discovery works regardless of current view
    const tasksToCheck = this.data.allTasks.filter(
      (t) => !TERMINAL_STATUSES.includes(t.status)
    );

    await Promise.all(
      tasksToCheck.map(async (task) => {
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

          if (status.exists) {
            this.data.prStatuses.set(task.id, status);

            // PR discovery: task has no pr_url but PR exists on GitHub
            if (!task.pr_url && status.url) {
              discoveredPRs.push({ task, url: status.url });
            }

            // Auto-cleanup when PR is merged (any active task with merged PR becomes done)
            const activeStatuses: TaskStatus[] = ["working", "agent-review", "reviewing", "stuck"];
            if (status.state === "MERGED" && activeStatuses.includes(task.status)) {
              mergedTasks.push(task);
            }

            // Auto-cancel when PR is closed without merge
            if (status.state === "CLOSED" && activeStatuses.includes(task.status)) {
              closedTasks.push(task);
            }
          }
        } catch {
          // Ignore errors
        }
      })
    );

    // Save discovered PRs to tasks
    for (const { task, url } of discoveredPRs) {
      log.info("Discovered existing PR for task", { task: task.id, branch: task.branch, url });
      task.pr_url = url;
      task.updated_at = this.deps.clock.now();
      await saveTask(this.deps, task);
      await appendHistory(this.deps, task.project, task.id, {
        type: "pr.created",
        timestamp: this.deps.clock.now(),
        url,
      });
    }

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

    // Auto-cancel tasks whose PRs were closed without merge
    for (const task of closedTasks) {
      if (this.data.pendingOps.has(task.id)) continue;
      this.data.pendingOps.add(task.id);
      this.emit();

      const proc = Bun.spawn(this.getOrangeCommand(["task", "cancel", task.id, "--yes"]), {
        stdout: "pipe",
        stderr: "pipe",
      });

      proc.exited.then(async (exitCode) => {
        this.data.pendingOps.delete(task.id);
        if (exitCode !== 0) {
          const stderr = await new Response(proc.stderr).text();
          this.data.error = `Auto-cancel failed for ${task.branch}: ${cleanErrorMessage(stderr) || "Unknown error"}`;
        } else {
          this.data.message = `Auto-cancelled ${task.branch} (PR closed without merge)`;
        }
        await this.refreshTasks();
        this.emit();
      });
    }
  }

  private applyStatusFilter(): void {
    let filtered: Task[];
    switch (this.data.statusFilter) {
      case "active":
        filtered = this.data.allTasks.filter((t) =>
          ACTIVE_STATUSES.includes(t.status)
        );
        break;
      case "done":
        filtered = this.data.allTasks.filter((t) =>
          DONE_STATUSES.includes(t.status)
        );
        break;
      default:
        filtered = this.data.allTasks;
    }
    this.data.tasks = sortTasks(filtered);
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
    const activeStatuses: TaskStatus[] = ["working", "agent-review", "reviewing", "stuck"];
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

  /**
   * Clean up orphaned resources:
   * - Release workspaces bound to terminal tasks (done/cancelled/failed)
   * - Kill sessions for terminal tasks
   * - Release workspaces from interrupted spawns (bound but no tmux_session)
   */
  private async cleanupOrphans(): Promise<void> {
    const log = this.deps.logger.child("dashboard");

    // Load ALL tasks (unfiltered) to check for orphans across all projects
    const allTasksUnfiltered = await listTasks(this.deps, {});

    // Build task lookup by ID
    const taskById = new Map(allTasksUnfiltered.map((t) => [t.id, t]));

    // Get all live sessions
    const liveSessions = new Set(await this.deps.tmux.listSessions());

    // Load pool state to find bound workspaces
    const poolState = await loadPoolState(this.deps);

    for (const [workspace, entry] of Object.entries(poolState.workspaces)) {
      if (entry.status !== "bound" || !entry.task) continue;

      // entry.task is "project/branch" format, need to find task by matching
      const task = allTasksUnfiltered.find(
        (t) => `${t.project}/${t.branch}` === entry.task
      );

      if (!task) {
        // Task doesn't exist — orphaned workspace (task was deleted)
        log.info("Releasing orphaned workspace (task deleted)", { workspace, task: entry.task });
        try {
          await releaseWorkspace(this.deps, workspace);
        } catch (err) {
          log.warn("Failed to release orphaned workspace", {
            workspace,
            error: err instanceof Error ? err.message : "Unknown",
          });
        }
        continue;
      }

      // Terminal task with bound workspace — release it
      if (TERMINAL_STATUSES.includes(task.status)) {
        log.info("Releasing workspace for terminal task", {
          workspace,
          task: task.id,
          status: task.status,
        });

        // Kill session if still alive
        if (task.tmux_session && liveSessions.has(task.tmux_session)) {
          log.info("Killing orphaned session for terminal task", {
            session: task.tmux_session,
            task: task.id,
          });
          await this.deps.tmux.killSessionSafe(task.tmux_session);
        }

        try {
          await releaseWorkspace(this.deps, workspace);
          // Clear workspace from task
          task.workspace = null;
          task.tmux_session = null;
          await saveTask(this.deps, task);
        } catch (err) {
          log.warn("Failed to release workspace for terminal task", {
            workspace,
            task: task.id,
            error: err instanceof Error ? err.message : "Unknown",
          });
        }
        continue;
      }

      // Interrupted spawn: workspace bound but no tmux_session and still pending
      if (task.status === "pending" && task.workspace && !task.tmux_session) {
        log.info("Releasing workspace from interrupted spawn", {
          workspace,
          task: task.id,
        });
        try {
          await releaseWorkspace(this.deps, workspace);
          task.workspace = null;
          await saveTask(this.deps, task);
        } catch (err) {
          log.warn("Failed to release workspace from interrupted spawn", {
            workspace,
            task: task.id,
            error: err instanceof Error ? err.message : "Unknown",
          });
        }
      }
    }

    // Also check for orphaned sessions (session alive but task is terminal)
    for (const task of allTasksUnfiltered) {
      if (!task.tmux_session) continue;
      if (!TERMINAL_STATUSES.includes(task.status)) continue;
      if (!liveSessions.has(task.tmux_session)) continue;

      log.info("Killing orphaned session for terminal task", {
        session: task.tmux_session,
        task: task.id,
        status: task.status,
      });
      await this.deps.tmux.killSessionSafe(task.tmux_session);

      // Clear session from task
      task.tmux_session = null;
      await saveTask(this.deps, task);
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
    if (!task || this.data.pendingOps.has(task.id)) return;

    // Session dead only matters for "working"/"agent-review" tasks
    const isDead = this.data.deadSessions.has(task.id) && (task.status === "working" || task.status === "agent-review");

    // Terminal states: no action
    if (task.status === "done" || task.status === "cancelled") {
      return;
    }

    // Pending: spawn
    if (task.status === "pending") {
      this.spawnTask();
      return;
    }

    // No session or dead session: respawn
    if (isDead || !task.tmux_session) {
      this.respawnTask();
      return;
    }

    // Check session still exists
    const sessionExists = await this.deps.tmux.sessionExists(task.tmux_session);
    if (!sessionExists) {
      this.data.deadSessions.add(task.id);
      this.respawnTask();
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
        return;
      }
      this.emitAttach();
    }
    // Note: non-tmux attach requires TUI suspend/resume — handled by the view layer
  }

  private mergeTask(): void {
    const task = this.data.tasks[this.data.cursor];
    if (!task || this.data.pendingOps.has(task.id)) return;

    // Terminal statuses can't be merged
    if (task.status === "done" || task.status === "cancelled" || task.status === "pending") {
      this.data.error = "Cannot merge this task.";
      this.emit();
      return;
    }

    // Non-reviewing: force confirm
    if (task.status !== "reviewing") {
      this.data.confirmMode = {
        active: true,
        message: `Task not reviewed yet (${task.status}). Force merge ${task.project}/${task.branch}?`,
        action: () => this.executeMerge(task),
      };
      this.emit();
      return;
    }

    this.executeMerge(task);
  }

  private executeMerge(task: Task): void {
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

    if (task.status !== "done" && task.status !== "cancelled") {
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
    const isCancelled = task.status === "cancelled";
    const isStuck = task.status === "stuck";
    const isWorking = task.status === "working";
    const isAgentReview = task.status === "agent-review";
    const isReviewing = task.status === "reviewing";

    // Allow: working/agent-review with dead session, stuck, cancelled, or reviewing without workspace/dead session
    const canRespawn = ((isWorking || isAgentReview) && sessionDead) || isStuck || isCancelled || (isReviewing && (noWorkspace || sessionDead));
    if (!canRespawn) {
      this.data.error = "Cannot respawn this task.";
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

  /**
   * Auto-spawn review agent when task enters agent-review status.
   * Creates a new named window in the existing tmux session.
   */
  private spawnReviewAgent(task: Task): void {
    if (this.data.pendingOps.has(task.id)) return;
    if (!task.tmux_session || !task.workspace) return;

    this.data.pendingOps.add(task.id);
    this.emit();

    (async () => {
      try {
        const { buildReviewPrompt } = await import("../core/agent.js");
        const { HARNESSES } = await import("../core/harness.js");
        const { saveTask, appendHistory } = await import("../core/state.js");
        const { join } = await import("node:path");

        // Increment review round
        task.review_round += 1;
        const now = this.deps.clock.now();
        task.updated_at = now;
        await saveTask(this.deps, task);

        const prompt = buildReviewPrompt(task);
        const harnessConfig = HARNESSES[task.review_harness];
        const command = harnessConfig.spawnCommand(prompt);
        const workspacePath = join(this.deps.dataDir, "workspaces", task.workspace!);
        const windowName = `review-${task.review_round}`;

        // Check if session exists (might have died)
        const sessionExists = await this.deps.tmux.sessionExists(task.tmux_session!);
        if (!sessionExists) {
          // Session died — create new session instead
          await this.deps.tmux.newSession(task.tmux_session!, workspacePath, command);
        } else {
          await this.deps.tmux.newWindow(task.tmux_session!, windowName, workspacePath, command);
        }

        await appendHistory(this.deps, task.project, task.id, {
          type: "review.started",
          timestamp: now,
          attempt: task.review_round,
        });

        this.data.pendingOps.delete(task.id);
        this.data.message = `Review agent spawned for ${task.branch} (round ${task.review_round})`;
        await this.refreshTasks();
        this.emit();
      } catch (err) {
        this.data.pendingOps.delete(task.id);
        this.data.error = `Review spawn failed: ${err instanceof Error ? err.message : "Unknown error"}`;
        await this.refreshTasks();
        this.emit();
      }
    })();
  }

  /**
   * Auto-respawn worker agent after review failed.
   * Creates a new named window for the fix round.
   */
  private respawnWorkerAfterReview(task: Task): void {
    if (this.data.pendingOps.has(task.id)) return;
    if (!task.tmux_session || !task.workspace) return;

    this.data.pendingOps.add(task.id);
    this.emit();

    (async () => {
      try {
        const { buildRespawnPrompt } = await import("../core/agent.js");
        const { HARNESSES } = await import("../core/harness.js");
        const { join } = await import("node:path");

        const prompt = buildRespawnPrompt(task);
        const harnessConfig = HARNESSES[task.harness];
        const command = prompt ? harnessConfig.respawnCommand(prompt) : harnessConfig.binary;
        const workspacePath = join(this.deps.dataDir, "workspaces", task.workspace!);
        const windowName = `worker-${task.review_round + 1}`;

        const sessionExists = await this.deps.tmux.sessionExists(task.tmux_session!);
        if (!sessionExists) {
          await this.deps.tmux.newSession(task.tmux_session!, workspacePath, command);
        } else {
          await this.deps.tmux.newWindow(task.tmux_session!, windowName, workspacePath, command);
        }

        this.data.pendingOps.delete(task.id);
        this.data.message = `Worker respawned for ${task.branch} (fix round)`;
        await this.refreshTasks();
        this.emit();
      } catch (err) {
        this.data.pendingOps.delete(task.id);
        this.data.error = `Worker respawn failed: ${err instanceof Error ? err.message : "Unknown error"}`;
        await this.refreshTasks();
        this.emit();
      }
    })();
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

    // Create PR — only for reviewing tasks without a PR
    if (task.status !== "reviewing") {
      this.data.error = "Only reviewing tasks can have PRs created.";
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

  private async copyTaskId(): Promise<void> {
    const task = this.data.tasks[this.data.cursor];
    if (!task) return;

    try {
      // Use pbcopy on macOS, xclip on Linux
      const proc = Bun.spawn(
        process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"],
        { stdin: "pipe" }
      );
      proc.stdin.write(task.id);
      proc.stdin.end();
      await proc.exited;

      this.data.message = `Copied: ${task.id}`;
      this.emit();
    } catch {
      this.data.error = "Failed to copy to clipboard";
      this.emit();
    }
  }

  /**
   * Get context-aware keybindings label based on selected task.
   */
  getContextKeys(): string {
    if (this.data.viewMode.active) {
      return " j/k:scroll  Esc:close";
    }

    if (this.data.createMode.active) {
      return " Tab:switch field  Enter:submit  Escape:cancel";
    }

    const task = this.data.tasks[this.data.cursor];
    const createKey = this.data.projectFilter ? "  c:create" : "";

    if (!task) return ` j/k:nav${createKey}  f:filter  q:quit`;

    // Session dead only matters for "working"/"agent-review" tasks
    const isDead = this.data.deadSessions.has(task.id) && (task.status === "working" || task.status === "agent-review");
    const hasLiveSession = task.tmux_session && !isDead;

    let keys = " j/k:nav  v:view  y:copy";
    if (task.status === "pending") {
      keys += "  Enter:spawn  x:cancel";
    } else if (task.status === "done") {
      keys += "  d:del";
    } else if (task.status === "cancelled") {
      keys += "  d:del";
    } else if (isDead) {
      // Working/agent-review task with dead session - needs respawn
      keys += "  Enter:respawn  x:cancel";
    } else if (task.status === "stuck") {
      keys += "  Enter:attach  m:force merge  x:cancel";
    } else if (task.status === "agent-review") {
      keys += "  Enter:attach  m:force merge  x:cancel";
    } else if (task.status === "reviewing") {
      keys += "  Enter:attach";
      keys += task.pr_url ? "  p:open PR" : "  m:merge  p:create PR";
      keys += "  x:cancel";
    } else {
      // working, clarification
      keys += "  Enter:attach  m:force merge  x:cancel";
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
