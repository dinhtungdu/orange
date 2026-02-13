# Architecture

Agent orchestration. Two modules: **Task Manager** (list, create, monitor) and **Workspace** (pool + terminal view). A deterministic workflow engine drives task lifecycle.

## Overview

```
┌─────────────────────────────────────────────────────┐
│                   Task Manager                      │
│  Task list, create, cancel, merge, monitor          │
│                                                     │
│  ── w ──▶  Workspace View (per task)                │
│            ┌────────────┬──────────────────────┐    │
│            │ Sidebar    │ Terminal              │    │
│            │ (context)  │ (agent session)       │    │
│            └────────────┴──────────────────────┘    │
│         ◀── Esc ──                                  │
└─────────────────────────────────────────────────────┘

Agents run in parallel tmux sessions:
┌─────────────────────────┐  ┌─────────────────────────┐
│ coffee/login-fix        │  │ coffee/password-reset    │
│ ┌─────────────────────┐ │  │ ┌─────────────────────┐ │
│ │ Agent (pi/claude/…) │ │  │ │ Agent (pi/claude/…) │ │
│ └─────────────────────┘ │  │ └─────────────────────┘ │
└─────────────────────────┘  └─────────────────────────┘
```

## Specs

| Spec | Scope |
|------|-------|
| [data.md](./data.md) | Storage layout, schemas, status definitions |
| [workflow.md](./workflow.md) | State machine, transitions, agent prompts |
| [task-manager.md](./task-manager.md) | Dashboard task list UI |
| [workspace.md](./workspace.md) | Worktree pool + workspace view |

Supporting: [cli.md](./cli.md), [harness.md](./harness.md), [github.md](./github.md), [logging.md](./logging.md), [testing.md](./testing.md).

## Flow

1. `orange` opens dashboard (task manager)
2. Create tasks — agents spawn in parallel worktrees
3. Agents implement, autonomous review loop runs
4. Tasks reach `reviewing` — human reviews and merges
5. `w` key opens workspace view: terminal + sidebar for live interaction

## Decisions

- Single user, no multi-user
- File-based storage (TASK.md source of truth)
- Deterministic workflow: agents write artifacts, engine validates and gates transitions
- Hardcoded state machine in TypeScript, designed as declarative data structures for future extraction to config
- Workspace pool: reuse worktrees, don't delete
- tmux-backed agent sessions
- Dependency injection for testability
- Dashboard-driven: auto-behaviors require dashboard open, no background daemon
