import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MockGitHub, buildPRBody, getGitHubHost } from "./github.js";

describe("getGitHubHost", () => {
  test("extracts host from HTTPS URL", () => {
    expect(getGitHubHost("https://github.com/org/repo.git")).toBe("github.com");
    expect(getGitHubHost("https://github.example.com/org/repo.git")).toBe("github.example.com");
    expect(getGitHubHost("https://git.company.io/org/repo")).toBe("git.company.io");
  });

  test("extracts host from SSH URL", () => {
    expect(getGitHubHost("git@github.com:org/repo.git")).toBe("github.com");
    expect(getGitHubHost("git@github.example.com:org/repo.git")).toBe("github.example.com");
    expect(getGitHubHost("git@git.company.io:org/repo")).toBe("git.company.io");
  });

  test("returns github.com for invalid URLs", () => {
    expect(getGitHubHost("invalid")).toBe("github.com");
    expect(getGitHubHost("")).toBe("github.com");
  });
});

describe("MockGitHub", () => {
  let gh: MockGitHub;

  beforeEach(() => {
    gh = new MockGitHub();
  });

  test("isAvailable returns true by default", async () => {
    expect(await gh.isAvailable()).toBe(true);
  });

  test("isAvailable returns false when set", async () => {
    gh.available = false;
    expect(await gh.isAvailable()).toBe(false);
  });

  test("createPR returns URL and tracks call", async () => {
    const url = await gh.createPR("/repo", {
      branch: "feature-x",
      base: "main",
      title: "Add feature X",
      body: "Description",
    });

    expect(url).toContain("feature-x");
    expect(gh.createdPRs).toHaveLength(1);
    expect(gh.createdPRs[0].branch).toBe("feature-x");
    expect(gh.createdPRs[0].title).toBe("Add feature X");
  });

  test("createPR sets PR as OPEN", async () => {
    await gh.createPR("/repo", {
      branch: "feature-x",
      base: "main",
      title: "Add feature X",
      body: "Description",
    });

    const status = await gh.getPRStatus("/repo", "feature-x");
    expect(status.exists).toBe(true);
    expect(status.state).toBe("OPEN");
  });

  test("getPRStatus returns not found for unknown branch", async () => {
    const status = await gh.getPRStatus("/repo", "unknown");
    expect(status.exists).toBe(false);
  });

  test("mergePR sets PR as MERGED", async () => {
    await gh.createPR("/repo", {
      branch: "feature-x",
      base: "main",
      title: "Test",
      body: "Body",
    });

    gh.mergePR("feature-x", "deadbeef");

    const status = await gh.getPRStatus("/repo", "feature-x");
    expect(status.exists).toBe(true);
    expect(status.state).toBe("MERGED");
    expect(status.mergeCommit).toBe("deadbeef");
  });

  test("clear resets all state", async () => {
    await gh.createPR("/repo", {
      branch: "feature-x",
      base: "main",
      title: "Test",
      body: "Body",
    });

    gh.clear();

    expect(gh.createdPRs).toHaveLength(0);
    const status = await gh.getPRStatus("/repo", "feature-x");
    expect(status.exists).toBe(false);
  });
});

describe("buildPRBody", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "orange-pr-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("builds body with description only", async () => {
    const body = await buildPRBody(tempDir, "Add dark mode", null);
    expect(body).toContain("## Task");
    expect(body).toContain("Add dark mode");
    expect(body).not.toContain("## Context");
  });

  test("builds body with description and context", async () => {
    const body = await buildPRBody(tempDir, "Add dark mode", "Use CSS variables");
    expect(body).toContain("## Task");
    expect(body).toContain("Add dark mode");
    expect(body).toContain("## Context");
    expect(body).toContain("Use CSS variables");
  });

  test("includes PR template from .github/pull_request_template.md", async () => {
    await mkdir(join(tempDir, ".github"), { recursive: true });
    await writeFile(
      join(tempDir, ".github", "pull_request_template.md"),
      "## Checklist\n- [ ] Tests\n- [ ] Docs"
    );

    const body = await buildPRBody(tempDir, "Add feature", null);
    expect(body).toContain("Add feature");
    expect(body).toContain("## Checklist");
    expect(body).toContain("- [ ] Tests");
  });

  test("includes PR template from .github/PULL_REQUEST_TEMPLATE.md", async () => {
    await mkdir(join(tempDir, ".github"), { recursive: true });
    await writeFile(
      join(tempDir, ".github", "PULL_REQUEST_TEMPLATE.md"),
      "## Review\nPlease review"
    );

    const body = await buildPRBody(tempDir, "Fix bug", null);
    expect(body).toContain("Fix bug");
    expect(body).toContain("## Review");
  });

  test("includes PR template from root pull_request_template.md", async () => {
    await writeFile(
      join(tempDir, "pull_request_template.md"),
      "## Notes\nRoot template"
    );

    const body = await buildPRBody(tempDir, "Update", null);
    expect(body).toContain("Root template");
  });

  test("works without PR template", async () => {
    const body = await buildPRBody(tempDir, "Simple task", "Some context");
    expect(body).toContain("Simple task");
    expect(body).toContain("Some context");
    // No template separator
    expect(body).not.toContain("---");
  });

  test("prefers .github/pull_request_template.md over root", async () => {
    await mkdir(join(tempDir, ".github"), { recursive: true });
    await writeFile(
      join(tempDir, ".github", "pull_request_template.md"),
      "GitHub template"
    );
    await writeFile(
      join(tempDir, "pull_request_template.md"),
      "Root template"
    );

    const body = await buildPRBody(tempDir, "Task", null);
    expect(body).toContain("GitHub template");
    expect(body).not.toContain("Root template");
  });
});
