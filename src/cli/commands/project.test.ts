/**
 * Integration tests for project CLI commands.
 *
 * Tests the full command workflow with mocked external dependencies.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Deps } from "../../core/types.js";
import { MockGit } from "../../core/git.js";
import { MockTmux } from "../../core/tmux.js";
import { MockClock } from "../../core/clock.js";
import { parseArgs } from "../args.js";
import { runProjectCommand } from "./project.js";
import { loadProjects } from "../../core/state.js";

describe("project add command", () => {
  let tempDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      clock: new MockClock(),
      dataDir: tempDir,
    };

    // Capture console output
    consoleLogs = [];
    consoleErrors = [];
    originalLog = console.log;
    originalError = console.error;
    originalExit = process.exit;

    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    // Prevent process.exit from terminating tests
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  });

  test("adds a project with default name and pool size", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "add", "/path/to/myproject"]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("myproject");
    expect(projects[0].path).toContain("/path/to/myproject");
    expect(projects[0].pool_size).toBe(2);
    expect(projects[0].default_branch).toBe("main");
    expect(consoleLogs[0]).toContain("Added project 'myproject'");
  });

  test("adds a project with custom name", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "add", "/path/to/repo", "--name", "custom-name"]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("custom-name");
    expect(consoleLogs[0]).toContain("Added project 'custom-name'");
  });

  test("adds a project with custom pool size", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "add", "/path/to/repo", "--pool-size", "5"]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects[0].pool_size).toBe(5);
    expect(consoleLogs[0]).toContain("pool size: 5");
  });

  test("adds a project with both custom name and pool size", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "project", "add", "/path/to/repo",
      "--name", "test-proj",
      "--pool-size", "3"
    ]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects[0].name).toBe("test-proj");
    expect(projects[0].pool_size).toBe(3);
  });

  test("rejects duplicate project names", async () => {
    // Add first project
    const parsed1 = parseArgs(["bun", "script.ts", "project", "add", "/path/to/repo1", "--name", "duplicate"]);
    await runProjectCommand(parsed1, deps);

    // Try to add with same name
    const parsed2 = parseArgs(["bun", "script.ts", "project", "add", "/path/to/repo2", "--name", "duplicate"]);

    await expect(runProjectCommand(parsed2, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors.join(" ")).toContain("already exists");
  });

  test("exits when path not provided", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "add"]);

    await expect(runProjectCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("Usage:");
  });

  test("adds multiple projects", async () => {
    const parsed1 = parseArgs(["bun", "script.ts", "project", "add", "/path/to/project1"]);
    const parsed2 = parseArgs(["bun", "script.ts", "project", "add", "/path/to/project2"]);

    await runProjectCommand(parsed1, deps);
    await runProjectCommand(parsed2, deps);

    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(2);
    expect(projects.map(p => p.name)).toEqual(["project1", "project2"]);
  });
});

describe("project list command", () => {
  let tempDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      clock: new MockClock(),
      dataDir: tempDir,
    };

    consoleLogs = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.log = originalLog;
  });

  test("shows message when no projects exist", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "list"]);

    await runProjectCommand(parsed, deps);

    expect(consoleLogs[0]).toContain("No projects registered");
  });

  test("lists single project with details", async () => {
    // Add a project first
    const addParsed = parseArgs(["bun", "script.ts", "project", "add", "/path/to/myproject"]);
    await runProjectCommand(addParsed, deps);
    consoleLogs = []; // Clear logs

    // List projects
    const listParsed = parseArgs(["bun", "script.ts", "project", "list"]);
    await runProjectCommand(listParsed, deps);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Projects:");
    expect(output).toContain("myproject");
    expect(output).toContain("/path/to/myproject");
    expect(output).toContain("main");
    expect(output).toContain("2"); // pool size
  });

  test("lists multiple projects", async () => {
    // Add projects
    await runProjectCommand(
      parseArgs(["bun", "script.ts", "project", "add", "/path/to/project1", "--pool-size", "3"]),
      deps
    );
    await runProjectCommand(
      parseArgs(["bun", "script.ts", "project", "add", "/path/to/project2", "--pool-size", "5"]),
      deps
    );
    consoleLogs = [];

    // List
    await runProjectCommand(parseArgs(["bun", "script.ts", "project", "list"]), deps);

    const output = consoleLogs.join("\n");
    expect(output).toContain("project1");
    expect(output).toContain("project2");
  });
});

describe("project command error handling", () => {
  let tempDir: string;
  let deps: Deps;
  let consoleErrors: string[];
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      clock: new MockClock(),
      dataDir: tempDir,
    };

    consoleErrors = [];
    originalError = console.error;
    originalExit = process.exit;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    console.error = originalError;
    process.exit = originalExit;
  });

  test("errors on unknown subcommand", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "unknown"]);
    // Force subcommand since parseArgs won't recognize it
    parsed.subcommand = "unknown";

    await expect(runProjectCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("Unknown project subcommand");
  });

  test("errors when no subcommand provided", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project"]);

    await expect(runProjectCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors.join(" ")).toContain("Usage:");
  });
});
