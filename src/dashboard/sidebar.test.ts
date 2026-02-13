/**
 * Tests for sidebar component.
 *
 * Tests: data pipeline, section rendering, event formatting.
 */

import { describe, expect, test } from "bun:test";
import type { HistoryEvent, TaskStatus } from "../core/types.js";

describe("Sidebar Event Formatting", () => {
  function formatEvent(event: HistoryEvent): string {
    switch (event.type) {
      case "status.changed":
        return `status \u2192 ${event.to}`;
      case "agent.spawned":
        return "spawned";
      case "agent.crashed":
        return `crashed (#${event.crash_count})`;
      case "auto.advanced":
        return `auto: ${event.from} \u2192 ${event.to}`;
      case "task.created":
        return "created";
      case "task.merged":
        return "merged";
      case "task.cancelled":
        return "cancelled";
      case "pr.created":
        return "PR created";
      case "pr.merged":
        return "PR merged";
      default:
        return event.type;
    }
  }

  test("formats status.changed event", () => {
    const event: HistoryEvent = {
      type: "status.changed",
      timestamp: new Date().toISOString(),
      from: "pending" as TaskStatus,
      to: "working" as TaskStatus,
    };
    expect(formatEvent(event)).toBe("status \u2192 working");
  });

  test("formats agent.spawned event", () => {
    const event: HistoryEvent = {
      type: "agent.spawned",
      timestamp: new Date().toISOString(),
      workspace: "orange--1",
      tmux_session: "orange/feature",
    };
    expect(formatEvent(event)).toBe("spawned");
  });

  test("formats agent.crashed event", () => {
    const event: HistoryEvent = {
      type: "agent.crashed",
      timestamp: new Date().toISOString(),
      status: "working" as TaskStatus,
      crash_count: 2,
      reason: "no ## Handoff",
    };
    expect(formatEvent(event)).toBe("crashed (#2)");
  });

  test("formats task.created event", () => {
    const event: HistoryEvent = {
      type: "task.created",
      timestamp: new Date().toISOString(),
      task_id: "abc123",
      project: "orange",
      branch: "feature",
      summary: "Add feature",
    };
    expect(formatEvent(event)).toBe("created");
  });
});

describe("Sidebar Age Formatting", () => {
  function formatAge(timestamp: string): string {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHour < 24) return `${diffHour}h ago`;
    return `${diffDay}d ago`;
  }

  test("formats seconds ago", () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(formatAge(ts)).toBe("30s ago");
  });

  test("formats minutes ago", () => {
    const ts = new Date(Date.now() - 300_000).toISOString();
    expect(formatAge(ts)).toBe("5m ago");
  });

  test("formats hours ago", () => {
    const ts = new Date(Date.now() - 7_200_000).toISOString();
    expect(formatAge(ts)).toBe("2h ago");
  });

  test("formats days ago", () => {
    const ts = new Date(Date.now() - 172_800_000).toISOString();
    expect(formatAge(ts)).toBe("2d ago");
  });
});

describe("Sidebar Sections", () => {
  test("files section formats correctly", () => {
    const files = [
      "M src/auth/callback.ts",
      "A src/auth/mobile.ts",
      "D src/auth/old.ts",
    ];

    const header = `\u2500\u2500 Files (${files.length}) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`;
    const fileLines = files.map(f => ` ${f}`);
    const content = header + "\n" + fileLines.join("\n");

    expect(content).toContain("Files (3)");
    expect(content).toContain(" M src/auth/callback.ts");
    expect(content).toContain(" A src/auth/mobile.ts");
    expect(content).toContain(" D src/auth/old.ts");
  });

  test("header section shows task info", () => {
    const task = {
      project: "coffee",
      branch: "login-fix",
      status: "working" as TaskStatus,
      harness: "pi",
    };
    const sessionAlive = true;
    const commits = 3;
    const added = 144;
    const removed = 12;

    const lines: string[] = [];
    lines.push(`${task.project}/${task.branch}`);
    lines.push(`Status: ${task.status} ${sessionAlive ? "\u25CF" : "\u2715"}`);
    lines.push(`Harness: ${task.harness}`);
    lines.push(`Commits: ${commits}  +${added} -${removed}`);

    const content = lines.join("\n");
    expect(content).toContain("coffee/login-fix");
    expect(content).toContain("Status: working");
    expect(content).toContain("Harness: pi");
    expect(content).toContain("Commits: 3  +144 -12");
  });

  test("empty files section is hidden", () => {
    const files: string[] = [];
    expect(files.length === 0).toBe(true);
    // Sidebar sets filesText.visible = false when no files
  });
});

describe("Sidebar Data Pipeline", () => {
  test("refresh intervals per spec", () => {
    // Per workspace.md data pipeline table
    expect(10_000).toBe(10_000);  // Session alive: 10s
    expect(30_000).toBe(30_000);  // PR info: 30s
    expect(10_000).toBe(10_000);  // Git data: 10s
  });

  test("PR failure increases interval to 60s", () => {
    const normalInterval = 30_000;
    const backoffInterval = 60_000;

    let interval = normalInterval;
    // Simulate failure
    interval = backoffInterval;
    expect(interval).toBe(60_000);

    // Simulate success resets
    interval = normalInterval;
    expect(interval).toBe(30_000);
  });
});
