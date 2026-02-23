/**
 * Core types for the Orange agent orchestration system.
 *
 * These types define the fundamental data structures used throughout the application:
 * - Task: Represents a unit of work assigned to an agent
 * - Project: Represents a registered project that can have tasks
 * - Deps: Dependency injection container for external services
 */

/**
 * Supported coding agent harnesses.
 */
export type Harness = "pi" | "opencode" | "claude" | "codex";

/**
 * Task status represents the lifecycle state of a task.
 *
 * Flow: pending → working → agent-review → reviewing → done
 *                    ↑↓            ↕
 *              clarification    working (fix cycle)
 *                                  ↓
 *                                stuck (after 2 rounds)
 *       cancelled (from any active state)
 */
export type TaskStatus =
  | "pending" // Created but not spawned
  | "planning" // Agent reading task, writing plan
  | "clarification" // Agent waiting for user input (vague task or scope change)
  | "working" // Agent actively implementing
  | "agent-review" // Review agent evaluating work
  | "reviewing" // Agent review passed, awaiting human review/merge
  | "stuck" // Failed after 2 review rounds or 2 crashes in review
  | "done" // Successfully merged/completed
  | "cancelled"; // User cancelled or errored

/**
 * Task represents a unit of work assigned to an agent.
 * Tasks are stored as TASK.md files with YAML frontmatter.
 */
export interface Task {
  /** Unique task identifier (nanoid) */
  id: string;
  /** Project name this task belongs to */
  project: string;
  /** Git branch name for this task */
  branch: string;
  /** Which coding agent harness to use */
  harness: Harness;
  /** Which harness to use for agent review (default: claude) */
  review_harness: Harness;
  /** Current status of the task */
  status: TaskStatus;
  /** Current review round (0 = no review yet, 1-2 = review rounds) */
  review_round: number;
  /** Number of consecutive crashes in current status (reset on successful transition) */
  crash_count: number;
  /** Assigned workspace path (e.g., "orange--1"), null if not spawned */
  workspace: string | null;
  /** tmux session name (e.g., "orange/dark-mode"), null if not spawned */
  tmux_session: string | null;
  /** Human-readable task summary (short one-liner, in frontmatter) */
  summary: string;
  /** Free-form body content (context, questions, notes — agent-controlled) */
  body: string;
  /** ISO 8601 timestamp of task creation */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
  /** GitHub PR URL, null if no PR created */
  pr_url: string | null;
  /** Final PR state, saved on terminal transition so we don't need to re-fetch */
  pr_state: "OPEN" | "CLOSED" | "MERGED" | null;
}

/**
 * Project represents a registered project that can have tasks.
 * Projects are stored in ~/orange/projects.json.
 */
export interface Project {
  /** Unique project name/identifier */
  name: string;
  /** Absolute filesystem path to the project */
  path: string;
  /** Main branch name (e.g., "main" or "master") */
  default_branch: string;
  /** Number of worktrees in the workspace pool */
  pool_size: number;
}

/**
 * TmuxExecutor interface for tmux session management.
 * Abstracted to support both real tmux and mock implementations for testing.
 */
export interface TmuxExecutor {
  /** Check if tmux is installed and available */
  isAvailable(): Promise<boolean>;
  /** Create a new tmux session */
  newSession(name: string, cwd: string, command: string): Promise<void>;
  /** Kill an existing tmux session */
  killSession(name: string): Promise<void>;
  /** Kill a session, ignoring errors if session doesn't exist */
  killSessionSafe(name: string): Promise<void>;
  /** List all tmux session names */
  listSessions(): Promise<string[]>;
  /** Check if a session exists */
  sessionExists(name: string): Promise<boolean>;
  /** Capture pane output from a session */
  capturePane(session: string, lines: number): Promise<string>;
  /** Capture pane output, returning null if session doesn't exist */
  capturePaneSafe(session: string, lines: number): Promise<string | null>;
  /** Capture pane output with ANSI escape sequences preserved */
  capturePaneAnsi(session: string, lines: number): Promise<string>;
  /** Capture pane output with ANSI, returning null if session doesn't exist */
  capturePaneAnsiSafe(session: string, lines: number): Promise<string | null>;
  /** Query pane info (cursor position, dimensions) */
  queryPaneInfo(session: string): Promise<{
    cursorX: number;
    cursorY: number;
    cursorVisible: boolean;
    paneWidth: number;
    paneHeight: number;
  } | null>;
  /** Resize pane to specified dimensions */
  resizePane(session: string, width: number, height: number): Promise<void>;
  /** Resize pane, ignoring errors */
  resizePaneSafe(session: string, width: number, height: number): Promise<void>;
  /** Send keys to a session */
  sendKeys(session: string, keys: string): Promise<void>;
  /** Create a new named window in an existing session */
  newWindow(session: string, name: string, cwd: string, command: string): Promise<void>;
  /** Rename the current window in a session */
  renameWindow(session: string, name: string): Promise<void>;
  /** Split window horizontally and run command in new pane */
  splitWindow(session: string, command: string): Promise<void>;
  /** Attach to session if exists, create and attach if not (tmux new-session -A) */
  attachOrCreate(name: string, cwd: string): Promise<void>;
  /** Rename a session */
  renameSession(oldName: string, newName: string): Promise<void>;
  /** Send literal text (not interpreted as key names) via send-keys -l */
  sendLiteral(session: string, text: string): Promise<void>;
  /** Scroll pane via copy-mode (enters copy-mode if needed, scrolls 1 line) */
  scrollPane(session: string, direction: "up" | "down"): Promise<void>;
  /** Kill a specific window in a session */
  killWindow(session: string, window: string): Promise<void>;
  /** Kill a specific window, ignoring errors */
  killWindowSafe(session: string, window: string): Promise<void>;
  /** Select (focus) a specific window in a session */
  selectWindow(session: string, window: string): Promise<void>;
  /** Select a specific window, ignoring errors */
  selectWindowSafe(session: string, window: string): Promise<void>;
}

/**
 * GitExecutor interface for git operations.
 * Abstracted to support both real git and mock implementations for testing.
 */
export interface GitExecutor {
  /** Fetch from remote */
  fetch(cwd: string): Promise<void>;
  /** Checkout a branch */
  checkout(cwd: string, branch: string): Promise<void>;
  /** Reset hard to a ref */
  resetHard(cwd: string, ref: string): Promise<void>;
  /** Create a new branch, optionally from a start point (defaults to HEAD) */
  createBranch(cwd: string, branch: string, startPoint?: string): Promise<void>;
  /** Check if a branch exists (local or remote) */
  branchExists(cwd: string, branch: string): Promise<boolean>;
  /** Delete a branch (local) */
  deleteBranch(cwd: string, branch: string): Promise<void>;
  /** Delete a remote branch */
  deleteRemoteBranch(cwd: string, branch: string, remote?: string): Promise<void>;
  /** Merge a branch into current branch */
  merge(cwd: string, branch: string, strategy?: "ff" | "merge"): Promise<void>;
  /** Get current branch name */
  currentBranch(cwd: string): Promise<string>;
  /** Rename a branch */
  renameBranch(cwd: string, oldName: string, newName: string): Promise<void>;
  /** Clean untracked files */
  clean(cwd: string): Promise<void>;
  /** Add worktree */
  addWorktree(cwd: string, path: string, branch: string): Promise<void>;
  /** Remove worktree */
  removeWorktree(cwd: string, path: string): Promise<void>;
  /** Get current commit hash (short or full) */
  getCommitHash(cwd: string, short?: boolean): Promise<string>;
  /** Check if working directory has uncommitted changes */
  isDirty(cwd: string): Promise<boolean>;
  /** Push a branch to remote. If branch omitted, pushes current branch. */
  push(cwd: string, remote?: string, branch?: string): Promise<void>;
  /** Get diff stats (lines added/removed) vs a base ref */
  getDiffStats(cwd: string, base: string): Promise<{ added: number; removed: number }>;
  /** Get number of commits ahead of a base ref */
  getCommitCount(cwd: string, base: string): Promise<number>;
}

/**
 * PR status from GitHub.
 */
export interface PRStatus {
  exists: boolean;
  url?: string;
  state?: "OPEN" | "CLOSED" | "MERGED";
  mergeCommit?: string;
  /** CI check rollup */
  checks?: "pending" | "pass" | "fail" | "none";
  /** Review decision */
  reviewDecision?: string;
}

/**
 * GitHubExecutor interface for GitHub CLI operations.
 * Abstracted to support both real gh CLI and mock implementations for testing.
 */
export interface GitHubExecutor {
  /** Check if gh CLI is available and authenticated for the repo's host */
  isAvailable(cwd?: string): Promise<boolean>;
  /** Create a PR. Returns PR URL. */
  createPR(
    cwd: string,
    opts: { branch: string; base: string; title: string; body: string }
  ): Promise<string>;
  /** Get PR status for a branch */
  getPRStatus(cwd: string, branch: string): Promise<PRStatus>;
}

/**
 * Clock interface for time operations.
 * Abstracted to support deterministic time in tests.
 */
export interface Clock {
  /** Get current time as ISO 8601 string */
  now(): string;
}

/**
 * Logger interface for structured logging.
 * Imported from logger.ts but declared here to avoid circular deps.
 */
export interface Logger {
  error(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  debug(msg: string, context?: Record<string, unknown>): void;
  child(component: string): Logger;
}

/**
 * Deps is the dependency injection container.
 * All external dependencies are injected through this interface,
 * allowing easy mocking in tests.
 */
export interface Deps {
  /** tmux session management */
  tmux: TmuxExecutor;
  /** Git operations */
  git: GitExecutor;
  /** GitHub CLI operations */
  github: GitHubExecutor;
  /** Time operations */
  clock: Clock;
  /** Structured logger */
  logger: Logger;
  /** Data directory path (default: ~/orange) */
  dataDir: string;
}

/**
 * Workspace status in the pool.
 */
export type WorkspaceStatus = "available" | "bound";

/**
 * Workspace entry in the pool state.
 */
export interface WorkspaceEntry {
  status: WorkspaceStatus;
  /** Task reference (project/branch) when bound, undefined when available */
  task?: string;
}

/**
 * Pool state stored in .pool.json.
 */
export interface PoolState {
  workspaces: Record<string, WorkspaceEntry>;
}

/**
 * History event types for the append-only event log.
 */
export type HistoryEventType =
  | "task.created"
  | "task.updated"
  | "agent.spawned"
  | "agent.crashed"
  | "auto.advanced"
  | "status.changed"
  | "task.merged"
  | "task.cancelled"
  | "pr.created"
  | "pr.merged"
  // Legacy event types (used by existing CLI code, will be removed in v2 CLI rewrite)
  | "review.started"
  | "review.passed"
  | "agent.stopped";

/**
 * Base history event structure.
 */
export interface HistoryEventBase {
  /** Event type */
  type: HistoryEventType;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/**
 * Task created event.
 */
export interface TaskCreatedEvent extends HistoryEventBase {
  type: "task.created";
  task_id: string;
  project: string;
  branch: string;
  summary: string;
}

/**
 * Task updated event.
 */
export interface TaskUpdatedEvent extends HistoryEventBase {
  type: "task.updated";
  changes: {
    branch?: { from: string; to: string };
    summary?: boolean;
  };
}

/**
 * Agent spawned event.
 */
export interface AgentSpawnedEvent extends HistoryEventBase {
  type: "agent.spawned";
  workspace: string;
  tmux_session: string;
}

/**
 * Agent crashed event.
 */
export interface AgentCrashedEvent extends HistoryEventBase {
  type: "agent.crashed";
  status: TaskStatus;
  crash_count: number;
  reason: string;
}

/**
 * Auto-advanced event (exit monitor advanced the task).
 */
export interface AutoAdvancedEvent extends HistoryEventBase {
  type: "auto.advanced";
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}

/**
 * Status changed event.
 */
export interface StatusChangedEvent extends HistoryEventBase {
  type: "status.changed";
  from: TaskStatus;
  to: TaskStatus;
}

/**
 * Task merged event.
 */
export interface TaskMergedEvent extends HistoryEventBase {
  type: "task.merged";
  commit_hash: string;
  strategy?: "ff" | "merge";
  /** Alias for commit_hash matching data.md format */
  commit?: string;
}

/**
 * Task cancelled event.
 */
export interface TaskCancelledEvent extends HistoryEventBase {
  type: "task.cancelled";
  reason?: string;
}

/**
 * PR created event.
 */
export interface PRCreatedEvent extends HistoryEventBase {
  type: "pr.created";
  url: string;
}

/**
 * PR merged event.
 */
export interface PRMergedEvent extends HistoryEventBase {
  type: "pr.merged";
  url: string;
  merge_commit: string;
}

// Legacy event interfaces (used by existing CLI code, will be removed in v2 CLI rewrite)

export interface ReviewStartedEvent extends HistoryEventBase {
  type: "review.started";
  attempt: number;
}

export interface ReviewPassedEvent extends HistoryEventBase {
  type: "review.passed";
  attempt: number;
}

export interface AgentStoppedEvent extends HistoryEventBase {
  type: "agent.stopped";
  outcome: "passed" | "stuck" | "failed";
  reason?: string;
}

/**
 * Union type of all history events.
 */
export type HistoryEvent =
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | AgentSpawnedEvent
  | AgentCrashedEvent
  | AutoAdvancedEvent
  | StatusChangedEvent
  | TaskMergedEvent
  | TaskCancelledEvent
  | PRCreatedEvent
  | PRMergedEvent
  | ReviewStartedEvent
  | ReviewPassedEvent
  | AgentStoppedEvent;

/**
 * Agent task outcome written to .orange-task file.
 */
export interface AgentTaskOutcome {
  id: string;
  outcome: "passed" | "stuck";
  reason?: string;
}
