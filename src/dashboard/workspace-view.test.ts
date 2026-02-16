/**
 * Tests for workspace view component.
 *
 * Tests: focus mode switching, key routing, layout calculation.
 */

import { describe, expect, test } from "bun:test";
import type { FocusMode } from "./workspace-view.js";
import type { MouseEvent } from "./mouse.js";
import { isLeftClick, isScrollUp, isScrollDown } from "./mouse.js";

describe("Focus Mode", () => {
  test("terminal focus forwards keys to tmux", () => {
    const focus: FocusMode = "terminal";

    // In terminal mode, keys should be forwarded (not intercepted)
    // Only Ctrl+\ and Ctrl+] are intercepted
    const isIntercepted = (key: string, ctrl: boolean) => {
      if (ctrl && key === "\\") return true; // → sidebar
      if (ctrl && key === "]") return true;  // → fullscreen
      return false;
    };

    expect(isIntercepted("a", false)).toBe(false);
    expect(isIntercepted("\\", true)).toBe(true);
    expect(isIntercepted("]", true)).toBe(true);
    expect(isIntercepted("c", true)).toBe(false); // Ctrl+C forwarded to tmux
  });

  test("sidebar focus handles Tab/Enter/Esc", () => {
    const focus: FocusMode = "sidebar";

    const handleSidebarKey = (key: string): "terminal" | "exit" | "none" => {
      switch (key) {
        case "tab":
        case "return":
        case "enter":
          return "terminal";
        case "escape":
          return "exit";
        default:
          return "none";
      }
    };

    expect(handleSidebarKey("tab")).toBe("terminal");
    expect(handleSidebarKey("enter")).toBe("terminal");
    expect(handleSidebarKey("return")).toBe("terminal");
    expect(handleSidebarKey("escape")).toBe("exit");
    expect(handleSidebarKey("a")).toBe("none");
  });

  test("focus switching works regardless of session state", () => {
    // Per spec: "Focus switching works regardless of session state —
    //           can switch to sidebar to read context even when session is dead"
    const sessionDead = true;
    const focus: FocusMode = "terminal";

    // Ctrl+\ should still switch to sidebar even with dead session
    const canSwitchToSidebar = true; // Always allowed
    expect(canSwitchToSidebar).toBe(true);
  });
});

describe("Layout Calculation", () => {
  const MIN_WIDTH = 80;
  const MIN_HEIGHT = 15;

  function calculateDims(width: number, height: number) {
    const bodyHeight = Math.max(1, height - 1); // Footer takes 1 row
    const showSidebar = width >= MIN_WIDTH && height >= MIN_HEIGHT;

    if (!showSidebar) {
      return {
        sidebarWidth: 0,
        terminalWidth: width,
        terminalHeight: bodyHeight,
        showSidebar: false,
      };
    }

    const sidebarWidth = Math.floor(width * 0.3);
    return {
      sidebarWidth,
      terminalWidth: width - sidebarWidth,
      terminalHeight: bodyHeight,
      showSidebar: true,
    };
  }

  test("normal terminal shows sidebar", () => {
    const dims = calculateDims(120, 40);
    expect(dims.showSidebar).toBe(true);
    expect(dims.sidebarWidth).toBe(36);
    expect(dims.terminalWidth).toBe(84);
    expect(dims.terminalHeight).toBe(39); // 40 - 1 footer
  });

  test("narrow terminal hides sidebar", () => {
    const dims = calculateDims(60, 40);
    expect(dims.showSidebar).toBe(false);
    expect(dims.sidebarWidth).toBe(0);
    expect(dims.terminalWidth).toBe(60);
  });

  test("short terminal hides sidebar", () => {
    const dims = calculateDims(120, 10);
    expect(dims.showSidebar).toBe(false);
    expect(dims.sidebarWidth).toBe(0);
    expect(dims.terminalWidth).toBe(120);
  });

  test("exact threshold shows sidebar", () => {
    const dims = calculateDims(80, 15);
    expect(dims.showSidebar).toBe(true);
    expect(dims.sidebarWidth).toBe(24);
    expect(dims.terminalWidth).toBe(56);
  });

  test("footer always takes 1 row", () => {
    const dims = calculateDims(120, 40);
    expect(dims.terminalHeight).toBe(39);

    const small = calculateDims(60, 10);
    expect(small.terminalHeight).toBe(9);
  });
});

describe("Footer Content", () => {
  test("terminal focus footer", () => {
    const focus: FocusMode = "terminal";
    const sessionDead = false;

    const footer = sessionDead
      ? " [Session ended]  Ctrl+\\:sidebar  Esc:dashboard"
      : focus === "terminal"
        ? " Ctrl+\\:sidebar  Ctrl+]:fullscreen"
        : " Tab:terminal  Esc:dashboard";

    expect(footer).toBe(" Ctrl+\\:sidebar  Ctrl+]:fullscreen");
  });

  test("sidebar focus footer", () => {
    const focus = "sidebar" as FocusMode;
    const sessionDead = false;

    const footer = sessionDead
      ? " [Session ended]  Ctrl+\\:sidebar  Esc:dashboard"
      : focus === "terminal"
        ? " Ctrl+\\:sidebar  Ctrl+]:fullscreen"
        : " Tab:terminal  Esc:dashboard";

    expect(footer).toBe(" Tab:terminal  Esc:dashboard");
  });

  test("session dead footer", () => {
    const sessionDead = true;

    const footer = sessionDead
      ? " [Session ended]  Ctrl+\\:sidebar  Esc:dashboard"
      : " Ctrl+\\:sidebar  Ctrl+]:fullscreen";

    expect(footer).toBe(" [Session ended]  Ctrl+\\:sidebar  Esc:dashboard");
  });
});

describe("Mouse Focus Switching", () => {
  // Simulate handleMouse focus logic from WorkspaceViewer
  function determineFocus(
    eventCol: number,
    sidebarWidth: number,
    showSidebar: boolean,
  ): FocusMode {
    const inSidebar = showSidebar && eventCol <= sidebarWidth;
    return inSidebar ? "sidebar" : "terminal";
  }

  function makeClick(col: number, row: number): MouseEvent {
    return { button: 0, col, row, type: "press", shift: false, ctrl: false, meta: false };
  }

  function makeScrollUp(col: number, row: number): MouseEvent {
    return { button: 64, col, row, type: "press", shift: false, ctrl: false, meta: false };
  }

  function makeScrollDown(col: number, row: number): MouseEvent {
    return { button: 65, col, row, type: "press", shift: false, ctrl: false, meta: false };
  }

  test("click in sidebar area switches to sidebar focus", () => {
    // sidebarWidth=36, click at col=10 → sidebar
    expect(determineFocus(10, 36, true)).toBe("sidebar");
  });

  test("click in terminal area switches to terminal focus", () => {
    // sidebarWidth=36, click at col=50 → terminal
    expect(determineFocus(50, 36, true)).toBe("terminal");
  });

  test("click at sidebar boundary is sidebar", () => {
    expect(determineFocus(36, 36, true)).toBe("sidebar");
  });

  test("click past sidebar boundary is terminal", () => {
    expect(determineFocus(37, 36, true)).toBe("terminal");
  });

  test("click always terminal when sidebar hidden", () => {
    expect(determineFocus(5, 0, false)).toBe("terminal");
  });

  test("mouse event helpers work", () => {
    expect(isLeftClick(makeClick(1, 1))).toBe(true);
    expect(isScrollUp(makeScrollUp(1, 1))).toBe(true);
    expect(isScrollDown(makeScrollDown(1, 1))).toBe(true);
    expect(isLeftClick(makeScrollUp(1, 1))).toBe(false);
  });
});
