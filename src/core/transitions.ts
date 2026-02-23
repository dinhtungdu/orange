/**
 * Workflow engine: deterministic state machine driving task lifecycle.
 *
 * Agents write artifacts, the engine validates and gates transitions.
 * No agent decides its own fate.
 *
 * Persistent worker model: worker session lives from pending to done/cancelled.
 * Reviewer spawns in background window, worker gets notified when review completes.
 *
 * See specs/workflow.md for the full specification.
 */

import type { Task, TaskStatus, Deps } from "./types.js";
import {
  saveTask,
  appendHistory,
  validatePlanGate,
  validateHandoffGate,
  validateReviewGate,
} from "./state.js";

/**
 * Hook identifiers. Actual implementations live in their respective modules.
 * The transition engine defines which hooks fire; execution is handled by callers.
 */
export type HookId =
  | "acquire_workspace"
  | "release_workspace"
  | "spawn_agent"
  | "spawn_reviewer"
  | "kill_session"
  | "kill_reviewer"
  | "notify_worker"
  | "spawn_next"
  | "delete_remote_branch"
  | "increment_review_round";

/**
 * Spawn agent variants passed as hook argument.
 */
export type SpawnAgentVariant = "worker" | "worker_respawn" | "reviewer" | "stuck_fix";

/**
 * Hook entry in a transition definition.
 */
export interface TransitionHook {
  id: HookId;
  /** For spawn_agent hooks, which prompt variant to use */
  variant?: SpawnAgentVariant;
}

/**
 * Artifact gate function type.
 */
export type GateFn = (body: string) => boolean;

/**
 * Condition function type. Evaluated against the task.
 */
export type ConditionFn = (task: Task) => boolean;

/**
 * A single transition definition in the state machine.
 */
export interface TransitionDef {
  from: TaskStatus;
  to: TaskStatus;
  gate?: GateFn;
  condition?: ConditionFn;
  hooks: TransitionHook[];
}

/**
 * The complete transition map. Every valid transition is listed here.
 * Any transition not in this map is rejected.
 *
 * Persistent worker model: worker never killed during normal flow.
 * Reviewer spawns in background window via spawn_reviewer hook.
 */
export const TRANSITION_MAP: TransitionDef[] = [
  // pending → planning: acquire workspace and spawn worker agent
  {
    from: "pending",
    to: "planning",
    hooks: [
      { id: "acquire_workspace" },
      { id: "spawn_agent", variant: "worker" },
    ],
  },
  // pending → cancelled: no hooks needed
  {
    from: "pending",
    to: "cancelled",
    hooks: [],
  },
  // planning → working: requires valid ## Plan, no hooks (same agent session continues)
  {
    from: "planning",
    to: "working",
    gate: validatePlanGate,
    hooks: [],
  },
  // planning → clarification: agent needs user input
  {
    from: "planning",
    to: "clarification",
    hooks: [],
  },
  // planning → cancelled
  {
    from: "planning",
    to: "cancelled",
    hooks: [
      { id: "kill_session" },
      { id: "release_workspace" },
    ],
  },
  // clarification → planning: user answered questions
  {
    from: "clarification",
    to: "planning",
    hooks: [],
  },
  // clarification → cancelled
  {
    from: "clarification",
    to: "cancelled",
    hooks: [
      { id: "kill_session" },
      { id: "release_workspace" },
    ],
  },
  // working → agent-review: worker stays alive, reviewer spawns in background window
  {
    from: "working",
    to: "agent-review",
    gate: validateHandoffGate,
    hooks: [
      { id: "spawn_reviewer" },
      { id: "increment_review_round" },
    ],
  },
  // working → clarification
  {
    from: "working",
    to: "clarification",
    hooks: [],
  },
  // working → stuck: no spawn — worker session is still alive for human interaction
  {
    from: "working",
    to: "stuck",
    hooks: [],
  },
  // working → cancelled
  {
    from: "working",
    to: "cancelled",
    hooks: [
      { id: "kill_session" },
      { id: "release_workspace" },
    ],
  },
  // agent-review → reviewing: review passed, kill reviewer window only
  {
    from: "agent-review",
    to: "reviewing",
    gate: (body) => validateReviewGate(body, "PASS"),
    hooks: [
      { id: "kill_reviewer" },
    ],
  },
  // agent-review → working: review failed, round < 2, kill reviewer + notify worker
  {
    from: "agent-review",
    to: "working",
    gate: (body) => validateReviewGate(body, "FAIL"),
    condition: (task) => task.review_round < 2,
    hooks: [
      { id: "kill_reviewer" },
      { id: "notify_worker" },
    ],
  },
  // agent-review → stuck: review failed, round >= 2, kill reviewer only (worker still alive)
  {
    from: "agent-review",
    to: "stuck",
    gate: (body) => validateReviewGate(body, "FAIL"),
    condition: (task) => task.review_round >= 2,
    hooks: [
      { id: "kill_reviewer" },
    ],
  },
  // agent-review → cancelled: kill both reviewer and worker
  {
    from: "agent-review",
    to: "cancelled",
    hooks: [
      { id: "kill_reviewer" },
      { id: "kill_session" },
      { id: "release_workspace" },
    ],
  },
  // reviewing → working: human requests changes, notify persistent worker
  {
    from: "reviewing",
    to: "working",
    hooks: [
      { id: "notify_worker" },
    ],
  },
  // reviewing → done: human approves
  {
    from: "reviewing",
    to: "done",
    hooks: [
      { id: "kill_session" },
      { id: "release_workspace" },
      { id: "delete_remote_branch" },
      { id: "spawn_next" },
    ],
  },
  // reviewing → cancelled
  {
    from: "reviewing",
    to: "cancelled",
    hooks: [
      { id: "kill_session" },
      { id: "release_workspace" },
    ],
  },
  // stuck → reviewing: human fixed it interactively
  {
    from: "stuck",
    to: "reviewing",
    hooks: [],
  },
  // stuck → cancelled
  {
    from: "stuck",
    to: "cancelled",
    hooks: [
      { id: "kill_session" },
      { id: "release_workspace" },
    ],
  },
];

/**
 * Find a matching transition definition.
 * Returns null if no valid transition exists.
 */
export function findTransition(
  from: TaskStatus,
  to: TaskStatus,
  task: Task,
): TransitionDef | null {
  for (const def of TRANSITION_MAP) {
    if (def.from !== from || def.to !== to) continue;
    // Check condition if present
    if (def.condition && !def.condition(task)) continue;
    return def;
  }
  return null;
}

/**
 * Hook executor function type.
 * Callers provide this to execute hooks during transition.
 */
export type HookExecutor = (hook: TransitionHook, task: Task) => Promise<void>;

/**
 * Transition result.
 */
export interface TransitionResult {
  success: true;
  from: TaskStatus;
  to: TaskStatus;
  hooks: TransitionHook[];
}

/**
 * Transition error.
 */
export class TransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
    public readonly reason: string,
  ) {
    super(`Transition ${from} → ${to} rejected: ${reason}`);
    this.name = "TransitionError";
  }
}

/**
 * Execute a status transition on a task.
 *
 * Steps (per specs/workflow.md § Transition Execution):
 * 1. Validate transition exists in map
 * 2. Evaluate condition — reject if false
 * 3. Validate artifact gate — reject if invalid
 * 4. Write new status to TASK.md
 * 5. Execute hooks in order
 * 6. Reset crash_count to 0
 * 7. Log history event
 */
export async function executeTransition(
  task: Task,
  targetStatus: TaskStatus,
  deps: Deps,
  executeHook: HookExecutor,
): Promise<TransitionResult> {
  const log = deps.logger.child("transitions");
  const from = task.status;

  log.debug("Attempting transition", { from, to: targetStatus, taskId: task.id });

  // 1 & 2. Find valid transition (includes condition check)
  const def = findTransition(from, targetStatus, task);
  if (!def) {
    throw new TransitionError(from, targetStatus, "no valid transition in map");
  }

  // 3. Validate artifact gate
  if (def.gate && !def.gate(task.body)) {
    throw new TransitionError(from, targetStatus, "artifact gate validation failed");
  }

  // 4. Write new status to TASK.md
  task.status = targetStatus;
  task.updated_at = deps.clock.now();
  await saveTask(deps, task);

  // 5. Execute hooks in order
  for (const hook of def.hooks) {
    try {
      await executeHook(hook, task);
    } catch (err) {
      // Hook failure after status write: log error, mark task for attention.
      // Don't roll back.
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Hook failed after status write", {
        hook: hook.id,
        taskId: task.id,
        error: errMsg,
      });
    }
  }

  // 6. Reset crash_count to 0
  task.crash_count = 0;
  task.updated_at = deps.clock.now();
  await saveTask(deps, task);

  // 7. Log history event
  await appendHistory(deps, task.project, task.id, {
    type: "status.changed",
    timestamp: deps.clock.now(),
    from,
    to: targetStatus,
  });

  log.info("Transition complete", { from, to: targetStatus, taskId: task.id });

  return {
    success: true,
    from,
    to: targetStatus,
    hooks: def.hooks,
  };
}
