# Workspace Viewer

Implementation spec for the workspace view — the primary working surface where users interact with agent sessions. Covers terminal rendering, sidebar data pipeline, input handling, and integration with the dashboard.

Parent spec: [workspace.md](./workspace.md) (layout, UX, keybindings).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ WorkspaceViewer                                     │
│                                                     │
│  ┌──── Sidebar ─────┐  ┌──── TerminalPanel ──────┐ │
│  │ SidebarRenderer   │  │ GhosttyTerminalRenderer │ │
│  │ (TextRenderable)  │  │ (GhosttyTerminal        │ │
│  │                   │  │  Renderable, persistent) │ │
│  │ ← DataPipeline    │  │                          │ │
│  │   (poll + watch)  │  │ ← tmux capture loop      │ │
│  │                   │  │ → tmux send-keys          │ │
│  └───────────────────┘  └──────────────────────────┘ │
│                                                     │
│  ┌──── FocusManager ────────────────────────────┐   │
│  │ terminal | sidebar                           │   │
│  │ routes keyboard input to active panel        │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Terminal Rendering

### Why ghostty-opentui

The existing `TerminalViewer` (in `terminal.ts`) uses `tmux capture-pane -e` → custom ANSI parser → `TextRenderable`. This approach has fundamental limits:

- **No cursor movement** — capture-pane gives final screen state, but ANSI parser doesn't handle cursor positioning sequences (CSI H, CSI A/B/C/D)
- **No scrolling regions** — agents use tools that set scroll regions, insert/delete lines
- **No alternate screen** — vim, less, fzf switch to alternate screen buffer
- **Lossy rendering** — the custom parser handles SGR (colors/styles) but drops everything else

ghostty-opentui solves all of this. It's a full VT emulator (Ghostty's Zig parser compiled to native addon) that processes all escape sequences and outputs rendered cells.

### Component: GhosttyTerminalRenderable

From `ghostty-opentui/terminal-buffer`:

```typescript
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";

// Register with opentui (if using composition API)
// Or instantiate directly:
const terminal = new GhosttyTerminalRenderable(renderContext, {
  cols: 120,
  rows: 40,
  persistent: true,    // maintain state across feed() calls
  showCursor: true,
  cursorStyle: "block",
});
```

**Persistent mode** is critical. Instead of re-parsing the full capture buffer each poll, we `feed()` only new data. The terminal maintains internal state (cursor, scroll region, colors, alternate screen) across calls.

### Capture Loop

Replace `tmux capture-pane` with raw PTY output feeding into persistent terminal.

```
tmux pipe-pane -t <session> -o "cat >> /tmp/orange-pty-<session>.fifo"
```

Wait — `pipe-pane` sends raw PTY output to a file/pipe, which is exactly what `PersistentTerminal.feed()` needs. But there's a problem: `pipe-pane` captures ongoing output, not the screen state at connection time.

**Hybrid approach:**

1. **On enter**: `tmux capture-pane -p -e -S -` (full scrollback with ANSI) → feed as initial state
2. **Ongoing**: poll with `tmux capture-pane -p -e` at adaptive intervals → diff against previous, feed delta

Actually, simpler: just use the full capture approach but feed into `GhosttyTerminalRenderable` instead of the custom ANSI parser. The ghostty component handles everything internally.

```typescript
// On each poll cycle:
const raw = await tmux.capturePaneAnsi(session, scrollbackLines);
terminal.ansi = raw;  // GhosttyTerminalRenderable re-parses
```

This is stateless (no persistent mode needed) but uses ghostty's full VT emulator for rendering. Simple, correct, no delta tracking.

**Persistent mode optimization** (Phase 2): For reduced CPU on long-running sessions, switch to `PersistentTerminal` with incremental `feed()`. Requires tracking a byte offset or using `pipe-pane`. Not needed for v1 — the stateless approach is fast enough (ghostty processes ~100MB/s).

### Resize

When the viewer panel resizes:

```typescript
// 1. Update ghostty component dimensions
terminal.cols = newCols;
terminal.rows = newRows;

// 2. Resize tmux pane to match
await tmux.resizePane(session, newCols, newRows);

// 3. Trigger immediate capture (tmux redraws after resize)
await poll();
```

The tmux pane must match the viewer dimensions exactly. Mismatched sizes cause wrapping artifacts, misaligned cursor, and broken full-screen apps.

### Adaptive Polling

Same strategy as existing `TerminalViewer`, applied to ghostty:

| State | Interval | Trigger |
|-------|----------|---------|
| Active input | 50ms | User typed within last 2s |
| Idle | 200ms | No input for 2–10s |
| Background | 500ms | No input for 10s+ |
| Post-keystroke | 20ms | Immediate after sending key to tmux |

Timer resets on every keystroke. This gives snappy feel during interaction without burning CPU when idle.

### Cursor

`GhosttyTerminalRenderable` handles cursor rendering when `showCursor: true`:

- Block cursor (default): inverts fg/bg at cursor position
- Underline cursor: adds underline attribute

Cursor position comes from ghostty's VT emulator — it tracks CSI cursor movement sequences correctly, unlike the capture-pane approach which requires a separate `tmux display -p` query.

### Fallback

If `ghostty-opentui` is not installed (it's an optional dep), fall back to the existing `TerminalViewer` with custom ANSI parser. The workspace view still works, just with degraded rendering (no cursor movement, no alternate screen).

```typescript
let TerminalComponent: typeof GhosttyTerminalRenderable | null = null;
try {
  const mod = await import("ghostty-opentui/terminal-buffer");
  TerminalComponent = mod.GhosttyTerminalRenderable;
} catch {
  // Fall back to existing TextRenderable + ansi-parser
}
```

## Sidebar

Read-only context HUD. Renders as a `TextRenderable` (or `TextBufferRenderable` for styled content) in the left 30% of the view.

### Data Pipeline

The sidebar aggregates data from multiple sources into a single rendered output.

```typescript
interface SidebarData {
  // Header
  taskName: string;           // "project/branch"
  status: TaskStatus;
  sessionAlive: boolean;
  harness: Harness;
  prInfo: string | null;      // "#123 open ✓" or null
  commits: number;
  linesAdded: number;
  linesRemoved: number;

  // Files
  changedFiles: FileChange[];  // { status: "M"|"A"|"D"|"R", path: string }

  // History
  recentEvents: HistoryEntry[];

  // Task
  taskBody: string;            // first ~10 lines of TASK.md body
}
```

### Data Sources

| Field | Source | Refresh |
|-------|--------|---------|
| `taskName`, `status`, `harness` | TASK.md frontmatter | File watcher (immediate) |
| `sessionAlive` | `tmux.sessionExists()` | Poll (10s) |
| `prInfo` | `github.getPRStatus()` | Poll (30s) |
| `commits`, `linesAdded/Removed` | `git.getCommitCount()`, `git.getDiffStats()` | Poll (10s) |
| `changedFiles` | `git diff --name-status` | Poll (10s) |
| `recentEvents` | `history.jsonl` | File watcher (immediate) |
| `taskBody` | TASK.md body | File watcher (immediate) |

### Rendering

Sidebar builds a single styled string from `SidebarData`:

```
 coffee/login-fix
 Status: working   ● live
 Harness: pi
 PR: #123 open ✓
 Commits: 3  +144 -12

 ── Files (3) ──────────
  M src/auth/callback.ts
  M src/auth/oauth.ts
  A src/auth/mobile.ts

 ── History ────────────
  2m ago  status → working
  5m ago  spawned (pi)

 ── Task ───────────────
  Fix OAuth redirect loop
  on mobile Safari...
```

**Formatting rules:**
- Session icon: `●` green (alive), `✗` red (dead)
- Status colored per `STATUS_COLOR` map
- File status prefixes: `M` yellow, `A` green, `D` red, `R` blue
- Max 10 files, then `+N more`
- Max 5 history entries, newest first
- Task body truncated to fill remaining height
- Section headers: dim gray with `──` line fill to sidebar width

### File Watcher

Uses chokidar (already a dependency) to watch:
- `~/orange/tasks/<project>/<taskId>/TASK.md` — status, body changes
- `~/orange/tasks/<project>/<taskId>/history.jsonl` — new events

On change (100ms debounce): re-read file, update `SidebarData`, re-render.

### Git Data

New method on `GitExecutor`:

```typescript
interface GitExecutor {
  // ... existing methods ...

  /** Get list of changed files vs a base ref */
  getChangedFiles(cwd: string, base: string): Promise<FileChange[]>;
}

interface FileChange {
  status: "M" | "A" | "D" | "R";
  path: string;
}
```

Implementation: `git diff --name-status <base>...HEAD`

## Input Handling

### Focus Manager

Two focus states. The viewer tracks which panel owns keyboard input.

```typescript
type ViewerFocus = "terminal" | "sidebar";

interface FocusState {
  focus: ViewerFocus;
}
```

### Terminal Focused (default)

All keys forwarded to tmux session via `tmux.sendKeys()`.

**Intercepted keys** (not forwarded):
| Key | Action |
|-----|--------|
| `Ctrl+\` | Switch focus to sidebar |
| `Ctrl+]` | Full-screen tmux attach (exit dashboard entirely) |

**Key forwarding pipeline:**

```
User keystroke
  → opentui keypress event
  → FocusManager routes to terminal
  → Map to tmux key name
  → tmux.sendKeys(session, key)
  → Poll immediately (20ms) to show result
```

### Key Mapping

Extend the existing `sendKeyToTmux` from `terminal.ts`. Critical mappings:

| Input | tmux send-keys |
|-------|---------------|
| Printable char | literal (via `sendKeys`) |
| Enter | `Enter` |
| Backspace | `BSpace` |
| Tab | `Tab` |
| Escape | `Escape` |
| Arrow keys | `Up`, `Down`, `Left`, `Right` |
| Ctrl+C | `C-c` |
| Ctrl+D | `C-d` |
| Ctrl+Z | `C-z` |
| Ctrl+A..Z | `C-{letter}` |
| Space | `Space` |
| Home/End | `Home`, `End` |
| Page Up/Down | `PageUp`, `PageDown` |
| Delete | `DC` |
| F1–F12 | `F1`–`F12` |

### Sidebar Focused

Terminal visible but keys not forwarded. Used to read context or navigate out.

| Key | Action |
|-----|--------|
| `Tab` or `Enter` | Return focus to terminal |
| `Esc` | Exit workspace view → return to task manager |

No scrolling or selection within the sidebar — it's read-only ambient context.

### Full-Screen Attach

`Ctrl+]` exits the dashboard entirely and attaches to the raw tmux session:

```typescript
async function fullScreenAttach(session: string): Promise<void> {
  // 1. Destroy viewer, cleanup timers
  viewer.destroy();
  // 2. Destroy opentui renderer (restores terminal)
  renderer.destroy();
  // 3. Exec tmux attach (replaces process)
  await tmux.attachOrCreate(session, process.cwd());
  // 4. When user detaches (Ctrl+B D), process exits
  // Dashboard must be restarted — this is an escape hatch
}
```

This is the "I need real tmux" escape hatch. Useful for complex interactions that don't work through the key forwarding layer.

## Integration with Dashboard

### Entry Point

From `dashboard/index.ts`, when user presses `w` on a task with a live session:

```typescript
// In dashboard key handler:
case "w": {
  const task = selectedTask();
  if (!task?.tmux_session) break;
  const sessionAlive = await deps.tmux.sessionExists(task.tmux_session);
  if (!sessionAlive) break;

  await workspaceViewer.enter(task);
  dashboardMode = "workspace";  // hide task list, show viewer
  break;
}
```

### Exit

When viewer fires `onExit` (user pressed `Esc` from sidebar focus):

```typescript
workspaceViewer.onExit = () => {
  dashboardMode = "taskList";  // show task list, hide viewer
  // Refresh task list (may have changed while viewing)
  refreshTasks();
};
```

### Mode Switching

Dashboard has two rendering modes:

```typescript
type DashboardMode = "taskList" | "workspace";
```

- `taskList`: existing task manager UI (full screen)
- `workspace`: viewer takes over (sidebar + terminal, full screen)

Only one is visible at a time. The opentui layout switches between two root containers based on mode.

### Session Death While Viewing

If the tmux session dies while the workspace viewer is active:

1. Poll detects session gone
2. Terminal shows `[Session ended]`
3. Sidebar updates session icon to `✗ dead`
4. Keys no longer forwarded (nothing to forward to)
5. User presses `Esc` → returns to task manager
6. Task manager shows task as crashed, user can respawn

No auto-exit on session death — user might want to read the sidebar context.

## Component Structure

### Files

```
src/dashboard/
├── index.ts                  # Dashboard orchestrator (adds mode switching)
├── state.ts                  # Data fetching, polling, health checks
├── viewer.ts                 # WorkspaceViewer (new — main viewer component)
├── viewer-sidebar.ts         # SidebarRenderer (new — sidebar data + rendering)
├── viewer-terminal.ts        # TerminalPanel (new — ghostty wrapper + capture loop)
├── terminal.ts               # Existing TerminalViewer (becomes fallback)
└── ansi-parser.ts            # Existing ANSI parser (used by fallback)
```

### WorkspaceViewer

Top-level component that owns the layout, focus state, and child panels.

```typescript
class WorkspaceViewer {
  private sidebar: SidebarRenderer;
  private terminal: TerminalPanel;
  private focus: ViewerFocus = "terminal";
  private task: Task | null = null;
  private container: BoxRenderable;

  constructor(renderer: CliRenderer, deps: Deps) { ... }

  /** Enter viewer for a task. Sets up panels, starts data pipelines. */
  async enter(task: Task): Promise<void>;

  /** Exit viewer. Stops data pipelines, cleans up. */
  exit(): void;

  /** Handle keyboard input. Routes to active panel. */
  async handleKey(key: KeyEvent): Promise<boolean>;

  /** Handle terminal resize. */
  async resize(width: number, height: number): Promise<void>;

  /** Cleanup all resources. */
  destroy(): void;

  /** Callbacks */
  onExit?: () => void;
  onAttach?: (session: string) => void;
}
```

### SidebarRenderer

Owns data fetching and text rendering for the sidebar.

```typescript
class SidebarRenderer {
  private data: SidebarData;
  private text: TextRenderable;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(renderer: CliRenderer, deps: Deps) { ... }

  /** Start watching/polling for a task. */
  start(task: Task, width: number, height: number): void;

  /** Stop watching/polling. */
  stop(): void;

  /** Force refresh all data. */
  async refresh(): Promise<void>;

  /** Get the renderable container. */
  getContainer(): BoxRenderable;
}
```

### TerminalPanel

Wraps either `GhosttyTerminalRenderable` or fallback `TerminalViewer`.

```typescript
class TerminalPanel {
  private ghostty: GhosttyTerminalRenderable | null;
  private fallback: TerminalViewer | null;
  private session: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityTime: number = 0;

  constructor(renderer: CliRenderer, deps: Deps) { ... }

  /** Connect to tmux session. Starts capture loop. */
  async connect(session: string, cols: number, rows: number): Promise<void>;

  /** Disconnect. Stops capture loop. */
  disconnect(): void;

  /** Send key to tmux session. */
  async sendKey(key: KeyEvent): Promise<void>;

  /** Resize terminal. */
  async resize(cols: number, rows: number): Promise<void>;

  /** Whether session is still alive. */
  get alive(): boolean;

  /** Get the renderable container. */
  getContainer(): BoxRenderable;
}
```

## Layout Calculation

```
Total width: W
Total height: H

Sidebar:  width = floor(W * 0.3), height = H - 1 (footer)
Terminal: width = W - sidebar_width, height = H - 1 (footer)
Footer:   width = W, height = 1

tmux pane: cols = terminal_width - 2 (border padding)
           rows = terminal_height
```

The terminal panel dimensions (cols × rows) are passed to both ghostty and `tmux resize-pane`. They must stay in sync.

### Minimum Dimensions

If terminal width < 40 or height < 10, hide sidebar entirely — terminal gets full width. Small terminals shouldn't waste space on a sidebar.

```typescript
const sidebarVisible = width >= 80 && height >= 15;
const sidebarWidth = sidebarVisible ? Math.floor(width * 0.3) : 0;
const terminalWidth = width - sidebarWidth;
```

## Lifecycle

### Enter

```
1. Create sidebar + terminal panel renderables
2. Add to container (flex row: sidebar | terminal)
3. Calculate dimensions
4. sidebar.start(task, sidebarWidth, height)
5. terminal.connect(session, termCols, termRows)
6. Set focus = "terminal"
7. Render footer: "Ctrl+\:sidebar  Ctrl+]:fullscreen"
```

### Poll Cycle (while active)

```
Terminal poll (adaptive 20–500ms):
  1. tmux.capturePaneAnsi(session, scrollback)
  2. Update ghostty.ansi = captured
  3. If capture fails → session dead → update UI

Sidebar poll (10s):
  1. tmux.sessionExists(session)
  2. git.getCommitCount(), git.getDiffStats(), git.getChangedFiles()
  3. Update sidebar data, re-render

Sidebar file watcher (immediate, 100ms debounce):
  1. TASK.md changed → re-read frontmatter + body
  2. history.jsonl changed → re-read last 5 events
  3. Update sidebar data, re-render
```

### Exit

```
1. terminal.disconnect()  — stop capture loop, cleanup timers
2. sidebar.stop()          — stop watcher + poll
3. Hide container
4. Fire onExit callback
```

### Destroy

```
1. exit() if active
2. Destroy all renderables
3. Null out references
```

## Error Handling

| Error | Behavior |
|-------|----------|
| tmux capture fails once | Retry on next poll cycle |
| tmux capture fails 3× consecutive | Show `[Session ended]`, mark dead |
| git commands fail | Sidebar shows stale data, no crash |
| File watcher error | Fall back to poll-only (10s) |
| ghostty import fails | Use fallback TerminalViewer |
| Resize to tiny dimensions | Hide sidebar, terminal gets full width |

## Migration from TerminalViewer

The existing `TerminalViewer` class in `terminal.ts` becomes the fallback renderer. The new `TerminalPanel` wraps either ghostty or the fallback:

```typescript
class TerminalPanel {
  constructor(renderer, deps) {
    try {
      const { GhosttyTerminalRenderable } = require("ghostty-opentui/terminal-buffer");
      this.ghostty = new GhosttyTerminalRenderable(renderer, {
        persistent: false,  // stateless for v1
        showCursor: true,
        cursorStyle: "block",
      });
    } catch {
      // ghostty not available, use fallback
      this.fallback = new TerminalViewer(renderer, { tmux: deps.tmux });
    }
  }
}
```

No code deleted — `terminal.ts` and `ansi-parser.ts` remain as fallback path.
