/**
 * Tests for agent prompt templates.
 *
 * Validates that prompt templates contain correct variables and key instructions.
 */

import { describe, expect, test } from "bun:test";
import type { Task } from "./types.js";
import {
  buildWorkerPrompt,
  buildWorkerRespawnPrompt,
  buildWorkerFixPrompt,
  buildReviewerPrompt,
  buildClarificationPrompt,
  buildStuckFixPrompt,
  buildAgentPrompt,
  buildRespawnPrompt,
  buildReviewPrompt,
} from "./agent.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test123",
    project: "orange",
    branch: "feature-x",
    harness: "claude",
    review_harness: "claude",
    status: "pending",
    review_round: 0,
    crash_count: 0,
    workspace: null,
    tmux_session: null,
    summary: "Implement auth",
    body: "",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    pr_url: null,
    ...overrides,
  };
}

describe("Worker prompt", () => {
  test("includes task summary", () => {
    const prompt = buildWorkerPrompt(createTask());
    expect(prompt).toContain("# Task: Implement auth");
  });

  test("includes project and branch", () => {
    const prompt = buildWorkerPrompt(createTask());
    expect(prompt).toContain("Project: orange");
    expect(prompt).toContain("Branch: feature-x");
  });

  test("includes Phase 1 (Plan) and Phase 2 (Implement)", () => {
    const prompt = buildWorkerPrompt(createTask());
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Phase 2");
    expect(prompt).toContain("## Plan");
    expect(prompt).toContain("## Handoff");
  });

  test("includes no-push instruction", () => {
    const prompt = buildWorkerPrompt(createTask());
    expect(prompt).toContain("Do NOT push to remote");
  });

  test("includes no-reviewing instruction", () => {
    const prompt = buildWorkerPrompt(createTask());
    expect(prompt).toContain("Do NOT set --status reviewing");
  });
});

describe("Worker respawn prompt", () => {
  test("includes Resuming header", () => {
    const prompt = buildWorkerRespawnPrompt(createTask({ status: "working" }));
    expect(prompt).toContain("# Resuming: Implement auth");
  });

  test("includes status and review round", () => {
    const prompt = buildWorkerRespawnPrompt(createTask({
      status: "working",
      review_round: 1,
    }));
    expect(prompt).toContain("Status: working");
    expect(prompt).toContain("Review round: 1");
  });

  test("includes instructions for planning status", () => {
    const prompt = buildWorkerRespawnPrompt(createTask({ status: "planning" }));
    expect(prompt).toContain("planning");
    expect(prompt).toContain("## Plan");
  });

  test("includes instructions for working status", () => {
    const prompt = buildWorkerRespawnPrompt(createTask({ status: "working" }));
    expect(prompt).toContain("## Handoff");
  });
});

describe("Worker fix prompt", () => {
  test("includes Fixing header", () => {
    const prompt = buildWorkerFixPrompt(createTask({ review_round: 1 }));
    expect(prompt).toContain("# Fixing: Implement auth");
  });

  test("includes review round", () => {
    const prompt = buildWorkerFixPrompt(createTask({ review_round: 1 }));
    expect(prompt).toContain("Review round: 1");
  });

  test("instructs to read Review and fix issues", () => {
    const prompt = buildWorkerFixPrompt(createTask());
    expect(prompt).toContain("## Review");
    expect(prompt).toContain("Fix each issue");
  });

  test("includes no-push instruction", () => {
    const prompt = buildWorkerFixPrompt(createTask());
    expect(prompt).toContain("Do NOT push to remote");
  });
});

describe("Reviewer prompt", () => {
  test("includes Review header", () => {
    const prompt = buildReviewerPrompt(createTask({ review_round: 1 }));
    expect(prompt).toContain("# Review: Implement auth");
  });

  test("includes review round of 2", () => {
    const prompt = buildReviewerPrompt(createTask({ review_round: 1 }));
    expect(prompt).toContain("Review round: 1 of 2");
  });

  test("instructs to write verdict line", () => {
    const prompt = buildReviewerPrompt(createTask());
    expect(prompt).toContain("Verdict: PASS");
    expect(prompt).toContain("Verdict: FAIL");
  });

  test("includes no-GitHub instruction", () => {
    const prompt = buildReviewerPrompt(createTask());
    expect(prompt).toContain("Do NOT post to GitHub");
  });

  test("instructs to review diff", () => {
    const prompt = buildReviewerPrompt(createTask());
    expect(prompt).toContain("git diff origin/HEAD...HEAD");
  });
});

describe("Clarification prompt", () => {
  test("includes task summary", () => {
    const prompt = buildClarificationPrompt(createTask());
    expect(prompt).toContain("# Task: Implement auth");
  });

  test("instructs to write Questions", () => {
    const prompt = buildClarificationPrompt(createTask());
    expect(prompt).toContain("## Questions");
  });

  test("instructs to set clarification status", () => {
    const prompt = buildClarificationPrompt(createTask());
    expect(prompt).toContain("--status clarification");
  });
});

describe("Stuck fix prompt", () => {
  test("includes Stuck header", () => {
    const prompt = buildStuckFixPrompt(createTask({ review_round: 2 }));
    expect(prompt).toContain("# Stuck: Implement auth");
  });

  test("includes review round", () => {
    const prompt = buildStuckFixPrompt(createTask({ review_round: 2 }));
    expect(prompt).toContain("Review round: 2");
  });

  test("instructs interactive session with human", () => {
    const prompt = buildStuckFixPrompt(createTask());
    expect(prompt).toContain("interactive session");
    expect(prompt).toContain("Wait for human input");
  });

  test("instructs to read review and plan", () => {
    const prompt = buildStuckFixPrompt(createTask());
    expect(prompt).toContain("## Review");
    expect(prompt).toContain("## Plan");
    expect(prompt).toContain("## Handoff");
  });
});

describe("Backwards-compatible aliases", () => {
  test("buildAgentPrompt returns worker prompt", () => {
    const prompt = buildAgentPrompt(createTask());
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Phase 2");
  });

  test("buildAgentPrompt returns empty string for empty summary", () => {
    expect(buildAgentPrompt(createTask({ summary: "" }))).toBe("");
    expect(buildAgentPrompt(createTask({ summary: "  " }))).toBe("");
  });

  test("buildRespawnPrompt returns worker respawn prompt", () => {
    const prompt = buildRespawnPrompt(createTask({ status: "working" }));
    expect(prompt).toContain("# Resuming:");
  });

  test("buildRespawnPrompt returns empty string for empty summary", () => {
    expect(buildRespawnPrompt(createTask({ summary: "" }))).toBe("");
  });

  test("buildReviewPrompt returns reviewer prompt", () => {
    const prompt = buildReviewPrompt(createTask({ review_round: 1 }));
    expect(prompt).toContain("# Review:");
    expect(prompt).toContain("of 2");
  });
});
