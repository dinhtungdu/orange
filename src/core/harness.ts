/**
 * Harness configuration and detection.
 *
 * Supports multiple coding agent harnesses: pi, opencode, claude, codex.
 * Each harness has its own binary, spawn commands, and workspace setup.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Harness } from "./types.js";

/**
 * Harness-specific configuration.
 */
export interface HarnessConfig {
  /** Binary name to check for installation */
  binary: string;
  /** Command to spawn agent with full permissions */
  spawnCommand: (prompt: string) => string;
  /** Command to spawn reviewer agent (may restrict tools to prevent unwanted side effects) */
  reviewSpawnCommand?: (prompt: string) => string;
  /** Command to respawn agent with reduced permissions */
  respawnCommand: (prompt: string) => string;
  /** Setup harness-specific files in workspace (optional) */
  workspaceSetup?: (workspacePath: string) => Promise<void>;
  /** Directories to add to git excludes */
  gitExcludes: string[];
  /** Skills directory path */
  skillsDir: string;
}

/**
 * Default Claude settings for autonomous agents.
 * Pre-allows common dev commands to avoid permission prompts.
 */
const CLAUDE_AGENT_SETTINGS = {
  permissions: {
    allow: [
      "Bash(bun run check:*)",
      "Bash(bunx tsc:*)",
      "Bash(bun test:*)",
      "Bash(bun install)",
      "Bash(git stash:*)",
    ],
  },
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
  },
};

/**
 * Escape a string for use in a shell double-quoted context.
 */
function shellEscape(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/\n/g, "\\n");
}

/**
 * Harness configurations.
 */
export const HARNESSES: Record<Harness, HarnessConfig> = {
  pi: {
    binary: "pi",
    spawnCommand: (prompt) => `pi "${shellEscape(prompt)}"`,
    respawnCommand: (prompt) => `pi "${shellEscape(prompt)}"`,
    gitExcludes: [".pi/"],
    skillsDir: join(homedir(), ".pi/agent/skills"),
  },
  opencode: {
    binary: "opencode",
    spawnCommand: (prompt) => `opencode run "${shellEscape(prompt)}"`,
    respawnCommand: (prompt) => `opencode run "${shellEscape(prompt)}"`,
    workspaceSetup: async (workspacePath) => {
      // Create opencode.json with allow permission
      await writeFile(
        join(workspacePath, "opencode.json"),
        JSON.stringify({ permission: "allow" }, null, 2)
      );
    },
    gitExcludes: [".opencode/", "opencode.json"],
    skillsDir: join(homedir(), ".config/opencode/skills"),
  },
  claude: {
    binary: "claude",
    spawnCommand: (prompt) => `claude --dangerously-skip-permissions "${shellEscape(prompt)}"`,
    // Block gh pr review/comment to prevent reviewer from posting to GitHub.
    // --disallowedTools is variadic, so use = to avoid it consuming the prompt as a tool name.
    reviewSpawnCommand: (prompt) => `claude --dangerously-skip-permissions --disallowedTools="Bash(gh pr review:*),Bash(gh pr comment:*),Bash(gh review:*)" "${shellEscape(prompt)}"`,
    respawnCommand: (prompt) => `claude --permission-mode acceptEdits "${shellEscape(prompt)}"`,
    workspaceSetup: async (workspacePath) => {
      // Create .claude/settings.local.json for autonomous agent permissions
      const claudeDir = join(workspacePath, ".claude");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(
        join(claudeDir, "settings.local.json"),
        JSON.stringify(CLAUDE_AGENT_SETTINGS, null, 2)
      );
    },
    gitExcludes: [".claude/"],
    skillsDir: join(homedir(), ".claude/skills"),
  },
  codex: {
    binary: "codex",
    spawnCommand: (prompt) => `codex exec --dangerously-bypass-approvals-and-sandbox "${shellEscape(prompt)}"`,
    respawnCommand: (prompt) => `codex exec --full-auto "${shellEscape(prompt)}"`,
    gitExcludes: [".codex/"],
    skillsDir: join(homedir(), ".codex/skills"),
  },
};

/**
 * Check if a harness binary is installed.
 */
async function isHarnessInstalled(harness: Harness): Promise<boolean> {
  const config = HARNESSES[harness];
  try {
    const proc = Bun.spawn(["which", config.binary], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get list of installed harnesses in preference order.
 */
export async function getInstalledHarnesses(): Promise<Harness[]> {
  const order: Harness[] = ["pi", "opencode", "claude", "codex"];
  const installed: Harness[] = [];

  for (const harness of order) {
    if (await isHarnessInstalled(harness)) {
      installed.push(harness);
    }
  }

  return installed;
}

/**
 * Resolve which harness to use.
 *
 * @param explicit - Explicitly specified harness (from CLI flag)
 * @returns The harness to use
 * @throws Error if no harness is installed
 */
export async function resolveHarness(explicit?: string): Promise<Harness> {
  // If explicitly specified, validate and return
  if (explicit) {
    const validHarnesses: Harness[] = ["pi", "opencode", "claude", "codex"];
    if (!validHarnesses.includes(explicit as Harness)) {
      throw new Error(`Invalid harness '${explicit}'. Valid options: ${validHarnesses.join(", ")}`);
    }
    const harness = explicit as Harness;
    const installed = await isHarnessInstalled(harness);
    if (!installed) {
      throw new Error(`Harness '${harness}' is not installed. Install it or choose another harness.`);
    }
    return harness;
  }

  // Auto-detect: use first installed in preference order
  const installed = await getInstalledHarnesses();
  if (installed.length === 0) {
    throw new Error("No coding agent harness installed. Install one of: pi, opencode, claude, codex");
  }

  return installed[0];
}

/**
 * Get all git excludes for all harnesses.
 */
export function getAllGitExcludes(): string[] {
  const excludes = new Set<string>();
  excludes.add("TASK.md");
  excludes.add(".orange-outcome");

  for (const config of Object.values(HARNESSES)) {
    for (const exclude of config.gitExcludes) {
      excludes.add(exclude);
    }
  }

  return Array.from(excludes);
}
