/**
 * Agent prompt generation and lifecycle management.
 *
 * Handles building the prompt injected into Claude Code agents
 * and managing the .orange-task file for hook integration.
 */

import type { Task } from "./types.js";

/**
 * Build the agent prompt for a task.
 *
 * The prompt instructs the agent to:
 * 1. Read CLAUDE.md for project context
 * 2. Implement the task
 * 3. Run tests and lint
 * 4. Self-review using claude --print subagent
 * 5. Fix issues and re-review (max 3 attempts)
 * 6. Write outcome to .orange-task before stopping
 */
export function buildAgentPrompt(task: Task, workspacePath: string, taskDir: string): string {
  return `You are working on task: ${task.description}

Project: ${task.project}
Branch: ${task.branch}
Worktree: ${workspacePath}
Task folder: ${taskDir}

Instructions:
1. Read CONTEXT.md in task folder for implementation details from the orchestrator
2. Read CLAUDE.md for project context and coding standards
3. Implement the task as described
4. Run tests and lint to verify your changes
5. When complete, self-review by running a review subagent:
   claude --print --prompt "Review the changes in this branch. Check:
   - Correctness: Does the implementation match the task requirements?
   - Tests: Are there adequate tests? Do they pass?
   - Style: Does the code follow project conventions in CLAUDE.md?
   - Edge cases: Are error cases handled appropriately?
   Respond with PASSED or FAILED with explanation."
6. If review finds issues, fix them and re-review (max 3 attempts)
7. Before stopping, write your outcome to .orange-task:
   - If review passed: {"id":"${task.id}","outcome":"passed"}
   - If stuck after 3 attempts: {"id":"${task.id}","outcome":"stuck","reason":"..."}
8. Only stop when review passes or you've exhausted 3 attempts

Important:
- Commit your changes with descriptive messages
- Keep commits atomic and focused
- Do not push - the merge will be handled by the orchestrator
- Write the .orange-task file BEFORE you stop so the hook can read the outcome`;
}

/**
 * Build the respawn prompt for a task.
 *
 * Different from initial spawn - instructs agent to:
 * 1. Check current state (.orange-task file)
 * 2. If already passed review, escalate to human
 * 3. Otherwise continue from where it left off
 */
export function buildRespawnPrompt(task: Task, workspacePath: string, taskDir: string): string {
  return `You are resuming work on task: ${task.description}

Project: ${task.project}
Branch: ${task.branch}
Worktree: ${workspacePath}
Task folder: ${taskDir}

FIRST: Check current state by reading .orange-task file.

If .orange-task shows outcome "passed":
- The task already passed agent review
- Write {"id":"${task.id}","outcome":"needs_human","reason":"Passed review, ready for human"} to .orange-task
- Stop immediately - human will review and merge

If .orange-task shows outcome "stuck" or doesn't exist:
- Continue with the task implementation
- Follow the standard workflow:
  1. Read CONTEXT.md in task folder for implementation details
  2. Read CLAUDE.md for project context
  3. Implement/fix the task
  4. Run tests and lint
  5. Self-review using: claude --print --prompt "Review the changes..."
  6. Fix issues and re-review (max 3 attempts total)
  7. Write outcome to .orange-task before stopping

Important:
- Commit changes with descriptive messages
- Keep commits atomic and focused
- Do not push - merge handled by orchestrator
- Write .orange-task BEFORE stopping`;
}

/**
 * Parse the agent task outcome from .orange-task file content.
 */
export function parseAgentOutcome(
  content: string
): { id: string; outcome: "passed" | "stuck" | "needs_human"; reason?: string } | null {
  try {
    const data = JSON.parse(content);
    if (typeof data.id === "string" && (data.outcome === "passed" || data.outcome === "stuck" || data.outcome === "needs_human")) {
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
