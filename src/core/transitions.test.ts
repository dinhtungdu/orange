/**
 * Tests for the workflow engine (transitions module).
 *
 * Covers: transition map, gate validation, condition evaluation,
 * hook execution order, and rejection of invalid transitions.
 *
 * Persistent worker model: worker never killed during normal flow.
 * Reviewer spawns in background window, worker notified on review complete.
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
import { saveTask, loadTask } from "./state.js";
import {
  TRANSITION_MAP,
  findTransition,
  executeTransition,
  TransitionError,
  type TransitionHook,
} from "./transitions.js";

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
    summary: "Test task",
    body: "",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    pr_url: null,
    pr_state: null,
    ...overrides,
  };
}

describe("Transition Map", () => {
  test("all transitions in map have valid from/to statuses", () => {
    const validStatuses = new Set([
      "pending", "planning", "clarification", "working",
      "agent-review", "reviewing", "stuck", "done", "cancelled",
    ]);

    for (const def of TRANSITION_MAP) {
      expect(validStatuses.has(def.from)).toBe(true);
      expect(validStatuses.has(def.to)).toBe(true);
    }
  });

  test("pending → planning exists", () => {
    const task = createTask({ status: "pending" });
    const def = findTransition("pending", "planning", task);
    expect(def).not.toBeNull();
    expect(def!.hooks).toHaveLength(2);
    expect(def!.hooks[0].id).toBe("acquire_workspace");
    expect(def!.hooks[1].id).toBe("spawn_agent");
    expect(def!.hooks[1].variant).toBe("worker");
  });

  test("pending → cancelled exists with no hooks", () => {
    const task = createTask({ status: "pending" });
    const def = findTransition("pending", "cancelled", task);
    expect(def).not.toBeNull();
    expect(def!.hooks).toHaveLength(0);
  });

  test("planning → working requires gate", () => {
    const task = createTask({ status: "planning" });
    const def = findTransition("planning", "working", task);
    expect(def).not.toBeNull();
    expect(def!.gate).toBeDefined();
    expect(def!.hooks).toHaveLength(0); // Same session continues
  });

  test("working → agent-review spawns reviewer in background (no kill_session)", () => {
    const task = createTask({ status: "working" });
    const def = findTransition("working", "agent-review", task);
    expect(def).not.toBeNull();
    expect(def!.gate).toBeDefined();
    // No kill_session — worker stays alive
    expect(def!.hooks.some(h => h.id === "kill_session")).toBe(false);
    // Reviewer spawns in background window
    expect(def!.hooks.some(h => h.id === "spawn_reviewer")).toBe(true);
    expect(def!.hooks.some(h => h.id === "increment_review_round")).toBe(true);
  });

  test("agent-review → reviewing kills reviewer only (not session)", () => {
    const task = createTask({ status: "agent-review", review_round: 1 });
    const def = findTransition("agent-review", "reviewing", task);
    expect(def).not.toBeNull();
    expect(def!.hooks.some(h => h.id === "kill_reviewer")).toBe(true);
    expect(def!.hooks.some(h => h.id === "kill_session")).toBe(false);
  });

  test("agent-review → working kills reviewer and notifies worker (no spawn)", () => {
    const task = createTask({ status: "agent-review", review_round: 1 });
    const def = findTransition("agent-review", "working", task);
    expect(def).not.toBeNull();
    expect(def!.gate).toBeDefined();
    expect(def!.condition).toBeDefined();
    expect(def!.hooks.some(h => h.id === "kill_reviewer")).toBe(true);
    expect(def!.hooks.some(h => h.id === "notify_worker")).toBe(true);
    // No spawn_agent — persistent worker handles fixes
    expect(def!.hooks.some(h => h.id === "spawn_agent")).toBe(false);
  });

  test("agent-review → working rejected when round >= 2", () => {
    const task = createTask({ status: "agent-review", review_round: 2 });
    const def = findTransition("agent-review", "working", task);
    expect(def).toBeNull(); // Condition fails, no match
  });

  test("agent-review → stuck requires FAIL verdict and round >= 2", () => {
    const task = createTask({ status: "agent-review", review_round: 2 });
    const def = findTransition("agent-review", "stuck", task);
    expect(def).not.toBeNull();
    expect(def!.gate).toBeDefined();
    expect(def!.hooks.some(h => h.id === "kill_reviewer")).toBe(true);
  });

  test("agent-review → stuck rejected when round < 2", () => {
    const task = createTask({ status: "agent-review", review_round: 1 });
    const def = findTransition("agent-review", "stuck", task);
    expect(def).toBeNull();
  });

  test("agent-review → cancelled kills both reviewer and session", () => {
    const task = createTask({ status: "agent-review" });
    const def = findTransition("agent-review", "cancelled", task);
    expect(def).not.toBeNull();
    expect(def!.hooks.some(h => h.id === "kill_reviewer")).toBe(true);
    expect(def!.hooks.some(h => h.id === "kill_session")).toBe(true);
    expect(def!.hooks.some(h => h.id === "release_workspace")).toBe(true);
  });

  test("reviewing → working notifies worker (no spawn)", () => {
    const task = createTask({ status: "reviewing" });
    const def = findTransition("reviewing", "working", task);
    expect(def).not.toBeNull();
    expect(def!.hooks.some(h => h.id === "notify_worker")).toBe(true);
    expect(def!.hooks.some(h => h.id === "spawn_agent")).toBe(false);
  });

  test("reviewing → done kills session and releases workspace", () => {
    const task = createTask({ status: "reviewing" });
    const def = findTransition("reviewing", "done", task);
    expect(def).not.toBeNull();
    expect(def!.hooks.map(h => h.id)).toEqual([
      "kill_session",
      "release_workspace",
      "spawn_next",
    ]);
  });

  test("stuck → reviewing has no hooks (worker session still alive)", () => {
    const task = createTask({ status: "stuck" });
    const def = findTransition("stuck", "reviewing", task);
    expect(def).not.toBeNull();
    expect(def!.hooks).toHaveLength(0);
  });

  test("stuck → working is rejected", () => {
    const task = createTask({ status: "stuck" });
    const def = findTransition("stuck", "working", task);
    expect(def).toBeNull();
  });

  test("working → stuck has no hooks (worker session still alive)", () => {
    const task = createTask({ status: "working" });
    const def = findTransition("working", "stuck", task);
    expect(def).not.toBeNull();
    expect(def!.hooks).toHaveLength(0);
  });

  test("invalid transition returns null", () => {
    const task = createTask({ status: "pending" });
    expect(findTransition("pending", "working", task)).toBeNull();
    expect(findTransition("pending", "done", task)).toBeNull();
    expect(findTransition("done", "pending", task)).toBeNull();
  });

  test("cancelled transitions exist from all active statuses", () => {
    const activeStatuses = [
      "pending", "planning", "clarification", "working",
      "agent-review", "reviewing", "stuck",
    ] as const;

    for (const status of activeStatuses) {
      const task = createTask({ status });
      const def = findTransition(status, "cancelled", task);
      expect(def).not.toBeNull();
    }
  });
});

describe("Gate Validation", () => {
  test("planning → working gate passes with valid plan", () => {
    const task = createTask({
      status: "planning",
      body: "## Plan\n\nAPPROACH: Use JWT for auth\nTOUCHING: src/auth.ts",
    });
    const def = findTransition("planning", "working", task);
    expect(def!.gate!(task.body)).toBe(true);
  });

  test("planning → working gate fails without plan", () => {
    const task = createTask({ status: "planning", body: "" });
    const def = findTransition("planning", "working", task);
    expect(def!.gate!(task.body)).toBe(false);
  });

  test("planning → working gate fails with empty plan fields", () => {
    const task = createTask({
      status: "planning",
      body: "## Plan\n\nsome random text",
    });
    const def = findTransition("planning", "working", task);
    expect(def!.gate!(task.body)).toBe(false);
  });

  test("working → agent-review gate passes with valid handoff", () => {
    const task = createTask({
      status: "working",
      body: "## Handoff\n\nDONE: Implemented auth\nREMAINING: Tests",
    });
    const def = findTransition("working", "agent-review", task);
    expect(def!.gate!(task.body)).toBe(true);
  });

  test("working → agent-review gate fails without handoff", () => {
    const task = createTask({ status: "working", body: "" });
    const def = findTransition("working", "agent-review", task);
    expect(def!.gate!(task.body)).toBe(false);
  });

  test("agent-review → reviewing gate passes with PASS verdict", () => {
    const task = createTask({
      status: "agent-review",
      body: "## Review\n\nVerdict: PASS\n\nLooks good!",
    });
    const def = findTransition("agent-review", "reviewing", task);
    expect(def!.gate!(task.body)).toBe(true);
  });

  test("agent-review → reviewing gate fails with FAIL verdict", () => {
    const task = createTask({
      status: "agent-review",
      body: "## Review\n\nVerdict: FAIL\n\nNeeds work",
    });
    const def = findTransition("agent-review", "reviewing", task);
    expect(def!.gate!(task.body)).toBe(false);
  });
});

describe("executeTransition", () => {
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

  const noopHook = async () => {};

  test("rejects invalid transition", async () => {
    const task = createTask({ status: "pending" });
    await saveTask(deps, task);

    try {
      await executeTransition(task, "done", deps, noopHook);
      expect(true).toBe(false); // Should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      expect((err as TransitionError).reason).toBe("no valid transition in map");
    }
  });

  test("rejects transition when gate fails", async () => {
    const task = createTask({ status: "planning", body: "" });
    await saveTask(deps, task);

    try {
      await executeTransition(task, "working", deps, noopHook);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      expect((err as TransitionError).reason).toBe("artifact gate validation failed");
    }
  });

  test("executes valid transition and updates task", async () => {
    const task = createTask({
      status: "planning",
      body: "## Plan\n\nAPPROACH: Use JWT\nTOUCHING: src/auth.ts",
      crash_count: 1,
    });
    await saveTask(deps, task);

    const result = await executeTransition(task, "working", deps, noopHook);

    expect(result.success).toBe(true);
    expect(result.from).toBe("planning");
    expect(result.to).toBe("working");

    // Verify task was updated
    const loaded = await loadTask(deps, "orange", "test123");
    expect(loaded!.status).toBe("working");
    expect(loaded!.crash_count).toBe(0); // Reset after transition
  });

  test("executes hooks in order", async () => {
    const task = createTask({ status: "pending" });
    await saveTask(deps, task);

    const hookOrder: string[] = [];
    const trackingHook = async (hook: TransitionHook) => {
      hookOrder.push(hook.id);
    };

    await executeTransition(task, "planning", deps, trackingHook);

    expect(hookOrder).toEqual(["acquire_workspace", "spawn_agent"]);
  });

  test("working → agent-review hooks: spawn_reviewer + increment (no kill_session)", async () => {
    const task = createTask({
      status: "working",
      body: "## Handoff\n\nDONE: Implemented feature",
    });
    await saveTask(deps, task);

    const hookOrder: string[] = [];
    const trackingHook = async (hook: TransitionHook) => {
      hookOrder.push(hook.id);
    };

    await executeTransition(task, "agent-review", deps, trackingHook);

    expect(hookOrder).toEqual(["spawn_reviewer", "increment_review_round"]);
  });

  test("agent-review → working hooks: kill_reviewer + notify_worker", async () => {
    const task = createTask({
      status: "agent-review",
      review_round: 1,
      body: "## Review\n\nVerdict: FAIL\n\nNeeds fixes",
    });
    await saveTask(deps, task);

    const hookOrder: string[] = [];
    const trackingHook = async (hook: TransitionHook) => {
      hookOrder.push(hook.id);
    };

    await executeTransition(task, "working", deps, trackingHook);

    expect(hookOrder).toEqual(["kill_reviewer", "notify_worker"]);
  });

  test("continues after hook failure", async () => {
    const task = createTask({ status: "pending" });
    await saveTask(deps, task);

    const failingHook = async (hook: TransitionHook) => {
      if (hook.id === "acquire_workspace") {
        throw new Error("workspace pool exhausted");
      }
    };

    // Should not throw — hook failures are logged but don't roll back
    const result = await executeTransition(task, "planning", deps, failingHook);
    expect(result.success).toBe(true);
    expect(task.status).toBe("planning");
  });

  test("resets crash_count after successful transition", async () => {
    const task = createTask({
      status: "planning",
      body: "## Plan\n\nAPPROACH: Implement feature",
      crash_count: 2,
    });
    await saveTask(deps, task);

    await executeTransition(task, "working", deps, noopHook);

    expect(task.crash_count).toBe(0);
    const loaded = await loadTask(deps, "orange", "test123");
    expect(loaded!.crash_count).toBe(0);
  });

  test("condition blocks transition when false", async () => {
    const task = createTask({
      status: "agent-review",
      review_round: 2,
      body: "## Review\n\nVerdict: FAIL\n\nNeeds fixes",
    });
    await saveTask(deps, task);

    // agent-review → working requires round < 2
    try {
      await executeTransition(task, "working", deps, noopHook);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
    }
  });

  test("agent-review → stuck allowed when round >= 2 and FAIL verdict", async () => {
    const task = createTask({
      status: "agent-review",
      review_round: 2,
      body: "## Review\n\nVerdict: FAIL\n\nFailed twice",
    });
    await saveTask(deps, task);

    const result = await executeTransition(task, "stuck", deps, noopHook);
    expect(result.success).toBe(true);
    expect(task.status).toBe("stuck");
  });

  test("cancelled from any active status", async () => {
    const statuses = ["pending", "planning", "working", "reviewing", "stuck"] as const;

    for (const status of statuses) {
      const task = createTask({ id: `task-${status}`, status });
      await saveTask(deps, task);

      const result = await executeTransition(task, "cancelled", deps, noopHook);
      expect(result.success).toBe(true);
      expect(task.status).toBe("cancelled");
    }
  });
});
