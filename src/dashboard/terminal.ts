/**
 * Terminal viewer component for Orange dashboard.
 *
 * Renders tmux session output inside the TUI with adaptive polling.
 * Uses TextBufferRenderable for plain text rendering.
 *
 * For full VT emulation with ghostty-opentui, see terminal-ghostty.ts.
 */

import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { TmuxExecutor } from "../core/types.js";

// Polling intervals (adaptive based on activity)
const POLL_FAST = 50; // During active input
const POLL_MEDIUM = 200; // After brief inactivity
const POLL_SLOW = 500; // Extended inactivity
const INACTIVITY_MEDIUM_THRESHOLD = 2000; // 2s
const INACTIVITY_SLOW_THRESHOLD = 10000; // 10s

// Scrollback lines to capture
const SCROLLBACK_LINES = 100;

export interface TerminalViewerOptions {
  /** tmux executor for capture/send operations */
  tmux: TmuxExecutor;
  /** Callback when exit key is pressed */
  onExit?: () => void;
  /** Callback when attach key is pressed */
  onAttach?: () => void;
}

export interface TerminalViewerState {
  /** Whether the viewer is active */
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
}

/**
 * Terminal viewer that renders tmux session output.
 *
 * Uses plain text rendering with tmux capture-pane.
 * Supports adaptive polling and key forwarding.
 */
export class TerminalViewer {
  private renderer: CliRenderer;
  private tmux: TmuxExecutor;
  private container: BoxRenderable;
  private header: TextRenderable;
  private content: TextRenderable;
  private footer: TextRenderable;
  private onExit?: () => void;
  private onAttach?: () => void;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
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
  };

  constructor(renderer: CliRenderer, options: TerminalViewerOptions) {
    this.renderer = renderer;
    this.tmux = options.tmux;
    this.onExit = options.onExit;
    this.onAttach = options.onAttach;

    // Create container
    this.container = new BoxRenderable(renderer, {
      id: "terminal-viewer",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      visible: false,
    });

    // Header
    this.header = new TextRenderable(renderer, {
      id: "terminal-header",
      content: "",
      fg: "#00DDFF",
    });

    // Content area
    this.content = new TextRenderable(renderer, {
      id: "terminal-content",
      content: "",
      fg: "#CCCCCC",
      flexGrow: 1,
    });

    // Footer with keybindings
    this.footer = new TextRenderable(renderer, {
      id: "terminal-footer",
      content: " Ctrl+\\:exit  Ctrl+]:attach full  [text mode]",
      fg: "#888888",
    });

    this.container.add(this.header);
    this.container.add(this.content);
    this.container.add(this.footer);
  }

  /**
   * Get the container renderable.
   */
  getContainer(): BoxRenderable {
    return this.container;
  }

  /**
   * Check if the viewer is active.
   */
  isActive(): boolean {
    return this.state.active;
  }

  /**
   * Enter terminal view mode for the given session.
   */
  async enter(session: string, width: number, height: number): Promise<void> {
    this.state.active = true;
    this.state.session = session;
    this.state.pollGeneration++;
    this.state.lastActivityTime = Date.now();
    this.state.output = "";

    // Calculate terminal dimensions (subtract header/footer)
    this.termHeight = Math.max(1, height - 2);
    this.termWidth = Math.max(20, width - 2);

    this.header.content = ` Session: ${session}`;
    this.content.content = "Loading...";
    this.container.visible = true;

    // Resize tmux pane to match
    await this.resizeTmuxPane(session, this.termWidth, this.termHeight);

    // Start polling
    await this.poll();
  }

  /**
   * Exit terminal view mode.
   */
  exit(): void {
    this.stopPolling();
    this.state.active = false;
    this.state.session = null;
    this.container.visible = false;

    if (this.onExit) {
      this.onExit();
    }
  }

  /**
   * Handle key input.
   * Returns true if key was handled, false to pass through.
   */
  async handleKey(key: string, ctrl: boolean, sequence?: string): Promise<boolean> {
    if (!this.state.active || !this.state.session) {
      return false;
    }

    // Exit key: Ctrl+\
    if (ctrl && key === "\\") {
      this.exit();
      return true;
    }

    // Attach key: Ctrl+]
    if (ctrl && key === "]") {
      this.exit();
      if (this.onAttach) {
        this.onAttach();
      }
      return true;
    }

    // Forward key to tmux
    this.state.lastActivityTime = Date.now();
    await this.sendKeyToTmux(key, ctrl, sequence);

    // Trigger immediate poll after keystroke
    this.schedulePoll(20);

    return true;
  }

  /**
   * Update dimensions.
   */
  async resize(width: number, height: number): Promise<void> {
    if (!this.state.active) return;

    this.termHeight = Math.max(1, height - 2);
    this.termWidth = Math.max(20, width - 2);

    if (this.state.session) {
      await this.resizeTmuxPane(this.state.session, this.termWidth, this.termHeight);
      // Immediate poll after resize
      this.schedulePoll(0);
    }
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    this.stopPolling();
    this.container.destroyRecursively();
  }

  // --- Private methods ---

  private async poll(): Promise<void> {
    if (!this.state.active || !this.state.session) {
      return;
    }

    const currentGen = this.state.pollGeneration;

    try {
      // Capture pane output (plain text)
      const output = await this.tmux.capturePaneSafe(this.state.session, SCROLLBACK_LINES);

      // Check if still active and same generation
      if (!this.state.active || currentGen !== this.state.pollGeneration) {
        return;
      }

      if (output !== null && output !== this.state.output) {
        this.state.output = output;
        // Show last N lines that fit in the view
        const lines = output.split("\n");
        const visibleLines = lines.slice(-this.termHeight);
        this.content.content = visibleLines.join("\n");
      }

      // Query cursor position
      const info = await this.tmux.queryPaneInfo(this.state.session);
      if (info) {
        this.state.cursor = [info.cursorX, info.cursorY];
        this.state.cursorVisible = info.cursorVisible;
      }
    } catch {
      // Session may have died
      this.content.content = "[Session ended]";
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

    if (inactivity > INACTIVITY_SLOW_THRESHOLD) {
      return POLL_SLOW;
    }
    if (inactivity > INACTIVITY_MEDIUM_THRESHOLD) {
      return POLL_MEDIUM;
    }
    return POLL_FAST;
  }

  /**
   * Send key to tmux session.
   */
  private async sendKeyToTmux(key: string, ctrl: boolean, sequence?: string): Promise<void> {
    if (!this.state.session) return;

    let tmuxKey: string;

    if (ctrl) {
      // Map Ctrl+key to tmux format
      tmuxKey = `C-${key}`;
    } else {
      // Map special keys
      switch (key) {
        case "return":
        case "enter":
          tmuxKey = "Enter";
          break;
        case "backspace":
          tmuxKey = "BSpace";
          break;
        case "tab":
          tmuxKey = "Tab";
          break;
        case "escape":
          tmuxKey = "Escape";
          break;
        case "up":
          tmuxKey = "Up";
          break;
        case "down":
          tmuxKey = "Down";
          break;
        case "left":
          tmuxKey = "Left";
          break;
        case "right":
          tmuxKey = "Right";
          break;
        case "space":
          tmuxKey = "Space";
          break;
        default:
          // Single character - use sequence if available for proper case handling
          if (sequence && sequence.length === 1) {
            await this.tmux.sendKeys(this.state.session, sequence);
            return;
          }
          if (key.length === 1) {
            await this.tmux.sendKeys(this.state.session, key);
            return;
          }
          tmuxKey = key;
      }
    }

    try {
      await this.tmux.sendKeys(this.state.session, tmuxKey);
    } catch {
      // Session may have died
    }
  }

  /**
   * Resize tmux pane to match view dimensions.
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
