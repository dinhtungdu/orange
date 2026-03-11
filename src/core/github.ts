/**
 * GitHub CLI abstraction layer.
 *
 * Provides PR creation and status checking via `gh` CLI.
 * Abstracted behind interface for testability.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitHubExecutor, PRStatus } from "./types.js";

/**
 * Execute a shell command and return result.
 * Inherits environment and adds proxy settings if configured.
 */
async function exec(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...getProxyEnv(),
    },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Get proxy environment variables for gh CLI.
 * Reads from GH_PROXY or standard proxy env vars.
 */
function getProxyEnv(): Record<string, string> {
  const proxy = process.env.GH_PROXY;
  if (!proxy) return {};
  return {
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
  };
}

/**
 * Extract GitHub hostname from git remote URL.
 * Supports both HTTPS and SSH URLs.
 */
export function getGitHubHost(remoteUrl: string): string {
  // SSH: git@github.example.com:org/repo.git
  const sshMatch = remoteUrl.match(/^git@([^:]+):/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.example.com/org/repo.git
  try {
    const url = new URL(remoteUrl);
    return url.hostname;
  } catch {
    return "github.com";
  }
}

/**
 * RealGitHub implements GitHubExecutor using the `gh` CLI.
 */
export class RealGitHub implements GitHubExecutor {
  async isAvailable(cwd?: string): Promise<boolean> {
    try {
      let hostname = "github.com";

      // If cwd provided, detect hostname from git remote
      if (cwd) {
        const { stdout, exitCode } = await exec(
          "git",
          ["remote", "get-url", "origin"],
          cwd
        );
        if (exitCode === 0 && stdout.trim()) {
          hostname = getGitHubHost(stdout.trim());
        }
      }

      const { exitCode } = await exec(
        "gh",
        ["auth", "status", "--hostname", hostname],
        cwd ?? "."
      );
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  async createPR(
    cwd: string,
    opts: { branch: string; base: string; title: string; body: string }
  ): Promise<string> {
    const args = [
      "pr",
      "create",
      "--head",
      opts.branch,
      "--base",
      opts.base,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ];

    const { stdout, stderr, exitCode } = await exec("gh", args, cwd);
    if (exitCode !== 0) {
      throw new Error(`gh pr create failed: ${stderr.trim()}`);
    }

    // gh pr create outputs the PR URL
    return stdout.trim();
  }

  async getPRStatus(cwd: string, branch: string): Promise<PRStatus> {
    const { stdout, exitCode } = await exec(
      "gh",
      [
        "pr",
        "view",
        branch,
        "--json",
        "state,url,mergeCommit,statusCheckRollup,reviewDecision",
      ],
      cwd
    );

    if (exitCode !== 0) {
      return { exists: false };
    }

    try {
      const data = JSON.parse(stdout);
      const state = data.state as "OPEN" | "CLOSED" | "MERGED";
      const merged = state === "MERGED";

      // Parse check rollup
      let checks: PRStatus["checks"] = "none";
      if (data.statusCheckRollup && data.statusCheckRollup.length > 0) {
        const statuses = data.statusCheckRollup.map(
          (c: { conclusion: string; status: string }) =>
            c.conclusion || c.status
        );
        if (statuses.some((s: string) => s === "FAILURE" || s === "ERROR")) {
          checks = "fail";
        } else if (
          statuses.some(
            (s: string) =>
              s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED"
          )
        ) {
          checks = "pending";
        } else {
          checks = "pass";
        }
      }

      return {
        exists: true,
        url: data.url,
        state,
        mergeCommit: merged ? data.mergeCommit?.oid : undefined,
        checks,
        reviewDecision: data.reviewDecision || undefined,
      };
    } catch {
      return { exists: false };
    }
  }
}

/**
 * MockGitHub implements GitHubExecutor for testing.
 */
export class MockGitHub implements GitHubExecutor {
  available = true;
  prs: Map<string, PRStatus & { url: string }> = new Map();
  createdPRs: Array<{
    cwd: string;
    branch: string;
    base: string;
    title: string;
    body: string;
  }> = [];

  async isAvailable(_cwd?: string): Promise<boolean> {
    return this.available;
  }

  async createPR(
    cwd: string,
    opts: { branch: string; base: string; title: string; body: string }
  ): Promise<string> {
    this.createdPRs.push({ cwd, ...opts });
    const url = `https://github.com/test/${opts.branch}/pull/1`;
    this.prs.set(opts.branch, {
      exists: true,
      url,
      state: "OPEN",
      checks: "none",
    });
    return url;
  }

  async getPRStatus(_cwd: string, branch: string): Promise<PRStatus> {
    return this.prs.get(branch) ?? { exists: false };
  }

  /**
   * Test helper: set PR as merged.
   */
  mergePR(branch: string, mergeCommit: string = "abc1234"): void {
    const existing = this.prs.get(branch);
    if (existing) {
      existing.state = "MERGED";
      existing.mergeCommit = mergeCommit;
    }
  }

  /**
   * Test helper: clear all state.
   */
  clear(): void {
    this.prs.clear();
    this.createdPRs = [];
  }
}

/**
 * Load PR template from common locations, if any.
 */
async function loadPRTemplate(projectPath: string): Promise<string | null> {
  const templatePaths = [
    join(projectPath, ".github", "pull_request_template.md"),
    join(projectPath, ".github", "PULL_REQUEST_TEMPLATE.md"),
    join(projectPath, "pull_request_template.md"),
    join(projectPath, "PULL_REQUEST_TEMPLATE.md"),
  ];

  for (const templatePath of templatePaths) {
    try {
      return await readFile(templatePath, "utf-8");
    } catch {
      // Template not found at this path, try next
    }
  }
  return null;
}

/**
 * Build a static PR body (fallback when LLM is unavailable).
 */
function buildStaticPRBody(summary: string, taskBody: string, template: string | null): string {
  let body = `## Task\n\n${summary}`;
  if (taskBody.trim()) {
    body += `\n\n${taskBody}`;
  }
  if (template) {
    body += `\n\n---\n\n${template}`;
  }
  return body;
}

export interface PRContent {
  title: string;
  body: string;
}

/**
 * Build PR title and body using LLM (claude -p) with diff context.
 * Falls back to static content if LLM fails.
 */
export async function buildPRContent(
  projectPath: string,
  summary: string,
  taskBody: string,
  options?: { workspacePath?: string; baseBranch?: string }
): Promise<PRContent> {
  const template = await loadPRTemplate(projectPath);
  const staticBody = buildStaticPRBody(summary, taskBody, template);
  const staticTitle = summary.split("\n")[0];
  const fallback: PRContent = { title: staticTitle, body: staticBody };

  const workspacePath = options?.workspacePath;
  const baseBranch = options?.baseBranch;
  if (!workspacePath || !baseBranch) return fallback;

  // Get diff against base branch
  let diff: string;
  try {
    const diffProc = Bun.spawn(["git", "diff", `${baseBranch}...HEAD`, "--stat"], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    await diffProc.exited;
    const statDiff = await new Response(diffProc.stdout).text();

    const fullProc = Bun.spawn(["git", "diff", `${baseBranch}...HEAD`], {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });
    await fullProc.exited;
    const fullDiff = await new Response(fullProc.stdout).text();

    // Truncate large diffs to ~50k chars
    diff = fullDiff.length > 50_000
      ? `${statDiff}\n\n(Full diff truncated to first 50k chars)\n\n${fullDiff.slice(0, 50_000)}`
      : `${statDiff}\n\n${fullDiff}`;
  } catch {
    return fallback;
  }

  if (!diff.trim()) return fallback;

  let prompt = `Write a concise PR title and description for the following changes. Target audience: developers reviewing the PR.\n\n`;
  prompt += `Task summary: ${summary}\n`;
  if (taskBody.trim()) {
    prompt += `\nTask details:\n${taskBody}\n`;
  }
  if (template) {
    prompt += `\nFill in this PR template for the body:\n${template}\n`;
  } else {
    prompt += `\nBody format: a short overview (2-4 bullet points), then a test plan section.\n`;
  }
  prompt += `\nDiff:\n\`\`\`\n${diff}\n\`\`\``;
  prompt += `\n\nRules:\n- Title: short (<70 chars), no prefix like "PR:"\n- Body: concise, no bold text, overview not tutorial\n- Output format: first line is the title, then a blank line, then the body markdown. Nothing else.`;

  try {
    const proc = Bun.spawn(["claude", "-p", "--model", "haiku"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new Response(prompt),
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return fallback;

    const output = (await new Response(proc.stdout).text()).trim();
    if (!output) return fallback;

    // Parse: first line = title, rest = body
    const newlineIdx = output.indexOf("\n");
    if (newlineIdx === -1) return fallback;

    const title = output.slice(0, newlineIdx).trim();
    const body = output.slice(newlineIdx + 1).trim();
    if (!title || !body) return fallback;

    return { title, body };
  } catch {
    return fallback;
  }
}

/**
 * Create a real GitHub executor for production use.
 */
export function createGitHub(): GitHubExecutor {
  return new RealGitHub();
}
