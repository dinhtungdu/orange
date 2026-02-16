# Workspace

Isolated environment for a task. Two concerns:
- **Pool** — allocate, release, reuse worktrees
- **View** — terminal + sidebar HUD (primary working view)

## Pool

Git worktrees, one per active task. Naming: `<project>--<n>`.

### Initialization

**Lazy** (default): worktrees created on-demand at first spawn.
**Explicit**: `orange workspace init` pre-creates based on `pool_size`.

Each worktree: detached HEAD at `origin/<default_branch>`. Detached because git doesn't allow the same branch in multiple worktrees.

### Acquisition

1. Lock pool file
2. Find available workspace for project
3. If none and under pool_size, create new worktree
4. Mark as bound to task
5. Release lock

Throws if pool exhausted.

### Release

1. Lock pool file
2. Fail if uncommitted changes
3. Fetch, reset to `origin/<default_branch>`, clean untracked
4. Remove TASK.md symlink
5. Mark as available
6. Release lock

Release never auto-spawns. The [spawn_next hook](./workflow.md#hooks) handles that explicitly.

### Configuration

- Pool size per project (default: 2)
- Acquired on spawn, released on merge/cancel
- Reused, not deleted

## View

Primary working view. Users spend most time here — interacting with the agent's terminal while a sidebar provides live workspace context.

Entry: `w` on a task with a live session in the [task manager](./task-manager.md). `Esc` returns to the task manager.

### Architecture

```
┌────────────────────────────────────────────────────┐
│ WorkspaceViewer                                    │
│                                                    │
│  ┌─── Sidebar ────┐  ┌─── TerminalPanel ────────┐ │
│  │ Data pipeline   │  │ ghostty / fallback ANSI  │ │
│  │ (poll + watch)  │  │ tmux capture + send-keys │ │
│  └─────────────────┘  └─────────────────────────┘ │
│                                                    │
│  ┌─── FocusManager ─────────────────────────────┐  │
│  │ terminal (default) | sidebar                  │  │
│  └───────────────────────────────────────────────┘  │
│                                                    │
│  ┌─── Footer ───────────────────────────────────┐  │
│  │ keybindings per focus state                   │  │
│  └───────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

### Layout

```
┌─────────── 30% ──────────┬──────────────── 70% ─────────────────┐
│ coffee/login-fix         │ > Analyzing the OAuth redirect...     │
│ Status: working   ● live │ > I'll fix the callback URL handler   │
│ Harness: pi              │ > ...                                 │
│ PR: #123 open ✓          │                                       │
│ Commits: 3  +144 -12    │                                       │
│                          │                                       │
│ ── Files (3) ──────────  │                                       │
│  M src/auth/callback.ts  │                                       │
│  A src/auth/mobile.ts    │                                       │
│                          │                                       │
│ ── History ────────────  │                                       │
│  2m ago  status → working│                                       │
│  5m ago  spawned         │                                       │
│                          │                                       │
│ ── Task ───────────────  │                                       │
│  Fix OAuth redirect...   │                                       │
├──────────────────────────┴───────────────────────────────────────┤
│ Ctrl+\:sidebar  Ctrl+]:fullscreen                                │
└──────────────────────────────────────────────────────────────────┘
```

**Dimensions:**
- Sidebar: `floor(width * ratio)` × `height - 1` (default ratio: 0.3, range: 0.15–0.50)
- Terminal: remaining width × `height - 1`
- Footer: full width × 1
- tmux pane resized to match terminal dimensions exactly (mismatches cause wrapping artifacts)
- Sidebar resizable via H/L or ←/→ arrow keys in sidebar focus mode (5% step)

**Small terminals** (width < 80 or height < 15): hide sidebar, terminal gets full width.

### Sidebar

Read-only context HUD. Not interactive.

**Sections:**

| Section | Content |
|---------|---------|
| Header | Task name, status + session icon, harness, PR info, commit stats |
| Files | Changed files vs default branch (`M`/`A`/`D`/`R` prefix) |
| History | Recent events from history.jsonl, newest first |
| Task | First lines of TASK.md body, fills remaining height |

**Data pipeline:**

| Data | Source | Refresh |
|------|--------|---------|
| Status, harness, task body | TASK.md | File watcher (immediate) |
| History events | history.jsonl | File watcher (immediate) |
| Session alive | tmux.sessionExists() | Poll 10s |
| PR info | github.getPRStatus() | Poll 30s |
| Commits, diff stats, changed files | git commands in workspace dir | Poll 10s |

File watcher: chokidar, 100ms debounce. On watcher failure, falls back to 10s polling.

Git commands run in the task's workspace directory. If workspace unavailable, git sections show `(unavailable)`.

PR polling failure (rate limit, auth): increase interval to 60s, show stale data.

### Terminal Panel

Full agent terminal connected to the task's tmux session.

**Rendering backends:**
- **ghostty-opentui** (primary, optional dep): native VT emulator, full SGR support (16/256/RGB colors, all text attributes)
- **Fallback ANSI parser**: basic SGR handling when ghostty unavailable

Both consume `tmux capture-pane -e` output — a rendered screen dump where tmux has already processed all VT sequences.

Cursor position from `tmux display -p`, rendered as highlight overlay.

**Capture loop:**
1. `tmux capture-pane -e` for screen content
2. Query cursor position
3. Update terminal renderable
4. Schedule next poll

**Adaptive polling:**

| State | Interval | Trigger |
|-------|----------|---------|
| Active | 50ms | User typed within last 2s |
| Idle | 500ms | No recent input |
| Post-keystroke | 20ms | Immediate after sending key |

**Resize:** Debounce 100ms, then resize tmux pane → update terminal dimensions → immediate capture.

**Session death:** 3 consecutive capture failures → show `[Session ended]`, mark session crashed. Keys stop forwarding. User presses Esc to return.

### Focus Modes

Two states: **terminal** (default on entry) and **sidebar**.

Focus switching works regardless of session state — can switch to sidebar to read context even when session is dead.

**Terminal focused** — all keys forwarded to tmux via `send-keys`:

| Intercepted key | Action |
|-----------------|--------|
| Ctrl+\\ | Switch focus to sidebar |
| Ctrl+] | Full-screen tmux attach (exits dashboard) |

Key mapping for send-keys:

| Input | tmux key |
|-------|----------|
| Printable chars | `send-keys -l` (literal) |
| Enter, Tab, Escape, Space | Named keys |
| Backspace | `BSpace` |
| Arrow keys | `Up`/`Down`/`Left`/`Right` |
| Ctrl+A..Z | `C-{letter}` |
| Home/End, PgUp/PgDn | Named keys |
| F1–F12 | Named keys |

Unmapped keys (Shift+arrows, Alt combos, mouse): dropped silently. `Ctrl+]` full-screen attach is the escape hatch for anything that doesn't work through send-keys.

**Sidebar focused** — keys not forwarded to tmux:

| Key | Action |
|-----|--------|
| Tab / Enter | Return focus to terminal |
| H / ← | Shrink sidebar (−5%) |
| L / → | Grow sidebar (+5%) |
| Esc | Exit to task manager |

**Footer:**

| Focus | Footer |
|-------|--------|
| Terminal | `Ctrl+\:sidebar  Ctrl+]:fullscreen` |
| Sidebar | `H/L:resize  Ctrl+\:terminal  Esc:dashboard` |

### Integration

**Entry:** `w` key in task manager when task has live session → switch to workspace mode.

**Exit:** Esc from sidebar → switch back to task manager, refresh task list.

**Mode switching:** Dashboard renders one module at a time. opentui switches root container.

**Polling coordination:** Task manager polling (health checks, PR sync) continues while workspace view is active. Workspace view runs its own sidebar + terminal polls independently.

### Lifecycle

**Enter:** Create renderables → calculate dimensions → start sidebar polls/watchers → connect terminal capture loop → set focus to terminal.

**Active:** Terminal poll (adaptive) + sidebar poll (10s) + sidebar file watcher (immediate). opentui batches renders at its fixed FPS.

**Exit:** Stop terminal capture → stop sidebar watchers/polls → hide container → callback to task manager.

**Full-screen attach (Ctrl+]):** Destroy viewer → destroy renderer → exec `tmux attach`. Exits dashboard entirely — escape hatch for interactions that don't work through send-keys.

### Error Handling

| Error | Behavior |
|-------|----------|
| tmux capture fails once | Retry next poll, increment failure count |
| 3 consecutive capture failures | `[Session ended]`, mark crashed |
| git commands fail | Sidebar shows stale data or `(unavailable)` |
| File watcher error | Fall back to 10s polling |
| ghostty import fails | Use fallback ANSI parser |
| Terminal too small | Hide sidebar, full-width terminal |
| PR polling fails | Increase interval to 60s |
