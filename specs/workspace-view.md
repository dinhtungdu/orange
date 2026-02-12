# Workspace View

Deep-dive view for a single task. Left sidebar shows workspace context, right panel shows the agent's terminal session.

Entry: press `w` on a selected task from the main dashboard. Only available when the task has a live tmux session. Back: `Esc` returns to dashboard.

## Layout

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
│ Tab:terminal  Esc:dashboard                                      │
└──────────────────────────────────────────────────────────────────┘
```

## Sidebar (30%)

Read-only context panel for the selected task's workspace. Not interactive — no scrolling or selection within the sidebar.

### Sections

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

### Auto-refresh

Sidebar refreshes on:
- File watcher detects TASK.md changes
- Poll cycle (30s): session health, git stats, PR status
- Immediate refresh after terminal interaction (keystroke → poll)

## Terminal Panel (70%)

Full agent terminal using the existing terminal viewer component. Connects to the task's `tmux_session`.

### Behavior

- Connects on entry, disconnects on exit
- Resizes tmux pane to fit panel dimensions
- ANSI colors preserved
- Adaptive polling (fast during input, slow during inactivity)

### Empty states

- Dead session: `[Session dead — Esc to dashboard, respawn from task list]`
- Session dies while viewing: terminal shows `[Session ended]`, sidebar updates icon to ✗

## Focus Modes

Two focus states: **sidebar** (default) and **terminal**.

### Sidebar focused (default on entry)

Terminal panel is visible and polling, but keys are not forwarded.

| Key | Action |
|-----|--------|
| Tab, Enter | Switch focus to terminal |
| Esc | Exit workspace view, return to dashboard |

### Terminal focused

All keys forwarded to the tmux session.

| Key | Action |
|-----|--------|
| Ctrl+\\ | Return focus to sidebar |
| Ctrl+] | Full-screen tmux attach (exit dashboard) |
| All other keys | Forwarded to tmux session |

## Footer

| Focus | Footer |
|-------|--------|
| Sidebar | `Tab:terminal  Esc:dashboard` |
| Terminal | `Ctrl+\:sidebar  Ctrl+]:fullscreen` |

## State

```
workspaceMode:
  active: boolean
  focus: "sidebar" | "terminal"
  task: Task              # the task being viewed
  changedFiles: string[]  # git diff file list
  history: HistoryEntry[] # recent history events
```

### Transitions

```
Dashboard ──w──> Workspace view (sidebar focus)
                    │
         Esc ◄──────┤
                    │
         Tab/Enter ─┼──> Terminal focus
                    │         │
         Ctrl+\ ◄───┼─────────┘
                    │
         Ctrl+] ────┼──> Full-screen attach (exit dashboard)
```
