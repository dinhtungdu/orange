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
  test("Task has all required fields", () => {
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
    pr_url: null,
    };

    expect(task.id).toBe("abc12345");
    expect(task.status).toBe("pending");
    expect(task.workspace).toBeNull();
  });

  test("TaskStatus includes all valid states", () => {
    const statuses: TaskStatus[] = [
      "pending",
      "clarification",
      "working",
      "reviewing",
      "stuck",
      "done",
      "cancelled",
    ];

    expect(statuses).toHaveLength(7);
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
    pr_url: null,
    };

    // Simulate state transitions
    task.status = "working";
    task.workspace = "orange--1";
    task.tmux_session = "orange/feature-x";
    expect(task.status).toBe("working");

    task.status = "reviewing";
    expect(task.status).toBe("reviewing");

    task.status = "done";
    task.workspace = null;
    task.tmux_session = null;
    expect(task.status).toBe("done");
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
      to: "working",
    };

    expect(event.type).toBe("status.changed");
    if (event.type === "status.changed") {
      expect(event.from).toBe("pending");
      expect(event.to).toBe("working");
    }
  });
});
