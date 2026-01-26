/**
 * Install command - installs the orchestrator skill.
 *
 * Copies the orchestrator skill to ~/.claude/skills/orange/
 */

import { mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SKILL_SOURCE = join(import.meta.dir, "../../../skills/orchestrator.md");
const SKILL_DEST_DIR = join(homedir(), ".claude/skills/orange");
const SKILL_DEST = join(SKILL_DEST_DIR, "orchestrator.md");

/**
 * Run the install command.
 */
export async function runInstallCommand(): Promise<void> {
  // Create destination directory
  await mkdir(SKILL_DEST_DIR, { recursive: true });

  // Copy skill file
  await copyFile(SKILL_SOURCE, SKILL_DEST);

  console.log(`Installed orchestrator skill to ${SKILL_DEST}`);
}
