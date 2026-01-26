/**
 * SQLite index cache for fast task queries.
 *
 * The database is a derived cache rebuilt from task folders if missing or corrupted.
 * Source of truth is the file-based TASK.md files.
 *
 * Uses Bun's built-in SQLite (bun:sqlite) for compatibility.
 *
 * Performance optimizations:
 * - Rebuild is triggered on-demand when database is missing or schema is invalid
 * - Single database connection per operation (auto-close)
 * - Prepared statements for repeated queries
 */

import { join } from "node:path";
import { mkdir, readdir, access, constants } from "node:fs/promises";
import { Database } from "bun:sqlite";
import type { Deps, Task, TaskStatus } from "./types.js";
import { loadTask } from "./state.js";

/**
 * Track whether rebuild has been triggered this session to avoid repeated rebuilds.
 */
let rebuildTriggeredThisSession = false;

/**
 * Get database path.
 */
function getDbPath(deps: Deps): string {
  return join(deps.dataDir, "index.db");
}

/**
 * Check if database file exists.
 */
async function dbExists(deps: Deps): Promise<boolean> {
  try {
    await access(getDbPath(deps), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate database schema integrity.
 * Returns false if schema is missing or corrupted.
 */
function validateSchema(db: Database): boolean {
  try {
    // Check if tasks table exists with expected columns
    const result = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
    ).get() as { sql: string } | null;

    if (!result) return false;

    // Verify essential columns exist
    const requiredColumns = [
      "id", "project", "branch", "status", "workspace",
      "tmux_session", "description", "created_at", "updated_at"
    ];

    const sql = result.sql.toLowerCase();
    return requiredColumns.every(col => sql.includes(col));
  } catch {
    return false;
  }
}

/**
 * Ensure database exists, has valid schema, and rebuild if needed.
 */
async function ensureDb(deps: Deps): Promise<Database> {
  await mkdir(deps.dataDir, { recursive: true });

  const dbPath = getDbPath(deps);
  const exists = await dbExists(deps);

  const db = new Database(dbPath);

  // Create schema if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace TEXT,
      tmux_session TEXT,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
  `);

  // If database was just created or schema is invalid, trigger rebuild
  if (!exists || !validateSchema(db)) {
    if (!rebuildTriggeredThisSession) {
      rebuildTriggeredThisSession = true;
      db.close();
      // Rebuild from task folders
      await rebuildDbInternal(deps);
      return new Database(dbPath);
    }
  }

  return db;
}

/**
 * Reset rebuild tracking (useful for tests).
 */
export function resetRebuildTracking(): void {
  rebuildTriggeredThisSession = false;
}

/**
 * Update or insert a task in the database.
 */
export async function updateTaskInDb(deps: Deps, task: Task): Promise<void> {
  const db = await ensureDb(deps);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO tasks (id, project, branch, status, workspace, tmux_session, description, created_at, updated_at)
    VALUES ($id, $project, $branch, $status, $workspace, $tmux_session, $description, $created_at, $updated_at)
  `);

  stmt.run({
    $id: task.id,
    $project: task.project,
    $branch: task.branch,
    $status: task.status,
    $workspace: task.workspace,
    $tmux_session: task.tmux_session,
    $description: task.description,
    $created_at: task.created_at,
    $updated_at: task.updated_at,
  });

  db.close();
}

/**
 * List tasks with optional filters.
 */
export async function listTasks(
  deps: Deps,
  filters: { project?: string; status?: TaskStatus }
): Promise<Task[]> {
  const db = await ensureDb(deps);

  let query = "SELECT * FROM tasks WHERE 1=1";
  const params: Record<string, string> = {};

  if (filters.project) {
    query += " AND project = $project";
    params.$project = filters.project;
  }

  if (filters.status) {
    query += " AND status = $status";
    params.$status = filters.status;
  }

  query += " ORDER BY created_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(params) as Task[];

  db.close();

  return rows;
}

/**
 * Get a task by ID.
 */
export async function getTaskById(deps: Deps, id: string): Promise<Task | null> {
  const db = await ensureDb(deps);

  const stmt = db.prepare("SELECT * FROM tasks WHERE id = $id");
  const row = stmt.get({ $id: id }) as Task | null;

  db.close();

  return row;
}

/**
 * Delete a task from the database.
 */
export async function deleteTaskFromDb(deps: Deps, id: string): Promise<void> {
  const db = await ensureDb(deps);

  const stmt = db.prepare("DELETE FROM tasks WHERE id = $id");
  stmt.run({ $id: id });

  db.close();
}

/**
 * Internal rebuild function (used by ensureDb for auto-recovery).
 */
async function rebuildDbInternal(deps: Deps): Promise<void> {
  await mkdir(deps.dataDir, { recursive: true });

  const dbPath = getDbPath(deps);
  const db = new Database(dbPath);

  // Create schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace TEXT,
      tmux_session TEXT,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
  `);

  // Clear existing data
  db.exec("DELETE FROM tasks");

  // Scan task folders
  const tasksDir = join(deps.dataDir, "tasks");

  try {
    const projects = await readdir(tasksDir);

    for (const project of projects) {
      const projectDir = join(tasksDir, project);

      try {
        const branches = await readdir(projectDir);

        for (const branch of branches) {
          const task = await loadTask(deps, project, branch);
          if (task) {
            const stmt = db.prepare(`
              INSERT OR REPLACE INTO tasks (id, project, branch, status, workspace, tmux_session, description, created_at, updated_at)
              VALUES ($id, $project, $branch, $status, $workspace, $tmux_session, $description, $created_at, $updated_at)
            `);

            stmt.run({
              $id: task.id,
              $project: task.project,
              $branch: task.branch,
              $status: task.status,
              $workspace: task.workspace,
              $tmux_session: task.tmux_session,
              $description: task.description,
              $created_at: task.created_at,
              $updated_at: task.updated_at,
            });
          }
        }
      } catch {
        // Skip non-directory entries
      }
    }
  } catch {
    // No tasks directory yet
  }

  db.close();
}

/**
 * Rebuild database from task folders.
 * Public API for manual rebuild (e.g., from CLI).
 */
export async function rebuildDb(deps: Deps): Promise<void> {
  await rebuildDbInternal(deps);
}
