# Orange

Agent orchestration. TS + pi-tui + tmux + SQLite.

## Setup

1. Read `specs/architecture.md`
2. `bun install`
3. `bun run dev <command>` — run during development
4. `bun run check` before commit

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

```
pending → working → needs_human → done
                 ↘ stuck (gave up after 3 reviews)
                 ↘ failed (crashed/errored)
```

## Rules

- No `any`
- `bun run check` before commit
- Integration tests preferred
- Commits: `type(scope): msg`

## Testing

- Bun test runner, colocated unit tests (`*.test.ts`)
- Dependency injection for mocking (tmux, git, clock)
- `bun run check` = tsc + tests

## Parallel Agents

- Add specific files only (no `git add -A`)
- No destructive git (`reset --hard`, `checkout .`, `clean -fd`)
