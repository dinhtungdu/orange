# Orange Architecture

Agent orchestration system. Dashboard manages tasks, agents work in parallel, auto-review, human review.

## Specs

- [Flows](./flows.md) — end-to-end workflows, status transitions
- [Data & Storage](./data.md) — files, formats, task status
- [CLI Commands](./cli.md) — project, task, workspace commands
- [Task Manager](./dashboard.md) — task list, keybindings, polling
- [Workspace](./workspace.md) — pool (worktree management) + view (terminal + sidebar HUD)
- [Agent Lifecycle](./agent.md) — spawn, prompt, self-review, hooks
- [Harness Configuration](./harness.md) — multi-harness support (pi, opencode, claude, codex)
- [Logging](./logging.md) — structured logging, debugging
- [Testing](./testing.md) — setup, strategy
- [GitHub](./github.md) — PR creation, merge detection
- [Pi Extension](./pi-extension.md) — optional pi tool + /tasks command

## Overview

The dashboard has two modules users switch between:

```
┌─────────────────────────────────────────────────────┐
│                   Task Manager                      │
│  Task list, status, create/cancel/merge, polling    │
│                                                     │
│  ── w ──▶  Workspace (per task)                     │
│            ┌────────────┬──────────────────────┐    │
│            │ Sidebar    │ Terminal              │    │
│            │ (context   │ (agent session)       │    │
│            │  HUD)      │                       │    │
│            └────────────┴──────────────────────┘    │
│         ◀── Esc ──                                  │
└─────────────────────────────────────────────────────┘

Task sessions (one per task):
┌─────────────────────────┐  ┌─────────────────────────┐
│ coffee/login-fix        │  │ coffee/password-reset   │
│ ┌─────────────────────┐ │  │ ┌─────────────────────┐ │
│ │ Agent (pi/claude/…) │ │  │ │ Agent (pi/claude/…) │ │
│ └─────────────────────┘ │  │ └─────────────────────┘ │
└─────────────────────────┘  └─────────────────────────┘
```

**Task Manager** — manage tasks: create, spawn, cancel, merge, monitor status. See [dashboard.md](./dashboard.md).

**Workspace** — isolated environment for a task: pool management + view (terminal + sidebar HUD). Users spend most time in the view. See [workspace.md](./workspace.md).

**Session naming:** `<project>/<branch>` for task sessions.

## Flow

1. **Run `orange`** from project directory (auto-registers if needed)
2. **Dashboard opens**: Create tasks, monitor progress
3. **Agents spawn**: One tmux session + worktree + agent per task
4. **Agents work**: Visible in dashboard (includes self-review loop)
5. **Agent stops**: Review passed → status becomes `reviewing`
6. **Human reviews**: Attach to session, review, merge

## Components

| Component | Description |
|-----------|-------------|
| CLI + Dashboard | Unified binary — CLI commands and TUI dashboard |
| Skills | Agent skills (installed to harness skills dir, see [harness.md](./harness.md)) |

## Modules

| Module | Responsibility |
|--------|----------------|
| args | CLI argument parsing |
| commands | CLI command handlers (project, task, workspace, install, log) |
| dashboard | TUI: task manager (list, create, polling) + workspace (terminal, sidebar HUD) |
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
| task | Core task operations (create) shared between CLI and dashboard |
| tmux | tmux session abstraction (real + mock) |
| workspace | Workspace pool management |

## Startup

1. `orange` from any directory
2. If in git repo: auto-registers project if not in `projects.json`, shows project-scoped dashboard
3. If not in git repo: shows global dashboard (all projects)
4. Use `orange --all` for global view, `orange --project <name>` for specific project

## Decisions

1. **Single user** — no multi-user support
2. **Storage** — file-based (TASK.md is source of truth)
3. **Workspace pool** — reuse worktrees, don't delete
4. **Merge workflow** — support both local merge and PR
5. **Self-review** — agent uses /code-review skill internally
6. **CWD-aware CLI** — commands infer project from current directory
7. **Lazy workspace init** — worktrees created on-demand at first spawn
8. **Dependency injection** — all external deps (tmux, git, clock, logger) injected for testability
9. **Dashboard-driven polling** — auto-behaviors (health check, PR sync, future auto-spawn) require dashboard open; no background daemon
