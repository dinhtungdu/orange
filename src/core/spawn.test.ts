import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getGitDir } from "./spawn.js";

describe("getGitDir", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orange-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns .git path when .git is a directory", async () => {
    // Normal repo: .git is a directory
    await mkdir(join(tempDir, ".git"));

    const result = await getGitDir(tempDir);
    expect(result).toBe(join(tempDir, ".git"));
  });

  test("returns gitdir path when .git is a file (worktree)", async () => {
    // Worktree: .git is a file pointing to actual git dir
    const actualGitDir = "/some/repo/.git/worktrees/my-worktree";
    await writeFile(join(tempDir, ".git"), `gitdir: ${actualGitDir}\n`);

    const result = await getGitDir(tempDir);
    expect(result).toBe(actualGitDir);
  });

  test("handles gitdir without trailing newline", async () => {
    const actualGitDir = "/path/to/.git/worktrees/test";
    await writeFile(join(tempDir, ".git"), `gitdir: ${actualGitDir}`);

    const result = await getGitDir(tempDir);
    expect(result).toBe(actualGitDir);
  });

  test("throws on invalid .git file", async () => {
    await writeFile(join(tempDir, ".git"), "invalid content");

    await expect(getGitDir(tempDir)).rejects.toThrow("Invalid .git file");
  });
});
