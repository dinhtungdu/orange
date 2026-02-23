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
      summary: "Implement feature X",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T01:00:00.000Z",
      review_harness: "claude",
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    pr_state: null,
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
      summary: "Initial description",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      review_harness: "claude",
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    pr_state: null,
    };

    await saveTask(deps, task);

    task.status = "working";
    task.workspace = "orange--1";
    task.summary = "Updated description";

    await saveTask(deps, task);

    // loadTask now takes task ID, not branch
    const loaded = await loadTask(deps, "orange", "abc12345");
    expect(loaded?.status).toBe("working");
    expect(loaded?.workspace).toBe("orange--1");
    expect(loaded?.summary).toBe("Updated description");
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
      summary: "Test",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      review_harness: "claude",
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    pr_state: null,
    };
    await saveTask(deps, task);

    // appendHistory now takes task ID, not branch
    await appendHistory(deps, "orange", "abc12345", {
      type: "task.created",
      timestamp: "2024-01-01T00:00:00.000Z",
      task_id: "abc12345",
      project: "orange",
      branch: "feature-x",
      summary: "Test",
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
      summary: "Test",
      body: "",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      review_harness: "claude",
    review_round: 0,
    crash_count: 0,
    pr_url: null,
    pr_state: null,
    };
    await saveTask(deps, task);

    // All history functions now take task ID, not branch
    await appendHistory(deps, "orange", "abc12345", {
      type: "task.created",
      timestamp: "2024-01-01T00:00:00.000Z",
      task_id: "abc12345",
      project: "orange",
      branch: "feature-x",
      summary: "Test",
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

// Import section parsing functions
import {
  extractSection,
  parsePlanSection,
  parseHandoffSection,
  parseReviewSection,
  validatePlanGate,
  validateHandoffGate,
  validateReviewGate,
} from "./state.js";

describe("Section parsing", () => {
  test("extractSection extracts named section content", () => {
    const body = "## Context\n\nSome context\n\n## Plan\n\nAPPROACH: Use JWT\n\n## Handoff\n\nDONE: Auth";
    expect(extractSection(body, "Plan")).toBe("APPROACH: Use JWT");
    expect(extractSection(body, "Context")).toBe("Some context");
    expect(extractSection(body, "Handoff")).toBe("DONE: Auth");
  });

  test("extractSection returns null for missing section", () => {
    expect(extractSection("## Context\n\nSome text", "Plan")).toBeNull();
    expect(extractSection("", "Plan")).toBeNull();
  });

  test("extractSection handles section at end of body", () => {
    const body = "## Plan\n\nAPPROACH: Do the thing";
    expect(extractSection(body, "Plan")).toBe("APPROACH: Do the thing");
  });

  test("parsePlanSection extracts all fields", () => {
    const body = "## Plan\n\nAPPROACH: Use JWT\nTOUCHING: src/auth.ts\nRISKS: Token rotation";
    const plan = parsePlanSection(body);
    expect(plan).not.toBeNull();
    expect(plan!.approach).toBe("Use JWT");
    expect(plan!.touching).toBe("src/auth.ts");
    expect(plan!.risks).toBe("Token rotation");
  });

  test("parsePlanSection returns null when section missing", () => {
    expect(parsePlanSection("## Context\n\nSome text")).toBeNull();
  });

  test("parsePlanSection returns empty object when no fields match", () => {
    const body = "## Plan\n\nJust some notes";
    const plan = parsePlanSection(body);
    expect(plan).not.toBeNull();
    expect(plan!.approach).toBeUndefined();
    expect(plan!.touching).toBeUndefined();
  });

  test("parseHandoffSection extracts all fields", () => {
    const body = "## Handoff\n\nDONE: Auth\nREMAINING: Tests\nDECISIONS: JWT\nUNCERTAIN: Expiry";
    const handoff = parseHandoffSection(body);
    expect(handoff).not.toBeNull();
    expect(handoff!.done).toBe("Auth");
    expect(handoff!.remaining).toBe("Tests");
    expect(handoff!.decisions).toBe("JWT");
    expect(handoff!.uncertain).toBe("Expiry");
  });

  test("parseHandoffSection returns null when section missing", () => {
    expect(parseHandoffSection("")).toBeNull();
  });

  test("parseReviewSection extracts verdict and feedback", () => {
    const body = "## Review\n\nVerdict: PASS\n\nLooks good!\nNice code.";
    const review = parseReviewSection(body);
    expect(review).not.toBeNull();
    expect(review!.verdict).toBe("PASS");
    expect(review!.feedback).toBe("Looks good!\nNice code.");
  });

  test("parseReviewSection handles FAIL verdict", () => {
    const body = "## Review\n\nVerdict: FAIL\n\nNeeds work on error handling";
    const review = parseReviewSection(body);
    expect(review).not.toBeNull();
    expect(review!.verdict).toBe("FAIL");
  });

  test("parseReviewSection is case-insensitive for verdict", () => {
    const body = "## Review\n\nVerdict: pass\n\nOK";
    const review = parseReviewSection(body);
    expect(review).not.toBeNull();
    expect(review!.verdict).toBe("PASS");
  });

  test("parseReviewSection returns null without verdict line", () => {
    const body = "## Review\n\nNo verdict here";
    expect(parseReviewSection(body)).toBeNull();
  });

  test("parseReviewSection returns null for missing section", () => {
    expect(parseReviewSection("")).toBeNull();
  });
});

describe("Gate validation", () => {
  test("validatePlanGate passes with APPROACH", () => {
    expect(validatePlanGate("## Plan\n\nAPPROACH: Use JWT")).toBe(true);
  });

  test("validatePlanGate passes with TOUCHING", () => {
    expect(validatePlanGate("## Plan\n\nTOUCHING: src/auth.ts")).toBe(true);
  });

  test("validatePlanGate fails without recognized fields", () => {
    expect(validatePlanGate("## Plan\n\nJust some notes")).toBe(false);
  });

  test("validatePlanGate fails without section", () => {
    expect(validatePlanGate("")).toBe(false);
  });

  test("validateHandoffGate passes with DONE", () => {
    expect(validateHandoffGate("## Handoff\n\nDONE: Implemented auth")).toBe(true);
  });

  test("validateHandoffGate passes with REMAINING", () => {
    expect(validateHandoffGate("## Handoff\n\nREMAINING: Tests")).toBe(true);
  });

  test("validateHandoffGate passes with DECISIONS", () => {
    expect(validateHandoffGate("## Handoff\n\nDECISIONS: JWT")).toBe(true);
  });

  test("validateHandoffGate passes with UNCERTAIN", () => {
    expect(validateHandoffGate("## Handoff\n\nUNCERTAIN: Token expiry")).toBe(true);
  });

  test("validateHandoffGate fails without section", () => {
    expect(validateHandoffGate("")).toBe(false);
  });

  test("validateReviewGate passes with matching PASS verdict", () => {
    expect(validateReviewGate("## Review\n\nVerdict: PASS\n\nGood", "PASS")).toBe(true);
  });

  test("validateReviewGate passes with matching FAIL verdict", () => {
    expect(validateReviewGate("## Review\n\nVerdict: FAIL\n\nBad", "FAIL")).toBe(true);
  });

  test("validateReviewGate fails with mismatched verdict", () => {
    expect(validateReviewGate("## Review\n\nVerdict: PASS\n\nGood", "FAIL")).toBe(false);
    expect(validateReviewGate("## Review\n\nVerdict: FAIL\n\nBad", "PASS")).toBe(false);
  });

  test("validateReviewGate fails without section", () => {
    expect(validateReviewGate("", "PASS")).toBe(false);
  });
});
