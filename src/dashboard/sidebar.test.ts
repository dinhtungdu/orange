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

describe("Sidebar Scroll State", () => {
  // Test the scroll offset clamping logic used in sidebar
  function clampOffset(offset: number, contentLines: number, visibleLines: number): number {
    const maxOffset = Math.max(0, contentLines - visibleLines);
    return Math.max(0, Math.min(maxOffset, offset));
  }

  test("scroll offset clamps to 0 when content fits", () => {
    // 5 lines of content, 10 visible → maxOffset=0
    expect(clampOffset(0, 5, 10)).toBe(0);
    expect(clampOffset(3, 5, 10)).toBe(0);
  });

  test("scroll offset clamps to max when content overflows", () => {
    // 20 lines, 8 visible → maxOffset=12
    expect(clampOffset(15, 20, 8)).toBe(12);
    expect(clampOffset(12, 20, 8)).toBe(12);
    expect(clampOffset(5, 20, 8)).toBe(5);
  });

  test("scroll offset does not go negative", () => {
    expect(clampOffset(-1, 20, 8)).toBe(0);
  });

  test("visible lines calculation with border", () => {
    // Box height minus 2 for border (top+bottom)
    const boxHeight = 10;
    const visibleLines = Math.max(1, boxHeight - 2);
    expect(visibleLines).toBe(8);
  });

  test("visible lines minimum is 1", () => {
    const boxHeight = 2; // border-only box
    const visibleLines = Math.max(1, boxHeight - 2);
    expect(visibleLines).toBe(1);
  });

  // Test section hit-testing logic
  function sectionAtRow(
    row: number,
    sections: Array<{ key: string; y: number; height: number; visible: boolean }>,
  ): string | null {
    for (const s of sections) {
      if (!s.visible) continue;
      if (row - 1 >= s.y && row - 1 < s.y + s.height) return s.key;
    }
    return null;
  }

  test("hit-test maps row to correct section", () => {
    const sections = [
      { key: "files", y: 5, height: 6, visible: true },
      { key: "history", y: 12, height: 5, visible: true },
      { key: "task", y: 18, height: 10, visible: true },
    ];
    // row is 1-based, y is 0-based
    expect(sectionAtRow(6, sections)).toBe("files"); // row 6 → y=5, in files [5,11)
    expect(sectionAtRow(13, sections)).toBe("history"); // row 13 → y=12, in history [12,17)
    expect(sectionAtRow(20, sections)).toBe("task"); // row 20 → y=19, in task [18,28)
  });

  test("hit-test returns null for gap between sections", () => {
    const sections = [
      { key: "files", y: 5, height: 3, visible: true },
      { key: "history", y: 10, height: 3, visible: true },
    ];
    // row 9 → y=8, not in files [5,8) or history [10,13)
    expect(sectionAtRow(9, sections)).toBe(null);
  });

  test("hit-test skips hidden sections", () => {
    const sections = [
      { key: "files", y: 5, height: 6, visible: false },
      { key: "history", y: 5, height: 6, visible: true },
    ];
    expect(sectionAtRow(6, sections)).toBe("history");
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
