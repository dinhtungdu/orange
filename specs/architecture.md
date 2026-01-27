# Orange Architecture

Agent orchestration system. Chat with orchestrator, agents work in parallel, auto-review, human review.

## Specs

- [Data & Storage](./data.md) — files, formats, task status
- [CLI Commands](./cli.md) — project, task, workspace commands
- [Dashboard](./dashboard.md) — TUI, keybindings
- [Agent Lifecycle](./agent.md) — spawn, prompt, self-review, hooks
- [Workspace Pool](./workspace.md) — worktree management
- [Logging](./logging.md) — structured logging, debugging
- [Testing](./testing.md) — setup, strategy
- [GitHub](./github.md) — PR creation, merge detection

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
- `<project>-orchestrator` — per-project orchestrator + scoped dashboard
- `<project>/<branch>` — task sessions

## Flow

1. **Chat with orchestrator**: Describe tasks
2. **Orchestrator plans**: Breaks down, asks questions
3. **Approve plan**
4. **Agents spawn**: One tmux session + worktree + Claude per task
5. **Agents work**: Visible in dashboard (includes self-review loop)
6. **Agent stops**: Review passed → hook marks `reviewing`
7. **Human reviews**: Attach to session, review, merge

## Components

| Component | Description |
|-----------|-------------|
| CLI + Dashboard | Unified binary — CLI commands and TUI dashboard |
| Skills | Claude skills (installed to `~/.claude/skills/orange-<name>`) |

## Modules

| Module | Responsibility |
|--------|----------------|
| args | CLI argument parsing |
| commands | CLI command handlers (project, task, workspace, start, install, log) |
| dashboard | TUI rendering, input handling, file watching |
| agent | Prompt generation (spawn + respawn) |
| clock | Time abstraction (real + mock) |
| cwd | CWD-based project detection |
| db | Task queries |
| deps | Dependency injection container |
| git | Git operations abstraction (real + mock) |
| github | GitHub CLI abstraction for PR operations (real + mock) |
| logger | Structured JSON logger |
| spawn | Task spawning lifecycle |
| state | Task/project persistence (TASK.md, projects.json) |
| tmux | tmux session abstraction (real + mock) |
| workspace | Workspace pool management |

## Startup

1. `orange start` from project directory
2. Auto-registers project if not in `projects.json`
3. Creates/attaches tmux session `<project>-orchestrator`:
   - Pane 0: Claude Code with orange skill
   - Pane 1: Dashboard TUI (project-scoped)
4. Working directory: the project repo (full context: CLAUDE.md, codebase)

Error if not in a git repo.

## Decisions

1. **Single user** — no multi-user support
2. **Storage** — file-based (TASK.md is source of truth)
3. **Workspace pool** — reuse worktrees, don't delete
4. **Merge workflow** — support both local merge and PR
5. **Self-review** — agent uses /code-review skill internally
6. **Per-project orchestrator** — must run in project directory for context
7. **CWD-aware CLI** — commands infer project from current directory
8. **Lazy workspace init** — worktrees created on-demand at first spawn
9. **Dependency injection** — all external deps (tmux, git, clock, logger) injected for testability
