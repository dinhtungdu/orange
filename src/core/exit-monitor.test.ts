/**
 * Tests for exit monitoring: dead session detection and auto-advance rules.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Task } from "./types.js";
import { MockGit } from "./git.js";
import { MockGitHub } from "./github.js";
import { MockTmux } from "./tmux.js";
import { MockClock } from "./clock.js";
import { NullLogger } from "./logger.js";
import { saveTask, loadTask, loadHistory } from "./state.js";
import { checkDeadSessions, applyAutoAdvanceRules } from "./exit-monitor.js";
import type { TransitionHook } from "./transitions.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test123",
    project: "orange",
    branch: "feature-x",
    harness: "claude",
    review_harness: "claude",
    status: "working",
    review_round: 0,
    crash_count: 0,
    workspace: "orange--1",
    tmux_session: "orange/feature-x",
    summary: "Test task",
    body: "",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    pr_url: null,
    ...overrides,
  };
}

describe("checkDeadSessions", () => {
  let tempDir: string;
  let deps: Deps;
  let mockTmux: MockTmux;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockTmux = new MockTmux();
    deps = {
      tmux: mockTmux,
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("detects dead session when tmux session missing", async () => {
    const task = createTask({ tmux_session: "orange/feature-x", status: "working" });
    // Don't create the tmux session — simulating it died

    const results = await checkDeadSessions([task], deps);
    expect(results).toHaveLength(1);
    expect(results[0].isDead).toBe(true);
  });

  test("does not flag live session as dead", async () => {
    const task = createTask({ tmux_session: "orange/feature-x", status: "working" });
    await mockTmux.newSession("orange/feature-x", "/tmp", "claude");

    const results = await checkDeadSessions([task], deps);
    expect(results).toHaveLength(1);
    expect(results[0].isDead).toBe(false);
  });

  test("skips tasks without tmux_session", async () => {
    const task = createTask({ tmux_session: null, status: "pending" });

    const results = await checkDeadSessions([task], deps);
    expect(results).toHaveLength(0);
  });

  test("skips tasks in terminal statuses", async () => {
    const task = createTask({ tmux_session: "orange/feature-x", status: "done" });

    const results = await checkDeadSessions([task], deps);
    expect(results).toHaveLength(0);
  });
});

describe("applyAutoAdvanceRules", () => {
  let tempDir: string;
  let deps: Deps;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const noopHook = async (_hook: TransitionHook, _task: Task) => {};

  // --- planning status ---

  test("planning: auto-advances to working with valid plan", async () => {
    const task = createTask({
      status: "planning",
      body: "## Plan\n\nAPPROACH: Use JWT\nTOUCHING: src/auth.ts",
    });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("advanced");
    expect(result.to).toBe("working");
  });

  test("planning: crashes without valid plan", async () => {
    const task = createTask({ status: "planning", body: "" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("crashed");
    expect(task.crash_count).toBe(1);
  });

  test("planning: advances to stuck after 2 crashes", async () => {
    const task = createTask({ status: "planning", crash_count: 1, body: "" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("stuck");
    expect(result.to).toBe("stuck");
    expect(task.crash_count).toBe(2);
    expect(task.status).toBe("stuck");
  });

  // --- working status ---

  test("working: auto-advances to agent-review with valid handoff", async () => {
    const task = createTask({
      status: "working",
      body: "## Handoff\n\nDONE: Auth implemented\nREMAINING: Tests",
    });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("advanced");
    expect(result.to).toBe("agent-review");
  });

  test("working: crashes without handoff", async () => {
    const task = createTask({ status: "working", body: "" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("crashed");
    expect(task.crash_count).toBe(1);
  });

  test("working: advances to stuck after 2 crashes", async () => {
    const task = createTask({ status: "working", crash_count: 1, body: "" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("stuck");
    expect(task.status).toBe("stuck");
  });

  // --- agent-review status ---

  test("agent-review: auto-advances to reviewing with PASS verdict", async () => {
    const task = createTask({
      status: "agent-review",
      body: "## Review\n\nVerdict: PASS\n\nLGTM!",
    });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("advanced");
    expect(result.to).toBe("reviewing");
  });

  test("agent-review: auto-advances to working with FAIL verdict and round < 2", async () => {
    const task = createTask({
      status: "agent-review",
      review_round: 1,
      body: "## Review\n\nVerdict: FAIL\n\nNeeds work",
    });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("advanced");
    expect(result.to).toBe("working");
  });

  test("agent-review: auto-advances to stuck with FAIL verdict and round >= 2", async () => {
    const task = createTask({
      status: "agent-review",
      review_round: 2,
      body: "## Review\n\nVerdict: FAIL\n\nStill broken",
    });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("stuck");
    expect(result.to).toBe("stuck");
  });

  test("agent-review: crashes without verdict", async () => {
    const task = createTask({ status: "agent-review", body: "" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("crashed");
    expect(task.crash_count).toBe(1);
  });

  // --- no-auto-advance statuses ---

  test("clarification: marks crashed, no auto-advance", async () => {
    const task = createTask({ status: "clarification" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("crashed");
    expect(task.crash_count).toBe(1);
    // Status should NOT change for clarification
    expect(task.status).toBe("clarification");
  });

  test("reviewing: marks crashed, no auto-advance", async () => {
    const task = createTask({ status: "reviewing" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("crashed");
    expect(task.crash_count).toBe(1);
  });

  test("stuck: marks crashed, no auto-advance", async () => {
    const task = createTask({ status: "stuck" });
    await saveTask(deps, task);

    const result = await applyAutoAdvanceRules(task, deps, noopHook);

    expect(result.action).toBe("crashed");
    expect(task.crash_count).toBe(1);
  });

  // --- crash tracking ---

  test("crash count persists to disk", async () => {
    const task = createTask({ status: "working", body: "" });
    await saveTask(deps, task);

    await applyAutoAdvanceRules(task, deps, noopHook);

    const loaded = await loadTask(deps, "orange", "test123");
    expect(loaded!.crash_count).toBe(1);
  });

  test("history events logged for crashes", async () => {
    const task = createTask({ status: "working", body: "" });
    await saveTask(deps, task);

    await applyAutoAdvanceRules(task, deps, noopHook);

    const events = await loadHistory(deps, "orange", "test123");
    const crashEvents = events.filter(e => e.type === "agent.crashed");
    expect(crashEvents).toHaveLength(1);
  });

  test("history events logged for auto-advance", async () => {
    const task = createTask({
      status: "working",
      body: "## Handoff\n\nDONE: Everything",
    });
    await saveTask(deps, task);

    await applyAutoAdvanceRules(task, deps, noopHook);

    const events = await loadHistory(deps, "orange", "test123");
    const advanceEvents = events.filter(e => e.type === "auto.advanced");
    expect(advanceEvents).toHaveLength(1);
  });

  test("crash threshold escalation logs both crash and auto-advance", async () => {
    const task = createTask({ status: "working", crash_count: 1, body: "" });
    await saveTask(deps, task);

    await applyAutoAdvanceRules(task, deps, noopHook);

    const events = await loadHistory(deps, "orange", "test123");
    const crashEvents = events.filter(e => e.type === "agent.crashed");
    const advanceEvents = events.filter(e => e.type === "auto.advanced");
    expect(crashEvents).toHaveLength(1);
    expect(advanceEvents).toHaveLength(1);
  });
});
