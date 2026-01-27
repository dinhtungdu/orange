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
 ◉ coffee/password-reset       needs_human  7        +89 -34        15m ago
 ✓ orange/dark-mode            done                                  1h ago
──────────────────────────────────────────────────────────────────────────────
 j/k:nav  Enter:attach  m:merge  x:cancel  f:filter  q:quit
```

**Columns:**
- Task: status icon + project/branch (or just branch if project-scoped)
- Status: working/needs_human/stuck/done/failed/pending/dead
- Commits: number of commits ahead of default branch (blank if none)
- Changes: lines added/removed vs default branch (green +N, red -N; blank if none)
- Activity: relative time since last update (2m ago, 3h ago)

**Selected row** shows description underneath.

**Dead sessions:** Tasks with active status but no live tmux session show as "dead" with ✗ icon.

## Status Icons

| Icon | Status |
|------|--------|
| ● | working — agent active |
| ◉ | needs_human — ready for review |
| ⚠ | stuck — agent needs help |
| ○ | pending — waiting to spawn |
| ✓ | done — merged |
| ✗ | failed/dead — cancelled/errored/session died |

## Context-Aware Keybindings

Footer shows relevant actions based on selected task's state:

| Task State | Available Keys |
|------------|----------------|
| No task selected | j/k:nav  f:filter  q:quit |
| Live session (working/needs_human/stuck) | j/k:nav  Enter:attach  m:merge  x:cancel  f:filter  q:quit |
| Dead session | j/k:nav  l:log  r:respawn  x:cancel  f:filter  q:quit |
| Completed (done/failed) | j/k:nav  l:log  d:del  f:filter  q:quit |
| Pending | j/k:nav  (spawn via CLI)  f:filter  q:quit |

### Key Actions

| Key | Action | When |
|-----|--------|------|
| j/k | Navigate tasks | Always |
| Enter | Switch to tmux session | Live sessions |
| l | View conversation log | Dead/completed tasks |
| r | Respawn agent | Dead sessions only |
| m | Merge task | Live sessions |
| x | Cancel task | Active tasks |
| d | Delete task folder | Completed tasks only |
| o | Open PR in browser | Any task |
| f | Filter by status (cycle: all → active → done) | Always |
| q | Quit dashboard | Always |

**Attach behavior:**
- Inside tmux: uses `switch-client`
- Outside tmux: uses `attach`

## Dead Session Detection

Checked immediately on startup, then periodically. If session died, task shows as "dead" with ✗ icon. Available actions: view log, respawn, or cancel.

## Polling

- File watcher on `~/orange/tasks/` for TASK.md changes (debounced)
- Periodic session health check (detects dead sessions)
- Diff stats refreshed on each task reload (async, non-blocking)
