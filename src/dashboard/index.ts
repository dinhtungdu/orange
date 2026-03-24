/**
 * Dashboard TUI for Orange agent orchestration.
 *
 * Built with OpenTUI, provides:
 * - Task list with status indicators
 * - Keyboard navigation
 * - Real-time status updates via file watching
 *
 * Scoping:
 * - In a project directory: shows only that project's tasks
 * - With --all flag: shows all tasks
 * - With --project flag: shows specific project's tasks
 */

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  t,
  fg,
  bold,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
} from "@opentui/core";
import type { Deps } from "../core/types.js";
import {
  DashboardState,
  STATUS_COLOR,
  SESSION_ICON,
  SESSION_COLOR,
  CHECKS_ICON,
  type DashboardOptions,
} from "./state.js";
import { parseMouse, isLeftClick, isScrollUp, isScrollDown } from "./mouse.js";

// Re-export for external use and tests
export { DashboardState } from "./state.js";
export type { DashboardOptions } from "./state.js";

// Column widths (fixed)
const COL_STATUS = 13;
const COL_PR = 14;
const COL_COMMITS = 8;
const COL_CHANGES = 14;
const COL_ACTIVITY = 9;
const FIXED_COLS = COL_STATUS + COL_PR + COL_COMMITS + COL_CHANGES + COL_ACTIVITY;

/** Pad or truncate a plain string to exact column width. */
function col(s: string, w: number): string {
  if (w <= 0) return "";
  if (s.length > w) return s.slice(0, w - 1) + "…";
  return s + " ".repeat(w - s.length);
}

/**
 * Format a table row as a single styled text string with manually positioned columns.
 * Bypasses flex layout to guarantee columns never overlap regardless of terminal width.
 * Layout: 1(pad) + 1(selector) + 1(space) + taskText + FIXED_COLS = width
 */
function formatRow(
  width: number,
  opts: {
    task: string;
    taskColor: string;
    status: string;
    statusColor: string;
    pr: string;
    prColor: string;
    commits: string;
    changesText: string;
    changesColor: string;
    activity: string;
    selected?: boolean;
  }
) {
  const taskTextWidth = Math.max(0, width - 3 - FIXED_COLS);
  const taskStr = col(opts.task, taskTextWidth);
  const statusStr = col(opts.status, COL_STATUS);
  const prStr = col(opts.pr, COL_PR);
  const commitsStr = col(opts.commits, COL_COMMITS);
  const changesStr = col(opts.changesText, COL_CHANGES);
  const activityStr = col(opts.activity, COL_ACTIVITY);

  if (opts.selected) {
    return t` ${fg("#00DDFF")("❯")} ${bold(fg(opts.taskColor)(taskStr))}${bold(fg(opts.statusColor)(statusStr))}${bold(fg(opts.prColor)(prStr))}${bold(fg("#CCCCCC")(commitsStr))}${bold(fg(opts.changesColor)(changesStr))}${bold(fg("#888888")(activityStr))}`;
  }
  return t`   ${fg(opts.taskColor)(taskStr)}${fg(opts.statusColor)(statusStr)}${fg(opts.prColor)(prStr)}${fg("#CCCCCC")(commitsStr)}${fg(opts.changesColor)(changesStr)}${fg("#888888")(activityStr)}`;
}

/**
 * Build the full dashboard UI.
 */
function buildDashboard(
  renderer: CliRenderer,
  state: DashboardState
): { update: () => void; root: BoxRenderable; taskIndexAtRow: (row: number) => number | null } {
  const s = state.data;

  // --- Root container ---
  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: "transparent",
  });

  // --- Header ---
  const header = new TextRenderable(renderer, {
    id: "header",
    content: "",
    fg: "#00DDFF",
  });

  // --- Column headers (single text row, updated each render) ---
  const colHeaderRow = new TextRenderable(renderer, {
    id: "col-headers",
    content: "",
  });

  // --- Separator ---
  const separator = new TextRenderable(renderer, {
    id: "separator",
    content: "",
    fg: "#555555",
  });

  // --- Messages area ---
  const messageText = new TextRenderable(renderer, {
    id: "message",
    content: "",
    fg: "#44FF44",
  });

  const errorText = new TextRenderable(renderer, {
    id: "error",
    content: "",
    fg: "#FF4444",
  });

  // --- Task list container ---
  const taskList = new BoxRenderable(renderer, {
    id: "task-list",
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
  });

  // --- Create form container ---
  const createForm = new BoxRenderable(renderer, {
    id: "create-form",
    flexDirection: "column",
    width: "100%",
    paddingLeft: 1,
  });
  const createTitle = new TextRenderable(renderer, {
    id: "create-title",
    content: " Create Task",
    fg: "#00DDFF",
  });
  const createBranchLabel = new TextRenderable(renderer, {
    id: "create-branch",
    content: "",
    fg: "#FFFFFF",
  });
  const createDescLabel = new TextRenderable(renderer, {
    id: "create-desc",
    content: "",
    fg: "#FFFFFF",
  });
  const createHarnessLabel = new TextRenderable(renderer, {
    id: "create-harness",
    content: "",
    fg: "#FFFFFF",
  });
  const createStatusLabel = new TextRenderable(renderer, {
    id: "create-status",
    content: "",
    fg: "#FFFFFF",
  });
  createForm.add(createTitle);
  createForm.add(createBranchLabel);
  createForm.add(createDescLabel);
  createForm.add(createHarnessLabel);
  createForm.add(createStatusLabel);

  // --- Footer ---
  const footerSep = new TextRenderable(renderer, {
    id: "footer-sep",
    content: "",
    fg: "#555555",
  });

  const footerKeys = new TextRenderable(renderer, {
    id: "footer-keys",
    content: "",
    fg: "#888888",
  });

  // Assemble tree
  root.add(header);
  root.add(colHeaderRow);
  root.add(separator);
  root.add(errorText);
  root.add(messageText);
  root.add(taskList);
  root.add(createForm);

  const confirmPrompt = new TextRenderable(renderer, {
    id: "confirm-prompt",
    content: "",
    fg: "#FFAA00",
    visible: false,
  });
  root.add(confirmPrompt);

  const fixPrompt = new TextRenderable(renderer, {
    id: "fix-prompt",
    content: "",
    fg: "#FFAA00",
    visible: false,
  });
  root.add(fixPrompt);

  // --- View overlay ---
  const viewOverlay = new BoxRenderable(renderer, {
    id: "view-overlay",
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    visible: false,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const viewHeader = new TextRenderable(renderer, {
    id: "view-header",
    content: "",
    fg: "#00DDFF",
  });
  const viewSep = new TextRenderable(renderer, {
    id: "view-sep",
    content: "",
    fg: "#555555",
  });
  const viewBody = new BoxRenderable(renderer, {
    id: "view-body",
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
  });
  viewOverlay.add(viewHeader);
  viewOverlay.add(viewSep);
  viewOverlay.add(viewBody);
  root.add(viewOverlay);

  root.add(footerSep);
  root.add(footerKeys);
  renderer.root.add(root);

  // Track task row renderables for cleanup
  let taskRows: BoxRenderable[] = [];
  let viewLines: TextRenderable[] = [];

  // Mouse hit-testing state (updated each render)
  let taskListStartRow = 0;
  let currentScrollStart = 0;

  function update() {
    const width = renderer.width;

    // Header
    const statusLabel =
      s.statusFilter === "all" ? "" : ` [${s.statusFilter}]`;
    const headerLabel =
      s.projectLabel === "all"
        ? `Orange Dashboard (all)${statusLabel}`
        : `${s.projectLabel}${statusLabel}`;
    const poolLabel = s.poolTotal > 0 ? `  pool: ${s.poolUsed}/${s.poolTotal}` : "";
    header.content = ` ${headerLabel}${poolLabel}`;

    // Column headers
    colHeaderRow.content = formatRow(width, {
      task: "Task",
      taskColor: "#666666",
      status: "Status",
      statusColor: "#666666",
      pr: "PR",
      prColor: "#666666",
      commits: "Commits",
      changesText: "Changes",
      changesColor: "#666666",
      activity: "Activity",
    });

    // Separator
    separator.content = "─".repeat(width);

    // Messages
    errorText.content = s.error ? ` Error: ${s.error}` : "";
    errorText.visible = !!s.error;
    messageText.content = s.message ? ` ✓ ${s.message}` : "";
    messageText.visible = !!s.message;

    // Create form
    const cm = s.createMode;
    createForm.visible = cm.active;
    if (cm.active) {
      const branchCursor = cm.focusedField === "branch" ? "█" : "";
      const summaryCursor = cm.focusedField === "summary" ? "█" : "";
      const branchHighlight = cm.focusedField === "branch" ? "#00DDFF" : "#888888";
      const summaryHighlight = cm.focusedField === "summary" ? "#00DDFF" : "#888888";
      const harnessHighlight = cm.focusedField === "harness" ? "#00DDFF" : "#888888";
      const statusHighlight = cm.focusedField === "status" ? "#00DDFF" : "#888888";
      const branchHint = cm.branch ? "" : " (auto)";
      createBranchLabel.content = `Branch:      [${cm.branch}${branchCursor}]${branchHint}`;
      createBranchLabel.fg = branchHighlight;
      const summaryHint = cm.summary ? "" : " (optional)";
      createDescLabel.content = `Summary:     [${cm.summary}${summaryCursor}]${summaryHint}`;
      createDescLabel.fg = summaryHighlight;
      // Harness field: show as toggleable with indicator
      const harnessDisplay = `${cm.harness} ◀`;
      createHarnessLabel.content = `Harness:     [${harnessDisplay}]`;
      createHarnessLabel.fg = harnessHighlight;
      // Status field: show as toggleable with indicator
      createStatusLabel.content = `Status:      [${cm.status} ◀]`;
      createStatusLabel.fg = statusHighlight;
    }

    // Confirm prompt
    const cfm = s.confirmMode;
    confirmPrompt.visible = cfm.active;
    if (cfm.active) {
      confirmPrompt.content = ` ${cfm.message} (y/N)`;
    }

    // Fix prompt
    const fxm = s.fixMode;
    fixPrompt.visible = fxm.active;
    if (fxm.active) {
      fixPrompt.content = ` Fix instructions (optional): [${fxm.instructions}█]  Enter:submit  Esc:cancel`;
    }

    // --- View overlay ---
    const vm = s.viewMode;
    viewOverlay.visible = vm.active;
    // Hide main content when view is active
    colHeaderRow.visible = !vm.active;
    separator.visible = !vm.active;
    taskList.visible = !vm.active;
    createForm.visible = vm.active ? false : createForm.visible;

    for (const line of viewLines) {
      line.destroy();
    }
    viewLines = [];

    if (vm.active && vm.task) {
      const task = vm.task;
      const statusColor = STATUS_COLOR[task.status] || "#888888";
      viewHeader.content = `${task.project}/${task.branch}  ${task.summary || "(no summary)"}`;
      viewSep.content = "─".repeat(width - 2);

      // Build content lines from task body
      const bodyText = task.body?.trim() || "(no body)";
      const allLines = bodyText.split("\n");

      // Available height for body (terminal height minus header/footer/chrome)
      const availableHeight = Math.max(1, renderer.height - 6);
      const maxScroll = Math.max(0, allLines.length - availableHeight);
      // Clamp scroll offset
      if (s.viewMode.scrollOffset > maxScroll) {
        s.viewMode.scrollOffset = maxScroll;
      }

      const visibleLines = allLines.slice(
        s.viewMode.scrollOffset,
        s.viewMode.scrollOffset + availableHeight
      );

      for (let i = 0; i < visibleLines.length; i++) {
        const line = new TextRenderable(renderer, {
          id: `view-line-${i}`,
          content: visibleLines[i],
          fg: "#CCCCCC",
        });
        viewBody.add(line);
        viewLines.push(line);
      }

      // Scroll indicator
      if (allLines.length > availableHeight) {
        const pos = `${s.viewMode.scrollOffset + 1}-${Math.min(s.viewMode.scrollOffset + availableHeight, allLines.length)}/${allLines.length}`;
        const scrollLine = new TextRenderable(renderer, {
          id: "view-scroll-indicator",
          content: pos,
          fg: "#555555",
        });
        viewBody.add(scrollLine);
        viewLines.push(scrollLine);
      }
    }

    // Footer
    footerSep.content = "─".repeat(width);
    const keys = state.getContextKeys();
    footerKeys.content = keys.length > width ? keys.slice(0, width - 1) + "…" : keys;

    // --- Task rows ---
    for (const row of taskRows) {
      row.destroyRecursively();
    }
    taskRows = [];

    // Calculate visible task count based on terminal height
    // Chrome: header(1) + col-headers(1) + separator(1) + footer-sep(1) + footer-keys(1) = 5
    // Each task takes 2 rows (task row + summary line)
    const chromeHeight = 5;
    const availableTaskHeight = Math.max(2, renderer.height - chromeHeight);
    const maxVisibleTasks = Math.floor(availableTaskHeight / 2);

    // Compute task list start row for mouse hit-testing (0-based)
    // header(1) + col-headers(1) + separator(1) + error(0-1) + message(0-1)
    taskListStartRow = 3 + (s.error ? 1 : 0) + (s.message ? 1 : 0);

    if (s.tasks.length === 0) {
      const projectMsg = s.projectFilter
        ? ` for project '${s.projectFilter}'`
        : "";
      const emptyRow = new TextRenderable(renderer, {
        id: "empty-msg",
        content: ` No tasks${projectMsg}. Use 'orange task create' to add one.`,
        fg: "#888888",
      });
      taskList.add(emptyRow);
      taskRows.push(emptyRow as unknown as BoxRenderable);
      return;
    }

    // Calculate scroll window to keep cursor visible
    let scrollStart = 0;
    if (s.tasks.length > maxVisibleTasks) {
      // Keep cursor in view with some context
      const cursorPos = s.cursor;
      if (cursorPos >= scrollStart + maxVisibleTasks) {
        scrollStart = cursorPos - maxVisibleTasks + 1;
      }
      if (cursorPos < scrollStart) {
        scrollStart = cursorPos;
      }
    }
    currentScrollStart = scrollStart;
    const scrollEnd = Math.min(scrollStart + maxVisibleTasks, s.tasks.length);

    for (let i = scrollStart; i < scrollEnd; i++) {
      const task = s.tasks[i];
      const selected = i === s.cursor;
      const pending = s.pendingOps.has(task.id);

      // Session state: alive, dead, or none
      const hasSession = !!task.tmux_session;
      const sessionDead = s.deadSessions.has(task.id);
      const sessionState = hasSession
        ? sessionDead
          ? "dead"
          : "alive"
        : "none";
      const sessionIcon = SESSION_ICON[sessionState];
      const sessionColor = SESSION_COLOR[sessionState];

      const activity = state.formatRelativeTime(task.updated_at);

      const taskName = s.projectFilter
        ? task.branch
        : `${task.project}/${task.branch}`;
      // Show workspace ID if assigned, task ID when selected
      const workspaceNum = task.workspace?.split("--")[1] ?? null;
      const workspacePrefix = workspaceNum ? `[${workspaceNum}] ` : "";
      const taskDisplay = selected
        ? `${workspacePrefix}${taskName} (${task.id})`
        : `${workspacePrefix}${taskName}`;

      // Status column: always task stage
      let statusCol: string = pending ? "processing…" : task.status;

      // PR column: PR info when available
      // Use live prStatus from GitHub polling for active tasks,
      // fall back to persisted pr_state for terminal tasks (done/cancelled)
      let prCol = "";
      let prColor = "#888888";
      if (task.pr_url) {
        const prNum = task.pr_url.match(/\/pull\/(\d+)/)?.[1];
        const prStatus = s.prStatuses.get(task.id);
        const effectiveState = prStatus?.state ?? task.pr_state;
        if (prNum && effectiveState) {
          const checksIcon = prStatus?.checks ? CHECKS_ICON[prStatus.checks] : "";
          if (effectiveState === "MERGED") {
            prCol = `#${prNum} merged`;
            prColor = "#22BB22";
          } else if (effectiveState === "CLOSED") {
            prCol = `#${prNum} closed`;
            prColor = "#888888";
          } else {
            prCol = checksIcon ? `#${prNum} open ${checksIcon}` : `#${prNum} open`;
            prColor = "#5599FF";
          }
        } else if (prNum) {
          prCol = `#${prNum}`;
          prColor = "#888888";
        }
      }

      const stats = s.diffStats.get(task.id);
      const commitsCol = stats && stats.commits > 0 ? String(stats.commits) : "";
      const changesAdded = stats && stats.added > 0 ? `+${stats.added}` : "";
      const changesRemoved = stats && stats.removed > 0 ? `-${stats.removed}` : "";
      let changesText = "";
      let changesColor = "#CCCCCC";
      if (changesAdded && changesRemoved) {
        changesText = `${changesAdded} ${changesRemoved}`;
      } else if (changesAdded) {
        changesText = changesAdded;
        changesColor = "#44FF44";
      } else if (changesRemoved) {
        changesText = changesRemoved;
        changesColor = "#FF4444";
      }

      // Outer container for row + summary
      const rowContainer = new BoxRenderable(renderer, {
        id: `task-row-${i}`,
        flexDirection: "column",
        width: "100%",
      });

      // Table row as single pre-formatted text (no flex column layout)
      const tableRow = new TextRenderable(renderer, {
        id: `task-cells-${i}`,
        content: formatRow(width, {
          task: `${sessionIcon} ${taskDisplay}`,
          taskColor: sessionColor,
          status: statusCol,
          statusColor: STATUS_COLOR[task.status],
          pr: prCol,
          prColor,
          commits: commitsCol,
          changesText,
          changesColor,
          activity,
          selected,
        }),
      });

      rowContainer.add(tableRow);

      // Summary line (always shown, indented to align under session icon)
      // Indentation: 1 (paddingLeft) + 2 (selector area) = 3, then └ under the icon
      const summaryIndent = "   └ "; // 3 spaces + └ + space to align under session icon
      const summaryMaxLen = width - summaryIndent.length - 1;
      const summaryDisplay =
        task.summary.length > summaryMaxLen
          ? task.summary.slice(0, summaryMaxLen - 1) + "…"
          : task.summary;
      const summaryText = new TextRenderable(renderer, {
        id: `task-summary-${i}`,
        content: `${summaryIndent}${summaryDisplay || "(no summary)"}`,
        fg: selected ? "#AAAAAA" : "#666666",
      });
      rowContainer.add(summaryText);

      taskList.add(rowContainer);
      taskRows.push(rowContainer);
    }
  }

  /** Map a 1-based terminal row to a task index, or null if outside task list. */
  function taskIndexAtRow(termRow: number): number | null {
    const row0 = termRow - 1; // convert to 0-based
    const offset = row0 - taskListStartRow;
    if (offset < 0) return null;
    const idx = currentScrollStart + Math.floor(offset / 2);
    if (idx < 0 || idx >= s.tasks.length) return null;
    return idx;
  }

  return { update, root, taskIndexAtRow };
}

/**
 * Run the dashboard.
 */

export async function runDashboard(
  deps: Deps,
  options: DashboardOptions = {}
): Promise<void> {
  // Mutable refs for mouse handler (set after dashboard/state created)
  let mouseState: DashboardState | null = null;
  let mouseDashboard: { taskIndexAtRow: (row: number) => number | null } | null = null;

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 10,
    useMouse: false,
    prependInputHandlers: [
      (sequence: string): boolean => {
        if (!mouseState || !mouseDashboard) return false;
        const me = parseMouse(sequence);
        if (!me) return false;

        // Ignore mouse in overlay modes
        if (mouseState.isCreateMode() ||
            mouseState.isConfirmMode() || mouseState.isFixMode()) {
          return true; // consume but ignore
        }

        // View mode: scroll only
        if (mouseState.isViewMode()) {
          if (isScrollUp(me)) mouseState.handleInput("k");
          else if (isScrollDown(me)) mouseState.handleInput("j");
          return true;
        }

        // List mode
        if (isLeftClick(me)) {
          const idx = mouseDashboard.taskIndexAtRow(me.row);
          if (idx !== null) {
            mouseState.setCursor(idx);
          }
        } else if (isScrollUp(me)) {
          mouseState.handleInput("k");
        } else if (isScrollDown(me)) {
          mouseState.handleInput("j");
        }
        return true;
      },
    ],
  });

  // Enable SGR mouse reporting through opentui's zig pipeline (process.stdout.write
  // doesn't work — opentui manages terminal output). Setting useMouse=true sends the
  // escape codes, then we reset _useMouse so events flow through _stdinBuffer to our
  // prependInputHandlers instead of opentui's handleMouseData.
  renderer.useMouse = true;
  (renderer as unknown as { _useMouse: boolean })._useMouse = false;

  const state = new DashboardState(deps, options);
  const dashboard = buildDashboard(renderer, state);

  // Wire up mouse handler refs
  mouseState = state;
  mouseDashboard = dashboard;

  function disableMouse(): void {
    // Temporarily enable so opentui's disableMouse sends the escape codes through zig
    (renderer as unknown as { _useMouse: boolean })._useMouse = true;
    renderer.useMouse = false;
  }

  state.onAttach(async (session: string) => {
    await state.dispose();
    disableMouse();
    renderer.destroy();

    if (options.exitOnAttach) {
      process.exit(0);
    }

    // Outside tmux: attach to session, return to dashboard on detach
    const insideTmux = !!process.env.TMUX;
    if (!insideTmux) {
      const proc = Bun.spawn(["tmux", "attach-session", "-t", session], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      await runDashboard(deps, options);
    }
  });

  // Keyboard handler
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      state.dispose().then(() => {
        disableMouse();
        renderer.destroy();
        process.exit(0);
      });
      return;
    }

    // In view mode, only j/k/up/down/escape/v/q are accepted
    if (state.isViewMode()) {
      const name = key.name;
      if (name === "escape") {
        state.handleInput("escape");
      } else if (name === "up" || name === "down") {
        state.handleInput(name);
      } else if (key.sequence === "j" || key.sequence === "k" || key.sequence === "v" || key.sequence === "q" || key.sequence === "r") {
        state.handleInput(key.sequence);
      }
      return;
    }

    // In confirm mode, only y/n/escape are accepted
    if (state.isConfirmMode()) {
      const name = key.name;
      if (name === "escape" || key.sequence === "n" || key.sequence === "N") {
        state.handleInput("escape");
      } else if (key.sequence === "y" || key.sequence === "Y") {
        state.handleInput("y");
      }
      return;
    }

    // In fix mode, text input keys go to state
    if (state.isFixMode()) {
      const name = key.name;
      if (name === "escape") {
        state.handleInput("escape");
      } else if (name === "return") {
        state.handleInput("enter");
      } else if (name === "backspace") {
        state.handleInput("backspace");
      } else if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
        state.handleInput(key.sequence);
      }
      return;
    }

    // In create mode, only Ctrl+C exits; all other keys go to state
    if (state.isCreateMode()) {
      const name = key.name;
      if (name === "escape") {
        state.handleInput("escape");
      } else if (name === "return") {
        state.handleInput("enter");
      } else if (name === "tab") {
        state.handleInput("tab");
      } else if (name === "backspace") {
        state.handleInput("backspace");
      } else if (key.sequence && key.sequence.length === 1 && key.sequence >= " ") {
        state.handleInput(key.sequence);
      }
      return;
    }

    if (key.name === "q" && !key.ctrl && !key.meta) {
      state.dispose().then(() => {
        disableMouse();
        renderer.destroy();
        process.exit(0);
      });
      return;
    }

    // Map key events to state machine
    // Pass all keys through — state machine ignores unknown keys
    const name = key.name;
    if (name === "up" || name === "down") {
      state.handleInput(name);
    } else if (name === "return") {
      state.handleInput("enter");
    } else if (key.sequence && key.sequence.length === 1) {
      // Single character keys (including shifted like 'R')
      state.handleInput(key.sequence);
    }
  });

  renderer.keyInput.on("paste", (event: PasteEvent) => {
    if (state.isCreateMode() || state.isFixMode()) {
      for (const ch of event.text) {
        if (ch >= " ") {
          state.handleInput(ch);
        }
      }
    }
  });

  // React to state changes
  state.onChange(() => {
    dashboard.update();
  });

  // Re-render on terminal resize
  renderer.on("resize", () => {
    dashboard.update();
  });

  // Initialize and do first render
  await state.init(options);
  dashboard.update();
}
