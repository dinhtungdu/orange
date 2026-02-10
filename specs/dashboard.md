# Dashboard TUI

Shows tasks from TASK.md files (including done/cancelled).

## Scoping

1. **Project-scoped** (default when in a project directory)
2. **Global** (when not in project, or with `--all`)

## Two Types of Status

The dashboard tracks two independent concepts:

1. **Session Status** (icon before task name): Is the agent running?
2. **Task Status** (Status column): Where is the task in the workflow?

### Session Status (Icon)

| Icon | State | Meaning |
|------|-------|---------|
| ● | active | tmux session alive, agent running |
| ✗ | crashed | tmux session died unexpectedly |
| ○ | inactive | no session (pending, finished, or cancelled) |

Colors: ● green, ✗ red, ○ gray

### Task Status (Column)

| Status | Meaning |
|--------|---------|
| pending | waiting to spawn |
| clarification | agent waiting for user input |
| working | agent assigned and should be running |
| agent-review | review agent evaluating work |
| reviewing | agent review passed, awaiting human review/merge |
| stuck | agent needs help |
| done | merged/completed |
| cancelled | user cancelled or errored |

**Clarification tasks** need attention — agent has questions or is waiting for requirements. Attach to session to discuss with agent.

When a task has a PR, the Status column shows PR info instead (e.g., `#123 open ✓`).

## Sorting

Tasks sorted by:
1. **Active first** — pending, clarification, working, reviewing, stuck
2. **Terminal last** — done, cancelled
3. **Within groups** — by `updated_at` descending (most recent first)

## Layout

```
 Orange Dashboard (all) [active]
 Task                          Status      PR             Commits  Changes   Activity
───────────────────────────────────────────────────────────────────────────────────────
 ● [1] coffee/login-fix        working                    3        +144 -12  2m ago
 └ Fix OAuth redirect loop on mobile
 ✗ [2] coffee/crashed-task     working                                       10m ago
 ○ coffee/password-reset       reviewing   #123 open ✓   7        +89 -34   15m ago
 ○ orange/dark-mode            done        #456 merged                       1h ago
───────────────────────────────────────────────────────────────────────────────────────
 j/k:nav  Enter:attach  m:merge  x:cancel  f:filter  q:quit
```

**Columns:**
- Task: session icon + workspace number (if assigned) + project/branch (or just branch if project-scoped)
- Status: task stage (pending/working/reviewing/stuck/done/cancelled)
- PR: PR number + state + checks (blank if no PR)
- Commits: number of commits ahead of default branch (blank if none)
- Changes: lines added/removed vs default branch (green +N, red -N; blank if none)
- Activity: relative time since last update (2m ago, 3h ago)

**Selected row** shows summary underneath.

## Context-Aware Keybindings

Footer shows relevant actions based on selected task's state:

| Task State | Available Keys |
|------------|----------------|
| No task selected | j/k:nav  c:create  f:filter  q:quit |
| Pending | j/k:nav  v:view  Enter:spawn  x:cancel  c:create  f:filter  q:quit |
| Clarification | j/k:nav  v:view  Enter:attach  x:cancel  c:create  f:filter  q:quit |
| Working | j/k:nav  v:view  Enter:attach  x:cancel  c:create  f:filter  q:quit |
| Agent-review | j/k:nav  v:view  Enter:attach  x:cancel  c:create  f:filter  q:quit |
| Reviewing (no PR) | j/k:nav  v:view  Enter:attach  m:merge  p:create PR  x:cancel  c:create  f:filter  q:quit |
| Reviewing (with PR) | j/k:nav  v:view  Enter:attach  p:open PR  x:cancel  c:create  f:filter  q:quit |
| Stuck | j/k:nav  v:view  Enter:attach  x:cancel  c:create  f:filter  q:quit |
| Dead/no session | j/k:nav  v:view  Enter:respawn  x:cancel  c:create  f:filter  q:quit |
| Cancelled | j/k:nav  v:view  d:del  c:create  f:filter  q:quit |
| Done | j/k:nav  v:view  d:del  c:create  f:filter  q:quit |

### Key Actions

| Key | Action | When |
|-----|--------|------|
| j/k | Navigate tasks | Always |
| v | View TASK.md content (scroll with j/k, Esc to close) | Any task selected |
| y | Copy task ID to clipboard | Any task selected |
| c | Create new task | Always (project-scoped only) |
| Enter | Work on task | Context-dependent (see below) |
| R | Refresh PR status | Any task (checks GitHub for PR) |
| m | Merge task | Reviewing tasks (no PR); force confirm from other active statuses |
| p | Create PR / Open PR in browser | Reviewing (no PR) creates, any with PR opens |
| x | Cancel task (shows confirmation) | Active tasks |
| d | Delete task folder (shows confirmation) | Cancelled or done tasks |
| f | Filter by status (cycle: all → active → done) | Always |
| q | Quit dashboard | Always |

**Enter behavior:**
- Pending → spawn agent
- Has live session → attach
  - If `--exit-on-attach`, dashboard exits after attach
- Dead/no session → respawn agent
- Cancelled/Done → no-op

## Create Task

Press `c` to create a new task inline. Only available when the dashboard is project-scoped (single project view). In global/all-projects view, `c` shows an error message.

### Flow

1. Press `c` — dashboard enters **create mode**
2. Inline form appears below the task list:
   ```
   ──────────────────────────────────────────────────────────────────────────────
    Create Task
    Branch:      [█] (auto)
    Summary:     [ ] (optional)
    Harness:     [pi ◀]
    Status:      [pending ◀]
    Enter:submit  Escape:cancel
   ```
3. `Tab` cycles through branch → summary → harness → status fields
4. Harness field: any key cycles through installed harnesses (pi → opencode → claude → codex)
5. Status field: any key toggles between `pending` and `reviewing`
6. `Enter` submits the form → creates task + auto-spawns agent
7. `Escape` cancels and returns to task list

### Behavior

- **All fields are optional** — press `c` then `Enter` to create immediately
- Empty branch: auto-generates from task ID (e.g., `orange-tasks/abc123`)
- Empty summary: spawns in `clarification` status (agent asks what to work on)
- Harness defaults to first installed (pi → opencode → claude → codex)
- Status defaults to `pending`; set to `reviewing` for existing work (skips agent spawn)
- Errors if an orange task already exists for the branch
- Auto-spawns agent after creation (except `reviewing` status)
- On success: shows "Created project/branch [status]" message, task appears in list
- On error: shows error message, stays in task list mode
- While in create mode, task list navigation keys (j/k/etc.) are disabled

## Session Detection

Checked immediately on startup, then periodically (30s). Compares `tmux list-sessions` against tasks with `tmux_session` set.

- Session exists → ● (active)
- Session gone + task is `working` → ✗ (crashed)
- No session expected → ○ (inactive)

## Theme

Transparent background — works with user's terminal background/wallpaper.

| Element | Color |
|---------|-------|
| Background | transparent |
| Selected row | `❯` prefix (no background — theme-agnostic) |
| Header | `#00DDFF` (cyan) |
| Separators | `#555555` (dim gray) |
| Muted text | `#888888` (gray) |
| Column headers | `#666666` (dark gray) |

Status colors defined in `state.ts` (`STATUS_COLOR`).

## Polling & Updates

**Dashboard must be open for auto-behaviors.** When closed, state remains consistent (TASK.md is source of truth) but automatic actions don't trigger.

**File watcher** (chokidar, 100ms debounce):
- Watches `~/orange/tasks/` for `TASK.md` changes
- Triggers immediate refresh on file change
- Status updates via `orange task update --status` are detected automatically

**Agent review auto-trigger:**
- On refresh, detect tasks that just entered `agent-review` status
- Auto-spawn review agent in same tmux session (new named window)
- Track previous status to avoid re-triggering on subsequent refreshes

**Health check** (30s interval):
- Single `tmux list-sessions` call (not N `has-session` calls)
- Parallel capture for working tasks
- Marks dead sessions for respawn UI

**Orphan cleanup** (30s interval):
- Release workspaces bound to terminal tasks (done/cancelled)
- Kill sessions for terminal tasks that still have one
- Release workspaces from interrupted spawns (workspace bound but no tmux_session)

**PR sync** (30s interval):
- Poll status for tasks with existing pr_url
- Discover PRs for tasks with branch but no pr_url (auto-populate)
- Auto-trigger merge cleanup when PR detected as merged
- Auto-cancel task when PR detected as closed without merge

**Diff stats:**
- Refreshed on each task reload (async, non-blocking)

**Future:**
- Auto-spawn ready tasks when dependencies complete (Phase 1)
