/**
 * Install command - installs Orange skills to harness-specific directories.
 *
 * Usage:
 *   orange install                    # Install for all detected harnesses
 *   orange install --harness claude   # Install only for Claude Code
 *
 * Skills are discovered from the skills/ directory. Each subfolder with a SKILL.md
 * is symlinked to the harness-specific skills directory.
 */

import { mkdir, writeFile, readFile, readdir, symlink, rm, lstat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { Harness } from "../../core/types.js";
import { HARNESSES, getInstalledHarnesses } from "../../core/harness.js";
import type { ParsedArgs } from "../args.js";

const SKILLS_DIR = join(import.meta.dir, "../../../skills");
const EXTENSIONS_DIR = join(import.meta.dir, "../../../extensions");

// Pi-specific paths for extensions
const PI_EXTENSIONS_DIR = join(homedir(), ".pi/agent/extensions");

// Claude-specific paths for permissions
const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");

interface Settings {
  permissions?: {
    allow?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Install a single skill to a harness's skills directory via symlink.
 */
async function installSkillForHarness(
  skillName: string,
  sourcePath: string,
  harness: Harness
): Promise<void> {
  const config = HARNESSES[harness];
  // Don't add orange- prefix if skill is already named 'orange'
  const destName = skillName === "orange" ? "orange" : `orange-${skillName}`;
  const destPath = join(config.skillsDir, destName);

  // Remove existing symlink/directory if present
  try {
    const stats = await lstat(destPath);
    if (stats.isSymbolicLink() || stats.isDirectory()) {
      await rm(destPath, { recursive: true, force: true });
    }
  } catch {
    // Doesn't exist, that's fine
  }

  // Create relative symlink
  const relPath = relative(dirname(destPath), sourcePath);
  await symlink(relPath, destPath);

  console.log(`  ${harness}: ${destName} -> ${sourcePath}`);
}

/**
 * Install the Bash(orange:*) permission into Claude's settings.json.
 */
async function installClaudePermission(): Promise<void> {
  await mkdir(CLAUDE_DIR, { recursive: true });

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
  if (!settings.permissions.allow.includes(permission)) {
    settings.permissions.allow.unshift(permission);
    await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log("  Added Bash(orange:*) permission to settings.json");
  } else {
    console.log("  Bash(orange:*) permission already installed");
  }
}

/**
 * Run the install command.
 */
export async function runInstallCommand(parsed?: ParsedArgs): Promise<void> {
  const harnessArg = parsed?.options.harness as string | undefined;

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
  } else {
    // Install for all detected harnesses
    harnesses = await getInstalledHarnesses();
    if (harnesses.length === 0) {
      console.error("No coding agent harness detected. Install one of: pi, opencode, claude, codex");
      process.exit(1);
    }
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

  // Install Claude-specific extras (permissions)
  if (harnesses.includes("claude")) {
    console.log();
    console.log("Claude Code:");
    await installClaudePermission();
  }

  // Install pi-specific extras (extensions)
  if (harnesses.includes("pi")) {
    console.log();
    console.log("Pi extensions:");
    await installPiExtension();
  }
}

/**
 * Install the pi extension for Orange.
 */
async function installPiExtension(): Promise<void> {
  const sourcePath = join(EXTENSIONS_DIR, "pi");
  const destPath = join(PI_EXTENSIONS_DIR, "orange");

  // Ensure extensions directory exists
  await mkdir(PI_EXTENSIONS_DIR, { recursive: true });

  // Remove existing symlink/directory if present
  try {
    const stats = await lstat(destPath);
    if (stats.isSymbolicLink() || stats.isDirectory()) {
      await rm(destPath, { recursive: true, force: true });
    }
  } catch {
    // Doesn't exist, that's fine
  }

  // Check if source exists
  if (!existsSync(sourcePath)) {
    console.log(`  Extension source not found: ${sourcePath}`);
    return;
  }

  // Create relative symlink
  const relPath = relative(dirname(destPath), sourcePath);
  await symlink(relPath, destPath);

  console.log(`  orange -> ${sourcePath}`);
}
