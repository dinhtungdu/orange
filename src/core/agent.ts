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
 * 4. Self-review using a subagent
 * 5. Fix issues and re-review (max 3 attempts)
 * 6. Write outcome to .orange-task before stopping
 */
export function buildAgentPrompt(task: Task, workspacePath: string): string {
  return `You are working on task: ${task.description}

Project: ${task.project}
Branch: ${task.branch}
Worktree: ${workspacePath}

Instructions:
1. Read CLAUDE.md for project context and coding standards
2. Implement the task as described
3. Run tests and lint to verify your changes
4. When complete, spawn a review subagent using the Task tool to review your changes
5. If review finds issues, fix them and re-review (max 3 attempts)
6. Before stopping, write your outcome to .orange-task:
   - If review passed: {"id":"${task.id}","outcome":"passed"}
   - If stuck after 3 attempts: {"id":"${task.id}","outcome":"stuck","reason":"..."}
7. Only stop when review passes or you've exhausted 3 attempts

Review subagent prompt:
"Review the changes in this branch. Check for:
- Correctness: Does the implementation match the task requirements?
- Tests: Are there adequate tests? Do they pass?
- Style: Does the code follow project conventions in CLAUDE.md?
- Edge cases: Are error cases handled appropriately?

Respond with either:
- PASSED: Brief explanation of why the changes look good
- FAILED: Specific issues that need to be fixed"

Important:
- Commit your changes with descriptive messages
- Keep commits atomic and focused
- Do not push - the merge will be handled by the orchestrator
- Write the .orange-task file BEFORE you stop so the hook can read the outcome`;
}

/**
 * Parse the agent task outcome from .orange-task file content.
 */
export function parseAgentOutcome(
  content: string
): { id: string; outcome: "passed" | "stuck"; reason?: string } | null {
  try {
    const data = JSON.parse(content);
    if (typeof data.id === "string" && (data.outcome === "passed" || data.outcome === "stuck")) {
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
