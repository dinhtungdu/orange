# Task Manager

Task list and management dashboard. The other module is [Workspace](./workspace.md#view).

Statuses and session states defined in [data.md](./data.md).

## Scoping

- **Project-scoped** (default): run `orange` from a project directory
- **Global**: `orange --all` or from outside any project

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
- **Task**: session icon + workspace number (if bound) + project/branch
- **Status**: workflow status (or PR info when PR exists)
- **PR**: number + state + checks
- **Commits**: ahead of default branch
- **Changes**: lines added/removed
- **Activity**: relative time since last update

Selected row shows summary underneath.

## Sorting

1. Active first (pending, planning, clarification, working, agent-review, reviewing, stuck)
2. Terminal last (done, cancelled)
3. Within groups: most recently updated first

## Keybindings

Context-aware footer shows available actions for the selected task.

| Key | Action | When |
|-----|--------|------|
| j/k | Navigate | Always |
| v | View TASK.md (scroll j/k, Esc close) | Any task |
| y | Copy task ID | Any task |
| c | Create task | Project-scoped only |
| Enter | Spawn / attach / respawn | Context-dependent |
| w | Open workspace view | Task has live session |
| r | Request changes (optional instructions) | `reviewing` → spawns fix agent |
| m | Merge | `reviewing` (force confirm from other active) |
| p | Create or open PR | `reviewing` creates; any with PR opens in browser |
| x | Cancel (with confirmation) | Active tasks |
| d | Delete task folder (with confirmation) | done / cancelled |
| R | Refresh PR status | Any task with PR |
| f | Filter (cycle: all → active → done) | Always |
| q | Quit | Always |

**Enter behavior:**
- `pending` → spawn agent
- live session → attach to tmux
- crashed / no session → respawn agent
- done / cancelled → no-op

**Merge gate:**
- From `reviewing` → normal merge
- From other active status → force confirm: "Not reviewed. Force merge?"

## Create Task

Press `c` in project-scoped view. Inline form:

```
Create Task
Branch:    [█] (auto)
Summary:   [ ] (optional)
Harness:   [pi ◀]
Status:    [pending ◀]
Enter:submit  Escape:cancel
```

- Tab cycles fields, all optional
- Empty branch → auto-generated from task ID
- Empty summary → spawns in `clarification`
- Harness: any key cycles installed harnesses
- Status: toggles pending / reviewing
- Errors if branch already has an orange task

## Polling

Dashboard must be open for auto-behaviors. State stays consistent when closed (TASK.md source of truth) but automation doesn't trigger.

| Concern | Method | Interval |
|---------|--------|----------|
| Task changes | File watcher (chokidar, 100ms debounce) | Immediate |
| Session health | `tmux list-sessions` | 30s |
| Orphan cleanup | Release workspaces for terminal tasks | 30s |
| PR sync | Poll status, detect merges/closes | 30s |
| Diff stats | Async on task reload | On change |

**Orphan cleanup:** Release workspaces still bound to done/cancelled tasks. Kill sessions for terminal tasks that still have one.

**PR sync:** Auto-detect merged PRs → trigger cleanup. Auto-cancel on PR closed without merge.

**Exit monitoring:** Session health check feeds into the [workflow exit monitoring](./workflow.md#exit-monitoring) for auto-advance decisions.

## Theme

Transparent background — works with any terminal theme.
