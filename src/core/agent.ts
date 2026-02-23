/**
 * Agent prompt templates.
 *
 * Persistent worker model: one worker session for the entire task lifecycle.
 * Worker plans, implements, waits for review, fixes if needed.
 * Reviewer spawns in background window.
 *
 * See specs/workflow.md § Agent Prompts for the canonical definitions.
 */

import type { Task } from "./types.js";

/**
 * Worker prompt (persistent — entire task lifecycle).
 * Single agent session covering planning, implementation, and review-fix cycles.
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

After setting agent-review, WAIT. A reviewer will evaluate your work in a
separate session. When review completes, you'll receive a notification.
Then:
- Read ## Review in TASK.md
- If back in working status: fix the issues, update ## Handoff, set agent-review again
- If in reviewing status: review passed — you're done, no further action needed

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

Read TASK.md — check ## Plan, ## Handoff, and ## Review for previous progress.

If status is planning:
  1. Write ## Plan if not yet written
  2. orange task update --status working
  3. Continue to implementation

If status is working:
  1. Check ## Review — if present, fix issues from review feedback first
  2. Pick up where last session left off
  3. Write updated ## Handoff
  4. orange task update --status agent-review

After setting agent-review, WAIT for reviewer notification.
Then read ## Review and act accordingly (see above).

Do NOT push to remote.`;
}

/**
 * Reviewer prompt (background — working → agent-review).
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

You are in an interactive session. Work WITH the human to fix the issues.

1. Summarize what went wrong and propose a fix approach
2. Wait for human input before making changes
3. After fixing, proactively ask: "Issue fixed — ready to send for review?"
4. When human confirms: orange task update --status reviewing`;
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
