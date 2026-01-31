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
 * Flow: pending → working → reviewing → reviewed → done
 *                    ↑↓
 *              clarification (vague task or scope change)
 *                                     ↘ stuck
 *                         ↘ failed (crashed/errored)
 *       cancelled (from any active state)
 */
export type TaskStatus =
  | "pending" // Created but not spawned
  | "clarification" // Agent waiting for user input (vague task or scope change)
  | "working" // Agent actively processing (includes self-review)
  | "reviewing" // Self-review passed, awaiting human review
  | "reviewed" // Human approved, ready to merge
  | "stuck" // Agent gave up after max review attempts
  | "done" // Successfully merged/completed
  | "failed" // Agent crashed or errored
  | "cancelled"; // User cancelled

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
  /** Current status of the task */
  status: TaskStatus;
  /** Assigned workspace path (e.g., "orange--1"), null if not spawned */
  workspace: string | null;
  /** tmux session name (e.g., "orange/dark-mode"), null if not spawned */
  tmux_session: string | null;
  /** Human-readable task description (short, in frontmatter) */
  description: string;
  /** Free-form body content (context, questions, notes — agent-controlled) */
  body: string;
  /** ISO 8601 timestamp of task creation */
  created_at: string;
  /** ISO 8601 timestamp of last update */
  updated_at: string;
  /** GitHub PR URL, null if no PR created */
  pr_url: string | null;
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
  /** Send keys to a session */
  sendKeys(session: string, keys: string): Promise<void>;
  /** Split window horizontally and run command in new pane */
  splitWindow(session: string, command: string): Promise<void>;
  /** Attach to session if exists, create and attach if not (tmux new-session -A) */
  attachOrCreate(name: string, cwd: string): Promise<void>;
  /** Rename a session */
  renameSession(oldName: string, newName: string): Promise<void>;
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
  | "message"
  | "review.started"
  | "review.passed"
  | "agent.stopped"
  | "status.changed"
  | "task.merged"
  | "task.cancelled"
  | "pr.created"
  | "pr.merged";

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
 * Task updated event.
 */
export interface TaskUpdatedEvent extends HistoryEventBase {
  type: "task.updated";
  changes: {
    branch?: { from: string; to: string };
    description?: boolean;
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

/**
 * Union type of all history events.
 */
export type HistoryEvent =
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | AgentSpawnedEvent
  | MessageEvent
  | ReviewStartedEvent
  | ReviewPassedEvent
  | AgentStoppedEvent
  | StatusChangedEvent
  | TaskMergedEvent
  | TaskCancelledEvent
  | PRCreatedEvent
  | PRMergedEvent;

/**
 * Agent task outcome written to .orange-task file.
 */
export interface AgentTaskOutcome {
  id: string;
  outcome: "passed" | "stuck";
  reason?: string;
}
