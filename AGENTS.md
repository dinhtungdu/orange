# Orange

Agent orchestration. TS + pi-tui + tmux + SQLite.

## Related Projects

- pi-tui: `~/workspace/pi-mono/packages/tui/` — TUI framework

## Setup

1. Read `specs/architecture.md`
2. `bun install`
3. Add alias: `alias orange="bun run ~/workspace/orange/src/index.ts"`
4. `orange install` — symlink skill to ~/.claude/skills/
5. `bun run check` before commit

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
- Commits: `type(scope): msg`
- Just run `git commit` — pre-commit hook runs `bun run check` (tsc + tests)
- Don't run tests twice (no need for `bun run check` before commit)

## Testing

- Bun test runner, colocated unit tests (`*.test.ts`)
- Dependency injection for mocking (tmux, git, clock)

## Parallel Agents

- Add specific files only (no `git add -A`)
- No destructive git (`reset --hard`, `checkout .`, `clean -fd`)
