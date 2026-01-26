# Orange Architecture

Agent orchestration system in TypeScript. Chat with orchestrator → agents work in parallel → auto-review → human review.

**Stack:** TypeScript, pi-tui, tmux, SQLite

## Overview

```
tmux sessions:
┌─────────────────────────┐
│ orange-orchestrator     │  ← orchestrator + dashboard
│ ┌─────────┬───────────┐ │
│ │ Claude  │ Dashboard │ │
│ │ Code    │ TUI       │ │
│ └─────────┴───────────┘ │
└─────────────────────────┘

┌─────────────────────────┐  ┌─────────────────────────┐
│ orange/dark-mode        │  │ coffee/login-fix        │
│ (task session)          │  │ (task session)          │
│ ┌─────────────────────┐ │  │ ┌─────────────────────┐ │
│ │ Claude Code agent   │ │  │ │ Claude Code agent   │ │
│ └─────────────────────┘ │  │ └─────────────────────┘ │
└─────────────────────────┘  └─────────────────────────┘

← attach to any session to interact with agent
```

**Session naming:**
- `orange-orchestrator` - Orchestrator + dashboard
- `<project>/<branch>` - Task sessions (e.g., `orange/dark-mode`)

## Flow

1. **Chat with orchestrator**: Describe tasks
2. **Orchestrator plans**: Breaks down, asks questions
3. **Approve plan**
4. **Agents spawn**: One tmux session + worktree + claude per task
5. **Agents work**: Visible in dashboard (includes self-review loop)
6. **Agent stops**: Review passed → hook marks `needs_human`
7. **Human reviews**: Attach to session, review, merge

## Components

| Component | Binary/File | Description |
|-----------|-------------|-------------|
| CLI + Dashboard | `orange` | TypeScript - unified binary (pi-tui) |
| Skill | `skills/orchestrator.md` | Orchestrator context (installed to ~/.claude/skills/) |

**Single TypeScript binary** - CLI commands and dashboard in one.

## Project Structure

```
src/
├── index.ts           # Entry point
├── cli/
│   ├── args.ts        # Argument parsing
│   ├── commands/      # CLI commands
│   │   ├── project.ts # project add/list
│   │   ├── task.ts    # task create/spawn/list/merge
│   │   ├── workspace.ts # workspace init/list
│   │   └── start.ts   # start orchestrator session
│   └── index.ts
├── dashboard/
│   ├── index.ts       # Dashboard TUI
│   ├── components/
│   │   ├── task-list.ts
│   │   ├── task-row.ts
│   │   └── status-bar.ts
│   └── state.ts
├── core/
│   ├── state.ts       # Task/project state management
│   ├── tmux.ts        # tmux abstraction
│   ├── workspace.ts   # Workspace pool management
│   └── types.ts       # Shared types
└── utils/
    └── index.ts

skills/
└── orchestrator.md    # Skill file (copied by `orange install`)

package.json
tsconfig.json
```

## Startup

```bash
orange start  # Creates orchestrator session
```

Creates:
- tmux session `orange-orchestrator`
- Pane 0: Claude Code (with orange skill)
- Pane 1: Dashboard TUI

```bash
# Or attach if already running
tmux attach -t orange-orchestrator
```

## Data Files

All in `~/orange/`.

```
~/orange/
├── projects.json           # Project registry
├── workspaces/             # Worktree pool (reused)
│   ├── orange--1/
│   ├── orange--2/
│   └── coffee--1/
├── tasks/
│   └── <project>/
│       └── <branch>/
│           ├── TASK.md         # Description, metadata
│           └── history.jsonl   # Event log (source of truth)
└── index.db                # SQLite cache (derived, rebuildable)
```

### projects.json

```json
[
  {
    "name": "orange",
    "path": "/Users/tung/workspace/orange",
    "default_branch": "main",
    "pool_size": 2
  }
]
```

### Task Folder (`tasks/<project>/<branch>/`)

**TASK.md** - Human-readable task description with frontmatter:
```markdown
---
id: abc123
project: orange
branch: dark-mode
status: working
workspace: orange--1
tmux_session: orange/dark-mode
created_at: 2024-01-15T10:00:00Z
---

Add dark mode support with system preference detection.

- Toggle in settings
- Persist preference
- Match system theme by default
```

**history.jsonl** - Append-only event log (source of truth):
```jsonl
{"type":"task.created","at":"2024-01-15T10:00:00Z","by":"orchestrator"}
{"type":"agent.spawned","at":"2024-01-15T10:00:05Z","workspace":"orange--1","session":"orange/dark-mode"}
{"type":"message","at":"2024-01-15T10:01:00Z","role":"agent","content":"Reading CLAUDE.md..."}
{"type":"review.started","at":"2024-01-15T10:25:00Z","attempt":1}
{"type":"review.passed","at":"2024-01-15T10:28:00Z","attempt":1}
{"type":"agent.stopped","at":"2024-01-15T10:30:00Z","outcome":"completed"}
{"type":"status.changed","at":"2024-01-15T10:30:01Z","from":"working","to":"needs_human"}
{"type":"task.merged","at":"2024-01-15T11:00:00Z","commit":"abc123"}
```

### Workspace Pool (`workspaces/`)

```
orange--1/     # worktree 1 for orange project
orange--2/     # worktree 2 for orange project
coffee--1/     # worktree 1 for coffee project
```

- Pool size per project (default: 2)
- Acquired on `spawn`, released on `complete`
- **Reused, not deleted** - branch reset on acquire
- Lock file per workspace prevents races

### index.db (derived cache)

SQLite cache for fast dashboard queries. Rebuilt from task folders if missing/corrupted.

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    branch TEXT NOT NULL,
    status TEXT NOT NULL,
    workspace TEXT,
    tmux_session TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_project ON tasks(project);
```

**Rebuild logic:**
```
for each ~/orange/tasks/<project>/<branch>/TASK.md:
    parse frontmatter → upsert into index.db
```

### Task Status

| Status | Description |
|--------|-------------|
| `pending` | Created, not yet spawned |
| `working` | Agent actively working (includes self-review) |
| `needs_human` | Agent done, awaiting human review |
| `done` | Merged/completed |
| `failed` | Agent failed/stuck |

## CLI Commands

```bash
# Projects
orange project add <path> [--name <name>] [--pool-size <n>]
orange project list

# Tasks
orange task create <project> <branch> <description>
orange task list [--project <project>] [--status <status>]
orange task spawn <task_id>
orange task peek <task_id> [--lines N]  # Show agent's recent terminal output
orange task complete <task_id>      # Called by claude hook → needs_human
orange task merge <task_id> [--strategy ff|merge]  # Merge + release workspace
orange task cancel <task_id>        # Cancel + release workspace

# Workspaces (pool management)
orange workspace list               # Show pool status
orange workspace init <project>     # Create worktrees for project pool

# Session
orange start                        # Create tmux session
orange install                      # Install orchestrator skill to ~/.claude/skills/
```

### Task Merge Flow

Two workflows supported:

**Local merge:**
```bash
orange task merge <id>
# 1. In source repo: git fetch, git merge origin/<branch>
# 2. Release workspace (mark available, don't delete)
# 3. Delete remote branch
# 4. tmux kill-session -t "$project/$branch"
# 5. status → done, history.jsonl: task.merged event
```

**PR workflow:**
```bash
# Agent or human creates PR via gh
gh pr create --fill

# After PR merged on GitHub:
orange task merge <id>
# 1. Release workspace (mark available)
# 2. tmux kill-session -t "$project/$branch"
# 3. status → done, history.jsonl: task.merged event
```

Both: workspace released (reused), session killed, status = done.

## Orchestrator Skill

Installed globally for orchestrator context.

```bash
orange install  # Copies skill to ~/.claude/skills/orange/
```

**~/.claude/skills/orange/orchestrator.md:**

```markdown
# Orange Orchestrator

You are an orchestrator managing coding tasks across multiple projects.

## CLI Commands

Use Bash tool to run these commands:

- `orange task create <project> <branch> "<description>"` - Create task
- `orange task spawn <task_id>` - Spawn agent in worktree + tmux session
- `orange task list [--project X] [--status Y]` - List tasks
- `orange task peek <task_id> [--lines N]` - See agent's terminal output

## Workflow

1. **Understand request** - Clarify scope, ask questions
2. **Break down** - Split into independent tasks (one branch each)
3. **Create tasks** - `orange task create` for each
4. **Spawn agents** - `orange task spawn` (can run multiple)
5. **Monitor** - `orange task peek` or check dashboard
6. **Notify user** - When agents stop, tell user to review

## Guidelines

- One task = one branch = one agent
- Keep tasks focused and independent
- Agents self-review before stopping
- You don't need to review - human does final review

## Example

User: "Add dark mode to orange and fix the login bug in coffee app"

```bash
orange task create orange dark-mode "Add dark mode with system preference detection"
# Output: Created task abc123

orange task create coffee fix-login "Fix OAuth redirect loop on mobile"
# Output: Created task def456

orange task spawn abc123
orange task spawn def456
```

"I've spawned two agents. Check the dashboard or attach to their sessions."
```

## Dashboard TUI

TypeScript + pi-tui. Task-centric monitoring.

```
┌─────────────────────────────────────────────────────────┐
│ Orange Dashboard                          3 tasks       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ ● orange/dark-mode                    [working]    2m  │
│   Add dark mode support with system preference...       │
│   > Implementing ThemeContext provider...               │
│                                                         │
│ ● coffee/login-fix                    [working]    5m  │
│   Fix OAuth redirect loop on mobile                     │
│   > Self-review: checking error handling...             │
│                                                         │
│ ◉ app/refactor                        [needs_human] 15m│
│   Refactor auth module to use new token service         │
│   > Ready for human review                              │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ j/k navigate │ Enter attach │ p peek │ m merge │ q quit │
└─────────────────────────────────────────────────────────┘
```

### Implementation (pi-tui)

```typescript
import { TUI, Component } from '@mariozechner/pi-tui';

interface Task {
  id: string;
  project: string;
  branch: string;
  status: 'pending' | 'working' | 'needs_human' | 'done' | 'failed';
  description: string;
  lastOutput?: string;
}

class TaskRow implements Component {
  constructor(private task: Task, private selected: boolean) {}

  render(width: number): string[] {
    const icon = this.task.status === 'needs_human' ? '◉' :
                 this.task.status === 'working' ? '●' : '○';
    const status = `[${this.task.status}]`;
    const name = `${this.task.project}/${this.task.branch}`;

    return [
      `${this.selected ? '>' : ' '} ${icon} ${name.padEnd(30)} ${status}`,
      `    ${this.task.description.slice(0, width - 6)}`,
      `    > ${this.task.lastOutput || '...'}`,
      ''
    ];
  }
}

class Dashboard implements Component {
  tasks: Task[] = [];
  cursor = 0;

  render(width: number): string[] {
    const lines = [`Orange Dashboard                    ${this.tasks.length} tasks`, '─'.repeat(width)];
    for (let i = 0; i < this.tasks.length; i++) {
      lines.push(...new TaskRow(this.tasks[i], i === this.cursor).render(width));
    }
    lines.push('─'.repeat(width));
    lines.push('j/k navigate │ Enter attach │ p peek │ m merge │ q quit');
    return lines;
  }

  handleInput(key: string) {
    if (key === 'j') this.cursor = Math.min(this.cursor + 1, this.tasks.length - 1);
    if (key === 'k') this.cursor = Math.max(this.cursor - 1, 0);
    // ... other handlers
  }
}
```

### Legend

- `●` = agent active
- `◉` = needs attention (needs_human)
- `○` = idle (done/failed)
- `[status]` = current status
- Last line = recent agent output (via tmux capture-pane)

### Keybindings

| Key | Action |
|-----|--------|
| j/k | Navigate tasks |
| Enter | Attach to task's tmux session |
| p | Peek - show more agent output |
| m | Merge task (local merge + cleanup) |
| x | Cancel task (cleanup) |
| o | Open PR in browser |
| q | Quit dashboard |

### Polling

```typescript
// Watch task folders for changes
const watcher = chokidar.watch('~/orange/tasks', { persistent: true });
watcher.on('change', () => this.reloadTasks());

// Capture agent output periodically
setInterval(() => {
  for (const task of this.tasks.filter(t => t.status === 'working')) {
    const output = execSync(`tmux capture-pane -t "${task.project}/${task.branch}" -p | tail -1`);
    task.lastOutput = output.toString().trim();
  }
  this.tui.invalidate();
}, 5000);
```

## Agent Lifecycle

### 1. Spawn

```bash
# orange task spawn <id>

# 1. Acquire workspace from pool
workspace=$(acquire_workspace $project)  # e.g., orange--1

# 2. Reset workspace to base branch + create task branch
cd $workspace
git fetch origin
git checkout $default_branch
git reset --hard origin/$default_branch
git checkout -b $branch

# 3. Create tmux session for task
session_name="$project/$branch"
tmux new-session -d -s "$session_name" -c "$workspace" \
  "claude --prompt '$AGENT_PROMPT'"

# 4. Update task metadata
# - TASK.md: workspace, tmux_session
# - history.jsonl: agent.spawned event
```

Writes `.orange-task` file in workspace with task ID for hook.

### 2. Agent Prompt

Injected via `--prompt`:

```
You are working on: $description

Project: $project
Branch: $branch
Worktree: $worktree

Instructions:
1. Read CLAUDE.md for project context
2. Implement the task
3. Run tests and lint
4. Self-review using Task tool:
   - Spawn subagent with: subagent_type="Explore" or custom reviewer
   - Prompt: "Review changes on this branch. Check: tests pass, no bugs, code style, matches requirements."
5. If review finds issues → fix them → re-review
6. Max 3 review attempts. If still failing, stop and explain.
7. Only stop when review passes OR you're stuck.

Do not stop until review passes or you've exhausted attempts.
```

### 3. Self-Review Loop

Agent handles review internally:

```
┌──────────────────────────────────────────────────┐
│                  Agent Session                   │
│                                                  │
│  implement → spawn review subagent → feedback    │
│                                         ↓        │
│                                   pass? ─────→ stop
│                                         ↓        │
│                                   fail + <3      │
│                                         ↓        │
│                                   fix → re-review│
│                                         ↓        │
│                                   fail + ≥3      │
│                                         ↓        │
│                                   stop (stuck)   │
└──────────────────────────────────────────────────┘
```

Benefits:
- Agent keeps full context across fix iterations
- No external review orchestration
- Agent responsible for own quality

### 4. Completion Hook

Claude's stop hook notifies orange:

```bash
# ~/.claude/hooks/stop.sh
#!/bin/bash
if [[ -f .orange-task ]]; then
  TASK_ID=$(cat .orange-task)
  orange task complete "$TASK_ID"
fi
```

`orange task complete`:
1. Status → `needs_human`
2. Dashboard shows ◉ indicator

### 5. Human Review

1. Dashboard shows task with ◉ (needs attention)
2. Human attaches to task session (`Enter` in dashboard or `tmux attach -t orange/dark-mode`)
3. Reviews changes, interacts with agent if needed
4. Two options:
   - **Local merge**: `m` in dashboard → merges to main, releases workspace, kills session
   - **PR workflow**: agent/human runs `gh pr create`, merge on GitHub, then `m` to cleanup
5. Workspace returned to pool, session killed, ready for next task

## Workspace Pool

### Initialization

```bash
orange workspace init orange
# Creates ~/orange/workspaces/orange--1, orange--2 (based on pool_size)
```

Each workspace is a git worktree of the source repo:
```bash
git -C /path/to/source worktree add ~/orange/workspaces/orange--1 main
```

### Acquisition

```typescript
async function acquireWorkspace(project: string): Promise<string> {
  const release = await lockfile.lock(POOL_LOCK);
  try {
    const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    const available = Object.entries(pool.workspaces)
      .find(([name, info]) => name.startsWith(project) && info.status === 'available');
    if (!available) throw new Error(`No available workspace for ${project}`);

    pool.workspaces[available[0]].status = 'bound';
    fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
    return available[0];
  } finally {
    await release();
  }
}
```

### Release

```typescript
async function releaseWorkspace(workspace: string): Promise<void> {
  const release = await lockfile.lock(POOL_LOCK);
  try {
    // Clean workspace
    execSync(`git -C ${workspacePath} checkout main && git -C ${workspacePath} clean -fd`);

    const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    pool.workspaces[workspace].status = 'available';
    pool.workspaces[workspace].task = null;
    fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
  } finally {
    await release();
  }
}
```

### Pool Status

```
~/orange/workspaces/
├── orange--1/           # bound to: orange/dark-mode
├── orange--2/           # available
├── coffee--1/           # bound to: coffee/login-fix
└── .pool.json           # pool state
```

**.pool.json:**
```json
{
  "workspaces": {
    "orange--1": {"status": "bound", "task": "orange/dark-mode"},
    "orange--2": {"status": "available"},
    "coffee--1": {"status": "bound", "task": "coffee/login-fix"}
  }
}
```

## tmux Abstraction

```typescript
interface TmuxExecutor {
  newSession(name: string, cwd: string, command: string): void;
  killSession(name: string): void;
  listSessions(): Session[];
  sessionExists(name: string): boolean;
  capturePane(session: string, lines: number): string;
  sendKeys(session: string, keys: string): void;
}

class RealTmux implements TmuxExecutor {
  newSession(name: string, cwd: string, command: string) {
    execSync(`tmux new-session -d -s "${name}" -c "${cwd}" "${command}"`);
  }
  capturePane(session: string, lines: number): string {
    return execSync(`tmux capture-pane -t "${session}" -p | tail -${lines}`).toString();
  }
  // ...
}

class MockTmux implements TmuxExecutor { /* for testing */ }
```

**Session naming convention:** `<project>/<branch>` (e.g., `orange/dark-mode`)

## Decisions

1. **Single user** - No multi-user support
2. **Task history** - Keep forever (task folders never deleted)
3. **Storage** - File-based (source of truth) + SQLite (derived cache)
4. **Workspace pool** - Reuse worktrees, don't delete
5. **Merge workflow** - Support both local merge and PR
6. **Self-review** - Agent spawns review subagent internally

## Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-tui` | TUI framework |
| `better-sqlite3` | SQLite index cache |
| `chokidar` | File watching (task folders) |
| `chalk` | Terminal colors |
| `gray-matter` | TASK.md frontmatter parsing |
| `nanoid` | Task IDs |
| `proper-lockfile` | File locking (workspace pool) |
