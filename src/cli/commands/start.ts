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
  // Check if tmux is available
  const tmuxAvailable = await deps.tmux.isAvailable();
  if (!tmuxAvailable) {
    console.error("Error: tmux is not installed or not in PATH");
    console.error("Install tmux to use the orchestrator:");
    console.error("  macOS: brew install tmux");
    console.error("  Ubuntu: apt install tmux");
    process.exit(1);
  }

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
    // Wait a bit for session to initialize before sending keys
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, 'C-b "'); // Split horizontally
      await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, "orange"); // Run dashboard
      await deps.tmux.sendKeys(ORCHESTRATOR_SESSION, "Enter");
    } catch (err) {
      // If sendKeys fails, the session is still usable - just warn
      console.warn("Warning: Failed to set up dashboard pane");
      console.warn(err instanceof Error ? err.message : String(err));
      console.warn("You can manually split the window and run 'orange' for the dashboard");
    }
  }

  // Attach to session (works whether we just created it or it already existed)
  await deps.tmux.attachOrCreate(ORCHESTRATOR_SESSION, deps.dataDir);
}
