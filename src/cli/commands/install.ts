/**
 * Install command - installs Orange skills, stop hook, and permissions.
 *
 * - Symlinks each skill folder to ~/.claude/skills/<skill-name> (dev changes reflect immediately)
 * - Adds stop hook to ~/.claude/settings.json
 * - Creates hook script at ~/.claude/hooks/stop-orange.sh
 * - Adds Bash(orange:*) permission to ~/.claude/settings.json
 *
 * Skills are discovered from the skills/ directory. Each subfolder with a SKILL.md
 * is symlinked as a separate skill (e.g., skills/orchestrator -> ~/.claude/skills/orange-orchestrator).
 */

import { mkdir, symlink, writeFile, chmod, readFile, unlink, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const SKILLS_DIR = join(import.meta.dir, "../../../skills");
const CLAUDE_DIR = join(homedir(), ".claude");
const SKILLS_DEST_DIR = join(CLAUDE_DIR, "skills");
const HOOKS_DIR = join(CLAUDE_DIR, "hooks");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const STOP_HOOK_SCRIPT = join(HOOKS_DIR, "stop-orange.sh");

/**
 * Stop hook script content.
 * Called by the settings.json hook entry.
 */
const STOP_HOOK_CONTENT = `#!/bin/bash
# Orange stop hook - notifies orange when agent completes
# Installed by: orange install

if [[ -f .orange-task ]]; then
  # Parse JSON without jq dependency (pure bash)
  TASK_ID=$(grep -o '"id":"[^"]*"' .orange-task 2>/dev/null | head -1 | cut -d'"' -f4)
  OUTCOME=$(grep -o '"outcome":"[^"]*"' .orange-task 2>/dev/null | head -1 | cut -d'"' -f4)

  if [[ -n "$TASK_ID" ]]; then
    if [[ "$OUTCOME" == "passed" || "$OUTCOME" == "needs_human" ]]; then
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
 * Install a single skill by creating a symlink.
 */
async function installSkill(skillName: string, sourcePath: string): Promise<void> {
  const destPath = join(SKILLS_DEST_DIR, `orange-${skillName}`);

  // Remove existing symlink/file if it exists
  try {
    await lstat(destPath);
    await unlink(destPath);
  } catch {
    // File doesn't exist, that's fine
  }

  // Create symlink
  await symlink(sourcePath, destPath, "dir");
  console.log(`Installed skill: orange-${skillName}`);
}

/**
 * Install the stop hook into settings.json.
 */
async function installStopHook(): Promise<void> {
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

  if (orangeHookExists) {
    console.log("Stop hook already installed in settings.json");
    return;
  }

  // Add orange hook
  // Find existing matcher or create new one
  if (settings.hooks.Stop.length === 0) {
    settings.hooks.Stop.push({ hooks: [] });
  }

  // Add to first matcher's hooks array
  settings.hooks.Stop[0].hooks.push({
    command: ORANGE_HOOK_COMMAND,
    type: "command",
  });

  // Write back settings
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log("Added stop hook to settings.json");
}

/**
 * Install the Bash(orange:*) permission into settings.json.
 */
async function installPermission(): Promise<void> {
  // Load existing settings
  let settings: Settings = {};
  try {
    const content = await readFile(SETTINGS_PATH, "utf-8");
    settings = JSON.parse(content);
  } catch {
    // File doesn't exist or invalid JSON, start fresh
  }

  // Ensure permissions.allow structure exists
  if (!settings.permissions) {
    settings.permissions = {};
  }
  if (!settings.permissions.allow) {
    settings.permissions.allow = [];
  }

  const permission = "Bash(orange:*)";

  // Check if permission already exists
  if (settings.permissions.allow.includes(permission)) {
    console.log("Permission already installed in settings.json");
    return;
  }

  // Add permission
  settings.permissions.allow.unshift(permission);

  // Write back settings
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log("Added Bash(orange:*) permission to settings.json");
}

/**
 * Run the install command.
 */
export async function runInstallCommand(): Promise<void> {
  // Create destination directories
  await mkdir(SKILLS_DEST_DIR, { recursive: true });
  await mkdir(HOOKS_DIR, { recursive: true });

  // Discover and install all skills
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  let skillCount = 0;

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const skillPath = join(SKILLS_DIR, entry.name);
      const skillFile = join(skillPath, "SKILL.md");

      if (existsSync(skillFile)) {
        await installSkill(entry.name, skillPath);
        skillCount++;
      }
    }
  }

  if (skillCount === 0) {
    console.log("No skills found to install");
  } else {
    console.log(`Installed ${skillCount} skill(s) to ${SKILLS_DEST_DIR}`);
  }

  // Write hook script
  await writeFile(STOP_HOOK_SCRIPT, STOP_HOOK_CONTENT);
  await chmod(STOP_HOOK_SCRIPT, 0o755);
  console.log(`Installed hook script to ${STOP_HOOK_SCRIPT}`);

  // Add hook to settings.json
  await installStopHook();

  // Add permission to settings.json
  await installPermission();
}
