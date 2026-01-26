/**
 * Install command - installs the orchestrator skill and stop hook.
 *
 * - Symlinks the skills folder to ~/.claude/skills/orange (dev changes reflect immediately)
 * - Installs the stop hook to ~/.claude/hooks/stop.sh
 */

import { mkdir, symlink, writeFile, chmod, readFile, unlink, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const SKILLS_SOURCE = join(import.meta.dir, "../../../skills/orchestrator");
const SKILL_DEST = join(homedir(), ".claude/skills/orange");
const SKILL_DEST_DIR = dirname(SKILL_DEST);

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
 * Run the install command.
 */
export async function runInstallCommand(): Promise<void> {
  // Create destination directories
  await mkdir(SKILL_DEST_DIR, { recursive: true });
  await mkdir(HOOKS_DIR, { recursive: true });

  // Remove existing symlink/file if it exists
  try {
    const stats = await lstat(SKILL_DEST);
    // Remove existing file or symlink
    await unlink(SKILL_DEST);
  } catch {
    // File doesn't exist, that's fine
  }

  // Create symlink to skills folder
  await symlink(SKILLS_SOURCE, SKILL_DEST, "dir");
  console.log(`Symlinked skills folder to ${SKILL_DEST}`);

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
