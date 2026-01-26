# Orange

Agent orchestration system for parallel Claude Code agents.

## Overview

Orange enables you to:
1. Chat with an orchestrator agent to describe tasks
2. Break tasks into independent, parallel work items
3. Spawn Claude Code agents that work autonomously in isolated tmux sessions
4. Monitor progress via a TUI dashboard
5. Review and merge completed work

## Quick Start

```bash
# Install dependencies
bun install

# Add a project
bun run dev project add /path/to/your/project --name myproject --pool-size 2

# Initialize workspace pool
bun run dev workspace init myproject

# Create and spawn a task
bun run dev task create myproject feature-branch "Implement feature X"
bun run dev task spawn <task_id>

# View dashboard
bun run dev

# Or start orchestrator session
bun run dev start
```

## Commands

### Project Management
```bash
orange project add <path> [--name <name>] [--pool-size <n>]
orange project list
```

### Task Management
```bash
orange task create <project> <branch> <description>
orange task list [--project <project>] [--status <status>]
orange task spawn <task_id>
orange task peek <task_id> [--lines N]
orange task complete <task_id>
orange task stuck <task_id>
orange task merge <task_id> [--strategy ff|merge]
orange task cancel <task_id>
```

### Workspace Management
```bash
orange workspace init <project>
orange workspace list
```

### Session Management
```bash
orange start    # Start orchestrator session
orange install  # Install orchestrator skill
```

## Task Status Flow

```
pending → working → needs_human → done
                 ↘ stuck (gave up after 3 reviews)
                 ↘ failed (crashed/errored)
```

## Dashboard Keybindings

| Key | Action |
|-----|--------|
| j/k | Navigate up/down |
| Enter | Attach to task's tmux session |
| p | Peek - show more agent output |
| m | Merge task |
| x | Cancel task |
| o | Open PR in browser |
| q | Quit |

## Architecture

- **Single binary**: CLI + Dashboard via pi-tui
- **Storage**: File-based (source of truth) + SQLite (cache)
- **Workspace pool**: Reusable git worktrees
- **Self-review**: Agents handle their own review loop

## Data Storage

- `~/orange/projects.json` - Project registry
- `~/orange/workspaces/` - Worktree pool
- `~/orange/tasks/<project>/<branch>/` - Task data (TASK.md, history.jsonl)
- `~/orange/index.db` - SQLite cache

## Development

```bash
# Run in development
bun run dev <command>

# Run tests
bun test

# Type check + tests
bun run check
```

## License

MIT
