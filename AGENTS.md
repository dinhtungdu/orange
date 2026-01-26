# Orange

Agent orchestration. TS + pi-tui + tmux + SQLite.

## Setup

1. Read `specs/architecture.md`
2. `npm run check` before commit

## Structure

```
src/cli/        # commands
src/dashboard/  # TUI (pi-tui)
src/core/       # state, tmux, workspace
skills/         # orchestrator skill
```

## Key Files

- `~/orange/workspaces/` — worktree pool
- `~/orange/tasks/<project>/<branch>/` — TASK.md + history.jsonl
- tmux: `<project>/<branch>`

## Status

pending → working → needs_human → done (or failed)

## Rules

- No `any`
- `npm run check` before commit
- Integration tests preferred
- Commits: `type(scope): msg`

## Parallel Agents

- Add specific files only (no `git add -A`)
- No destructive git (`reset --hard`, `checkout .`, `clean -fd`)
