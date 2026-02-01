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
- stuck → continue implementation
- clarification → wait for user input
- working → continue implementation`;
}
