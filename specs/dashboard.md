# Dashboard TUI

Shows tasks from TASK.md files (including done/failed).

## Scoping

1. **Project-scoped** (default when in a project directory)
2. **Global** (when not in project, or with `--all`)

## Layout

```
 Orange Dashboard (all) [active]
 Task                          Status       Commits  Changes        Activity
──────────────────────────────────────────────────────────────────────────────
 ● coffee/login-fix            working      3        +144 -12        2m ago
 └ Fix OAuth redirect loop on mobile
 ✗ coffee/crashed-task         dead                                 10m ago
 ◉ coffee/password-reset       reviewing  7        +89 -34        15m ago
 ✓ orange/dark-mode            done                                  1h ago
──────────────────────────────────────────────────────────────────────────────
 j/k:nav  Enter:attach  m:merge  x:cancel  f:filter  q:quit
```

**Columns:**
- Task: status icon + project/branch (or just branch if project-scoped)
- Status: working/reviewing/reviewed/stuck/done/failed/cancelled/pending/dead
- Commits: number of commits ahead of default branch (blank if none)
- Changes: lines added/removed vs default branch (green +N, red -N; blank if none)
- Activity: relative time since last update (2m ago, 3h ago)

**Selected row** shows description underneath.

**Dead sessions:** Tasks with active status but no live tmux session show as "dead" with ✗ icon.

## Status Icons

| Icon | Status |
|------|--------|
| ● | working — agent active |
| ◉ | reviewing — awaiting human review |
| ◈ | reviewed — human approved |
| ⚠ | stuck — agent needs help |
| ○ | pending — waiting to spawn |
| ✓ | done — merged |
| ✗ | failed/dead — cancelled/errored/session died |

## Context-Aware Keybindings

Footer shows relevant actions based on selected task's state:

| Task State | Available Keys |
|------------|----------------|
| No task selected | j/k:nav  c:create  f:filter  q:quit |
| Pending | j/k:nav  s:spawn  x:cancel  c:create  f:filter  q:quit |
| Working | j/k:nav  Enter:attach  x:cancel  c:create  f:filter  q:quit |
| Reviewing (no PR) | j/k:nav  Enter:attach  a:approve  x:cancel  c:create  f:filter  q:quit |
| Reviewing (with PR) | j/k:nav  Enter:attach  p:open PR  x:cancel  c:create  f:filter  q:quit |
| Reviewed (no PR) | j/k:nav  Enter:attach  m:merge  p:create PR  x:cancel  c:create  f:filter  q:quit |
| Reviewed (with PR) | j/k:nav  Enter:attach  p:open PR  x:cancel  c:create  f:filter  q:quit |
| Stuck | j/k:nav  Enter:attach  r:respawn  x:cancel  c:create  f:filter  q:quit |
| Dead session | j/k:nav  r:respawn  x:cancel  c:create  f:filter  q:quit |
| Completed (done/failed/cancelled) | j/k:nav  d:del  c:create  f:filter  q:quit |

### Key Actions

| Key | Action | When |
|-----|--------|------|
| j/k | Navigate tasks | Always |
| c | Create new task | Always (project-scoped only) |
| Enter | Switch to tmux session | Live sessions |
| s | Spawn agent | Pending tasks |
| a | Approve task | Reviewing tasks (no PR) |
| u | Unapprove task | Reviewed tasks |
| r | Respawn agent | Dead sessions or stuck tasks |
| R | Refresh PR status | Any task (checks GitHub for PR) |
| m | Merge task (local) | Reviewed tasks (no PR) |
| p | Create PR / Open PR in browser | Reviewed (no PR) creates, any with PR opens |
| x | Cancel task (shows confirmation) | Active tasks |
| d | Delete task folder (shows confirmation) | Completed tasks only |
| f | Filter by status (cycle: all → active → done) | Always |
| q | Quit dashboard | Always |

**Attach behavior:**
- Inside tmux: uses `switch-client`
- Outside tmux: uses `attach`

## Create Task

Press `c` to create a new task inline. Only available when the dashboard is project-scoped (single project view). In global/all-projects view, `c` shows an error message.

### Flow

1. Press `c` — dashboard enters **create mode**
2. Inline form appears below the task list:
   ```
   ──────────────────────────────────────────────────────────────────────────────
    Create Task
    Branch:      [feature-login____________]
    Description: [Fix the OAuth redirect___]
    Status:      [pending ◀]
    Enter:submit  Escape:cancel
   ```
3. `Tab` cycles through branch → description → status fields
4. Status field: any key toggles between `pending` and `reviewing`
5. `Enter` submits the form → creates task + auto-spawns agent (if pending)
6. `Escape` cancels and returns to task list

### Behavior

- Branch and description are required (submit is no-op if either is empty)
- Status defaults to `pending`; set to `reviewing` for existing work (skips agent spawn)
- Errors if an orange task already exists for the branch
- Auto-spawns agent after creation only for `pending` status
- On success: shows "Created project/branch [status]" message, task appears in list
- On error: shows error message, stays in task list mode
- While in create mode, task list navigation keys (j/k/etc.) are disabled

## Dead Session Detection

Checked immediately on startup, then periodically. If session died, task shows as "dead" with ✗ icon. Available actions: respawn or cancel.

## Theme

Transparent background — works with user's terminal background/wallpaper.

| Element | Color |
|---------|-------|
| Background | transparent |
| Selected row | `#3a3a5a` (semi-transparent purple-gray) |
| Header | `#00DDFF` (cyan) |
| Separators | `#555555` (dim gray) |
| Muted text | `#888888` (gray) |
| Column headers | `#666666` (dark gray) |

Status colors defined in `state.ts` (`STATUS_COLOR`).

## Polling

- File watcher on `~/orange/tasks/` for TASK.md changes (debounced)
- Periodic session health check (detects dead sessions)
- Diff stats refreshed on each task reload (async, non-blocking)
