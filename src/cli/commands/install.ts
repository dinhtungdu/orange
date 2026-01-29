/**
 * Install command - installs Orange skills to harness-specific directories.
 *
 * Usage:
 *   orange install                    # Install for first detected harness
 *   orange install --harness claude   # Install only for Claude Code
 *   orange install --all              # Install for all detected harnesses
 *
 * Skills are discovered from the skills/ directory. Each subfolder with a SKILL.md
 * is installed to the harness-specific skills directory.
 *
 * The SKILL.md is modified to include --harness <name> in orange commands,
 * so spawned agents pass their identity back to orange.
 */

import { mkdir, writeFile, chmod, readFile, unlink, lstat, readdir, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { Harness } from "../../core/types.js";
import { HARNESSES, getInstalledHarnesses } from "../../core/harness.js";
import type { ParsedArgs } from "../args.js";

const SKILLS_DIR = join(import.meta.dir, "../../../skills");

// Claude-specific paths for stop hook
const CLAUDE_DIR = join(homedir(), ".claude");
const HOOKS_DIR = join(CLAUDE_DIR, "hooks");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const STOP_HOOK_SCRIPT = join(HOOKS_DIR, "stop-orange.sh");

/**
 * Stop hook script content (Claude Code only).
 * Provides immediate status updates when agent stops.
 */
const STOP_HOOK_CONTENT = `#!/bin/bash
# Orange stop hook - provides immediate status updates for Claude Code
# Optional: dashboard polls .orange-outcome files anyway
# Installed by: orange install

if [[ -f .orange-outcome ]]; then
  # Parse JSON without jq dependency (pure bash)
  TASK_ID=$(grep -o '"id":"[^"]*"' .orange-outcome 2>/dev/null | head -1 | cut -d'"' -f4)
  OUTCOME=$(grep -o '"outcome":"[^"]*"' .orange-outcome 2>/dev/null | head -1 | cut -d'"' -f4)

  if [[ -n "$TASK_ID" ]]; then
    if [[ "$OUTCOME" == "passed" || "$OUTCOME" == "reviewing" ]]; then
      orange task complete "$TASK_ID"
    elif [[ "$OUTCOME" == "stuck" ]]; then
      orange task stuck "$TASK_ID"
    fi
  fi
fi
`;

/** Hook command that goes into settings.json */
const ORANGE_HOOK_COMMAND = `bash ${STOP_HOOK_SCRIPT}`;

interface HookEntry {
  command: string;
  type: "command";
}

interface HookMatcher {
  hooks: HookEntry[];
}

interface Settings {
  hooks?: {
    Stop?: HookMatcher[];
  };
  permissions?: {
    allow?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Template SKILL.md content with harness-specific commands.
 * Adds --harness <name> to orange task create commands.
 */
function templateSkillContent(content: string, harness: Harness): string {
  // Replace 'orange task create' with 'orange task create --harness <harness>'
  // but only if --harness is not already present
  return content.replace(
    /orange task create (?!--harness)/g,
    `orange task create --harness ${harness} `
  );
}

/**
 * Install a single skill to a harness's skills directory.
 */
async function installSkillForHarness(
  skillName: string,
  sourcePath: string,
  harness: Harness
): Promise<void> {
  const config = HARNESSES[harness];
  const destDir = join(config.skillsDir, `orange-${skillName}`);

  // Create destination directory
  await mkdir(destDir, { recursive: true });

  // Read and template SKILL.md
  const skillMdPath = join(sourcePath, "SKILL.md");
  const skillContent = await readFile(skillMdPath, "utf-8");
  const templatedContent = templateSkillContent(skillContent, harness);

  // Write templated SKILL.md
  await writeFile(join(destDir, "SKILL.md"), templatedContent);

  // Copy any other files in the skill directory
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue; // Already handled
    const srcFile = join(sourcePath, entry.name);
    const destFile = join(destDir, entry.name);
    await cp(srcFile, destFile, { recursive: true });
  }

  console.log(`  ${harness}: orange-${skillName}`);
}

/**
 * Install the stop hook into Claude's settings.json.
 */
async function installClaudeStopHook(): Promise<void> {
  // Create hooks directory
  await mkdir(HOOKS_DIR, { recursive: true });

  // Write hook script
  await writeFile(STOP_HOOK_SCRIPT, STOP_HOOK_CONTENT);
  await chmod(STOP_HOOK_SCRIPT, 0o755);
  console.log(`Installed hook script to ${STOP_HOOK_SCRIPT}`);

  // Load existing settings
  let settings: Settings = {};
  try {
    const content = await readFile(SETTINGS_PATH, "utf-8");
    settings = JSON.parse(content);
  } catch {
    // File doesn't exist or invalid JSON, start fresh
  }

  // Ensure hooks.Stop structure exists
  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!settings.hooks.Stop) {
    settings.hooks.Stop = [];
  }

  // Check if orange hook already exists
  const orangeHookExists = settings.hooks.Stop.some((matcher) =>
    matcher.hooks?.some((hook) => hook.command.includes("stop-orange.sh"))
  );

  if (!orangeHookExists) {
    // Add orange hook
    if (settings.hooks.Stop.length === 0) {
      settings.hooks.Stop.push({ hooks: [] });
    }
    settings.hooks.Stop[0].hooks.push({
      command: ORANGE_HOOK_COMMAND,
      type: "command",
    });
    console.log("Added stop hook to settings.json");
  } else {
    console.log("Stop hook already installed in settings.json");
  }

  // Ensure permissions.allow structure exists
  if (!settings.permissions) {
    settings.permissions = {};
  }
  if (!settings.permissions.allow) {
    settings.permissions.allow = [];
  }

  const permission = "Bash(orange:*)";
  if (!settings.permissions.allow.includes(permission)) {
    settings.permissions.allow.unshift(permission);
    console.log("Added Bash(orange:*) permission to settings.json");
  } else {
    console.log("Permission already installed in settings.json");
  }

  // Write back settings
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/**
 * Run the install command.
 */
export async function runInstallCommand(parsed?: ParsedArgs): Promise<void> {
  const harnessArg = parsed?.options.harness as string | undefined;
  const installAll = parsed?.options.all === true;

  // Determine which harnesses to install for
  let harnesses: Harness[];

  if (harnessArg) {
    // Explicit harness specified
    const validHarnesses: Harness[] = ["pi", "opencode", "claude", "codex"];
    if (!validHarnesses.includes(harnessArg as Harness)) {
      console.error(`Invalid harness '${harnessArg}'. Valid options: ${validHarnesses.join(", ")}`);
      process.exit(1);
    }
    harnesses = [harnessArg as Harness];
  } else if (installAll) {
    // Install for all detected harnesses
    harnesses = await getInstalledHarnesses();
    if (harnesses.length === 0) {
      console.error("No coding agent harness detected. Install one of: pi, opencode, claude, codex");
      process.exit(1);
    }
  } else {
    // Install for first detected harness
    harnesses = await getInstalledHarnesses();
    if (harnesses.length === 0) {
      console.error("No coding agent harness detected. Install one of: pi, opencode, claude, codex");
      process.exit(1);
    }
    harnesses = [harnesses[0]];
  }

  console.log(`Installing for harness(es): ${harnesses.join(", ")}`);
  console.log();

  // Discover skills
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const skills: { name: string; path: string }[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = join(SKILLS_DIR, entry.name);
      const skillFile = join(skillPath, "SKILL.md");
      if (existsSync(skillFile)) {
        skills.push({ name: entry.name, path: skillPath });
      }
    }
  }

  if (skills.length === 0) {
    console.log("No skills found to install");
    return;
  }

  // Install skills for each harness
  console.log("Installing skills:");
  for (const harness of harnesses) {
    const config = HARNESSES[harness];

    // Create skills directory
    await mkdir(config.skillsDir, { recursive: true });

    for (const skill of skills) {
      await installSkillForHarness(skill.name, skill.path, harness);
    }
  }

  console.log();
  console.log(`Installed ${skills.length} skill(s) for ${harnesses.length} harness(es)`);

  // Install Claude-specific extras (stop hook, permissions)
  if (harnesses.includes("claude")) {
    console.log();
    console.log("Installing Claude Code extras:");
    await installClaudeStopHook();
  }
}
