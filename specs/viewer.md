# Workspace Viewer

Implementation spec for the workspace view — the primary working surface where users interact with agent sessions. Covers terminal rendering, sidebar data pipeline, input handling, and integration with the dashboard.

Parent spec: [workspace.md](./workspace.md) (layout, UX, keybindings).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ WorkspaceViewer                                     │
│                                                     │
│  ┌──── Sidebar ─────┐  ┌──── TerminalPanel ──────┐ │
│  │ SidebarRenderer   │  │ GhosttyTerminal         │ │
│  │ (TextRenderable)  │  │ Renderable (stateless)  │ │
│  │                   │  │                          │ │
│  │ ← DataPipeline    │  │ ← tmux capture-pane     │ │
│  │   (poll + watch)  │  │ → tmux send-keys         │ │
│  │                   │  │ ← tmux display (cursor)  │ │
│  └───────────────────┘  └──────────────────────────┘ │
│                                                     │
│  ┌──── FocusManager ────────────────────────────┐   │
│  │ terminal | sidebar                           │   │
│  │ routes keyboard input to active panel        │   │
│  └──────────────────────────────────────────────┘   │
│                                                     │
│  ┌──── Footer ──────────────────────────────────┐   │
│  │ context-aware keybindings per focus state     │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## Terminal Rendering

### Two rendering backends

**ghostty-opentui** (primary, optional dep) — Uses Ghostty's Zig VT emulator compiled as a native addon. Fed `capture-pane -e` output, it produces correctly rendered cells with full SGR support: 16/256/RGB colors, bold, italic, underline, dim, inverse, strikethrough. Significantly more robust than a hand-rolled ANSI parser.

**Custom ANSI parser** (fallback) — The existing `TerminalViewer` in `terminal.ts` with `ansi-parser.ts`. Handles basic SGR sequences. Used when `ghostty-opentui` is not installed.

### What ghostty gives us (and what it doesn't)

Both backends consume `tmux capture-pane -e` output, which is a **rendered screen dump** — tmux has already processed all VT sequences (cursor movement, scroll regions, alternate screen) and re-encodes the final screen state with SGR color codes only.

This means:

| Feature | Handled by | Backend matters? |
|---------|-----------|-----------------|
| Colors (16/256/RGB) | SGR in capture output | Yes — ghostty handles edge cases the custom parser misses |
| Text attributes (bold, italic, etc.) | SGR in capture output | Yes — ghostty handles all attributes correctly |
| Cursor position | `tmux display -p` (separate query) | No — neither backend gets cursor from capture output |
| Alternate screen (vim, less) | tmux (already switched) | No — capture-pane shows current screen |
| Scroll regions | tmux (already processed) | No — capture-pane shows final result |

**Cursor position** always comes from tmux via `queryPaneInfo()`, not from the rendering backend. Neither ghostty nor the custom parser can determine cursor position from capture-pane output (which has no cursor movement sequences).

The ghostty advantage is **rendering correctness**: proper handling of complex SGR sequences (256-color, RGB, combined attributes) where the hand-rolled parser has gaps. Not full VT emulation — tmux already did that.

### Component Setup

```typescript
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";

const terminal = new GhosttyTerminalRenderable(renderContext, {
  cols: 120,
  rows: 40,
  persistent: false,   // stateless — full capture-pane on each poll
  showCursor: false,    // cursor rendered separately via tmux query
});
```

Stateless mode: set `terminal.ansi = capturedOutput` on each poll cycle. Ghostty re-parses from scratch. At ~100MB/s parsing speed, a full screen (120×40 = ~5KB) takes <0.1ms. No need for persistent mode.

### Cursor Rendering

Cursor is rendered as an overlay based on tmux pane info:

```typescript
const info = await tmux.queryPaneInfo(session);
if (info && info.cursorVisible) {
  // Apply cursor highlight at (info.cursorX, info.cursorY)
  terminal.highlights = [{
    line: info.cursorY,
    start: info.cursorX,
    end: info.cursorX + 1,
    backgroundColor: "#FFFFFF",  // or use terminal.cursorStyle for block/underline
  }];
}
```

This uses `GhosttyTerminalRenderable.highlights` to draw the cursor at the correct position, separate from the terminal content parsing.

### Capture Loop

```typescript
async function poll(): Promise<void> {
  // 1. Capture screen state (with ANSI SGR codes)
  const output = await tmux.capturePaneAnsi(session, scrollbackLines);

  // 2. Update terminal content
  if (output !== null && output !== lastOutput) {
    terminal.ansi = output;
    lastOutput = output;
  }

  // 3. Update cursor position (separate query)
  const info = await tmux.queryPaneInfo(session);
  if (info) {
    terminal.highlights = info.cursorVisible ? [{
      line: info.cursorY,
      start: info.cursorX,
      end: info.cursorX + 1,
      backgroundColor: "#FFFFFF",
    }] : [];
  }

  // 4. Schedule next poll
  schedulePoll(calculateInterval());
}
```

### Resize

When the viewer panel resizes:

```typescript
// 1. Resize tmux pane to match (tmux redraws content)
await tmux.resizePane(session, newCols, newRows);

// 2. Update ghostty component dimensions
terminal.cols = newCols;
terminal.rows = newRows;

// 3. Trigger immediate capture (tmux has redrawn)
await poll();
```

The tmux pane must match the viewer dimensions exactly. Mismatched sizes cause wrapping artifacts and broken full-screen apps (vim, htop).

### Adaptive Polling

| State | Interval | Trigger |
|-------|----------|---------|
| Active input | 50ms | User typed within last 2s |
| Idle | 200ms | No input for 2–10s |
| Background | 500ms | No input for 10s+ |
| Post-keystroke | 20ms | Immediate after sending key to tmux |

Timer resets on every keystroke. This gives snappy feel during interaction without burning CPU when idle.

### Fallback

If `ghostty-opentui` is not installed (it's an optional dep), fall back to the existing `TerminalViewer` with custom ANSI parser. The workspace view still works, just with potential rendering gaps for complex SGR sequences.

```typescript
let TerminalComponent: typeof GhosttyTerminalRenderable | null = null;
try {
  const mod = await import("ghostty-opentui/terminal-buffer");
  TerminalComponent = mod.GhosttyTerminalRenderable;
} catch {
  // Fall back to existing TextRenderable + ansi-parser
}
```

No code deleted — `terminal.ts` and `ansi-parser.ts` remain as fallback path.

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

  // Internal
  workspacePath: string;       // resolved via getWorkspacePath(deps, task.workspace)
}
```

### Data Sources

All git commands run in the task's workspace directory: `getWorkspacePath(deps, task.workspace)`. If `task.workspace` is null (shouldn't happen for live tasks), git data is skipped and sidebar shows stale/empty values.

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
| Printable char | literal via `send-keys -l` |
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

### Limitations of send-keys

`tmux send-keys` is a tmux command (process fork per keystroke), not raw PTY input. Known limitations:

- **Paste**: multi-character input must use `send-keys -l` (literal mode) to avoid tmux interpreting key names. For large pastes, buffer and send as a single `send-keys -l` call.
- **Alt+key**: sends `ESC` followed by key. `send-keys` may misinterpret multi-byte sequences. Workaround: send `Escape` then the key as separate calls, or use `send-keys -H` with hex codes.
- **Typing speed**: each keystroke = one `tmux send-keys` invocation. Fast typing generates many process forks. In practice this is fine for interactive use but not for bulk input.
- **Mouse events**: not supported through send-keys. Mouse support would require raw PTY passthrough.

`Ctrl+]` full-screen attach is the escape hatch for any interaction that doesn't work through the key forwarding layer.

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

This is the "I need real tmux" escape hatch. Useful for complex interactions that don't work through the key forwarding layer (paste, Alt+key combos, mouse-heavy TUIs).

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

### Render Batching

Three async data sources update the UI: terminal poll, sidebar poll, file watcher. opentui's `CliRenderer` handles batching — it renders at a fixed FPS (default 30), collecting all property changes since the last frame. Multiple updates between frames produce a single render.

If sidebar and terminal update within the same frame interval, opentui renders once.

### Session Death While Viewing

If the tmux session dies while the workspace viewer is active:

1. Capture poll returns null / throws → increment failure count
2. After 3 consecutive capture failures → show `[Session ended]`
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
├── viewer.ts                 # WorkspaceViewer (new — layout, focus, lifecycle, footer)
├── viewer-sidebar.ts         # SidebarRenderer (new — sidebar data + rendering)
├── viewer-terminal.ts        # TerminalPanel (new — ghostty wrapper + capture loop)
├── terminal.ts               # Existing TerminalViewer (becomes fallback)
└── ansi-parser.ts            # Existing ANSI parser (used by fallback)
```

### WorkspaceViewer

Top-level component that owns the layout, focus state, footer, and child panels.

```typescript
class WorkspaceViewer {
  private sidebar: SidebarRenderer;
  private terminal: TerminalPanel;
  private footer: TextRenderable;
  private focus: ViewerFocus = "terminal";
  private task: Task | null = null;
  private container: BoxRenderable;

  constructor(renderer: CliRenderer, deps: Deps) { ... }

  /** Enter viewer for a task. Sets up panels, starts data pipelines. */
  async enter(task: Task): Promise<void>;

  /** Exit viewer. Stops data pipelines, cleans up. */
  exit(): void;

  /** Handle keyboard input. Routes to active panel or handles focus keys. */
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

Footer is owned by `WorkspaceViewer` and updated on focus change:
- Terminal focused: `Ctrl+\:sidebar  Ctrl+]:fullscreen`
- Sidebar focused: `Tab:terminal  Esc:dashboard`

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
  private consecutiveFailures: number = 0;

  constructor(renderer: CliRenderer, deps: Deps) { ... }

  /** Connect to tmux session. Starts capture loop. */
  async connect(session: string, cols: number, rows: number): Promise<void>;

  /** Disconnect. Stops capture loop. */
  disconnect(): void;

  /** Send key to tmux session. */
  async sendKey(key: KeyEvent): Promise<void>;

  /** Resize terminal. */
  async resize(cols: number, rows: number): Promise<void>;

  /**
   * Whether session appears alive.
   * Potentially stale — based on last successful capture.
   * 3 consecutive failures = considered dead.
   */
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
1. Create sidebar + terminal panel + footer renderables
2. Add to container (flex column: [flex row: sidebar | terminal] + footer)
3. Calculate dimensions
4. Resolve workspace path: getWorkspacePath(deps, task.workspace)
5. sidebar.start(task, sidebarWidth, height - 1)
6. terminal.connect(session, termCols, termRows)
7. Set focus = "terminal"
8. Update footer: "Ctrl+\:sidebar  Ctrl+]:fullscreen"
```

### Poll Cycle (while active)

```
Terminal poll (adaptive 20–500ms):
  1. tmux.capturePaneAnsi(session, scrollback)
  2. tmux.queryPaneInfo(session) for cursor
  3. Update ghostty.ansi + highlights
  4. If capture fails → increment consecutiveFailures
  5. If consecutiveFailures >= 3 → show [Session ended], mark dead

Sidebar poll (10s):
  1. tmux.sessionExists(session)
  2. git.getCommitCount(workspacePath, base)
  3. git.getDiffStats(workspacePath, base)
  4. git.getChangedFiles(workspacePath, base)
  5. Update sidebar data, re-render

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
| tmux capture fails once | Retry on next poll cycle, increment failure count |
| tmux capture fails 3× consecutive | Show `[Session ended]`, mark dead |
| git commands fail | Sidebar shows stale data, no crash |
| File watcher error | Fall back to poll-only (10s) for affected files |
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
        persistent: false,
        showCursor: false,   // cursor rendered via highlights + tmux query
      });
    } catch {
      // ghostty not available, use fallback
      this.fallback = new TerminalViewer(renderer, { tmux: deps.tmux });
    }
  }
}
```

No code deleted — `terminal.ts` and `ansi-parser.ts` remain as fallback path.
