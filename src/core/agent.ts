/**
 * Agent prompt generation and lifecycle management.
 *
 * Files in worktree:
 * - TASK.md: Symlinked from task folder, contains task description + context
 */

import type { Task } from "./types.js";

/**
 * Build the agent prompt for initial spawn.
 * Returns empty string if no description (interactive session).
 */
export function buildAgentPrompt(task: Task): string {
  // No description = interactive session, no prompt
  if (!task.description.trim()) {
    return "";
  }

  return `# Task: ${task.description}

Project: ${task.project}
Branch: ${task.branch}

Read the orange skill for workflow instructions.`;
}

/**
 * Build the respawn prompt for resuming a dead session.
 * Returns empty string if no description (interactive session).
 */
export function buildRespawnPrompt(task: Task): string {
  // No description = interactive session, no prompt
  if (!task.description.trim()) {
    return "";
  }

  return `# Resuming Task: ${task.description}

Project: ${task.project}
Branch: ${task.branch}
Status: ${task.status}

Read the orange skill for workflow instructions.

Check current status and continue accordingly:
- reviewing → already done, stop
- stuck → continue implementation
- clarification → wait for user input
- working → continue implementation`;
}
