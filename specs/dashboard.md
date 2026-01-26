# Dashboard TUI

TypeScript + pi-tui. Shows tasks from SQLite cache (including done/failed).

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
 Task                          Status       Activity
────────────────────────────────────────────────────────
 ● coffee/login-fix            working       2m ago
 └ Fix OAuth redirect loop on mobile
 ✗ coffee/crashed-task         dead         10m ago
 ◉ coffee/password-reset       needs_human  15m ago
 ✓ orange/dark-mode            done          1h ago
────────────────────────────────────────────────────────
 j/k:nav  Enter:attach  m:merge  x:cancel  f:filter  q:quit
```

**Columns:**
- Task: status icon + project/branch (or just branch if project-scoped)
- Status: working/needs_human/stuck/done/failed/pending/dead
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
| Enter | Attach to tmux session | Live sessions |
| l | View output log | Dead/completed tasks |
| r | Respawn agent | Dead sessions only |
| m | Merge task | Live sessions |
| x | Cancel task | Active tasks |
| d | Delete task folder | Completed tasks only |
| o | Open PR in browser | Any task |
| f | Filter by status (cycle: all → active → done) | Always |
| q | Quit dashboard | Always |

## Dead Session Detection

Dashboard periodically checks if tmux sessions still exist for active tasks. If a session died (agent crashed, tmux killed externally), the task shows:
- Icon: ✗ (failed)
- Status: "dead"
- Available actions: view log, respawn, or cancel

## Output Logging

All terminal output is captured to `~/orange/tasks/<project>/<branch>/output.log` using the `script` command. This persists after session ends.

## Polling

- File watcher on `~/orange/tasks/` for TASK.md changes
- Periodic session health check (detects dead sessions)
