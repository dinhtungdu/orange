/**
 * Start command - creates the orchestrator session.
 *
 * Creates a tmux session 'orange-orchestrator' with:
 * - Pane 0: Claude Code with orange skill
 * - Pane 1: Dashboard TUI
 */

import type { Deps } from "../../core/types.js";

const ORCHESTRATOR_SESSION = "orange-orchestrator";

/**
 * Run the start command.
 */
export async function runStartCommand(deps: Deps): Promise<void> {
  // Check if session already exists
  const exists = await deps.tmux.sessionExists(ORCHESTRATOR_SESSION);
  if (exists) {
    console.log(`Session '${ORCHESTRATOR_SESSION}' already exists.`);
    console.log(`Run: tmux attach -t ${ORCHESTRATOR_SESSION}`);
    return;
  }

  // Create new session with Claude Code in first pane
  await deps.tmux.newSession(
    ORCHESTRATOR_SESSION,
    process.cwd(),
    "claude"
  );

  // Split window and run dashboard in second pane
  // Note: We use sendKeys to split and run dashboard since our interface doesn't have split-window
  await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, 'C-b "'); // Split horizontally
  await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, "orange"); // Run dashboard
  await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, "Enter");

  console.log(`Created orchestrator session '${ORCHESTRATOR_SESSION}'`);
  console.log(`Run: tmux attach -t ${ORCHESTRATOR_SESSION}`);
}
