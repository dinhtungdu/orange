/**
 * Agent prompt generation and lifecycle management.
 *
 * Files in worktree:
 * - TASK.md: Symlinked from task folder, contains task summary + context
 */

import type { Task } from "./types.js";

/**
 * Build the agent prompt for initial spawn.
 * Returns empty string if no summary (clarification mode).
 */
export function buildAgentPrompt(task: Task): string {
  // No summary = clarification mode, no prompt
  if (!task.summary.trim()) {
    return "";
  }

  return `# Task: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}

Read the orange skill for workflow instructions.`;
}

/**
 * Build the respawn prompt for resuming a dead session.
 * Returns empty string if no summary (clarification mode).
 */
export function buildRespawnPrompt(task: Task): string {
  // No summary = clarification mode, no prompt
  if (!task.summary.trim()) {
    return "";
  }

  return `# Resuming Task: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}
Status: ${task.status}

Read the orange skill for workflow instructions.

Check current status and continue accordingly:
- reviewing → already done, stop
- agent-review → stop, review agent will be spawned separately
- stuck → continue implementation
- clarification → wait for user input
- working (review_round > 0) → read ## Review feedback in TASK.md, fix issues, then set --status agent-review
- working → continue implementation`;
}

/**
 * Build the review agent prompt.
 * Review agent evaluates worker's changes and writes ## Review to TASK.md.
 */
export function buildReviewPrompt(task: Task): string {
  const isLastRound = task.review_round >= 2;
  return `# Review Task: ${task.summary}

Project: ${task.project}
Branch: ${task.branch}
Review round: ${task.review_round} of 2

You are a code reviewer. Review the changes on this branch.

## Instructions

1. Read TASK.md for requirements (summary, context, notes)
2. Review the diff: git diff origin/HEAD...HEAD
3. Use PR review toolkit/skill if available
4. Evaluate:
   - Requirements met?
   - Code quality, bugs, edge cases
   - Tests present and passing?
5. Write ## Review section in TASK.md body with:
   - PASS or FAIL verdict
   - Specific feedback per file/issue
6. Update status:
   - If PASS: orange task update --status reviewing
   - If FAIL${isLastRound ? " (round 2 — final)" : ""}: orange task update --status ${isLastRound ? "stuck" : "working"}

Do NOT modify any code. Review only.`;
}
