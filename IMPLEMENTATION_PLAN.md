# Orange Implementation Plan

## Status: Phase 1-11 Complete

**Goal**: Agent orchestration system - Chat with orchestrator → agents work in parallel → auto-review → human review

**Stack**: TypeScript, pi-tui, tmux, SQLite (bun:sqlite)

**Legend**: 🔴 Not started | 🟡 In progress | 🟢 Complete

**Last verified**: 2026-01-26

**Specs**: See `specs/*.md` for detailed specifications

---

## Implementation Priority

### Phase 1: Project Foundation (Critical Path)

- 🟢 **Initialize project structure**
  - Created `package.json` with dependencies (pi-tui, chokidar, chalk, gray-matter, nanoid, proper-lockfile)
  - Created `tsconfig.json` per specs/architecture.md
  - Created directory structure: `src/cli/`, `src/dashboard/`, `src/core/`
  - Note: Using `bun:sqlite` instead of `better-sqlite3` for Bun compatibility

- 🟢 **Core types** (`src/core/types.ts`)
  - Task interface (id, project, branch, status, workspace, tmux_session, description, created_at, updated_at)
  - TaskStatus type: pending, working, needs_human, stuck, done, failed
  - Project interface (name, path, default_branch, pool_size)
  - Deps interface for dependency injection (TmuxExecutor, GitExecutor, Clock, dataDir)
  - PoolState, WorkspaceEntry, HistoryEvent types

- 🟢 **Entry point** (`src/index.ts`)
  - Argument parsing dispatch to CLI commands or dashboard
  - Routes: project, task, workspace, start, install, help, dashboard

### Phase 2: External Abstractions (Required for Testing)

- 🟢 **Tmux abstraction** (`src/core/tmux.ts`)
  - TmuxExecutor interface: isAvailable, newSession, killSession, killSessionSafe, listSessions, sessionExists, capturePane, capturePaneSafe, sendKeys, attachOrCreate
  - RealTmux class implementing TmuxExecutor
  - MockTmux class for testing with setAvailable() helper

- 🟢 **Git abstraction** (`src/core/git.ts`)
  - GitExecutor interface: fetch, checkout, resetHard, createBranch, deleteBranch, merge, currentBranch, clean, addWorktree, removeWorktree
  - Added: getCommitHash(cwd, short?) to get actual commit hash after merge
  - Added: deleteRemoteBranch(cwd, branch, remote?) for cleanup
  - Updated: merge(cwd, branch, strategy?) supports ff (--ff-only) and merge (--no-ff) strategies
  - RealGit class implementing GitExecutor
  - MockGit class for testing (now creates directory on filesystem for consistency)

- 🟢 **Clock abstraction** (`src/core/clock.ts`)
  - Clock interface: now()
  - RealClock and MockClock implementations

### Phase 3: State Management

- 🟢 **File-based state** (`src/core/state.ts`)
  - Projects: load/save `~/orange/projects.json`
  - Tasks: TASK.md frontmatter read/write (gray-matter)
  - History: history.jsonl append-only event log
  - Event types: task.created, agent.spawned, status.changed, task.merged, task.cancelled, etc.

- 🟢 **SQLite index cache** (`src/core/db.ts`)
  - Create `~/orange/index.db` schema per specs/data.md
  - Tasks table: id, project, branch, status, workspace, tmux_session, description, created_at, updated_at
  - Rebuild from task folders if missing/corrupted
  - Query helpers: listTasks, getTaskById, updateTaskInDb, rebuildDb

### Phase 4: Workspace Pool

- 🟢 **Workspace pool management** (`src/core/workspace.ts`)
  - initWorkspacePool(deps, project): Create worktrees based on pool_size
  - acquireWorkspace(deps, project, task): Acquire available workspace with lock
  - releaseWorkspace(deps, workspace): Release workspace, clean git state
  - .pool.json state tracking
  - proper-lockfile for race condition prevention

### Phase 5: CLI Commands (Core)

- 🟢 **Argument parsing** (`src/cli/args.ts`)
  - Parse CLI commands and options
  - Route to appropriate command handlers
  - Support for subcommands and options

- 🟢 **Project commands** (`src/cli/commands/project.ts`)
  - `orange project add <path> [--name] [--pool-size]`
  - `orange project list`

- 🟢 **Workspace commands** (`src/cli/commands/workspace.ts`)
  - `orange workspace init <project>` - Create worktrees for pool
  - `orange workspace list` - Show pool status

- 🟢 **Task commands** (`src/cli/commands/task.ts`)
  - `orange task create <project> <branch> <description>` - Create task folder, TASK.md, history.jsonl
  - `orange task list [--project] [--status]` - List from SQLite index
  - `orange task spawn <task_id>` - Acquire workspace, create branch, start tmux session with Claude
    - Now writes `.orange-task` file with task ID during spawn for hook integration

### Phase 6: Agent Integration

- 🟢 **Agent prompt generation** (`src/core/agent.ts`)
  - buildAgentPrompt(): Build `--prompt` string per specs/agent.md
  - Include: description, project, branch, worktree, self-review instructions
  - Max 3 review attempts, write outcome to .orange-task
  - parseAgentOutcome(): Parse .orange-task file

- 🟢 **Task lifecycle commands** (`src/cli/commands/task.ts` - additional)
  - `orange task peek <task_id> [--lines N]` - Capture tmux pane output
  - `orange task complete <task_id>` - Called by hook → needs_human
  - `orange task stuck <task_id>` - Called by hook → stuck
  - `orange task merge <task_id> [--strategy]` - Merge branch, release workspace, kill session
    - Now uses actual commit hash instead of placeholder
    - Implements proper merge strategies (ff-only vs merge)
    - Deletes remote branch after successful merge
  - `orange task cancel <task_id>` - Cancel task, release workspace, kill session

- 🟢 **Orchestrator skill** (`skills/orchestrator.md`)
  - Created skill file per specs/cli.md
  - `orange install` command to copy to ~/.claude/skills/orange/
  - Installs stop hook to `~/.claude/hooks/stop.sh`
  - Hook handles Claude Code integration to auto-call `orange task complete/stuck`
  - Respects existing hooks and provides manual instructions if custom hook exists

### Phase 7: Dashboard TUI

- 🟢 **Dashboard** (`src/dashboard/index.ts`)
  - TUI setup with pi-tui (ProcessTerminal, TUI, Component)
  - Task list with status indicators (●/◉/⚠/○/✓/✗)
  - Cursor navigation (j/k)
  - Input handling: j/k navigate, Enter attach, p peek, m merge, x cancel, o open PR, q quit
  - Async operation handling (fire-and-forget pattern per specs/dashboard.md)
  - File watching with chokidar for task folder changes
  - Periodic tmux capture for "lastOutput" display (every 5s)

### Phase 8: Start Command

- 🟢 **Start command** (`src/cli/commands/start.ts`)
  - `orange start` - Create orchestrator session
  - Create tmux session `orange-orchestrator`
  - Pane 0: Claude Code
  - Pane 1: Dashboard TUI (via split and sendKeys)
  - Handle already-running session gracefully

---

## Phase 9: Testing Infrastructure

- 🟢 **Test mocks** (colocated in `src/core/*.ts`)
  - MockTmux, MockGit, MockClock implementations
  - Temp directory utilities in tests

- 🟢 **Core tests** (colocated `*.test.ts`)
  - types.test.ts: Type validation (13 tests)
  - workspace.test.ts: Pool acquire/release/exhaustion (8 tests)
  - state.test.ts: TASK.md parsing, history.jsonl events (10 tests)
  - db.test.ts: SQLite index queries, rebuild from folders (10 tests)

- 🟢 **CLI tests**
  - args.test.ts: Argument parsing (15 tests)
  - project.test.ts: Project add/list commands (16 tests)
  - task.test.ts: Full task lifecycle (27 tests - includes tmux availability and safe method tests)

**Total: 121 tests passing** (after Phase 11 + lazy init)

---

## Phase 10: Spec Refinements (1bdc20a) - Complete

- 🟢 **Symlink skill install** (`src/cli/commands/install.ts`)
  - Changed from copy to symlink: `ln -s skills/ ~/.claude/skills/orange`
  - Dev changes reflect immediately without re-install

- 🟢 **Auto-attach start** (`src/cli/commands/start.ts`)
  - Added `attachOrCreate` method to TmuxExecutor interface
  - `orange start` now attaches if session exists, creates if not
  - Uses `tmux new-session -A` for seamless attach-or-create

- 🟢 **PR detection in merge** (`src/cli/commands/task.ts`)
  - Before local merge, checks: `gh pr view <branch> --json state,mergeCommit`
  - If PR merged → skips local merge, uses PR's merge commit
  - If no PR or PR open → does local merge as before
  - Message shows "merged via PR" or "merged locally"

- 🟢 **Auto-spawn next pending** (`src/core/spawn.ts`, `src/core/workspace.ts`)
  - Extracted spawn logic to reusable `spawnTaskById()` function
  - Added `spawnNextPending()` that queries pending tasks and spawns oldest (FIFO)
  - `releaseWorkspace()` now auto-spawns next pending task for the project

- 🟢 **Dashboard status filter** (`src/dashboard/index.ts`)
  - Added `f` keybind: cycles filter (all → active → done)
  - Active = pending, working, needs_human, stuck
  - Done = done, failed
  - Header shows current filter: "Orange Dashboard (active)"

---

## Phase 11: CWD-Aware Refactor 🟢

Major architectural change: Orchestrator is per-project, not global. CLI commands infer project from current directory.

### 11.1 Core Changes

- 🟢 **CWD detection utility** (`src/core/cwd.ts`)
  - `detectProject(cwd)`: Find git root, lookup in projects.json, return project or null
  - `requireProject(cwd)`: Same but throws if not in a registered project
  - `getGitRoot(cwd)`: Find git repository root from any subdirectory
  - `autoRegisterProject(cwd)`: Auto-register project with defaults
  - Path normalization to handle macOS symlinks (/var -> /private/var)

- 🟢 **Project auto-registration**
  - When `orange start` runs in unregistered project: auto-add to projects.json
  - Infer name from folder, use default pool_size=2
  - Skip if already registered
  - Handle name conflicts by appending timestamp

### 11.2 CLI Command Updates

- 🟢 **orange start** (`src/cli/commands/start.ts`)
  - Must run from git repository (error if not)
  - Auto-register project if not in projects.json
  - Session name: `<project>-orchestrator` (not `orange-orchestrator`)
  - Working directory: project repo path (not ~/orange)
  - Dashboard pane: project-scoped (pass `--project` flag)

- 🟢 **orange task create** (`src/cli/commands/task.ts`)
  - Change signature: `orange task create <branch> <description>` (no project arg)
  - Infer project from cwd (or `--project` flag for scripting/testing)
  - Error if not in a registered project

- 🟢 **orange task list** (`src/cli/commands/task.ts`)
  - Default: show tasks for current project (inferred from cwd)
  - `--all` flag: show all tasks across projects
  - `--project` flag: filter by explicit project
  - If not in project and no `--all`: show all (global view)

- 🟢 **orange workspace init** (`src/cli/commands/workspace.ts`)
  - Change signature: `orange workspace init` (no project arg)
  - Infer project from cwd

- 🟢 **orange workspace list** (`src/cli/commands/workspace.ts`)
  - Default: show pool for current project
  - `--all` flag: show all workspaces

- 🟢 **orange (no args) / orange dashboard**
  - In project directory: project-scoped dashboard
  - Not in project: global dashboard
  - `--all` flag: always global
  - `--project <name>` flag: specific project

- 🟢 **orange project add** (`src/cli/commands/project.ts`)
  - Path defaults to current directory if not provided
  - Validates path is a git repository
  - Auto-detects default branch
  - Added `orange project remove <name>` command

### 11.3 Dashboard Updates

- 🟢 **Project scoping** (`src/dashboard/index.ts`)
  - Accept `--project` flag to filter tasks
  - Accept `--all` flag for global view
  - Header shows project name (scoped) or "all" (global)
  - When launched from `orange start`: auto-scoped to that project

### 11.4 Workspace Lazy Init

- 🟢 **On-demand worktree creation** (`src/core/workspace.ts`)
  - `acquireWorkspace()`: if no workspace exists, create one (up to pool_size)
  - Show progress: "Creating workspace coffee--1..."
  - `orange workspace init` becomes optional (pre-warming)
  - Added `getPoolStats()` helper for statistics

### 11.5 Test Updates

- 🟢 **Update existing tests**
  - `task.test.ts`: Updated for new `task create` signature (uses `--project` flag)
  - `args.test.ts`: Updated argument parsing tests for new signatures
  - `cwd.test.ts`: Added CWD detection tests (21 tests)
  - `project.test.ts`: Updated to create real git repos for testing

### 11.6 Skill Update

- 🟢 **Updated skill file** (`skills/orchestrator.md`)
  - Removed `<project>` from `task create` examples
  - Updated to reflect CWD-aware design
  - Orchestrator now assumes it's running in project directory

**Total: 144 tests passing**

---

## Post-MVP Enhancements (P2-P5)

### P2 - Polish

- 🟢 **Error handling improvements**
  - Added `isAvailable()` to TmuxExecutor for checking if tmux is installed
  - Added `killSessionSafe()` and `capturePaneSafe()` for graceful error handling
  - `orange start` checks tmux availability with clear install instructions
  - `orange task spawn` checks tmux availability before attempting spawn
  - `orange task peek` handles missing sessions gracefully
  - `orange task merge/cancel` use safe session killing
  - Dashboard attachment validates tmux availability and session existence
  - Dashboard peek/capture uses safe methods
  - All error messages are clear and actionable

- 🟢 **Performance optimizations**
  - SQLite index rebuild on demand only (auto-triggers when db missing or schema invalid)
  - Efficient file watching patterns (only watch TASK.md files, debounced 100ms)

### P3 - Extended Features

- 🟢 **Multiple orchestrator instances** (solved by Phase 11)
  - Per-project orchestrators: `<project>-orchestrator` sessions

- 🟢 **Project filtering in dashboard** (solved by Phase 11)
  - CWD-aware scoping + `--all` / `--project` flags

### P5 - Test Coverage

- 🟢 **Dashboard rendering tests** (`src/dashboard/index.test.ts`)
  - 8 tests for rendering, navigation, filtering
  - Uses MockTerminal and direct component testing

- 🟢 **Integration tests with real git repos** (`src/__tests__/integration.test.ts`)
  - 15 tests covering git operations, workspace pool, task lifecycle
  - Creates temp git repos for end-to-end testing

- 🟢 **CLI command integration tests**
  - project.test.ts: Add/list projects (16 tests)
  - task.test.ts: Create/spawn/complete/merge lifecycle (20 tests)

---

## Architecture Notes

Per specs/architecture.md:
- **Single binary**: CLI + Dashboard via pi-tui
- **Per-project orchestrator**: `<project>-orchestrator` sessions, runs in project directory
- **CWD-aware CLI**: Commands infer project from current directory
- **Session naming**: `<project>-orchestrator` for orchestrator, `<project>/<branch>` for tasks
- **Storage**: File-based (source of truth) + SQLite (derived cache)
- **Workspace pool**: Reuse worktrees, don't delete; lazy init on first spawn
- **Self-review**: Agent spawns review subagent internally (no external review orchestration)

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Single user | No multi-user | Simplicity |
| Task history | Keep forever | Audit trail |
| Storage | File + SQLite cache | Source of truth in files |
| Workspace pool | Reuse, not delete | Fast task switching |
| Merge workflow | Local + PR both supported | Flexibility |
| Self-review | Agent-internal | Agent keeps context |
| Session naming | `project-orchestrator`, `project/branch` | Per-project isolation |
| SQLite driver | `bun:sqlite` | Bun native, better-sqlite3 not supported |
| CWD-aware | Infer project from cwd | Orchestrator needs project context |
| Lazy workspace init | Create on first spawn | Fast `orange start`, no wasted resources |

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-tui` | TUI framework |
| `bun:sqlite` | SQLite index cache (built-in) |
| `chokidar` | File watching (task folders) |
| `chalk` | Terminal colors |
| `gray-matter` | TASK.md frontmatter parsing |
| `nanoid` | Task IDs |
| `proper-lockfile` | File locking (workspace pool) |
| `bun-types` | Bun TypeScript types |

---

## Spec Alignment

| Spec | Status | Notes |
|------|--------|-------|
| `architecture.md` | 🟢 Complete | Per-project orchestrator, CWD-aware design |
| `cli.md` | 🟢 Complete | CWD-aware commands, new signatures |
| `data.md` | 🟢 Complete | projects.json, TASK.md, history.jsonl, index.db |
| `agent.md` | 🟢 Complete | Prompt generation, hook integration |
| `workspace.md` | 🟢 Complete | Lazy init deferred to future |
| `dashboard.md` | 🟢 Complete | Project scoping, --all flag |
| `testing.md` | 🟢 Complete | DI pattern, mocks, 144 tests |

---

## Known Issues

None currently. All issues have been resolved.

### Resolved Issues

1. **Stop hook jq dependency** → Fixed: Use pure bash JSON parsing with grep/cut
2. **Hardcoded path in start.ts** → Fixed: Use `process.argv[1]` for dynamic path
3. **Agent prompt "Task tool" reference** → Fixed: Use `claude --print --prompt` for review subagent

---

## Next Steps

All planned tasks complete! ✅

1. ~~**Implement Phase 11** - CWD-aware refactor~~ ✅
2. ~~Update tests for new command signatures~~ ✅
3. ~~Lazy workspace initialization~~ ✅
4. ~~End-to-end testing with real git repos~~ ✅
5. ~~Dashboard rendering tests~~ ✅
6. ~~Performance optimizations~~ ✅
7. ~~**Fix known issues** - Stop hook, hardcoded path, agent prompt~~ ✅
