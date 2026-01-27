/**
 * Agent prompt generation and lifecycle management.
 *
 * Files in worktree:
 * - TASK.md: Symlinked from task folder, contains task description + context
 * - .orange-outcome: JSON file for hook integration (written by agent before stopping)
 */

import type { Task } from "./types.js";

/** Shared workflow instructions for agents. */
const WORKFLOW = `
## Workflow

1. Read TASK.md for task description and implementation context
2. Read CLAUDE.md for project conventions
3. Implement the task
4. Run tests and lint
5. Self-review using /code-review skill
6. If review finds issues, fix and re-review (max 2 attempts)
7. Write outcome to .orange-outcome before stopping

## Rules

- Commit with descriptive messages, keep commits atomic
- Do not push - orchestrator handles merge
- Write .orange-outcome BEFORE stopping so hook can read it`;

/**
 * Build the agent prompt for initial spawn.
 */
export function buildAgentPrompt(task: Task): string {
  return `# Task: ${task.description}

Project: ${task.project}
Branch: ${task.branch}
${WORKFLOW}

## Outcome Format

Write to .orange-outcome:
- Passed: {"id":"${task.id}","outcome":"passed"}
- Stuck (after 2 failed reviews): {"id":"${task.id}","outcome":"stuck","reason":"..."}`;
}

/**
 * Build the respawn prompt for resuming a dead session.
 */
export function buildRespawnPrompt(task: Task): string {
  return `# Resuming Task: ${task.description}

Project: ${task.project}
Branch: ${task.branch}

## First: Check Current State

Read .orange-outcome file.

If outcome is "passed":
- Task already passed review
- Write {"id":"${task.id}","outcome":"reviewing"} to .orange-outcome
- Stop immediately

If outcome is "stuck" or file missing:
- Continue with implementation
${WORKFLOW}

## Outcome Format

Write to .orange-outcome:
- Passed: {"id":"${task.id}","outcome":"passed"}
- Stuck (after 2 failed reviews): {"id":"${task.id}","outcome":"stuck","reason":"..."}`;
}

/**
 * Parse the agent outcome from .orange-outcome file content.
 */
export function parseAgentOutcome(
  content: string
): { id: string; outcome: "passed" | "stuck" | "reviewing"; reason?: string } | null {
  try {
    const data = JSON.parse(content);
    if (typeof data.id === "string" && (data.outcome === "passed" || data.outcome === "stuck" || data.outcome === "reviewing")) {
      return {
        id: data.id,
        outcome: data.outcome,
        reason: data.reason,
      };
    }
    return null;
  } catch {
    return null;
  }
}
