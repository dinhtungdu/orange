/**
 * Start command - creates and attaches to the orchestrator session.
 *
 * Creates a tmux session 'orange-orchestrator' with:
 * - Pane 0: Claude Code with orange skill
 * - Pane 1: Dashboard TUI
 *
 * Uses `tmux new-session -A` which attaches if session exists,
 * or creates and attaches if not.
 */

import type { Deps } from "../../core/types.js";

const ORCHESTRATOR_SESSION = "orange-orchestrator";

/**
 * Run the start command.
 */
export async function runStartCommand(deps: Deps): Promise<void> {
  // Check if session exists - if not, set it up first
  const exists = await deps.tmux.sessionExists(ORCHESTRATOR_SESSION);
  if (!exists) {
    // Create new session with Claude Code in first pane
    await deps.tmux.newSession(
      ORCHESTRATOR_SESSION,
      deps.dataDir,
      "claude"
    );

    // Split window and run dashboard in second pane
    await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, 'C-b "'); // Split horizontally
    await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, "orange"); // Run dashboard
    await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, "Enter");
  }

  // Attach to session (works whether we just created it or it already existed)
  await deps.tmux.attachOrCreate(ORCHESTRATOR_SESSION, deps.dataDir);
}
