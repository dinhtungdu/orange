# Workspace

Isolated environment for a task: code, agent session, and a view to interact with it. Currently backed by git worktrees; will support containers later.

Two concerns:
- **Pool** — allocate, release, reuse workspaces
- **View** — terminal + sidebar HUD (primary working view in the dashboard)

## Pool

### Initialization

**Explicit:** `orange workspace init` creates worktrees based on `pool_size`.

**Lazy (automatic):** Worktrees created on-demand when spawning if none available.

Each workspace is a git worktree created with detached HEAD at `origin/<default_branch>`. Detached because git doesn't allow the same branch checked out in multiple worktrees.

Harness-specific setup happens at spawn time (not worktree creation) based on task's harness. See [harness.md](./harness.md) for details.

### Pool State

```
~/orange/workspaces/
├── orange--1/           # bound to: orange/dark-mode
├── orange--2/           # available
├── coffee--1/           # bound to: coffee/login-fix
└── .pool.json
```

`.pool.json`:
```json
{
  "workspaces": {
    "orange--1": {"status": "bound", "task": "orange/dark-mode"},
    "orange--2": {"status": "available"},
    "coffee--1": {"status": "bound", "task": "coffee/login-fix"}
  }
}
```

### Acquisition

1. Lock pool file
2. Find first available workspace for project
3. If none available and under pool_size, create new worktree
4. Mark as bound
5. Release lock

Throws if pool exhausted.

### Release

1. Lock pool file
2. Fail if workspace has uncommitted changes
3. Fetch latest, reset to `origin/<default_branch>`, clean untracked files
4. Remove `TASK.md` symlink (excluded from git, so `git clean` doesn't remove it)
5. Mark as available
6. Release lock
7. Auto-spawn next pending task for the project (FIFO)

### Pool Notes

- Pool size per project (default: 2)
- Acquired on spawn, released on merge/cancel
- **Reused, not deleted** — branch reset on release
- File lock prevents race conditions
- Naming convention: `<project>--<number>`

### tmux Abstraction

Interface for session management:
- `newSession(name, cwd, command)` — create detached session
- `killSession(name)` — destroy session
- `sessionExists(name)` — check if alive
- `capturePane(session, lines)` — capture terminal output
- `isAvailable()` — check if tmux is installed

Session naming: `<project>/<branch>`

Mock implementation for testing (no real tmux needed).

## View

Primary working view for a task. Users spend most of their time here — interacting with the agent's terminal while a persistent sidebar provides live workspace context.

Implementation details: [viewer.md](./viewer.md) (terminal rendering, sidebar data pipeline, input handling, component structure).

Entry: press `w` on a selected task from the [Task Manager](./dashboard.md). Only available when the task has a live tmux session. `Esc` returns to the task manager.

### Layout

```
┌─────────── 30% ──────────┬──────────────── 70% ─────────────────┐
│ coffee/login-fix         │ Session: coffee/login-fix             │
│ Status: working   ● live │                                       │
│ Harness: pi              │ > Analyzing the OAuth redirect...     │
│ PR: #123 open ✓          │ > I'll fix the callback URL handler   │
│ Commits: 3  +144 -12    │ > ...                                 │
│                          │                                       │
│ ── Files (3) ──────────  │                                       │
│  M src/auth/callback.ts  │                                       │
│  M src/auth/oauth.ts     │                                       │
│  A src/auth/mobile.ts    │                                       │
│                          │                                       │
│ ── History ────────────  │                                       │
│  2m ago  status → working│                                       │
│  5m ago  spawned (pi)    │                                       │
│                          │                                       │
│ ── Task ───────────────  │                                       │
│  Fix OAuth redirect loop │                                       │
│  on mobile Safari...     │                                       │
├──────────────────────────┴───────────────────────────────────────┤
│ Ctrl+\:sidebar  Ctrl+]:fullscreen                                │
└──────────────────────────────────────────────────────────────────┘
```

### Sidebar (30%)

Persistent context HUD for the task's workspace. Always visible while working in the terminal — this ambient awareness is the key advantage over raw tmux. Read-only, not interactive — no scrolling or selection within the sidebar.

#### Sections

**Header**
- Task name: `project/branch`
- Status + session state: `Status: working   ● live` / `Status: working   ✗ dead`
- Harness: `Harness: pi`
- PR: `PR: #123 open ✓` or `PR: none` (blank if no PR)
- Stats: `Commits: 3  +144 -12`

**Files**
- Section header: `── Files (N) ──`
- List of changed files vs default branch (git diff --name-status)
- Prefix: `M` modified, `A` added, `D` deleted, `R` renamed
- Truncated to fit sidebar width
- If no changes: `(no changes)`
- Max ~10 files shown, `+N more` if truncated

**History**
- Section header: `── History ──`
- Recent events from `history.jsonl`, newest first
- Format: `{relative time}  {event description}`
- Events: spawned, status changes, review outcomes, PR created, crashes
- Max ~5 entries shown

**Task**
- Section header: `── Task ──`
- Task body from TASK.md (first ~10 lines, truncated)
- If no body: `(no description)`

#### Auto-refresh

Since this is the primary view, sidebar data must stay fresh:
- File watcher detects TASK.md changes
- Poll cycle (10s): session health, git stats, PR status
- Immediate refresh after terminal interaction (keystroke → poll)

### Terminal Panel (70%)

Full agent terminal using the existing terminal viewer component. Connects to the task's `tmux_session`.

#### Behavior

- Connects on entry, disconnects on exit
- Resizes tmux pane to fit panel dimensions
- ANSI colors preserved
- Adaptive polling (fast during input, slow during inactivity)

#### Empty states

- Dead session: `[Session dead — Esc to dashboard, respawn from task list]`
- Session dies while viewing: terminal shows `[Session ended]`, sidebar updates icon to ✗

### Focus Modes

Two focus states: **terminal** (default) and **sidebar**.

#### Terminal focused (default on entry)

All keys forwarded to the tmux session. This is where users spend most of their time.

| Key | Action |
|-----|--------|
| Ctrl+\\ | Switch focus to sidebar |
| Ctrl+] | Full-screen tmux attach (escape hatch, exits dashboard) |
| All other keys | Forwarded to tmux session |

#### Sidebar focused

Terminal panel is visible and polling, but keys are not forwarded. Used to read context or exit.

| Key | Action |
|-----|--------|
| Tab, Enter | Return focus to terminal |
| Esc | Exit workspace view, return to task manager |

### Footer

| Focus | Footer |
|-------|--------|
| Terminal | `Ctrl+\:sidebar  Ctrl+]:fullscreen` |
| Sidebar | `Tab:terminal  Esc:dashboard` |

### View State

```
workspaceMode:
  active: boolean
  focus: "terminal" | "sidebar"
  task: Task              # the task being viewed
  changedFiles: string[]  # git diff file list
  history: HistoryEntry[] # recent history events
```

#### Transitions

```
Task Manager ──w──> Workspace view (terminal focus)
                    │
         Ctrl+\ ────┼──> Sidebar focus
                    │         │
         Tab/Enter ◄─┼─────────┘
                    │         │
         Esc ◄───────┼─────────┘  (exit to task manager)
                    │
         Ctrl+] ────┼──> Full-screen attach (exit dashboard)
```
