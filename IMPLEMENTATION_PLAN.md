# Orange Implementation Plan

## Status: Phase 1-9 Complete - MVP Ready

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
  - TmuxExecutor interface: newSession, killSession, listSessions, sessionExists, capturePane, sendKeys
  - RealTmux class implementing TmuxExecutor
  - MockTmux class for testing

- 🟢 **Git abstraction** (`src/core/git.ts`)
  - GitExecutor interface: fetch, checkout, resetHard, createBranch, deleteBranch, merge, currentBranch, clean, addWorktree, removeWorktree
  - RealGit class implementing GitExecutor
  - MockGit class for testing

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
  - `orange task cancel <task_id>` - Cancel task, release workspace, kill session

- 🟢 **Orchestrator skill** (`skills/orchestrator.md`)
  - Created skill file per specs/cli.md
  - `orange install` command to copy to ~/.claude/skills/orange/

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

**Total: 51 tests passing**

---

## Post-MVP Enhancements (P2-P5)

### P2 - Polish

- 🔴 **Error handling improvements**
  - Graceful degradation when tmux not available
  - Clear error messages for common failures

- 🔴 **Performance optimizations**
  - SQLite index rebuild on demand only
  - Efficient file watching patterns

### P3 - Extended Features

- 🔴 **Multiple orchestrator instances**
  - Support multiple independent orchestrator sessions

- 🔴 **Task filtering in dashboard**
  - Filter by project
  - Filter by status

### P5 - Test Coverage

- 🔴 **Dashboard rendering tests**
  - Use VirtualTerminal from pi-tui

- 🔴 **Integration tests with real git repos**
  - Create temp repos for end-to-end testing

- 🔴 **CLI command integration tests**
  - project.test.ts: Add/list projects
  - task.test.ts: Create/spawn/complete/merge lifecycle

---

## Architecture Notes

Per specs/architecture.md:
- **Single binary**: CLI + Dashboard via pi-tui
- **Session naming**: `orange-orchestrator` for main, `<project>/<branch>` for tasks
- **Storage**: File-based (source of truth) + SQLite (derived cache)
- **Workspace pool**: Reuse worktrees, don't delete
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
| Session naming | `project/branch` | Easy identification |
| SQLite driver | `bun:sqlite` | Bun native, better-sqlite3 not supported |

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
| `architecture.md` | 🟢 Complete | Full implementation done |
| `cli.md` | 🟢 Complete | All commands implemented |
| `data.md` | 🟢 Complete | projects.json, TASK.md, history.jsonl, index.db |
| `agent.md` | 🟢 Complete | Prompt generation, hook integration |
| `workspace.md` | 🟢 Complete | Pool management with locking |
| `dashboard.md` | 🟢 Complete | pi-tui implementation |
| `testing.md` | 🟢 Complete | DI pattern, mocks, 51 tests |

---

## Known Issues

None currently.

---

## Next Steps

1. End-to-end testing with real tmux/git
2. Add more comprehensive CLI command tests
3. Consider adding hook support for agent completion detection
