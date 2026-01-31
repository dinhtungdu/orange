/**
 * Tests for file-based state management.
 *
 * Tests TASK.md parsing, history.jsonl events, and projects.json handling.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps, Task, Project } from "./types.js";
import { MockGit } from "./git.js";
import { MockGitHub } from "./github.js";
import { MockTmux } from "./tmux.js";
import { MockClock } from "./clock.js";
import { NullLogger } from "./logger.js";
import {
  loadProjects,
  saveProjects,
  loadTask,
  saveTask,
  appendHistory,
  loadHistory,
  getTaskDir,
} from "./state.js";

describe("Projects state", () => {
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

  test("loadProjects returns empty array when no file", async () => {
    const projects = await loadProjects(deps);
    expect(projects).toEqual([]);
  });

  test("saveProjects creates projects.json", async () => {
    const projects: Project[] = [
      {
        name: "test",
        path: "/path/to/test",
        default_branch: "main",
        pool_size: 2,
      },
    ];

    await saveProjects(deps, projects);

    const loaded = await loadProjects(deps);
    expect(loaded).toEqual(projects);
  });

  test("saveProjects overwrites existing projects", async () => {
    await saveProjects(deps, [
      { name: "old", path: "/old", default_branch: "main", pool_size: 1 },
    ]);

    const newProjects: Project[] = [
      { name: "new", path: "/new", default_branch: "main", pool_size: 3 },
    ];
    await saveProjects(deps, newProjects);

    const loaded = await loadProjects(deps);
    expect(loaded).toEqual(newProjects);
  });
});

describe("Task state (TASK.md)", () => {
  let tempDir: string;
  let deps: Deps;
  let mockClock: MockClock;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    mockClock = new MockClock();
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: mockClock,
      dataDir: tempDir,
      logger: new NullLogger(),
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("saveTask creates TASK.md with frontmatter", async () => {
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "pending",
      workspace: null,
      tmux_session: null,
      description: "Implement feature X",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      pr_url: null,
    };

    await saveTask(deps, task);

    // Task dir is now by ID, not branch
    const taskPath = join(getTaskDir(deps, "orange", "abc12345"), "TASK.md");
    const content = readFileSync(taskPath, "utf-8");

    expect(content).toContain("id: abc12345");
    expect(content).toContain("status: pending");
    expect(content).toContain("Implement feature X");
  });

  test("loadTask parses TASK.md frontmatter", async () => {
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "working",
      workspace: "orange--1",
      tmux_session: "orange/feature-x",
      description: "Implement feature X",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T01:00:00.000Z",
      pr_url: null,
    };

    await saveTask(deps, task);
    // loadTask now takes task ID, not branch
    const loaded = await loadTask(deps, "orange", "abc12345");

    expect(loaded).toEqual(task);
  });

  test("loadTask returns null for non-existent task", async () => {
    const loaded = await loadTask(deps, "orange", "nonexistent");
    expect(loaded).toBeNull();
  });

  test("saveTask updates existing task", async () => {
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "pending",
      workspace: null,
      tmux_session: null,
      description: "Initial description",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      pr_url: null,
    };

    await saveTask(deps, task);

    task.status = "working";
    task.workspace = "orange--1";
    task.description = "Updated description";

    await saveTask(deps, task);

    // loadTask now takes task ID, not branch
    const loaded = await loadTask(deps, "orange", "abc12345");
    expect(loaded?.status).toBe("working");
    expect(loaded?.workspace).toBe("orange--1");
    expect(loaded?.description).toBe("Updated description");
  });
});

describe("History (history.jsonl)", () => {
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

  test("appendHistory creates history.jsonl", async () => {
    // First need to create task directory
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "pending",
      workspace: null,
      tmux_session: null,
      description: "Test",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      pr_url: null,
    };
    await saveTask(deps, task);

    // appendHistory now takes task ID, not branch
    await appendHistory(deps, "orange", "abc12345", {
      type: "task.created",
      timestamp: "2024-01-01T00:00:00.000Z",
      task_id: "abc12345",
      project: "orange",
      branch: "feature-x",
      description: "Test",
    });

    // loadHistory now takes task ID, not branch
    const events = await loadHistory(deps, "orange", "abc12345");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("task.created");
  });

  test("appendHistory appends to existing file", async () => {
    const task: Task = {
      id: "abc12345",
      project: "orange",
      branch: "feature-x",
      harness: "claude",
      status: "pending",
      workspace: null,
      tmux_session: null,
      description: "Test",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      pr_url: null,
    };
    await saveTask(deps, task);

    // All history functions now take task ID, not branch
    await appendHistory(deps, "orange", "abc12345", {
      type: "task.created",
      timestamp: "2024-01-01T00:00:00.000Z",
      task_id: "abc12345",
      project: "orange",
      branch: "feature-x",
      description: "Test",
    });

    await appendHistory(deps, "orange", "abc12345", {
      type: "agent.spawned",
      timestamp: "2024-01-01T00:01:00.000Z",
      workspace: "orange--1",
      tmux_session: "orange/feature-x",
    });

    await appendHistory(deps, "orange", "abc12345", {
      type: "status.changed",
      timestamp: "2024-01-01T00:01:00.000Z",
      from: "pending",
      to: "working",
    });

    const events = await loadHistory(deps, "orange", "abc12345");
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("task.created");
    expect(events[1].type).toBe("agent.spawned");
    expect(events[2].type).toBe("status.changed");
  });

  test("loadHistory returns empty array for non-existent task", async () => {
    const events = await loadHistory(deps, "orange", "nonexistent");
    expect(events).toEqual([]);
  });
});
