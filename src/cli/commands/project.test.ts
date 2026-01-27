/**
 * Integration tests for project CLI commands.
 *
 * Tests the full command workflow with mocked external dependencies.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { Deps } from "../../core/types.js";
import { MockGit } from "../../core/git.js";
import { MockGitHub } from "../../core/github.js";
import { MockTmux } from "../../core/tmux.js";
import { MockClock } from "../../core/clock.js";
import { NullLogger } from "../../core/logger.js";
import { parseArgs } from "../args.js";
import { runProjectCommand } from "./project.js";
import { loadProjects } from "../../core/state.js";

/**
 * Normalize path for comparison (handles macOS /var -> /private/var).
 */
function normalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Create a git repository in the given directory.
 */
function createGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name 'Test User'", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m 'Initial commit'", { cwd: dir, stdio: "pipe" });
}

describe("project add command", () => {
  let tempDir: string;
  let projectDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    projectDir = join(tempDir, "myproject");
    createGitRepo(projectDir);

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
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
    const parsed = parseArgs(["bun", "script.ts", "project", "add", projectDir]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("myproject");
    expect(projects[0].path).toBe(normalizePath(projectDir));
    expect(projects[0].pool_size).toBe(2);
    expect(consoleLogs[0]).toContain("Added project 'myproject'");
  });

  test("adds a project with custom name", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "add", projectDir, "--name", "custom-name"]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe("custom-name");
    expect(consoleLogs[0]).toContain("Added project 'custom-name'");
  });

  test("adds a project with custom pool size", async () => {
    const parsed = parseArgs(["bun", "script.ts", "project", "add", projectDir, "--pool-size", "5"]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects[0].pool_size).toBe(5);
    expect(consoleLogs.join("\n")).toContain("5"); // Pool size shown in output
  });

  test("adds a project with both custom name and pool size", async () => {
    const parsed = parseArgs([
      "bun", "script.ts", "project", "add", projectDir,
      "--name", "test-proj",
      "--pool-size", "3"
    ]);

    await runProjectCommand(parsed, deps);

    const projects = await loadProjects(deps);
    expect(projects[0].name).toBe("test-proj");
    expect(projects[0].pool_size).toBe(3);
  });

  test("rejects duplicate project names", async () => {
    // Create a second git repo
    const projectDir2 = join(tempDir, "repo2");
    createGitRepo(projectDir2);

    // Add first project
    const parsed1 = parseArgs(["bun", "script.ts", "project", "add", projectDir, "--name", "duplicate"]);
    await runProjectCommand(parsed1, deps);

    // Try to add with same name
    const parsed2 = parseArgs(["bun", "script.ts", "project", "add", projectDir2, "--name", "duplicate"]);

    await expect(runProjectCommand(parsed2, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors.join(" ")).toContain("already exists");
  });

  test("rejects duplicate project paths", async () => {
    // Add project
    const parsed1 = parseArgs(["bun", "script.ts", "project", "add", projectDir, "--name", "name1"]);
    await runProjectCommand(parsed1, deps);

    // Try to add same path with different name
    const parsed2 = parseArgs(["bun", "script.ts", "project", "add", projectDir, "--name", "name2"]);

    await expect(runProjectCommand(parsed2, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors.join(" ")).toContain("already registered");
  });

  test("rejects non-git directory", async () => {
    const nonGitDir = join(tempDir, "not-a-git-repo");
    mkdirSync(nonGitDir, { recursive: true });

    const parsed = parseArgs(["bun", "script.ts", "project", "add", nonGitDir]);

    await expect(runProjectCommand(parsed, deps)).rejects.toThrow("process.exit(1)");
    expect(consoleErrors.join(" ")).toContain("not a git repository");
  });

  test("adds multiple projects", async () => {
    const project1 = join(tempDir, "project1");
    const project2 = join(tempDir, "project2");
    createGitRepo(project1);
    createGitRepo(project2);

    const parsed1 = parseArgs(["bun", "script.ts", "project", "add", project1]);
    const parsed2 = parseArgs(["bun", "script.ts", "project", "add", project2]);

    await runProjectCommand(parsed1, deps);
    await runProjectCommand(parsed2, deps);

    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(2);
    expect(projects.map(p => p.name)).toEqual(["project1", "project2"]);
  });
});

describe("project list command", () => {
  let tempDir: string;
  let projectDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    projectDir = join(tempDir, "myproject");
    createGitRepo(projectDir);

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
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
    const addParsed = parseArgs(["bun", "script.ts", "project", "add", projectDir]);
    await runProjectCommand(addParsed, deps);
    consoleLogs = []; // Clear logs

    // List projects
    const listParsed = parseArgs(["bun", "script.ts", "project", "list"]);
    await runProjectCommand(listParsed, deps);

    const output = consoleLogs.join("\n");
    expect(output).toContain("Projects:");
    expect(output).toContain("myproject");
    expect(output).toContain(normalizePath(projectDir));
  });

  test("lists multiple projects", async () => {
    // Add projects
    const project1 = join(tempDir, "project1");
    const project2 = join(tempDir, "project2");
    createGitRepo(project1);
    createGitRepo(project2);

    await runProjectCommand(
      parseArgs(["bun", "script.ts", "project", "add", project1, "--pool-size", "3"]),
      deps
    );
    await runProjectCommand(
      parseArgs(["bun", "script.ts", "project", "add", project2, "--pool-size", "5"]),
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

describe("project remove command", () => {
  let tempDir: string;
  let projectDir: string;
  let deps: Deps;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "orange-test-"));
    projectDir = join(tempDir, "myproject");
    createGitRepo(projectDir);

    deps = {
      tmux: new MockTmux(),
      git: new MockGit(),
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
    };

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

  test("removes a project", async () => {
    // Add a project first
    await runProjectCommand(
      parseArgs(["bun", "script.ts", "project", "add", projectDir]),
      deps
    );
    consoleLogs = [];

    // Remove it
    await runProjectCommand(
      parseArgs(["bun", "script.ts", "project", "remove", "myproject"]),
      deps
    );

    const projects = await loadProjects(deps);
    expect(projects).toHaveLength(0);
    expect(consoleLogs[0]).toContain("Removed project 'myproject'");
  });

  test("errors when project not found", async () => {
    await expect(
      runProjectCommand(
        parseArgs(["bun", "script.ts", "project", "remove", "nonexistent"]),
        deps
      )
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("not found");
  });

  test("errors when name not provided", async () => {
    await expect(
      runProjectCommand(
        parseArgs(["bun", "script.ts", "project", "remove"]),
        deps
      )
    ).rejects.toThrow("process.exit(1)");
    expect(consoleErrors[0]).toContain("Usage:");
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
      github: new MockGitHub(),
      clock: new MockClock(),
      dataDir: tempDir,
      logger: new NullLogger(),
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
