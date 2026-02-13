/**
 * Exit monitoring: detects dead agent sessions and applies auto-advance rules.
 *
 * Dashboard health check (30s poll) detects dead agent sessions and
 * applies deterministic rules per specs/workflow.md § Exit Monitoring.
 */

import type { Task, TaskStatus, Deps } from "./types.js";
import {
  saveTask,
  appendHistory,
  validatePlanGate,
  validateHandoffGate,
  validateReviewGate,
} from "./state.js";
import {
  executeTransition,
  type HookExecutor,
} from "./transitions.js";

/** Crash count threshold before auto-advancing to stuck. */
const CRASH_THRESHOLD = 2;

/**
 * Result of checking a single task for dead session.
 */
export interface DeadSessionResult {
  task: Task;
  /** Whether the tmux session was found dead */
  isDead: boolean;
}

/**
 * Check which tasks have dead tmux sessions.
 *
 * Compare `tmux list-sessions` against tasks with active `tmux_session`.
 * Session gone + task in active status = dead session.
 */
export async function checkDeadSessions(
  tasks: Task[],
  deps: Deps,
): Promise<DeadSessionResult[]> {
  const log = deps.logger.child("exit-monitor");

  // Get live tmux sessions
  let liveSessions: string[];
  try {
    liveSessions = await deps.tmux.listSessions();
  } catch {
    log.warn("Failed to list tmux sessions");
    return [];
  }

  const liveSet = new Set(liveSessions);
  const results: DeadSessionResult[] = [];

  // Active statuses that should have a tmux session
  const activeStatuses: Set<TaskStatus> = new Set([
    "planning",
    "working",
    "agent-review",
    "clarification",
    "reviewing",
    "stuck",
  ]);

  for (const task of tasks) {
    if (!task.tmux_session) continue;
    if (!activeStatuses.has(task.status)) continue;

    const isDead = !liveSet.has(task.tmux_session);
    if (isDead) {
      log.info("Dead session detected", {
        taskId: task.id,
        session: task.tmux_session,
        status: task.status,
      });
    }
    results.push({ task, isDead });
  }

  return results;
}

/**
 * Auto-advance result for a single task.
 */
export interface AutoAdvanceResult {
  task: Task;
  action: "advanced" | "crashed" | "stuck" | "no-action";
  from?: TaskStatus;
  to?: TaskStatus;
  reason?: string;
}

/**
 * Apply auto-advance rules for a task with a dead session.
 *
 * Per-status rules (workflow.md § Exit Monitoring):
 * - planning: has valid ## Plan → advance to working; else crash
 * - working: has valid ## Handoff → advance to agent-review; else crash
 * - agent-review: has verdict → advance based on verdict; else crash
 * - clarification, reviewing, stuck: mark crashed, no auto-advance
 *
 * Crash tracking: increment crash_count, threshold of 2 → stuck.
 */
export async function applyAutoAdvanceRules(
  task: Task,
  deps: Deps,
  executeHook: HookExecutor,
): Promise<AutoAdvanceResult> {
  const log = deps.logger.child("exit-monitor");
  const status = task.status;

  log.debug("Applying auto-advance rules", { taskId: task.id, status });

  switch (status) {
    case "planning":
      return await handlePlanningExit(task, deps, executeHook);
    case "working":
      return await handleWorkingExit(task, deps, executeHook);
    case "agent-review":
      return await handleAgentReviewExit(task, deps, executeHook);
    case "clarification":
    case "reviewing":
    case "stuck":
      return await handleNoAutoAdvance(task, deps);
    default:
      return { task, action: "no-action" };
  }
}

/**
 * Handle dead session in planning status.
 * Has valid ## Plan → advance to working. Else crash.
 */
async function handlePlanningExit(
  task: Task,
  deps: Deps,
  executeHook: HookExecutor,
): Promise<AutoAdvanceResult> {
  if (validatePlanGate(task.body)) {
    await executeTransition(task, "working", deps, executeHook);
    await appendHistory(deps, task.project, task.id, {
      type: "auto.advanced",
      timestamp: deps.clock.now(),
      from: "planning",
      to: "working",
      reason: "## Plan found",
    });
    return { task, action: "advanced", from: "planning", to: "working", reason: "## Plan found" };
  }
  return await handleCrash(task, deps);
}

/**
 * Handle dead session in working status.
 * Has valid ## Handoff → advance to agent-review. Else crash.
 */
async function handleWorkingExit(
  task: Task,
  deps: Deps,
  executeHook: HookExecutor,
): Promise<AutoAdvanceResult> {
  if (validateHandoffGate(task.body)) {
    await executeTransition(task, "agent-review", deps, executeHook);
    await appendHistory(deps, task.project, task.id, {
      type: "auto.advanced",
      timestamp: deps.clock.now(),
      from: "working",
      to: "agent-review",
      reason: "## Handoff found",
    });
    return { task, action: "advanced", from: "working", to: "agent-review", reason: "## Handoff found" };
  }
  return await handleCrash(task, deps);
}

/**
 * Handle dead session in agent-review status.
 * Verdict: PASS → reviewing; FAIL + round < 2 → working; FAIL + round >= 2 → stuck. Else crash.
 */
async function handleAgentReviewExit(
  task: Task,
  deps: Deps,
  executeHook: HookExecutor,
): Promise<AutoAdvanceResult> {
  if (validateReviewGate(task.body, "PASS")) {
    await executeTransition(task, "reviewing", deps, executeHook);
    await appendHistory(deps, task.project, task.id, {
      type: "auto.advanced",
      timestamp: deps.clock.now(),
      from: "agent-review",
      to: "reviewing",
      reason: "Verdict: PASS",
    });
    return { task, action: "advanced", from: "agent-review", to: "reviewing", reason: "Verdict: PASS" };
  }

  if (validateReviewGate(task.body, "FAIL")) {
    if (task.review_round < 2) {
      await executeTransition(task, "working", deps, executeHook);
      await appendHistory(deps, task.project, task.id, {
        type: "auto.advanced",
        timestamp: deps.clock.now(),
        from: "agent-review",
        to: "working",
        reason: "Verdict: FAIL, respawning worker",
      });
      return { task, action: "advanced", from: "agent-review", to: "working", reason: "Verdict: FAIL, round < 2" };
    } else {
      await executeTransition(task, "stuck", deps, executeHook);
      await appendHistory(deps, task.project, task.id, {
        type: "auto.advanced",
        timestamp: deps.clock.now(),
        from: "agent-review",
        to: "stuck",
        reason: "Verdict: FAIL, max rounds reached",
      });
      return { task, action: "stuck", from: "agent-review", to: "stuck", reason: "Verdict: FAIL, round >= 2" };
    }
  }

  return await handleCrash(task, deps);
}

/**
 * Handle statuses with no auto-advance (clarification, reviewing, stuck).
 * Just mark crashed.
 */
async function handleNoAutoAdvance(
  task: Task,
  deps: Deps,
): Promise<AutoAdvanceResult> {
  return await handleCrash(task, deps);
}

/**
 * Handle a crash: increment crash_count, check threshold.
 * If crash_count >= CRASH_THRESHOLD → advance to stuck.
 * Otherwise just log the crash.
 */
async function handleCrash(
  task: Task,
  deps: Deps,
): Promise<AutoAdvanceResult> {
  const log = deps.logger.child("exit-monitor");
  const previousStatus = task.status;

  task.crash_count += 1;
  task.updated_at = deps.clock.now();

  await appendHistory(deps, task.project, task.id, {
    type: "agent.crashed",
    timestamp: deps.clock.now(),
    status: previousStatus,
    crash_count: task.crash_count,
    reason: `no required artifact for ${previousStatus}`,
  });

  if (task.crash_count >= CRASH_THRESHOLD) {
    log.info("Crash threshold reached, advancing to stuck", {
      taskId: task.id,
      crash_count: task.crash_count,
    });

    task.status = "stuck";
    await saveTask(deps, task);

    await appendHistory(deps, task.project, task.id, {
      type: "auto.advanced",
      timestamp: deps.clock.now(),
      from: previousStatus,
      to: "stuck",
      reason: `crash_count reached ${CRASH_THRESHOLD}`,
    });

    return {
      task,
      action: "stuck",
      from: previousStatus,
      to: "stuck",
      reason: `crash_count ${task.crash_count} >= ${CRASH_THRESHOLD}`,
    };
  }

  log.info("Task crashed, awaiting respawn", {
    taskId: task.id,
    crash_count: task.crash_count,
  });

  await saveTask(deps, task);

  return {
    task,
    action: "crashed",
    from: previousStatus,
    reason: `crash ${task.crash_count}/${CRASH_THRESHOLD}`,
  };
}
