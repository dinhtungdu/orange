/**
 * Workspace view — primary working view per workspace.md spec.
 *
 * Layout: Sidebar (30%) + Terminal (70%) + Footer (1 row)
 * Focus modes: terminal (default) and sidebar. Toggle with Ctrl+\.
 *
 * Entry: Enter key on task in task manager.
 * Exit: Esc from sidebar → return to task manager.
 */

import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";
import type { Deps, Task } from "../core/types.js";
import { loadProjects } from "../core/state.js";
import { TerminalViewer } from "./terminal.js";
import { Sidebar } from "./sidebar.js";

// Small terminal thresholds per spec
const MIN_WIDTH_FOR_SIDEBAR = 80;
const MIN_HEIGHT_FOR_SIDEBAR = 15;

/** Focus state */
export type FocusMode = "terminal" | "sidebar";

export interface WorkspaceViewOptions {
  deps: Deps;
  task: Task;
  /** Callback when exiting workspace view to return to task manager */
  onExit: () => void;
  /** Callback for tmux attach (Ctrl+]) */
  onAttach: (session: string) => void;
  /** Callback to spawn or respawn the task */
  onSpawn?: (task: Task) => Promise<void>;
}

/**
 * WorkspaceViewer — orchestrates sidebar, terminal panel, and focus management.
 */
export class WorkspaceViewer {
  private deps: Deps;
  private task: Task;
  private onExit: () => void;
  private onAttach: (session: string) => void;
  private onSpawn?: (task: Task) => Promise<void>;
  private spawning = false;

  private renderer: CliRenderer;
  private container: BoxRenderable;
  private bodyRow: BoxRenderable;
  private sidebarBox: BoxRenderable;
  private terminalBox: BoxRenderable;
  private footer: TextRenderable;

  private terminal: TerminalViewer;
  private sidebar: Sidebar | null = null;

  private focus: FocusMode = "terminal";
  private sidebarVisible = true;
  private active = false;

  constructor(renderer: CliRenderer, options: WorkspaceViewOptions) {
    this.renderer = renderer;
    this.deps = options.deps;
    this.task = options.task;
    this.onExit = options.onExit;
    this.onAttach = options.onAttach;
    this.onSpawn = options.onSpawn;

    // Root container (column: body + footer)
    this.container = new BoxRenderable(renderer, {
      id: "workspace-view",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      visible: false,
    });

    // Body row (sidebar + terminal, side by side)
    this.bodyRow = new BoxRenderable(renderer, {
      id: "ws-body",
      flexDirection: "row",
      width: "100%",
      flexGrow: 1,
    });

    // Sidebar box (will hold Sidebar renderable)
    this.sidebarBox = new BoxRenderable(renderer, {
      id: "ws-sidebar-box",
      flexDirection: "column",
      border: ["right"],
      borderColor: "#333333",
    });

    // Terminal box (will hold TerminalViewer renderable)
    this.terminalBox = new BoxRenderable(renderer, {
      id: "ws-terminal-box",
      flexDirection: "column",
      flexGrow: 1,
    });

    this.bodyRow.add(this.sidebarBox);
    this.bodyRow.add(this.terminalBox);

    // Footer
    this.footer = new TextRenderable(renderer, {
      id: "ws-footer",
      content: "",
      fg: "#888888",
    });

    this.container.add(this.bodyRow);
    this.container.add(this.footer);

    // Create terminal panel
    this.terminal = new TerminalViewer(renderer, {
      tmux: this.deps.tmux,
      onSessionDeath: () => {
        this.updateFooter();
      },
    });
    this.terminalBox.add(this.terminal.getRenderable());
  }

  /**
   * Get the root container.
   */
  getContainer(): BoxRenderable {
    return this.container;
  }

  /**
   * Check if the workspace view is active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get current focus mode.
   */
  getFocus(): FocusMode {
    return this.focus;
  }

  /**
   * Enter workspace view for a task.
   *
   * If session exists and is alive, starts terminal capture.
   * Otherwise shows a placeholder with status info.
   */
  async enter(): Promise<void> {
    this.active = true;
    this.focus = "terminal";
    this.container.visible = true;

    // Calculate layout dimensions
    const dims = this.calculateDimensions();

    // Set up sidebar
    await this.setupSidebar(dims);

    // Set sidebar dimensions
    this.updateLayout(dims);

    // Start terminal capture or show placeholder
    const session = this.task.tmux_session;
    if (session) {
      const exists = await this.deps.tmux.sessionExists(session);
      if (exists) {
        await this.terminal.start(session, dims.terminalWidth, dims.terminalHeight);
      } else {
        this.terminal.showPlaceholder(this.getPlaceholderMessage());
      }
    } else {
      this.terminal.showPlaceholder(this.getPlaceholderMessage());
    }

    this.updateFocusIndicators();
    this.updateFooter();
  }

  /**
   * Exit workspace view.
   */
  async exit(): Promise<void> {
    this.active = false;

    // Stop terminal
    this.terminal.stop();

    // Stop sidebar
    if (this.sidebar) {
      await this.sidebar.stop();
    }

    this.container.visible = false;
    this.onExit();
  }

  /**
   * Handle key input with focus-aware routing.
   */
  async handleKey(key: string, ctrl: boolean, sequence?: string): Promise<boolean> {
    if (!this.active) return false;

    if (this.focus === "terminal") {
      return this.handleTerminalKey(key, ctrl, sequence);
    } else {
      return this.handleSidebarKey(key, ctrl, sequence);
    }
  }

  /**
   * Handle resize event.
   */
  resize(): void {
    if (!this.active) return;

    const dims = this.calculateDimensions();
    this.updateLayout(dims);

    // Resize terminal
    this.terminal.resize(dims.terminalWidth, dims.terminalHeight);
  }

  /**
   * Cleanup all resources.
   */
  async destroy(): Promise<void> {
    this.terminal.destroy();
    if (this.sidebar) {
      await this.sidebar.destroy();
    }
    this.container.destroyRecursively();
  }

  // --- Private: Focus indicators ---

  private updateFocusIndicators(): void {
    // Sidebar border color indicates which panel is focused
    this.sidebarBox.borderColor = this.focus === "sidebar" ? "#00DDFF" : "#333333";
  }

  // --- Private: Focus handling ---

  private async handleTerminalKey(key: string, ctrl: boolean, sequence?: string): Promise<boolean> {
    // Ctrl+\ → toggle to sidebar
    // Kitty mode: ctrl=true, key="\\"
    // Raw/legacy mode: ctrl=false, key="\x1c" (ASCII 28)
    if ((ctrl && key === "\\") || key === "\x1c" || sequence === "\x1c") {
      this.focus = "sidebar";
      this.updateFocusIndicators();
      this.updateFooter();
      return true;
    }

    // 's' key: spawn or respawn when no active session
    if (!ctrl && (key === "s" || sequence === "s")) {
      if (this.needsSpawn() && !this.spawning) {
        await this.handleSpawn();
        return true;
      }
    }

    // Forward everything else to terminal
    return this.terminal.handleKey(key, ctrl, sequence);
  }

  private async handleSidebarKey(key: string, ctrl: boolean, sequence?: string): Promise<boolean> {
    // Ctrl+\ → toggle back to terminal
    if ((ctrl && key === "\\") || key === "\x1c" || sequence === "\x1c") {
      this.focus = "terminal";
      this.updateFocusIndicators();
      this.updateFooter();
      return true;
    }

    switch (key) {
      case "tab":
      case "return":
      case "enter":
        // Return focus to terminal
        this.focus = "terminal";
        this.updateFocusIndicators();
        this.updateFooter();
        return true;
      case "a": {
        // Attach to tmux session (only if session alive)
        const session = this.task.tmux_session;
        if (session && !this.terminal.isSessionDead() && this.terminal.isActive()) {
          await this.exit();
          this.onAttach(session);
        }
        return true;
      }
      case "escape":
        // Exit to task manager
        this.exit();
        return true;
      default:
        return false;
    }
  }

  // --- Private: Spawn/Respawn ---

  /**
   * Whether the task needs spawn or respawn (no active terminal session).
   */
  private needsSpawn(): boolean {
    if (!this.onSpawn) return false;
    // Terminal is actively capturing a live session — no spawn needed
    if (this.terminal.isActive() && !this.terminal.isSessionDead()) return false;
    return true;
  }

  /**
   * Handle spawn/respawn via callback, then start terminal capture.
   */
  private async handleSpawn(): Promise<void> {
    if (!this.onSpawn || this.spawning) return;

    this.spawning = true;
    this.terminal.showPlaceholder("Spawning agent...");
    this.updateFooter();

    try {
      await this.onSpawn(this.task);

      // Reload task to get new tmux_session
      const { listTasks } = await import("../core/db.js");
      const tasks = await listTasks(this.deps, {});
      const updated = tasks.find((t) => t.id === this.task.id);
      if (updated) {
        this.task = updated;
      }

      // Start terminal on new session
      if (this.task.tmux_session) {
        const exists = await this.deps.tmux.sessionExists(this.task.tmux_session);
        if (exists) {
          const dims = this.calculateDimensions();
          await this.terminal.start(this.task.tmux_session, dims.terminalWidth, dims.terminalHeight);
        } else {
          this.terminal.showPlaceholder(this.getPlaceholderMessage());
        }
      } else {
        this.terminal.showPlaceholder(this.getPlaceholderMessage());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.terminal.showPlaceholder(`Spawn failed: ${msg}`);
    } finally {
      this.spawning = false;
      this.updateFooter();
    }
  }

  /**
   * Get appropriate placeholder message based on task state.
   */
  private getPlaceholderMessage(): string {
    if (this.task.status === "pending") {
      return "No agent running — press 's' to spawn";
    }
    if (this.terminal.isSessionDead() || (this.task.tmux_session && !this.terminal.isActive())) {
      return "Session ended — press 's' to respawn";
    }
    if (!this.task.tmux_session) {
      return "No session — press 's' to spawn";
    }
    return "No active session";
  }

  // --- Private: Layout ---

  private calculateDimensions(): {
    sidebarWidth: number;
    terminalWidth: number;
    terminalHeight: number;
    showSidebar: boolean;
  } {
    const width = this.renderer.width;
    const height = this.renderer.height;

    // Footer takes 1 row
    const bodyHeight = Math.max(1, height - 1);

    // Small terminal: hide sidebar
    const showSidebar = width >= MIN_WIDTH_FOR_SIDEBAR && height >= MIN_HEIGHT_FOR_SIDEBAR;

    if (!showSidebar) {
      return {
        sidebarWidth: 0,
        terminalWidth: width,
        terminalHeight: bodyHeight,
        showSidebar: false,
      };
    }

    const sidebarWidth = Math.floor(width * 0.3);
    const terminalWidth = width - sidebarWidth;

    return {
      sidebarWidth,
      terminalWidth,
      terminalHeight: bodyHeight,
      showSidebar: true,
    };
  }

  private updateLayout(dims: {
    sidebarWidth: number;
    terminalWidth: number;
    terminalHeight: number;
    showSidebar: boolean;
  }): void {
    this.sidebarVisible = dims.showSidebar;
    this.sidebarBox.visible = dims.showSidebar;

    if (dims.showSidebar) {
      this.sidebarBox.width = dims.sidebarWidth;
      this.sidebarBox.height = dims.terminalHeight;
    }
  }

  private async setupSidebar(dims: {
    showSidebar: boolean;
  }): Promise<void> {
    if (!dims.showSidebar) return;

    // Load project info for default branch
    const projects = await loadProjects(this.deps);
    const project = projects.find(p => p.name === this.task.project);
    const defaultBranch = project?.default_branch ?? "main";

    this.sidebar = new Sidebar(this.renderer, {
      deps: this.deps,
      project: this.task.project,
      taskId: this.task.id,
      defaultBranch,
    });

    this.sidebarBox.add(this.sidebar.getRenderable());
    await this.sidebar.start();
  }

  // --- Private: Footer ---

  private updateFooter(): void {
    if (this.spawning) {
      this.footer.content = " [terminal] Spawning...";
      return;
    }

    const canSpawn = this.needsSpawn();
    const focusLabel = this.focus === "terminal" ? "[terminal]" : "[sidebar]";

    if (this.focus === "terminal") {
      const spawnHint = canSpawn ? "  s:spawn" : "";
      this.footer.content = ` ${focusLabel} Ctrl+\\:unfocus${spawnHint}`;
    } else {
      const hasSession = this.task.tmux_session && this.terminal.isActive() && !this.terminal.isSessionDead();
      const attachHint = hasSession ? "  a:attach" : "";
      this.footer.content = ` ${focusLabel} Ctrl+\\:terminal${attachHint}  Esc:dashboard`;
    }
  }
}
