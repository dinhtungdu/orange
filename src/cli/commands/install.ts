/**
 * Install command - installs Orange skills and stop hook.
 *
 * - Symlinks each skill folder to ~/.claude/skills/<skill-name> (dev changes reflect immediately)
 * - Installs the stop hook to ~/.claude/hooks/stop.sh
 *
 * Skills are discovered from the skills/ directory. Each subfolder with a SKILL.md
 * is symlinked as a separate skill (e.g., skills/orchestrator -> ~/.claude/skills/orange-orchestrator).
 */

import { mkdir, symlink, writeFile, chmod, readFile, unlink, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const SKILLS_DIR = join(import.meta.dir, "../../../skills");
const SKILLS_DEST_DIR = join(homedir(), ".claude/skills");

const HOOKS_DIR = join(homedir(), ".claude/hooks");
const STOP_HOOK_PATH = join(HOOKS_DIR, "stop.sh");

/**
 * Stop hook content.
 * This hook is called by Claude Code when an agent stops.
 * It reads the .orange-task file to determine if the agent passed or got stuck.
 * Uses pure bash JSON parsing (no jq dependency).
 */
const STOP_HOOK_CONTENT = `#!/bin/bash
# Orange stop hook - notifies orange when agent completes
# Installed by: orange install

if [[ -f .orange-task ]]; then
  # Parse JSON without jq dependency (pure bash)
  TASK_ID=$(grep -o '"id":"[^"]*"' .orange-task 2>/dev/null | head -1 | cut -d'"' -f4)
  OUTCOME=$(grep -o '"outcome":"[^"]*"' .orange-task 2>/dev/null | head -1 | cut -d'"' -f4)

  if [[ -n "$TASK_ID" ]]; then
    if [[ "$OUTCOME" == "passed" ]]; then
      orange task complete "$TASK_ID"
    else
      orange task stuck "$TASK_ID"
    fi
  fi
fi
`;

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

  // Check if stop hook already exists and has content
  let existingContent = "";
  try {
    existingContent = await readFile(STOP_HOOK_PATH, "utf-8");
  } catch {
    // File doesn't exist, will create new
  }

  // Only write hook if it doesn't exist or is our hook
  if (!existingContent || existingContent.includes("Orange stop hook")) {
    await writeFile(STOP_HOOK_PATH, STOP_HOOK_CONTENT);
    await chmod(STOP_HOOK_PATH, 0o755);
    console.log(`Installed stop hook to ${STOP_HOOK_PATH}`);
  } else {
    console.log(`Stop hook already exists at ${STOP_HOOK_PATH} (not overwriting)`);
    console.log("To enable Orange integration, add the following to your stop hook:");
    console.log("");
    console.log(`if [[ -f .orange-task ]]; then`);
    console.log(`  TASK_ID=$(jq -r .id .orange-task 2>/dev/null)`);
    console.log(`  OUTCOME=$(jq -r .outcome .orange-task 2>/dev/null)`);
    console.log(`  if [[ -n "$TASK_ID" && "$TASK_ID" != "null" ]]; then`);
    console.log(`    if [[ "$OUTCOME" == "passed" ]]; then`);
    console.log(`      orange task complete "$TASK_ID"`);
    console.log(`    else`);
    console.log(`      orange task stuck "$TASK_ID"`);
    console.log(`    fi`);
    console.log(`  fi`);
    console.log(`fi`);
  }
}
