# Orange Architecture

Agent orchestration system in TypeScript. Chat with orchestrator → agents work in parallel → auto-review → human review.

**Stack:** TypeScript, pi-tui, tmux, SQLite

## Specs

- [Data & Storage](./data.md) — files, formats, task status
- [CLI Commands](./cli.md) — project, task, workspace commands
- [Dashboard](./dashboard.md) — TUI, keybindings
- [Agent Lifecycle](./agent.md) — spawn, prompt, self-review, hooks
- [Workspace Pool](./workspace.md) — worktree management
- [Testing](./testing.md) — setup, strategy

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
└── orchestrator.md    # Skill file (symlinked by `orange install`)

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
orange start
# Creates tmux session (if not exists) and attaches:
#   - Pane 0: Claude Code (with orange skill)
#   - Pane 1: Dashboard TUI
# If session exists, just attaches.
# Working directory: ~/orange/
```

Equivalent to:
```bash
tmux new-session -A -s orange-orchestrator -c ~/orange
```

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
