# Orange

Agent orchestration for parallel coding agents.

## Overview

Orange enables you to:
1. Chat with an orchestrator agent to describe tasks
2. Break tasks into independent, parallel work items
3. Spawn coding agents that work autonomously in isolated tmux sessions
4. Monitor progress via a TUI dashboard
5. Review and merge completed work

## Quick Start

```bash
# Install
bun install

# Install skill to your coding agent
bun run dev install

# From a git project directory, open dashboard
bun run dev

# Create a task (auto-spawns agent)
bun run dev task create my-feature "Implement feature X"

# Or let orchestrator plan and create tasks
# (chat with your coding agent, it will call orange task create)
```

## Commands

### Dashboard
```bash
orange                              # Dashboard (project-scoped if in git repo)
orange --all                        # Dashboard (all projects)
orange --project <name>             # Dashboard (specific project)
```

### Project Management
```bash
orange project add [path] [--name <name>] [--pool-size <n>]
orange project list
orange project update <name> [--pool-size <n>]
orange project remove <name>
```

### Task Management
```bash
orange task create [branch] [summary] [--harness <name>] [--status pending|reviewing]
orange task list [--status <status>] [--all]
orange task spawn <task_id>
orange task attach <task_id>
orange task respawn <task_id>
orange task update [task_id] [--branch [name]] [--summary <text>] [--status <status>]
orange task merge <task_id> [--strategy ff|merge] [--local]
orange task cancel <task_id> [--yes]
orange task delete <task_id> [--yes]
orange task create-pr <task_id>
orange task show <task_id>          # Show task details, content, history
orange task complete <task_id>      # Agent use: set status to reviewing
orange task stuck <task_id>         # Agent use: set status to stuck
```

### Workspace Management
```bash
orange workspace init
orange workspace list [--all]
orange workspace gc
```

### Other
```bash
orange install [--harness <name>]   # Install skill to coding agents
orange log [--level <level>] [--lines N]
```

## Task Status Flow

```
pending → working → reviewing → done
            ↕           ↓
      clarification  cancelled
            ↓
          stuck
```

| Status | Description |
|--------|-------------|
| pending | Created, waiting to spawn |
| clarification | Agent waiting for user input |
| working | Agent actively working |
| reviewing | Self-review passed, awaiting human review |
| stuck | Agent gave up after max attempts |
| done | Merged/completed |
| cancelled | User cancelled |

## Dashboard Keybindings

| Key | Action |
|-----|--------|
| j/k | Navigate up/down |
| y | Copy task ID to clipboard |
| Enter | Spawn/attach/respawn (context-dependent) |
| c | Create new task |
| m | Merge task |
| p | Create PR / Open PR in browser |
| R | Refresh PR status |
| x | Cancel task |
| d | Delete task (done/cancelled only) |
| f | Filter by status (all → active → done) |
| q | Quit |

## Architecture

- **CLI + TUI**: Single binary with dashboard
- **Storage**: File-based (`~/orange/`)
- **Workspace pool**: Reusable git worktrees per project
- **Multi-harness**: Supports pi, claude, opencode, codex

## Data Storage

```
~/orange/
├── projects.json           # Project registry
├── orange.log              # Structured log
├── workspaces/             # Git worktree pool
│   └── .pool.json
└── tasks/<project>/<id>/   # Task data
    ├── TASK.md
    └── history.jsonl
```

## Development

```bash
bun run dev <command>    # Run in development
bun test                 # Run tests
bun run check            # Type check + tests
```

## License

MIT
