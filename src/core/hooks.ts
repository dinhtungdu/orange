/**
 * Hook executor factory.
 *
 * Persistent worker model: worker session lives from pending to done/cancelled.
 * Reviewer spawns in background tmux window, worker gets notified via send-keys.
 */

import { join } from "node:path";
import type { Deps, Task, Harness } from "./types.js";
import type { HookExecutor, TransitionHook, SpawnAgentVariant } from "./transitions.js";
import { saveTask, appendHistory, loadProjects, getTaskPath } from "./state.js";
import { acquireWorkspace, releaseWorkspace, addGitExcludes, getWorkspacePath } from "./workspace.js";
import {
  buildWorkerPrompt,
  buildWorkerRespawnPrompt,
  buildWorkerWaitPrompt,
  buildReviewerPrompt,
  buildStuckFixPrompt,
} from "./agent.js";
import { HARNESSES } from "./harness.js";
import { spawnNextPending } from "./spawn.js";
import { linkTaskFile } from "./spawn.js";

/**
 * Variant → prompt builder mapping.
 */
function buildPromptForVariant(variant: SpawnAgentVariant, task: Task): string {
  switch (variant) {
    case "worker":
      // Empty summary = interactive session (clarification)
      return task.summary.trim() ? buildWorkerPrompt(task) : "";
    case "worker_respawn":
      return task.summary.trim() ? buildWorkerRespawnPrompt(task) : "";
    case "worker_wait":
      return buildWorkerWaitPrompt(task);
    case "reviewer":
      return buildReviewerPrompt(task);
    case "stuck_fix":
      return buildStuckFixPrompt(task);
  }
}

/**
 * Variant → harness selection.
 */
function harnessForVariant(variant: SpawnAgentVariant, task: Task): Harness {
  return variant === "reviewer" ? task.review_harness : task.harness;
}

/**
 * Variant → window name.
 */
function windowNameForVariant(variant: SpawnAgentVariant, task: Task): string {
  switch (variant) {
    case "worker":
      return "worker";
    case "worker_respawn":
      return "worker";
    case "worker_wait":
      return "worker";
    case "reviewer":
      return `review-${task.review_round}`;
    case "stuck_fix":
      return "worker-stuck";
  }
}

/**
 * Acquire workspace for a task.
 *
 * Acquires from pool, sets up git branch, symlinks TASK.md,
 * runs harness workspace setup. Writes task.workspace.
 *
 * No-op if task already has a workspace.
 */
export async function acquireWorkspaceHook(deps: Deps, task: Task): Promise<void> {
  if (task.workspace) return;

  const log = deps.logger.child("hooks");
  const projects = await loadProjects(deps);
  const project = projects.find((p) => p.name === task.project);
  if (!project) throw new Error(`Project '${task.project}' not found`);

  const workspace = await acquireWorkspace(deps, task.project, `${task.project}/${task.branch}`);
  log.debug("Workspace acquired", { workspace, project: task.project });

  const workspacePath = getWorkspacePath(deps, workspace);

  // Pull latest default branch from origin if available
  try {
    await deps.git.fetch(workspacePath);
    await deps.git.resetHard(workspacePath, `origin/${project.default_branch}`);
  } catch {
    // No remote
  }

  // Create or checkout branch
  const branchExists = await deps.git.branchExists(workspacePath, task.branch);
  if (branchExists) {
    try {
      await deps.git.checkout(workspacePath, task.branch);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes("already used by worktree")) {
        await releaseWorkspace(deps, workspace);
        throw new Error(
          `Branch '${task.branch}' is already checked out in another worktree. ` +
          `Switch the main repo to a different branch first.`
        );
      }
      await deps.git.createBranch(workspacePath, task.branch, `origin/${task.branch}`);
    }
  } else {
    await deps.git.createBranch(workspacePath, task.branch);
  }

  // Ensure git excludes
  await addGitExcludes(project.path);

  // Symlink TASK.md
  await linkTaskFile(deps, workspacePath, task.project, task.id);

  // Harness workspace setup (use worker harness for workspace setup)
  const harnessConfig = HARNESSES[task.harness];
  if (harnessConfig.workspaceSetup) {
    await harnessConfig.workspaceSetup(workspacePath);
  }

  task.workspace = workspace;
  await saveTask(deps, task);
}

/**
 * Spawn agent in tmux session.
 *
 * Creates new tmux session for the worker. One session per task.
 * Writes task.tmux_session, logs agent.spawned.
 */
export async function spawnAgentHook(
  deps: Deps,
  task: Task,
  variant: SpawnAgentVariant,
): Promise<void> {
  const log = deps.logger.child("hooks");

  if (!task.workspace) throw new Error("Cannot spawn agent without workspace");

  const workspacePath = getWorkspacePath(deps, task.workspace);
  const tmuxSession = `${task.project}/${task.branch}`;
  const harness = harnessForVariant(variant, task);
  const harnessConfig = HARNESSES[harness];
  const prompt = buildPromptForVariant(variant, task);
  const windowName = windowNameForVariant(variant, task);

  // Empty prompt = interactive session
  const isRespawnVariant = variant === "worker_respawn" || variant === "stuck_fix";
  const isReviewer = variant === "reviewer";
  const command = prompt
    ? (isRespawnVariant
        ? harnessConfig.respawnCommand(prompt)
        : isReviewer
          ? (harnessConfig.reviewSpawnCommand ?? harnessConfig.spawnCommand)(prompt)
          : harnessConfig.spawnCommand(prompt))
    : harnessConfig.binary;

  // Kill existing session to clean up stale windows from previous agents
  await deps.tmux.killSessionSafe(tmuxSession);

  await deps.tmux.newSession(tmuxSession, workspacePath, command);
  try {
    await deps.tmux.renameWindow(tmuxSession, windowName);
  } catch {
    // Best-effort
  }

  log.debug("Agent spawned", { session: tmuxSession, variant, window: windowName });

  task.tmux_session = tmuxSession;
  await saveTask(deps, task);

  await appendHistory(deps, task.project, task.id, {
    type: "agent.spawned",
    timestamp: deps.clock.now(),
    workspace: task.workspace,
    tmux_session: tmuxSession,
  });
}

/**
 * Spawn reviewer in a background tmux window within the existing session.
 *
 * Worker session stays alive in the main window. Reviewer runs in a new window.
 * Uses reviewSpawnCommand if available (e.g., Claude blocks Task tool to prevent
 * plugin agents from posting to GitHub).
 */
export async function spawnReviewerHook(deps: Deps, task: Task): Promise<void> {
  const log = deps.logger.child("hooks");

  if (!task.workspace) throw new Error("Cannot spawn reviewer without workspace");
  if (!task.tmux_session) throw new Error("Cannot spawn reviewer without active tmux session");

  const workspacePath = getWorkspacePath(deps, task.workspace);
  const harness = task.review_harness;
  const harnessConfig = HARNESSES[harness];
  const prompt = buildReviewerPrompt(task);
  const windowName = `review-${task.review_round}`;

  const command = (harnessConfig.reviewSpawnCommand ?? harnessConfig.spawnCommand)(prompt);

  await deps.tmux.newWindow(task.tmux_session, windowName, workspacePath, command);

  // Switch back to worker window so reviewer stays in background
  // and doesn't inherit the workspace view's manual window size
  await deps.tmux.selectWindowSafe(task.tmux_session, "worker");

  log.debug("Reviewer spawned in background window", {
    session: task.tmux_session,
    window: windowName,
  });

  await appendHistory(deps, task.project, task.id, {
    type: "agent.spawned",
    timestamp: deps.clock.now(),
    workspace: task.workspace,
    tmux_session: task.tmux_session,
  });
}

/**
 * Kill reviewer window only, leaving worker session alive.
 */
export async function killReviewerHook(deps: Deps, task: Task): Promise<void> {
  if (!task.tmux_session) return;

  const windowName = `review-${task.review_round}`;
  await deps.tmux.killWindowSafe(task.tmux_session, windowName);

  deps.logger.child("hooks").debug("Reviewer window killed", {
    session: task.tmux_session,
    window: windowName,
  });
}

/**
 * Notify worker via tmux send-keys that review is complete.
 *
 * Sends a message to the worker window telling it to read ## Review.
 */
export async function notifyWorkerHook(deps: Deps, task: Task): Promise<void> {
  if (!task.tmux_session) return;

  const target = `${task.tmux_session}:worker`;
  const message = [
    "",
    "# ━━━ Review complete ━━━",
    "# Status changed to: " + task.status,
    "# Read ## Review in TASK.md and continue.",
    "# If working: fix issues, update ## Handoff, set --status agent-review",
    "# If reviewing: review passed — you're done.",
    "",
  ].join("\n");

  try {
    await deps.tmux.sendKeys(target, message + "\n");
  } catch {
    // Worker window may not exist (crashed). Best-effort.
    deps.logger.child("hooks").warn("Failed to notify worker", {
      session: task.tmux_session,
    });
  }
}

/**
 * Create a HookExecutor that dispatches to the hook implementations above.
 */
export function createHookExecutor(deps: Deps): HookExecutor {
  const log = deps.logger.child("hooks");

  return async (hook: TransitionHook, task: Task): Promise<void> => {
    switch (hook.id) {
      case "acquire_workspace":
        await acquireWorkspaceHook(deps, task);
        break;

      case "spawn_agent":
        if (!hook.variant) throw new Error("spawn_agent hook requires variant");
        await spawnAgentHook(deps, task, hook.variant);
        break;

      case "spawn_reviewer":
        await spawnReviewerHook(deps, task);
        break;

      case "kill_reviewer":
        await killReviewerHook(deps, task);
        break;

      case "notify_worker":
        await notifyWorkerHook(deps, task);
        break;

      case "release_workspace":
        if (task.workspace) {
          await releaseWorkspace(deps, task.workspace, { force: true });
          task.workspace = null;
          await saveTask(deps, task);
        }
        break;

      case "kill_session":
        if (task.tmux_session) {
          await deps.tmux.killSessionSafe(task.tmux_session);
          task.tmux_session = null;
          await saveTask(deps, task);
        }
        break;

      case "increment_review_round":
        task.review_round += 1;
        await saveTask(deps, task);
        break;

      case "spawn_next":
        await spawnNextPending(deps, task.project);
        break;

      default:
        log.warn("Unknown hook", { hook: hook.id });
        break;
    }
  };
}
