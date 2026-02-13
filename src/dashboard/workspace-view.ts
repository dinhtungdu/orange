/**
 * Workspace view — primary working view per workspace.md spec.
 *
 * Layout: Sidebar (30%) + Terminal (70%) + Footer (1 row)
 * Focus modes: terminal (default) and sidebar.
 *
 * Entry: `w` key on task with live session in task manager.
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
  /** Callback for full-screen tmux attach (Ctrl+]) */
  onAttach: (session: string) => void;
}

/**
 * WorkspaceViewer — orchestrates sidebar, terminal panel, and focus management.
 */
export class WorkspaceViewer {
  private deps: Deps;
  private task: Task;
  private onExit: () => void;
  private onAttach: (session: string) => void;

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

    // Start terminal capture
    const session = this.task.tmux_session;
    if (session) {
      await this.terminal.start(session, dims.terminalWidth, dims.terminalHeight);
    }

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
      return this.handleSidebarKey(key);
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

  // --- Private: Focus handling ---

  private async handleTerminalKey(key: string, ctrl: boolean, sequence?: string): Promise<boolean> {
    // Intercept Ctrl+\ → switch to sidebar
    if (ctrl && key === "\\") {
      this.focus = "sidebar";
      this.updateFooter();
      return true;
    }

    // Intercept Ctrl+] → full-screen tmux attach
    if (ctrl && key === "]") {
      const session = this.task.tmux_session;
      if (session) {
        await this.exit();
        this.onAttach(session);
      }
      return true;
    }

    // Forward everything else to terminal
    return this.terminal.handleKey(key, ctrl, sequence);
  }

  private handleSidebarKey(key: string): boolean {
    switch (key) {
      case "tab":
      case "return":
      case "enter":
        // Return focus to terminal
        this.focus = "terminal";
        this.updateFooter();
        return true;
      case "escape":
        // Exit to task manager
        this.exit();
        return true;
      default:
        return false;
    }
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
    if (this.terminal.isSessionDead()) {
      this.footer.content = " [Session ended]  Ctrl+\\:sidebar  Esc:dashboard";
      return;
    }

    if (this.focus === "terminal") {
      this.footer.content = " Ctrl+\\:sidebar  Ctrl+]:fullscreen";
    } else {
      this.footer.content = " Tab:terminal  Esc:dashboard";
    }
  }
}
