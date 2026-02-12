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

Steps:
1. Read TASK.md — summary in frontmatter, context in body
2. If branch is orange-tasks/<id>, rename: git branch -m <old> <meaningful-name> && orange task update --branch
3. If empty/vague summary: add ## Questions to TASK.md, set --status clarification, wait
4. If no ## Context: document plan in ## Notes before coding
5. Read project rules (AGENTS.md, etc.), implement, test, commit
6. Write ## Handoff to TASK.md (DONE/REMAINING/DECISIONS/UNCERTAIN)
7. orange task update --status agent-review (triggers review agent)

IMPORTANT:
- Do NOT push to remote (no git push) — human handles that
- Do NOT set --status reviewing directly — always use agent-review
- ALWAYS write ## Handoff to TASK.md before setting --status agent-review

Read the orange skill for full details.`;
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
Review round: ${task.review_round}

Read ## Handoff in TASK.md first — it has structured state from the previous session.

Check status and act:
- reviewing → ready for human review, assist with any questions or changes the reviewer requests
- agent-review → stop, review agent will be spawned separately
- stuck → continue implementation, then write ## Handoff and set --status agent-review
- clarification → wait for user input
- working (review_round > 0) → read ## Review feedback in TASK.md, fix the issues, then write ## Handoff and set --status agent-review
- working → continue implementation, then write ## Handoff and set --status agent-review

IMPORTANT:
- Do NOT push to remote (no git push) — human handles that
- Do NOT set --status reviewing directly — always use agent-review
- ALWAYS write ## Handoff to TASK.md before setting --status agent-review

Read the orange skill for full details.`;
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

You MUST write a ## Review section to TASK.md body BEFORE setting status.

Steps:
1. Read TASK.md for requirements and ## Handoff for implementation state
2. Review diff: git diff origin/HEAD...HEAD
3. Check ## Handoff UNCERTAIN items — flag any that affect correctness
4. Write ## Review to TASK.md with verdict (PASS/FAIL) and specific feedback
4. Then set status: ${isLastRound
    ? "orange task update --status reviewing (pass) or --status stuck (fail, final round)"
    : "orange task update --status reviewing (pass) or --status working (fail)"}

IMPORTANT:
- Do NOT post comments or reviews to GitHub (no gh pr review, no gh pr comment)
- Do NOT set status without writing ## Review first
- Save ALL feedback to TASK.md only

Read the orange skill for detailed review agent instructions.`;
}
