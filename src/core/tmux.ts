/**
 * Tmux abstraction layer for session management.
 *
 * Provides both real tmux execution and mock implementation for testing.
 * Session naming convention: <project>/<branch> (e.g., "orange/dark-mode")
 */

import type { TmuxExecutor } from "./types.js";

/**
 * Execute a shell command and return stdout.
 */
async function exec(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * RealTmux implements TmuxExecutor using actual tmux commands.
 */
export class RealTmux implements TmuxExecutor {
  private tmuxAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.tmuxAvailable !== null) {
      return this.tmuxAvailable;
    }

    const { exitCode } = await exec("which", ["tmux"]);
    this.tmuxAvailable = exitCode === 0;
    return this.tmuxAvailable;
  }

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    // Wrap command to drop into shell after exit, so humans can review output and run commands.
    // Uses $SHELL to respect user's default shell (zsh, fish, etc).
    const wrappedCommand = `bash -c '${command.replace(/'/g, "'\\''")}; exec \${SHELL:-bash}'`;

    const { exitCode, stderr } = await exec("tmux", [
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwd,
      wrappedCommand,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to create tmux session '${name}': ${stderr}`);
    }
  }

  async killSession(name: string): Promise<void> {
    const { exitCode, stderr } = await exec("tmux", [
      "kill-session",
      "-t",
      name,
    ]);

    if (exitCode !== 0 && !stderr.includes("no server running")) {
      throw new Error(`Failed to kill tmux session '${name}': ${stderr}`);
    }
  }

  async killSessionSafe(name: string): Promise<void> {
    try {
      await this.killSession(name);
    } catch {
      // Ignore errors - session may not exist
    }
  }

  async listSessions(): Promise<string[]> {
    const { stdout, exitCode } = await exec("tmux", [
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);

    if (exitCode !== 0) {
      // No sessions or no server running
      return [];
    }

    return stdout
      .trim()
      .split("\n")
      .filter((s) => s.length > 0);
  }

  async sessionExists(name: string): Promise<boolean> {
    const { exitCode } = await exec("tmux", ["has-session", "-t", name]);
    return exitCode === 0;
  }

  async capturePane(session: string, lines: number): Promise<string> {
    const { stdout, exitCode, stderr } = await exec("tmux", [
      "capture-pane",
      "-t",
      session,
      "-p",
      "-S",
      `-${lines}`,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Failed to capture pane from session '${session}': ${stderr}`
      );
    }

    return stdout;
  }

  async capturePaneAnsi(session: string, _lines: number): Promise<string> {
    const { stdout, exitCode, stderr } = await exec("tmux", [
      "capture-pane",
      "-t",
      session,
      "-p",
      "-e", // Preserve ANSI escape sequences
      // No -S flag: captures visible viewport (respects copy-mode scroll position)
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Failed to capture pane from session '${session}': ${stderr}`
      );
    }

    return stdout;
  }

  async capturePaneAnsiSafe(session: string, lines: number): Promise<string | null> {
    try {
      return await this.capturePaneAnsi(session, lines);
    } catch {
      return null;
    }
  }

  async queryPaneInfo(session: string): Promise<{
    cursorX: number;
    cursorY: number;
    cursorVisible: boolean;
    paneWidth: number;
    paneHeight: number;
  } | null> {
    const { stdout, exitCode } = await exec("tmux", [
      "display-message",
      "-t",
      session,
      "-p",
      "#{cursor_x},#{cursor_y},#{cursor_flag},#{pane_width},#{pane_height}",
    ]);

    if (exitCode !== 0) {
      return null;
    }

    const parts = stdout.trim().split(",");
    if (parts.length < 5) {
      return null;
    }

    return {
      cursorX: parseInt(parts[0], 10),
      cursorY: parseInt(parts[1], 10),
      cursorVisible: parts[2] !== "0",
      paneWidth: parseInt(parts[3], 10),
      paneHeight: parseInt(parts[4], 10),
    };
  }

  async resizePane(session: string, width: number, height: number): Promise<void> {
    // Set window-size to manual first
    await exec("tmux", ["set-option", "-t", session, "window-size", "manual"]);

    // Resize window
    const { exitCode, stderr } = await exec("tmux", [
      "resize-window",
      "-t",
      session,
      "-x",
      String(width),
      "-y",
      String(height),
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to resize pane '${session}': ${stderr}`);
    }
  }

  async resizePaneSafe(session: string, width: number, height: number): Promise<void> {
    try {
      await this.resizePane(session, width, height);
    } catch {
      // Ignore errors
    }
  }

  async capturePaneSafe(session: string, lines: number): Promise<string | null> {
    try {
      return await this.capturePane(session, lines);
    } catch {
      // Session may not exist
      return null;
    }
  }

  async newWindow(session: string, name: string, cwd: string, command: string): Promise<void> {
    const wrappedCommand = `bash -c '${command.replace(/'/g, "'\\''")}; exec \${SHELL:-bash}'`;

    const { exitCode, stderr } = await exec("tmux", [
      "new-window",
      "-t",
      session,
      "-n",
      name,
      "-c",
      cwd,
      wrappedCommand,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to create window '${name}' in session '${session}': ${stderr}`);
    }
  }

  async renameWindow(session: string, name: string): Promise<void> {
    const { exitCode, stderr } = await exec("tmux", [
      "rename-window",
      "-t",
      session,
      name,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to rename window in session '${session}': ${stderr}`);
    }
  }

  async sendKeys(session: string, keys: string): Promise<void> {
    const { exitCode, stderr } = await exec("tmux", [
      "send-keys",
      "-t",
      session,
      keys,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Failed to send keys to session '${session}': ${stderr}`
      );
    }
  }

  async splitWindow(session: string, command: string): Promise<void> {
    // Wrap command to drop into shell after exit, using user's default shell
    const wrappedCommand = `bash -c '${command.replace(/'/g, "'\\''")}; exec \${SHELL:-bash}'`;

    const { exitCode, stderr } = await exec("tmux", [
      "split-window",
      "-t",
      session,
      "-h", // Horizontal split (side by side)
      wrappedCommand,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Failed to split window in session '${session}': ${stderr}`
      );
    }
  }

  async attachOrCreate(name: string, cwd: string): Promise<void> {
    // If inside tmux, switch to session instead of attach (avoids nesting warning)
    if (process.env.TMUX) {
      const proc = Bun.spawn(["tmux", "switch-client", "-t", name], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
    } else {
      // Use Bun.spawn with inherited stdio for interactive attach
      const proc = Bun.spawn(["tmux", "new-session", "-A", "-s", name, "-c", cwd], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
    }
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const { exitCode, stderr } = await exec("tmux", [
      "rename-session",
      "-t",
      oldName,
      newName,
    ]);

    if (exitCode !== 0) {
      throw new Error(`Failed to rename tmux session '${oldName}': ${stderr}`);
    }
  }

  async sendLiteral(session: string, text: string): Promise<void> {
    const { exitCode, stderr } = await exec("tmux", [
      "send-keys",
      "-t",
      session,
      "-l",
      text,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `Failed to send literal to session '${session}': ${stderr}`
      );
    }
  }

  async scrollPane(session: string, direction: "up" | "down"): Promise<void> {
    // Enter copy-mode (no-op if already in copy-mode)
    await exec("tmux", ["copy-mode", "-t", session]);
    // Send scroll command within copy-mode
    const cmd = direction === "up" ? "scroll-up" : "scroll-down";
    await exec("tmux", ["send-keys", "-X", "-t", session, cmd]);
  }
}

/**
 * MockTmux implements TmuxExecutor for testing.
 * Tracks sessions in memory without actually running tmux.
 */
export class MockTmux implements TmuxExecutor {
  /** In-memory session storage */
  sessions: Map<string, { cwd: string; command: string; output: string[] }> =
    new Map();

  /** Mock availability state - defaults to true for tests */
  private available = true;

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  /**
   * Test helper: Set whether tmux is available.
   */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async newSession(name: string, cwd: string, command: string): Promise<void> {
    if (this.sessions.has(name)) {
      throw new Error(`Session '${name}' already exists`);
    }
    this.sessions.set(name, { cwd, command, output: [] });
  }

  async killSession(name: string): Promise<void> {
    this.sessions.delete(name);
  }

  async killSessionSafe(name: string): Promise<void> {
    this.sessions.delete(name);
  }

  async listSessions(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  async sessionExists(name: string): Promise<boolean> {
    return this.sessions.has(name);
  }

  async capturePane(session: string, lines: number): Promise<string> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    return sessionData.output.slice(-lines).join("\n");
  }

  async capturePaneSafe(session: string, lines: number): Promise<string | null> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      return null;
    }
    return sessionData.output.slice(-lines).join("\n");
  }

  async capturePaneAnsi(session: string, lines: number): Promise<string> {
    // Mock: same as capturePane (no ANSI in mock)
    return this.capturePane(session, lines);
  }

  async capturePaneAnsiSafe(session: string, lines: number): Promise<string | null> {
    return this.capturePaneSafe(session, lines);
  }

  async queryPaneInfo(session: string): Promise<{
    cursorX: number;
    cursorY: number;
    cursorVisible: boolean;
    paneWidth: number;
    paneHeight: number;
  } | null> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      return null;
    }
    // Mock: return default values
    return {
      cursorX: 0,
      cursorY: sessionData.output.length,
      cursorVisible: true,
      paneWidth: 80,
      paneHeight: 24,
    };
  }

  async resizePane(session: string, width: number, height: number): Promise<void> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    sessionData.output.push(`[resize: ${width}x${height}]`);
  }

  async resizePaneSafe(session: string, width: number, height: number): Promise<void> {
    try {
      await this.resizePane(session, width, height);
    } catch {
      // Ignore
    }
  }

  async newWindow(session: string, name: string, cwd: string, command: string): Promise<void> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    sessionData.output.push(`[window: ${name} cmd: ${command}]`);
  }

  async renameWindow(session: string, name: string): Promise<void> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    sessionData.output.push(`[rename-window: ${name}]`);
  }

  async sendKeys(session: string, keys: string): Promise<void> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    sessionData.output.push(`[keys: ${keys}]`);
  }

  async splitWindow(session: string, command: string): Promise<void> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    sessionData.output.push(`[split: ${command}]`);
  }

  async attachOrCreate(name: string, cwd: string): Promise<void> {
    // For testing, we just create the session if it doesn't exist
    if (!this.sessions.has(name)) {
      this.sessions.set(name, { cwd, command: "", output: [] });
    }
    // In mock, there's no actual attach - just simulate the session exists
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const session = this.sessions.get(oldName);
    if (!session) {
      throw new Error(`Session '${oldName}' not found`);
    }
    this.sessions.delete(oldName);
    this.sessions.set(newName, session);
  }

  async sendLiteral(session: string, text: string): Promise<void> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    sessionData.output.push(`[literal: ${text}]`);
  }

  async scrollPane(session: string, direction: "up" | "down"): Promise<void> {
    const sessionData = this.sessions.get(session);
    if (!sessionData) {
      throw new Error(`Session '${session}' not found`);
    }
    sessionData.output.push(`[scroll: ${direction}]`);
  }

  /**
   * Test helper: Add output to a session's captured pane.
   */
  addOutput(session: string, line: string): void {
    const sessionData = this.sessions.get(session);
    if (sessionData) {
      sessionData.output.push(line);
    }
  }

  /**
   * Test helper: Clear all sessions.
   */
  clear(): void {
    this.sessions.clear();
  }
}

/**
 * Create a real tmux executor for production use.
 */
export function createTmux(): TmuxExecutor {
  return new RealTmux();
}
