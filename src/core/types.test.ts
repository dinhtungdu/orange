/**
 * Tests for core types.
 *
 * Validates that type definitions work correctly at runtime.
 */

import { describe, expect, test } from "bun:test";
import type {
  Task,
  TaskStatus,
  Project,
  PoolState,
  HistoryEvent,
} from "./types.js";

describe("Task types", () => {
  test("Task has all required fields including crash_count", () => {
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "pending",
      workspace: null,
      tmux_session: null,
      summary: "Implement feature X",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      review_harness: "claude",
      review_round: 0,
      crash_count: 0,
      pr_url: null,
    pr_state: null,
    };

    expect(task.id).toBe("abc12345");
    expect(task.status).toBe("pending");
    expect(task.workspace).toBeNull();
    expect(task.crash_count).toBe(0);
  });

  test("TaskStatus includes all valid states including planning", () => {
    const statuses: TaskStatus[] = [
      "pending",
      "planning",
      "clarification",
      "working",
      "agent-review",
      "reviewing",
      "stuck",
      "done",
      "cancelled",
    ];

    expect(statuses).toHaveLength(9);
  });

  test("Task can transition through statuses", () => {
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "pending",
      workspace: null,
      tmux_session: null,
      summary: "Test task",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      review_harness: "claude",
      review_round: 0,
      crash_count: 0,
      pr_url: null,
    pr_state: null,
    };

    // Simulate new state machine: pending → planning → working
    task.status = "planning";
    expect(task.status).toBe("planning");

    task.status = "working";
    task.workspace = "orange--1";
    task.tmux_session = "orange/feature-x";
    expect(task.status).toBe("working");

    task.status = "agent-review";
    expect(task.status).toBe("agent-review");

    task.status = "reviewing";
    expect(task.status).toBe("reviewing");

    task.status = "done";
    task.workspace = null;
    task.tmux_session = null;
    expect(task.status).toBe("done");
  });

  test("crash_count tracks agent crashes", () => {
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "working",
      workspace: "orange--1",
      tmux_session: "orange/feature-x",
      summary: "Test task",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      review_harness: "claude",
      review_round: 0,
      crash_count: 0,
      pr_url: null,
    pr_state: null,
    };

    // Simulate crashes
    task.crash_count = 1;
    expect(task.crash_count).toBe(1);

    task.crash_count = 2;
    expect(task.crash_count).toBe(2);

    // Reset on successful transition
    task.crash_count = 0;
    expect(task.crash_count).toBe(0);
  });
});

describe("Project types", () => {
  test("Project has all required fields", () => {
    const project: Project = {
      name: "orange",
      path: "/Users/test/workspace/orange",
      default_branch: "main",
      pool_size: 2,
    };

    expect(project.name).toBe("orange");
    expect(project.pool_size).toBe(2);
  });
});

describe("PoolState types", () => {
  test("PoolState tracks workspace entries", () => {
    const state: PoolState = {
      workspaces: {
        "orange--1": { status: "available" },
        "orange--2": { status: "bound", task: "orange/feature-x" },
      },
    };

    expect(state.workspaces["orange--1"].status).toBe("available");
    expect(state.workspaces["orange--2"].status).toBe("bound");
    expect(state.workspaces["orange--2"].task).toBe("orange/feature-x");
  });
});

describe("HistoryEvent types", () => {
  test("task.created event has required fields", () => {
    const event: HistoryEvent = {
      type: "task.created",
      timestamp: "2024-01-01T00:00:00.000Z",
      task_id: "abc12345",
      project: "orange",
      branch: "feature-x",
      summary: "Implement feature X",
    };

    expect(event.type).toBe("task.created");
    if (event.type === "task.created") {
      expect(event.task_id).toBe("abc12345");
    }
  });

  test("status.changed event tracks transitions", () => {
    const event: HistoryEvent = {
      type: "status.changed",
      timestamp: "2024-01-01T00:00:00.000Z",
      from: "pending",
      to: "planning",
    };

    expect(event.type).toBe("status.changed");
    if (event.type === "status.changed") {
      expect(event.from).toBe("pending");
      expect(event.to).toBe("planning");
    }
  });

  test("agent.crashed event tracks crash details", () => {
    const event: HistoryEvent = {
      type: "agent.crashed",
      timestamp: "2024-01-01T00:00:00.000Z",
      status: "working",
      crash_count: 1,
      reason: "no ## Handoff",
    };

    expect(event.type).toBe("agent.crashed");
    if (event.type === "agent.crashed") {
      expect(event.crash_count).toBe(1);
      expect(event.reason).toBe("no ## Handoff");
    }
  });

  test("auto.advanced event tracks auto-advance", () => {
    const event: HistoryEvent = {
      type: "auto.advanced",
      timestamp: "2024-01-01T00:00:00.000Z",
      from: "working",
      to: "agent-review",
      reason: "## Handoff found",
    };

    expect(event.type).toBe("auto.advanced");
    if (event.type === "auto.advanced") {
      expect(event.from).toBe("working");
      expect(event.to).toBe("agent-review");
      expect(event.reason).toBe("## Handoff found");
    }
  });
});
