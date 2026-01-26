/**
 * Core types for the Orange agent orchestration system.
 *
 * These types define the fundamental data structures used throughout the application:
 * - Task: Represents a unit of work assigned to an agent
 * - Project: Represents a registered project that can have tasks
 * - Deps: Dependency injection container for external services
 */

/**
 * Task status represents the lifecycle state of a task.
 *
 * Flow: pending → working → needs_human → done
 *                        ↘ stuck (gave up after 3 reviews)
 *                        ↘ failed (crashed/errored)
 */
export type TaskStatus =
  | "pending" // Created but not spawned
  | "working" // Agent actively processing (includes self-review)
  | "needs_human" // Self-review passed, awaiting human review
  | "stuck" // Agent gave up after max review attempts
  | "done" // Successfully merged/completed
  | "failed"; // Agent crashed or errored

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
  /** Current status of the task */
  status: TaskStatus;
  /** Assigned workspace path (e.g., "orange--1"), null if not spawned */
  workspace: string | null;
  /** tmux session name (e.g., "orange/dark-mode"), null if not spawned */
  tmux_session: string | null;
  /** Human-readable task description */
  description: string;
  /** ISO 8601 timestamp of task creation */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
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
  /** Create a new tmux session. If logFile provided, captures all output to that file. */
  newSession(name: string, cwd: string, command: string, logFile?: string): Promise<void>;
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
  /** Send keys to a session */
  sendKeys(session: string, keys: string): Promise<void>;
  /** Split window horizontally and run command in new pane */
  splitWindow(session: string, command: string): Promise<void>;
  /** Attach to session if exists, create and attach if not (tmux new-session -A) */
  attachOrCreate(name: string, cwd: string): Promise<void>;
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
  /** Delete a branch (local) */
  deleteBranch(cwd: string, branch: string): Promise<void>;
  /** Delete a remote branch */
  deleteRemoteBranch(cwd: string, branch: string, remote?: string): Promise<void>;
  /** Merge a branch into current branch */
  merge(cwd: string, branch: string, strategy?: "ff" | "merge"): Promise<void>;
  /** Get current branch name */
  currentBranch(cwd: string): Promise<string>;
  /** Clean untracked files */
  clean(cwd: string): Promise<void>;
  /** Add worktree */
  addWorktree(cwd: string, path: string, branch: string): Promise<void>;
  /** Remove worktree */
  removeWorktree(cwd: string, path: string): Promise<void>;
  /** Get current commit hash (short or full) */
  getCommitHash(cwd: string, short?: boolean): Promise<string>;
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
  | "agent.spawned"
  | "message"
  | "review.started"
  | "review.passed"
  | "agent.stopped"
  | "status.changed"
  | "task.merged"
  | "task.cancelled";

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
  description: string;
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
 * Message event (agent communication).
 */
export interface MessageEvent extends HistoryEventBase {
  type: "message";
  content: string;
}

/**
 * Review started event.
 */
export interface ReviewStartedEvent extends HistoryEventBase {
  type: "review.started";
  attempt: number;
}

/**
 * Review passed event.
 */
export interface ReviewPassedEvent extends HistoryEventBase {
  type: "review.passed";
  attempt: number;
}

/**
 * Agent stopped event.
 */
export interface AgentStoppedEvent extends HistoryEventBase {
  type: "agent.stopped";
  outcome: "passed" | "stuck" | "failed";
  reason?: string;
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
  strategy: "ff" | "merge";
}

/**
 * Task cancelled event.
 */
export interface TaskCancelledEvent extends HistoryEventBase {
  type: "task.cancelled";
  reason?: string;
}

/**
 * Union type of all history events.
 */
export type HistoryEvent =
  | TaskCreatedEvent
  | AgentSpawnedEvent
  | MessageEvent
  | ReviewStartedEvent
  | ReviewPassedEvent
  | AgentStoppedEvent
  | StatusChangedEvent
  | TaskMergedEvent
  | TaskCancelledEvent;

/**
 * Agent task outcome written to .orange-task file.
 */
export interface AgentTaskOutcome {
  id: string;
  outcome: "passed" | "stuck";
  reason?: string;
}
