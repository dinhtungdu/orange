# Orange Architecture

Agent orchestration system in TypeScript. Chat with orchestrator → agents work in parallel → auto-review → human review.

**Stack:** TypeScript, pi-tui, tmux, SQLite

## Specs

- [Data & Storage](./data.md) — files, formats, task status
- [CLI Commands](./cli.md) — project, task, workspace commands
- [Dashboard](./dashboard.md) — TUI, keybindings
- [Agent Lifecycle](./agent.md) — spawn, prompt, self-review, hooks
- [Workspace Pool](./workspace.md) — worktree management
- [Logging](./logging.md) — structured logging, debugging
- [Testing](./testing.md) — setup, strategy

## Overview

```
tmux sessions (per-project orchestrators):
┌─────────────────────────┐  ┌─────────────────────────┐
│ coffee-orchestrator     │  │ orange-orchestrator     │
│ cwd: ~/workspace/coffee │  │ cwd: ~/workspace/orange │
│ ┌─────────┬───────────┐ │  │ ┌─────────┬───────────┐ │
│ │ Claude  │ Dashboard │ │  │ │ Claude  │ Dashboard │ │
│ │ Code    │ (scoped)  │ │  │ │ Code    │ (scoped)  │ │
│ └─────────┴───────────┘ │  │ └─────────┴───────────┘ │
└─────────────────────────┘  └─────────────────────────┘

┌─────────────────────────┐  ┌─────────────────────────┐
│ coffee/login-fix        │  │ orange/dark-mode        │
│ (task session)          │  │ (task session)          │
│ ┌─────────────────────┐ │  │ ┌─────────────────────┐ │
│ │ Claude Code agent   │ │  │ │ Claude Code agent   │ │
│ └─────────────────────┘ │  │ └─────────────────────┘ │
└─────────────────────────┘  └─────────────────────────┘

← attach to any session to interact with agent
```

**Session naming:**
- `<project>-orchestrator` - Per-project orchestrator + scoped dashboard (e.g., `coffee-orchestrator`)
- `<project>/<branch>` - Task sessions (e.g., `coffee/login-fix`)

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
| Skills | `skills/<name>/SKILL.md` | Claude skills (installed to ~/.claude/skills/orange-<name>) |

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
└── orchestrator/
    └── SKILL.md       # Orchestrator skill (symlinked to ~/.claude/skills/orange-orchestrator)

package.json
tsconfig.json
```

## Build & Development

**package.json:**
```json
{
  "name": "orange",
  "type": "module",
  "bin": {
    "orange": "./dist/orange"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --compile --outfile dist/orange",
    "test": "bun test",
    "check": "tsc --noEmit && bun test",
    "lint": "eslint src/"
  }
}
```

**Development:**
```bash
bun run dev project list          # run directly
bun run dev task create ...       # no build needed
```

**Build:**
```bash
bun run build                     # creates dist/orange (single binary)
```

**Install globally:**
```bash
# Development (changes apply immediately):
alias orange="bun run ~/workspace/orange/src/index.ts"
# Add to ~/.zshrc or ~/.bashrc

# Production (compiled binary):
bun run build
cp dist/orange /usr/local/bin/
```

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

## Startup

```bash
cd ~/workspace/coffee
orange start
# 1. Auto-registers project if not in projects.json (name from folder)
# 2. Creates/attaches tmux session "coffee-orchestrator":
#    - Pane 0: Claude Code (with orange skill, has project context)
#    - Pane 1: Dashboard TUI (project-scoped, shows only coffee/* tasks)
# 3. Working directory: ~/workspace/coffee (the actual project repo)
```

**CWD-aware design:**
- Orchestrator runs IN the project directory (has full context: CLAUDE.md, codebase)
- Dashboard pane shows only that project's tasks
- Each project has its own orchestrator session
- Multiple orchestrators can run simultaneously

**Error if not in git repo:**
```bash
cd ~/Downloads
orange start
# Error: Not a git repository. Run from a project directory.
```

## Decisions

1. **Single user** - No multi-user support
2. **Task history** - Keep forever (task folders never deleted)
3. **Storage** - File-based (source of truth) + SQLite (derived cache)
4. **Workspace pool** - Reuse worktrees, don't delete
5. **Merge workflow** - Support both local merge and PR
6. **Self-review** - Agent spawns review subagent internally
7. **Per-project orchestrator** - Orchestrator must run in project directory for context
8. **CWD-aware CLI** - Commands infer project from current directory
9. **Lazy workspace init** - Worktrees created on-demand at first `task spawn`

## Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-tui` | TUI framework |
| `bun:sqlite` | SQLite index cache (Bun built-in) |
| `chokidar` | File watching (task folders) |
| `chalk` | Terminal colors |
| `gray-matter` | TASK.md frontmatter parsing |
| `nanoid` | Task IDs |
| `proper-lockfile` | File locking (workspace pool) |
