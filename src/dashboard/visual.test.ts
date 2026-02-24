/**
 * Visual snapshot tests for the Dashboard TUI.
 *
 * Uses OpenTUI's test renderer to capture rendered frames
 * and assert on visual output — like Playwright for TUIs.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { Deps, Task, Project } from "../core/types.js";
import { MockGit } from "../core/git.js";
import { MockGitHub } from "../core/github.js";
import { MockTmux } from "../core/tmux.js";
import { MockClock } from "../core/clock.js";
import { NullLogger } from "../core/logger.js";
import { saveTask, saveProjects } from "../core/state.js";
import { DashboardState, STATUS_COLOR, SESSION_ICON, SESSION_COLOR } from "./state.js";

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: "test123",
  project: "testproj",
  branch: "feature-x",
  harness: "claude",
  review_harness: "claude",
  status: "pending",
  review_round: 0,
  crash_count: 0,
  workspace: null,
  tmux_session: null,
  summary: "Test task description",
  body: "",
  created_at: "2024-01-15T10:00:00.000Z",
  updated_at: "2024-01-15T10:00:00.000Z",
  pr_url: null,
    pr_state: null,
  ...overrides,
});

// Column widths (must match index.ts)
const COL_STATUS = 12;
const COL_PR = 14;
const COL_COMMITS = 8;
const COL_CHANGES = 14;
const COL_ACTIVITY = 9;

/**
 * Build the dashboard UI into a test renderer.
 * Mirrors the structure from index.ts but in a test context.
 */
function buildTestDashboard(
  renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"],
  state: DashboardState
) {
  const s = state.data;

  const root = new BoxRenderable(renderer, {
    id: "root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });

  const header = new TextRenderable(renderer, {
    id: "header",
    content: "",
    fg: "#00DDFF",
  });

  const colHeaderRow = new BoxRenderable(renderer, {
    id: "col-headers",
    flexDirection: "row",
    width: "100%",
    paddingLeft: 1,
  });
  const hTask = new TextRenderable(renderer, { id: "h-task", content: "Task", fg: "#666666", flexGrow: 1 });
  const hStatus = new TextRenderable(renderer, { id: "h-status", content: "Status", fg: "#666666", width: COL_STATUS });
  const hPR = new TextRenderable(renderer, { id: "h-pr", content: "PR", fg: "#666666", width: COL_PR });
  const hCommits = new TextRenderable(renderer, { id: "h-commits", content: "Commits", fg: "#666666", width: COL_COMMITS });
  const hChanges = new TextRenderable(renderer, { id: "h-changes", content: "Changes", fg: "#666666", width: COL_CHANGES });
  const hActivity = new TextRenderable(renderer, { id: "h-activity", content: "Activity", fg: "#666666", width: COL_ACTIVITY });
  colHeaderRow.add(hTask);
  colHeaderRow.add(hStatus);
  colHeaderRow.add(hPR);
  colHeaderRow.add(hCommits);
  colHeaderRow.add(hChanges);
  colHeaderRow.add(hActivity);

  const separator = new TextRenderable(renderer, { id: "separator", content: "", fg: "#444444" });
  const errorText = new TextRenderable(renderer, { id: "error", content: "", fg: "#FF4444" });
  const messageText = new TextRenderable(renderer, { id: "message", content: "", fg: "#44FF44" });

  const taskList = new BoxRenderable(renderer, {
    id: "task-list",
    flexDirection: "column",
    flexGrow: 1,
    width: "100%",
  });

  const footerSep = new TextRenderable(renderer, { id: "footer-sep", content: "", fg: "#444444" });
  const footerKeys = new TextRenderable(renderer, { id: "footer-keys", content: "", fg: "#888888" });

  root.add(header);
  root.add(colHeaderRow);
  root.add(separator);
  root.add(errorText);
  root.add(messageText);
  root.add(taskList);
  root.add(footerSep);
  root.add(footerKeys);
  renderer.root.add(root);

  let taskRows: BoxRenderable[] = [];

  function update() {
    const width = renderer.width;

    const statusLabel = s.statusFilter === "all" ? "" : ` [${s.statusFilter}]`;
    const headerLabel = s.projectLabel === "all"
      ? `Orange Dashboard (all)${statusLabel}`
      : `${s.projectLabel}${statusLabel}`;
    header.content = ` ${headerLabel}`;

    separator.content = "─".repeat(width);
    errorText.content = s.error ? ` Error: ${s.error}` : "";
    errorText.visible = !!s.error;
    messageText.content = s.message ? ` ✓ ${s.message}` : "";
    messageText.visible = !!s.message;

    footerSep.content = "─".repeat(width);
    footerKeys.content = state.getContextKeys();

    for (const row of taskRows) row.destroy();
    taskRows = [];

    if (s.tasks.length === 0) {
      const projectMsg = s.projectFilter ? ` for project '${s.projectFilter}'` : "";
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

      // Session state: alive, dead (working + no session), or none
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
      const taskName = s.projectFilter ? task.branch : `${task.project}/${task.branch}`;
      const statusCol = task.status;

      const rowContainer = new BoxRenderable(renderer, {
        id: `task-row-${i}`,
        flexDirection: "column",
        width: "100%",
      });

      const tableRow = new BoxRenderable(renderer, {
        id: `task-cells-${i}`,
        flexDirection: "row",
        width: "100%",
        paddingLeft: 1,
        backgroundColor: selected ? "#333366" : "transparent",
      });

      tableRow.add(new TextRenderable(renderer, { id: `t-task-${i}`, content: `${sessionIcon} ${taskName}`, fg: sessionColor, flexGrow: 1, flexShrink: 1 }));
      tableRow.add(new TextRenderable(renderer, { id: `t-status-${i}`, content: statusCol, fg: STATUS_COLOR[task.status], width: COL_STATUS }));
      tableRow.add(new TextRenderable(renderer, { id: `t-pr-${i}`, content: "", fg: "#888888", width: COL_PR }));
      tableRow.add(new TextRenderable(renderer, { id: `t-commits-${i}`, content: "", fg: "#CCCCCC", width: COL_COMMITS }));
      tableRow.add(new TextRenderable(renderer, { id: `t-changes-${i}`, content: "", fg: "#CCCCCC", width: COL_CHANGES }));
      tableRow.add(new TextRenderable(renderer, { id: `t-activity-${i}`, content: activity, fg: "#888888", width: COL_ACTIVITY }));
      rowContainer.add(tableRow);

      if (selected) {
        rowContainer.add(new TextRenderable(renderer, {
          id: `task-desc-${i}`,
          content: ` └ ${task.summary}`,
          fg: "#888888",
        }));
      }

      taskList.add(rowContainer);
      taskRows.push(rowContainer);
    }
  }

  return { update };
}

describe("Dashboard Visual", () => {
  let tempDir: string;
  let deps: Deps;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-visual-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(new Date("2024-01-15T10:00:00.000Z")),
      logger: new NullLogger(),
      dataDir: tempDir,
    };
    const project: Project = {
      name: "testproj",
      path: "/path/to/testproj",
      default_branch: "main",
      pool_size: 2,
    };
    await saveProjects(deps, [project]);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("renders empty dashboard", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
    });

    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();
    const dashboard = buildTestDashboard(renderer, state);
    dashboard.update();

    await renderOnce();
    const frame = captureCharFrame();

    expect(frame).toContain("testproj");
    expect(frame).toContain("Task");
    expect(frame).toContain("Status");
    expect(frame).toContain("Commits");
    expect(frame).toContain("Changes");
    expect(frame).toContain("Activity");
    expect(frame).toContain("No tasks");
    expect(frame).toContain("c:create");

    renderer.destroy();
  });

  test("renders task list with proper column alignment", async () => {
    // Use different timestamps for deterministic ordering (newest first)
    // Working task has an active session
    await saveTask(deps, createTask({ id: "t1", branch: "login-fix", status: "working", tmux_session: "testproj/login-fix", summary: "Fix OAuth redirect loop", created_at: "2024-01-15T12:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t2", branch: "dark-mode", status: "done", summary: "Add dark theme", created_at: "2024-01-15T11:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t3", branch: "password-reset", status: "reviewing", summary: "Password reset flow", created_at: "2024-01-15T10:00:00.000Z" }));

    // Mock tmux to return the working task's session as alive
    (deps.tmux as MockTmux).sessions.set("testproj/login-fix", { cwd: "/tmp", command: "", output: [], windows: new Set() });

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
    });

    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();
    const dashboard = buildTestDashboard(renderer, state);
    dashboard.update();

    await renderOnce();
    const frame = captureCharFrame();

    // Check task names appear
    expect(frame).toContain("login-fix");
    expect(frame).toContain("dark-mode");
    expect(frame).toContain("password-reset");

    // Check session icons (● = alive, ○ = no session)
    expect(frame).toContain("●"); // working with active session
    expect(frame).toContain("○"); // done/reviewing have no session

    // Check statuses
    expect(frame).toContain("working");
    expect(frame).toContain("done");
    expect(frame).toContain("reviewing");

    // Selected task shows description
    expect(frame).toContain("Fix OAuth redirect loop");

    // Column headers on same line (no wrapping)
    const lines = frame.split("\n");
    const headerLine = lines.find(l => l.includes("Task") && l.includes("Status"));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain("Commits");
    expect(headerLine).toContain("Changes");
    expect(headerLine).toContain("Activity");

    renderer.destroy();
  });

  test("columns stay aligned across different terminal widths", async () => {
    await saveTask(deps, createTask({ id: "t1", branch: "feature-branch", status: "working" }));

    // Minimum 80 width to fit all columns (Task + Status + PR + Commits + Changes + Activity)
    for (const width of [80, 120, 160]) {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width,
        height: 24,
      });

      const state = new DashboardState(deps, { project: "testproj" });
      await state.loadTasks();
      const dashboard = buildTestDashboard(renderer, state);
      dashboard.update();

      await renderOnce();
      const frame = captureCharFrame();
      const lines = frame.split("\n");

      // Header line should have all columns on one line
      const headerLine = lines.find(l => l.includes("Task") && l.includes("Status"));
      expect(headerLine).toBeDefined();
      expect(headerLine).toContain("PR");
      expect(headerLine).toContain("Commits");
      expect(headerLine).toContain("Activity");

      renderer.destroy();
    }
  });

  test("cursor navigation changes selected row", async () => {
    // Use different timestamps for deterministic ordering (newest first)
    await saveTask(deps, createTask({ id: "t1", branch: "branch-a", status: "working", summary: "First task", created_at: "2024-01-15T12:00:00.000Z" }));
    await saveTask(deps, createTask({ id: "t2", branch: "branch-b", status: "done", summary: "Second task", created_at: "2024-01-15T11:00:00.000Z" }));

    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
    });

    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();
    const dashboard = buildTestDashboard(renderer, state);

    // First task selected
    dashboard.update();
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toContain("└ First task");

    // Move down
    state.handleInput("j");
    dashboard.update();
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toContain("└ Second task");
    expect(frame).not.toContain("└ First task");

    renderer.destroy();
  });

  test("filter indicator shows in header", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 80,
      height: 24,
    });

    const state = new DashboardState(deps, { project: "testproj" });
    await state.loadTasks();
    const dashboard = buildTestDashboard(renderer, state);

    state.handleInput("f"); // active
    dashboard.update();
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toContain("[active]");

    state.handleInput("f"); // done
    dashboard.update();
    await renderOnce();
    frame = captureCharFrame();
    expect(frame).toContain("[done]");

    renderer.destroy();
  });
});
