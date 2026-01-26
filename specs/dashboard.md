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
 ◉ coffee/password-reset       needs_human  15m ago
 ✓ orange/dark-mode            done          1h ago
 ✗ orange/broken-feature       failed        2h ago
────────────────────────────────────────────────────────
 j/k:nav  Enter:attach  l:log  m:merge  x:cancel  d:del  f:filter  q:quit
```

**Columns:**
- Task: status icon + project/branch (or just branch if project-scoped)
- Status: working/needs_human/stuck/done/failed/pending
- Activity: relative time since last update (2m ago, 3h ago)

**Selected row** shows description underneath.

## Status Icons

| Icon | Status |
|------|--------|
| ● | working - agent active |
| ◉ | needs_human - ready for review |
| ⚠ | stuck - agent needs help |
| ○ | pending - waiting to spawn |
| ✓ | done - merged |
| ✗ | failed - cancelled/errored |

## Keybindings

| Key | Action |
|-----|--------|
| j/k | Navigate tasks |
| Enter | Attach to task's tmux session |
| l | View output log (works for any task with log) |
| m | Merge task (local merge + cleanup) |
| x | Cancel task (cleanup) |
| d | Delete task (only done/failed) |
| o | Open PR in browser |
| f | Filter by status (cycle: all → active → done) |
| q | Quit dashboard |

## Session Handling

- **Active tasks** (working/needs_human/stuck): Have live tmux session
  - `Enter` attaches to session
  - If session died unexpectedly, error suggests using `l` to view log

- **Completed tasks** (done/failed): Session killed
  - `l` views output.log captured during session
  - `d` deletes task folder

## Output Logging

All terminal output is captured to `~/orange/tasks/<project>/<branch>/output.log` using the `script` command. This persists after session ends.

## Polling

- File watcher on `~/orange/tasks/` for TASK.md changes
- Periodic refresh of task list from SQLite
