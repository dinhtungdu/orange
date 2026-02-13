/**
 * Terminal panel for Orange workspace view.
 *
 * Renders tmux session output with adaptive polling.
 * Pure content panel — no UI chrome (workspace view manages layout).
 *
 * Rendering backends:
 * - ghostty-opentui (primary, optional) — full VT emulator
 * - Fallback ANSI parser — basic SGR handling
 */

import {
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { TmuxExecutor } from "../core/types.js";
import { ansiToStyledText } from "./ansi-parser.js";

// Adaptive polling intervals per workspace.md spec
const POLL_ACTIVE = 50;      // User typed within last 2s
const POLL_IDLE = 500;        // No recent input
const POLL_POST_KEYSTROKE = 20; // Immediate after sending key
const ACTIVITY_THRESHOLD = 2000; // 2s boundary between active/idle

// Session death detection
const MAX_CONSECUTIVE_FAILURES = 3;

// Resize debounce
const RESIZE_DEBOUNCE = 100;

export interface TerminalViewerOptions {
  /** tmux executor for capture/send operations */
  tmux: TmuxExecutor;
  /** Callback when session dies (3 consecutive capture failures) */
  onSessionDeath?: () => void;
}

export interface TerminalViewerState {
  /** Whether the viewer is actively polling */
  active: boolean;
  /** Current session name */
  session: string | null;
  /** Last captured output */
  output: string;
  /** Last activity time for adaptive polling */
  lastActivityTime: number;
  /** Cursor position [col, row] */
  cursor: [number, number];
  /** Whether cursor is visible */
  cursorVisible: boolean;
  /** Poll generation (for invalidating stale polls) */
  pollGeneration: number;
  /** Consecutive capture failures */
  consecutiveFailures: number;
  /** Whether session is confirmed dead */
  sessionDead: boolean;
}

/**
 * Terminal panel that renders tmux session output.
 *
 * Provides a TextRenderable with captured tmux content.
 * Handles adaptive polling, key forwarding, and session death detection.
 */
export class TerminalViewer {
  private tmux: TmuxExecutor;
  private content: TextRenderable;
  private onSessionDeath?: () => void;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private termWidth = 80;
  private termHeight = 24;

  readonly state: TerminalViewerState = {
    active: false,
    session: null,
    output: "",
    lastActivityTime: Date.now(),
    cursor: [0, 0],
    cursorVisible: true,
    pollGeneration: 0,
    consecutiveFailures: 0,
    sessionDead: false,
  };

  constructor(renderer: CliRenderer, options: TerminalViewerOptions) {
    this.tmux = options.tmux;
    this.onSessionDeath = options.onSessionDeath;

    this.content = new TextRenderable(renderer, {
      id: "terminal-content",
      content: "",
      fg: "#CCCCCC",
      flexGrow: 1,
    });
  }

  /**
   * Get the content renderable to add to a layout.
   */
  getRenderable(): TextRenderable {
    return this.content;
  }

  /**
   * Check if the viewer is actively polling.
   */
  isActive(): boolean {
    return this.state.active;
  }

  /**
   * Check if the session has been detected as dead.
   */
  isSessionDead(): boolean {
    return this.state.sessionDead;
  }

  /**
   * Start capturing a tmux session.
   */
  async start(session: string, width: number, height: number): Promise<void> {
    this.state.active = true;
    this.state.session = session;
    this.state.pollGeneration++;
    this.state.lastActivityTime = Date.now();
    this.state.output = "";
    this.state.consecutiveFailures = 0;
    this.state.sessionDead = false;

    this.termHeight = Math.max(1, height);
    this.termWidth = Math.max(20, width);

    this.content.content = "Loading...";

    // Resize tmux pane to match
    await this.resizeTmuxPane(session, this.termWidth, this.termHeight);

    // Start polling
    await this.poll();
  }

  /**
   * Stop capturing.
   */
  stop(): void {
    this.stopPolling();
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.state.active = false;
    this.state.session = null;
  }

  /**
   * Forward a key to the tmux session.
   * Returns true if the key was forwarded, false if ignored.
   */
  async handleKey(key: string, ctrl: boolean, sequence?: string): Promise<boolean> {
    if (!this.state.active || !this.state.session || this.state.sessionDead) {
      return false;
    }

    this.state.lastActivityTime = Date.now();
    await this.sendKeyToTmux(key, ctrl, sequence);

    // Post-keystroke fast poll
    this.schedulePoll(POLL_POST_KEYSTROKE);

    return true;
  }

  /**
   * Update dimensions with debounce.
   */
  resize(width: number, height: number): void {
    if (!this.state.active) return;

    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(async () => {
      this.resizeTimer = null;
      this.termWidth = Math.max(20, width);
      this.termHeight = Math.max(1, height);
      if (this.state.session) {
        await this.resizeTmuxPane(this.state.session, this.termWidth, this.termHeight);
        // Immediate capture after resize
        this.schedulePoll(0);
      }
    }, RESIZE_DEBOUNCE);
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    this.stopPolling();
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this.content.destroy();
  }

  // --- Private methods ---

  private async poll(): Promise<void> {
    if (!this.state.active || !this.state.session) {
      return;
    }

    const currentGen = this.state.pollGeneration;

    try {
      // Capture pane output with ANSI escape sequences
      const output = await this.tmux.capturePaneAnsiSafe(this.state.session, this.termHeight);

      // Check if still active and same generation
      if (!this.state.active || currentGen !== this.state.pollGeneration) {
        return;
      }

      if (output !== null) {
        // Success — reset failure counter
        this.state.consecutiveFailures = 0;

        if (output !== this.state.output) {
          this.state.output = output;
          const lines = output.split("\n");
          const visibleLines = lines.slice(-this.termHeight);
          this.content.content = ansiToStyledText(visibleLines.join("\n"));
        }

        // Query cursor position
        const info = await this.tmux.queryPaneInfo(this.state.session);
        if (info) {
          this.state.cursor = [info.cursorX, info.cursorY];
          this.state.cursorVisible = info.cursorVisible;
        }
      } else {
        // Capture returned null — count as failure
        this.state.consecutiveFailures++;
        if (this.state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.state.sessionDead = true;
          this.content.content = "[Session ended]";
          this.stopPolling();
          if (this.onSessionDeath) {
            this.onSessionDeath();
          }
          return;
        }
      }
    } catch {
      // Capture threw — count as failure
      this.state.consecutiveFailures++;
      if (this.state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.state.sessionDead = true;
        this.content.content = "[Session ended]";
        this.stopPolling();
        if (this.onSessionDeath) {
          this.onSessionDeath();
        }
        return;
      }
    }

    // Schedule next poll with adaptive interval
    const interval = this.calculatePollInterval();
    this.schedulePoll(interval);
  }

  private schedulePoll(delay: number): void {
    this.stopPolling();

    if (!this.state.active) return;

    const gen = this.state.pollGeneration;
    this.pollTimer = setTimeout(() => {
      if (this.state.pollGeneration === gen) {
        this.poll();
      }
    }, delay);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private calculatePollInterval(): number {
    const inactivity = Date.now() - this.state.lastActivityTime;
    return inactivity > ACTIVITY_THRESHOLD ? POLL_IDLE : POLL_ACTIVE;
  }

  /**
   * Send key to tmux session using proper key mapping per workspace.md spec.
   */
  private async sendKeyToTmux(key: string, ctrl: boolean, sequence?: string): Promise<void> {
    if (!this.state.session) return;

    if (ctrl) {
      // Ctrl+A..Z → C-{letter}
      await this.tmux.sendKeys(this.state.session, `C-${key}`);
      return;
    }

    // Map special keys to tmux named keys
    switch (key) {
      case "return":
      case "enter":
        await this.tmux.sendKeys(this.state.session, "Enter");
        return;
      case "tab":
        await this.tmux.sendKeys(this.state.session, "Tab");
        return;
      case "escape":
        await this.tmux.sendKeys(this.state.session, "Escape");
        return;
      case "space":
        await this.tmux.sendKeys(this.state.session, "Space");
        return;
      case "backspace":
        await this.tmux.sendKeys(this.state.session, "BSpace");
        return;
      case "up":
        await this.tmux.sendKeys(this.state.session, "Up");
        return;
      case "down":
        await this.tmux.sendKeys(this.state.session, "Down");
        return;
      case "left":
        await this.tmux.sendKeys(this.state.session, "Left");
        return;
      case "right":
        await this.tmux.sendKeys(this.state.session, "Right");
        return;
      case "home":
        await this.tmux.sendKeys(this.state.session, "Home");
        return;
      case "end":
        await this.tmux.sendKeys(this.state.session, "End");
        return;
      case "pageup":
        await this.tmux.sendKeys(this.state.session, "PPage");
        return;
      case "pagedown":
        await this.tmux.sendKeys(this.state.session, "NPage");
        return;
      case "f1": case "f2": case "f3": case "f4":
      case "f5": case "f6": case "f7": case "f8":
      case "f9": case "f10": case "f11": case "f12":
        await this.tmux.sendKeys(this.state.session, key.toUpperCase().replace("F", "F"));
        return;
    }

    // Printable characters — use send-keys -l (literal) per spec
    if (sequence && sequence.length === 1) {
      try {
        await this.tmux.sendLiteral(this.state.session, sequence);
      } catch {
        // Session may have died
      }
      return;
    }
    if (key.length === 1) {
      try {
        await this.tmux.sendLiteral(this.state.session, key);
      } catch {
        // Session may have died
      }
      return;
    }

    // Unmapped keys: dropped silently per spec
  }

  /**
   * Resize tmux pane to match terminal dimensions.
   */
  private async resizeTmuxPane(
    session: string,
    width: number,
    height: number
  ): Promise<void> {
    await this.tmux.resizePaneSafe(session, width, height);
  }
}

/**
 * Create a terminal viewer instance.
 */
export function createTerminalViewer(
  renderer: CliRenderer,
  options: TerminalViewerOptions
): TerminalViewer {
  return new TerminalViewer(renderer, options);
}
