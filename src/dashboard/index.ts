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
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type { Deps, TaskStatus } from "../core/types.js";
import {
  DashboardState,
  STATUS_ICON,
  STATUS_COLOR,
  CHECKS_ICON,
  type DashboardOptions,
} from "./state.js";

// Re-export for external use and tests
export { DashboardState } from "./state.js";
export type { DashboardOptions } from "./state.js";

// Column widths (fixed)
const COL_STATUS = 22;
const COL_COMMITS = 8;
const COL_CHANGES = 14;
const COL_ACTIVITY = 9;
const FIXED_COLS = COL_STATUS + COL_COMMITS + COL_CHANGES + COL_ACTIVITY;

/** Create a flex row (horizontal box) with table cells. */
function createTableRow(
  renderer: CliRenderer,
  id: string,
  opts: {
    task: string;
    taskColor: string;
    status: string;
    statusColor: string;
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
    backgroundColor: opts.selected ? "#333366" : "transparent",
  });

  // Task column: flex-grows to fill remaining space
  const taskCell = new TextRenderable(renderer, {
    id: `${id}-task`,
    content: opts.task,
    fg: opts.taskColor,
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
    backgroundColor: "#1a1a2e",
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
    fg: "#444444",
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
  createForm.add(createTitle);
  createForm.add(createBranchLabel);
  createForm.add(createDescLabel);

  // --- Footer ---
  const footerSep = new TextRenderable(renderer, {
    id: "footer-sep",
    content: "",
    fg: "#444444",
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
    header.content = ` ${headerLabel}`;

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
      const descCursor = cm.focusedField === "description" ? "█" : "";
      const branchHighlight = cm.focusedField === "branch" ? "#00DDFF" : "#888888";
      const descHighlight = cm.focusedField === "description" ? "#00DDFF" : "#888888";
      createBranchLabel.content = `Branch:      [${cm.branch}${branchCursor}]`;
      createBranchLabel.fg = branchHighlight;
      createDescLabel.content = `Description: [${cm.description}${descCursor}]`;
      createDescLabel.fg = descHighlight;
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
      const isDead = s.deadSessions.has(task.id);
      const displayStatus: TaskStatus = isDead ? "failed" : task.status;
      const icon = STATUS_ICON[displayStatus];
      const color = isDead ? STATUS_COLOR.failed : STATUS_COLOR[task.status];
      const activity = state.formatRelativeTime(task.updated_at);

      const taskName = s.projectFilter
        ? task.branch
        : `${task.project}/${task.branch}`;

      let statusCol: string = isDead ? "dead" : task.status;
      if (task.pr_url) {
        const prNum = task.pr_url.match(/\/pull\/(\d+)/)?.[1];
        const prStatus = s.prStatuses.get(task.id);
        if (prNum) statusCol += ` #${prNum}`;
        if (prStatus?.state === "MERGED") {
          statusCol += " merged";
        } else if (prStatus?.state === "CLOSED") {
          statusCol += " closed";
        } else if (prStatus?.checks) {
          const checksIcon = CHECKS_ICON[prStatus.checks];
          if (checksIcon) statusCol += ` ${checksIcon}`;
        }
      }
      if (pending) statusCol = "processing…";

      const stats = s.diffStats.get(task.id);
      const commitsCol = stats && stats.commits > 0 ? String(stats.commits) : "";
      const changesAdded = stats && stats.added > 0 ? `+${stats.added}` : "";
      const changesRemoved = stats && stats.removed > 0 ? `-${stats.removed}` : "";

      // Outer container for row + description
      const rowContainer = new BoxRenderable(renderer, {
        id: `task-row-${i}`,
        flexDirection: "column",
        width: "100%",
      });

      // Table row with flex columns
      const tableRow = createTableRow(renderer, `task-cells-${i}`, {
        task: `${icon} ${taskName}`,
        taskColor: color,
        status: statusCol,
        statusColor: color,
        commits: commitsCol,
        changes: "",
        changesAdded,
        changesRemoved,
        activity,
        selected,
      });

      rowContainer.add(tableRow);

      // Description for selected task
      if (selected) {
        const descMaxLen = width - 4;
        const desc =
          task.description.length > descMaxLen
            ? task.description.slice(0, descMaxLen - 1) + "…"
            : task.description;
        const descText = new TextRenderable(renderer, {
          id: `task-desc-${i}`,
          content: ` └ ${desc}`,
          fg: "#888888",
        });
        rowContainer.add(descText);
      }

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

  // Keyboard handler
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      state.dispose().then(() => {
        renderer.destroy();
        process.exit(0);
      });
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
    const name = key.name;
    if (name === "j" || name === "k" || name === "m" || name === "x" ||
        name === "d" || name === "r" || name === "p" ||
        name === "f" || name === "c" || name === "s" || name === "a") {
      state.handleInput(name);
    } else if (name === "up" || name === "down") {
      state.handleInput(name);
    } else if (name === "return") {
      state.handleInput("enter");
    }
  });

  // React to state changes
  state.onChange(() => {
    dashboard.update();
  });

  // Initialize and do first render
  await state.init(options);
  dashboard.update();
}
