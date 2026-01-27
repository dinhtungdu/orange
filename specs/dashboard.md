# Dashboard TUI

TypeScript + pi-tui. Shows tasks from TASK.md files (including done/failed).

## Scoping

Dashboard can run in two modes:

1. **Project-scoped** (default when in a project directory):
   ```bash
   cd ~/workspace/coffee
   orange      # Shows only coffee tasks
   ```

2. **Global** (when not in project, or with `--all`):
   ```bash
   cd ~
   orange      # Shows all tasks
   orange --all  # Explicit global view
   ```

## Layout

Table format with columns:

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
| ● | working - agent active |
| ◉ | needs_human - ready for review |
| ⚠ | stuck - agent needs help |
| ○ | pending - waiting to spawn |
| ✓ | done - merged |
| ✗ | failed/dead - cancelled/errored/session died |

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
| l | View output log | Dead/completed tasks |
| r | Respawn agent | Dead sessions only |
| m | Merge task | Live sessions |
| x | Cancel task | Active tasks |
| d | Delete task folder | Completed tasks only |
| o | Open PR in browser | Any task |
| f | Filter by status (cycle: all → active → done) | Always |
| q | Quit dashboard | Always |

**Attach behavior:**
- Inside tmux: uses `switch-client` (switches current client to task session)
- Outside tmux: uses `attach` (attaches to task session)

To return from task session, use tmux session switcher (prefix + s) or similar.

## Dead Session Detection

Dashboard checks for dead sessions immediately on startup, then periodically. If a session died (agent crashed, tmux killed externally), the task shows:
- Icon: ✗ (failed)
- Status: "dead"
- Available actions: view log, respawn, or cancel

## Output Logging

All terminal output is captured to `~/orange/tasks/<project>/<branch>/output.log` using the `script` command. This persists after session ends.

## Polling

- File watcher on `~/orange/tasks/` for TASK.md changes
- Periodic session health check (detects dead sessions)
