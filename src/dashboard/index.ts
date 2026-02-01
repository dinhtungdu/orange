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
import type { Deps, TaskStatus } from "../core/types.js";
import {
  DashboardState,
  STATUS_COLOR,
  SESSION_ICON,
  SESSION_COLOR,
  CHECKS_ICON,
  type DashboardOptions,
} from "./state.js";

// Re-export for external use and tests
export { DashboardState } from "./state.js";
export type { DashboardOptions } from "./state.js";

// Column widths (fixed)
const COL_STATUS = 12;
const COL_PR = 14;
const COL_COMMITS = 8;
const COL_CHANGES = 14;
const COL_ACTIVITY = 9;
const FIXED_COLS = COL_STATUS + COL_PR + COL_COMMITS + COL_CHANGES + COL_ACTIVITY;

/** Create a flex row (horizontal box) with table cells. */
function createTableRow(
  renderer: CliRenderer,
  id: string,
  opts: {
    task: string;
    taskColor: string;
    status: string;
    statusColor: string;
    pr: string;
    prColor: string;
    commits: string;
    changes: string;
    changesAdded: string;
    changesRemoved: string;
    activity: string;
    selected?: boolean;
  }
): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    id,
    flexDirection: "row",
    width: "100%",
    paddingLeft: 1,
  });

  // Selection indicator + task column: flex-grows to fill remaining space
  const taskContent = opts.selected
    ? t`${fg("#00DDFF")("❯")} ${bold(fg(opts.taskColor)(opts.task))}`
    : t`  ${fg(opts.taskColor)(opts.task)}`;
  const taskCell = new TextRenderable(renderer, {
    id: `${id}-task`,
    content: taskContent,
    flexGrow: 1,
    flexShrink: 1,
  });

  // Status column: fixed width
  const statusCell = new TextRenderable(renderer, {
    id: `${id}-status`,
    content: opts.status,
    fg: opts.statusColor,
    width: COL_STATUS,
  });

  // PR column: fixed width
  const prCell = new TextRenderable(renderer, {
    id: `${id}-pr`,
    content: opts.pr,
    fg: opts.prColor,
    width: COL_PR,
  });

  // Commits column: fixed width
  const commitsCell = new TextRenderable(renderer, {
    id: `${id}-commits`,
    content: opts.commits,
    fg: "#CCCCCC",
    width: COL_COMMITS,
  });

  // Changes column: fixed width, colored parts
  // We show "+N -M" as a single string; coloring per-part would need two cells
  // For now use added color if only adds, removed if only removes, white if both
  let changesText = opts.changes || "";
  let changesColor = "#CCCCCC";
  if (opts.changesAdded && opts.changesRemoved) {
    changesText = `${opts.changesAdded} ${opts.changesRemoved}`;
  } else if (opts.changesAdded) {
    changesText = opts.changesAdded;
    changesColor = "#44FF44";
  } else if (opts.changesRemoved) {
    changesText = opts.changesRemoved;
    changesColor = "#FF4444";
  }
  const changesCell = new TextRenderable(renderer, {
    id: `${id}-changes`,
    content: changesText,
    fg: changesColor,
    width: COL_CHANGES,
  });

  // Activity column: fixed width, right-aligned not easily done per-cell,
  // but we can pad the content
  const activityCell = new TextRenderable(renderer, {
    id: `${id}-activity`,
    content: opts.activity,
    fg: "#888888",
    width: COL_ACTIVITY,
  });

  row.add(taskCell);
  row.add(statusCell);
  row.add(prCell);
  row.add(commitsCell);
  row.add(changesCell);
  row.add(activityCell);

  return row;
}

/** Create the column header row. */
function createHeaderRow(renderer: CliRenderer): BoxRenderable {
  return createTableRow(renderer, "col-headers", {
    task: "Task",
    taskColor: "#666666",
    status: "Status",
    statusColor: "#666666",
    pr: "PR",
    prColor: "#666666",
    commits: "Commits",
    changes: "Changes",
    changesAdded: "",
    changesRemoved: "",
    activity: "Activity",
    selected: false,
  });
}

/**
 * Build the full dashboard UI.
 */
function buildDashboard(
  renderer: CliRenderer,
  state: DashboardState
): { update: () => void } {
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

  // --- Column headers (flex row) ---
  const colHeaderRow = createHeaderRow(renderer);

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
  root.add(footerSep);
  root.add(footerKeys);
  renderer.root.add(root);

  // Track task row renderables for cleanup
  let taskRows: BoxRenderable[] = [];

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
      const statusDisplay = cm.status === "pending" ? "pending ◀" : "reviewing ◀";
      createStatusLabel.content = `Status:      [${statusDisplay}]`;
      createStatusLabel.fg = statusHighlight;
    }

    // Confirm prompt
    const cfm = s.confirmMode;
    confirmPrompt.visible = cfm.active;
    if (cfm.active) {
      confirmPrompt.content = ` ${cfm.message} (y/N)`;
    }

    // Footer
    footerSep.content = "─".repeat(width);
    const keys = state.getContextKeys();
    footerKeys.content = keys.length > width ? keys.slice(0, width - 1) + "…" : keys;

    // --- Task rows ---
    for (const row of taskRows) {
      row.destroy();
    }
    taskRows = [];

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

    for (let i = 0; i < s.tasks.length; i++) {
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

      // Status column: always task stage
      let statusCol: string = pending ? "processing…" : task.status;

      // PR column: PR info when available
      let prCol = "";
      let prColor = "#888888";
      if (task.pr_url) {
        const prNum = task.pr_url.match(/\/pull\/(\d+)/)?.[1];
        const prStatus = s.prStatuses.get(task.id);
        if (prNum && prStatus) {
          const checksIcon = prStatus.checks ? CHECKS_ICON[prStatus.checks] : "";
          if (prStatus.state === "MERGED") {
            prCol = `#${prNum} merged`;
            prColor = "#22BB22";
          } else if (prStatus.state === "CLOSED") {
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

      // Outer container for row + summary
      const rowContainer = new BoxRenderable(renderer, {
        id: `task-row-${i}`,
        flexDirection: "column",
        width: "100%",
      });

      // Table row with flex columns
      const tableRow = createTableRow(renderer, `task-cells-${i}`, {
        task: `${sessionIcon} ${taskName}`,
        taskColor: sessionColor,
        status: statusCol,
        statusColor: STATUS_COLOR[task.status],
        pr: prCol,
        prColor,
        commits: commitsCol,
        changes: "",
        changesAdded,
        changesRemoved,
        activity,
        selected,
      });

      rowContainer.add(tableRow);

      // Summary line (always shown)
      const summaryMaxLen = width - 4;
      const summaryDisplay =
        task.summary.length > summaryMaxLen
          ? task.summary.slice(0, summaryMaxLen - 1) + "…"
          : task.summary;
      const summaryText = new TextRenderable(renderer, {
        id: `task-summary-${i}`,
        content: ` └ ${summaryDisplay || "(no summary)"}`,
        fg: selected ? "#AAAAAA" : "#666666",
      });
      rowContainer.add(summaryText);

      taskList.add(rowContainer);
      taskRows.push(rowContainer);
    }
  }

  return { update };
}

/**
 * Run the dashboard.
 */
export async function runDashboard(
  deps: Deps,
  options: DashboardOptions = {}
): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 10,
    useMouse: false,
  });

  const state = new DashboardState(deps, options);
  const dashboard = buildDashboard(renderer, state);

  if (options.exitOnAttach) {
    state.onAttach(() => {
      state.dispose().then(() => {
        renderer.destroy();
        process.exit(0);
      });
    });
  }

  // Keyboard handler
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      state.dispose().then(() => {
        renderer.destroy();
        process.exit(0);
      });
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
    if (state.isCreateMode()) {
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
