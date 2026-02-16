/**
 * Agent prompt templates.
 *
 * Each spawn_agent hook uses a prompt template.
 * Variables: {summary}, {project}, {branch}, {review_round}, {status}.
 *
 * See specs/workflow.md § Agent Prompts for the canonical definitions.
 */

import type { Task } from "./types.js";

/**
 * Worker prompt (pending → planning → working).
 * Single agent session covering both planning and implementation phases.
 */
export function buildWorkerPrompt(task: Task): string {
  return `# Task: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}

Phase 1 — Plan:
1. Read TASK.md — summary in frontmatter, context in body
2. If branch is orange-tasks/<id>, rename it and run: orange task update --branch
3. If requirements unclear: add ## Questions, set --status clarification, wait
4. Write ## Plan to TASK.md (APPROACH + TOUCHING, optional RISKS)
5. orange task update --status working

Phase 2 — Implement:
6. Read project rules (AGENTS.md, etc.)
7. Implement according to ## Plan, test, commit
8. Write ## Handoff (at least one of DONE/REMAINING/DECISIONS/UNCERTAIN)
9. orange task update --status agent-review

Do NOT push to remote.
Do NOT set --status reviewing — always use agent-review.`;
}

/**
 * Worker respawn prompt (crashed session resume).
 */
export function buildWorkerRespawnPrompt(task: Task): string {
  return `# Resuming: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}
Status: ${task.status}
Review round: ${task.review_round}

Read TASK.md — check ## Plan and ## Handoff for previous progress.

If status is planning:
  1. Write ## Plan if not yet written
  2. orange task update --status working
  3. Continue to implementation

If status is working:
  1. Pick up where last session left off
  2. Write updated ## Handoff
  3. orange task update --status agent-review

Do NOT push to remote.`;
}

/**
 * Worker fix prompt (review failed, address feedback).
 */
export function buildWorkerFixPrompt(task: Task): string {
  return `# Fixing: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}
Review round: ${task.review_round}

1. Read ## Review — specific feedback to address
1b. Read ## Fix Instructions if present — user-specified scope (only fix listed items)
2. Fix each issue
3. Commit changes
4. Write updated ## Handoff
5. orange task update --status agent-review

Do NOT push to remote.`;
}

/**
 * Reviewer prompt (working → agent-review).
 */
export function buildReviewerPrompt(task: Task): string {
  return `# Review: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}
Review round: ${task.review_round} of 2

1. Read TASK.md for requirements, ## Plan for approach, ## Handoff for state
2. Review diff: git diff origin/HEAD...HEAD
3. Check UNCERTAIN items for correctness risks
4. Write ## Review to TASK.md:
   - First line must be: "Verdict: PASS" or "Verdict: FAIL"
   - Then detailed, actionable feedback
5. Set status:
   - PASS → orange task update --status reviewing
   - FAIL, round < 2 → orange task update --status working
   - FAIL, round ≥ 2 → orange task update --status stuck

Do NOT post to GitHub. All feedback goes in TASK.md only.
The command rejects if ## Review is missing or has no verdict line.`;
}

/**
 * Clarification prompt (requirements unclear).
 */
export function buildClarificationPrompt(task: Task): string {
  return `# Task: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}

Requirements unclear. Write ## Questions to TASK.md with 2-3 specific questions.
Run: orange task update --status clarification
Wait for user to attach and discuss.

After discussion:
1. orange task update --summary "..."
2. Write ## Plan (APPROACH + TOUCHING)
3. orange task update --status working`;
}

/**
 * Stuck fix prompt (respawn from stuck).
 */
export function buildStuckFixPrompt(task: Task): string {
  return `# Stuck: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}
Review round: ${task.review_round}

Task stuck — review failed twice or repeated crashes.
Read ## Review, ## Plan, and ## Handoff for what went wrong.

1. Address the root issues
2. Write updated ## Handoff
3. orange task update --status agent-review`;
}

// --- Backwards-compatible aliases used by spawn.ts ---

/**
 * Build the agent prompt for initial spawn (worker).
 * Returns empty string if no summary (clarification mode).
 */
export function buildAgentPrompt(task: Task): string {
  if (!task.summary.trim()) {
    return "";
  }
  return buildWorkerPrompt(task);
}

/**
 * Build the respawn prompt for resuming a dead session.
 * Returns empty string if no summary (clarification mode).
 */
export function buildRespawnPrompt(task: Task): string {
  if (!task.summary.trim()) {
    return "";
  }
  return buildWorkerRespawnPrompt(task);
}

/**
 * Build the review agent prompt.
 */
export function buildReviewPrompt(task: Task): string {
  return buildReviewerPrompt(task);
}
