/**
 * Tests for CLI argument parsing.
 */

import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  test("no args returns dashboard command", () => {
    const result = parseArgs(["bun", "script.ts"]);
    expect(result.command).toBe("dashboard");
    expect(result.subcommand).toBeNull();
    expect(result.args).toEqual([]);
  });

  test("parses simple command", () => {
    const result = parseArgs(["bun", "script.ts", "start"]);
    expect(result.command).toBe("start");
    expect(result.subcommand).toBeNull();
  });

  test("parses command with subcommand", () => {
    const result = parseArgs(["bun", "script.ts", "project", "list"]);
    expect(result.command).toBe("project");
    expect(result.subcommand).toBe("list");
  });

  test("parses project add with path", () => {
    const result = parseArgs(["bun", "script.ts", "project", "add", "/path/to/project"]);
    expect(result.command).toBe("project");
    expect(result.subcommand).toBe("add");
    expect(result.args).toEqual(["/path/to/project"]);
  });

  test("parses project add with options", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "project",
      "add",
      "/path/to/project",
      "--name",
      "my-project",
      "--pool-size",
      "4",
    ]);
    expect(result.command).toBe("project");
    expect(result.subcommand).toBe("add");
    expect(result.args).toEqual(["/path/to/project"]);
    expect(result.options.name).toBe("my-project");
    expect(result.options["pool-size"]).toBe("4");
  });

  test("parses task create with description", () => {
    // New CWD-aware syntax: orange task create <branch> <description>
    const result = parseArgs([
      "bun",
      "script.ts",
      "task",
      "create",
      "feature-x",
      "Implement",
      "feature",
      "X",
    ]);
    expect(result.command).toBe("task");
    expect(result.subcommand).toBe("create");
    expect(result.args).toEqual(["feature-x", "Implement", "feature", "X"]);
  });

  test("parses task create with --project flag", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "task",
      "create",
      "--project",
      "orange",
      "feature-x",
      "Implement",
      "feature",
    ]);
    expect(result.command).toBe("task");
    expect(result.subcommand).toBe("create");
    expect(result.options.project).toBe("orange");
    expect(result.args).toEqual(["feature-x", "Implement", "feature"]);
  });

  test("parses task list with filters", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "task",
      "list",
      "--project",
      "orange",
      "--status",
      "working",
    ]);
    expect(result.command).toBe("task");
    expect(result.subcommand).toBe("list");
    expect(result.options.project).toBe("orange");
    expect(result.options.status).toBe("working");
  });

  test("parses task spawn", () => {
    const result = parseArgs(["bun", "script.ts", "task", "spawn", "abc12345"]);
    expect(result.command).toBe("task");
    expect(result.subcommand).toBe("spawn");
    expect(result.args).toEqual(["abc12345"]);
  });

  test("parses task create-pr with task id", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "task",
      "create-pr",
      "abc12345",
    ]);
    expect(result.command).toBe("task");
    expect(result.subcommand).toBe("create-pr");
    expect(result.args).toEqual(["abc12345"]);
  });

  test("parses task merge with strategy", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "task",
      "merge",
      "abc12345",
      "--strategy",
      "merge",
    ]);
    expect(result.command).toBe("task");
    expect(result.subcommand).toBe("merge");
    expect(result.args).toEqual(["abc12345"]);
    expect(result.options.strategy).toBe("merge");
  });

  test("parses workspace init", () => {
    // New CWD-aware syntax: orange workspace init (no project arg)
    const result = parseArgs(["bun", "script.ts", "workspace", "init"]);
    expect(result.command).toBe("workspace");
    expect(result.subcommand).toBe("init");
    expect(result.args).toEqual([]);
  });

  test("parses workspace list", () => {
    const result = parseArgs(["bun", "script.ts", "workspace", "list"]);
    expect(result.command).toBe("workspace");
    expect(result.subcommand).toBe("list");
  });

  test("parses short options", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "task",
      "list",
      "-p",
      "orange",
    ]);
    expect(result.options.p).toBe("orange");
  });

  test("parses boolean flags", () => {
    const result = parseArgs([
      "bun",
      "script.ts",
      "some-command",
      "--verbose",
    ]);
    expect(result.options.verbose).toBe(true);
  });

  test("handles help command", () => {
    const result = parseArgs(["bun", "script.ts", "help"]);
    expect(result.command).toBe("help");
  });

  test("handles --help flag", () => {
    const result = parseArgs(["bun", "script.ts", "--help"]);
    expect(result.command).toBe("--help");
  });
});
