/**
 * Start command - creates and attaches to the orchestrator session.
 *
 * Must be run from a project directory (git repository).
 * Auto-registers the project if not already in projects.json.
 *
 * Creates a tmux session '<project>-orchestrator' with:
 * - Pane 0: Claude Code with orange skill (cwd = project directory)
 * - Pane 1: Dashboard TUI (project-scoped)
 *
 * Uses `tmux new-session -A` which attaches if session exists,
 * or creates and attaches if not.
 */

import type { Deps } from "../../core/types.js";
import { autoRegisterProject } from "../../core/cwd.js";

/**
 * Get the orchestrator session name for a project.
 */
export function getOrchestratorSession(projectName: string): string {
  return `${projectName}-orchestrator`;
}

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

  // Auto-register project (will error if not in a git repo)
  const project = await autoRegisterProject(deps);
  const sessionName = getOrchestratorSession(project.name);

  // Check if session exists - if not, set it up first
  const exists = await deps.tmux.sessionExists(sessionName);
  if (!exists) {
    // Create new session with Claude Code in first pane
    // Working directory is the project path (orchestrator has full context)
    await deps.tmux.newSession(
      sessionName,
      project.path,
      "claude"
    );

    // Split window and run dashboard in second pane (project-scoped)
    // Use full path since 'orange' alias isn't available in non-interactive shell
    const orangePath = `${process.env.HOME}/workspace/orange/src/index.ts`;
    const dashboardCmd = `bun run ${orangePath} dashboard --project ${project.name}`;
    try {
      await deps.tmux.splitWindow(sessionName, dashboardCmd);
    } catch (err) {
      // If split fails, the session is still usable - just warn
      console.warn("Warning: Failed to set up dashboard pane");
      console.warn(err instanceof Error ? err.message : String(err));
      console.warn("You can manually split the window and run 'orange dashboard' for the dashboard");
    }
  }

  // Attach to session (works whether we just created it or it already existed)
  await deps.tmux.attachOrCreate(sessionName, project.path);
}
