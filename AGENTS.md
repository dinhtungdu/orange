# Orange

Agent orchestration. TS + opentui + tmux + SQLite.

## Related Projects

- opentui: `~/workspace/pi-mono/packages/tui/` — TUI framework (@opentui/core)

## Setup

1. Read `specs/architecture.md`
2. `bun install`
3. `orange install` — symlink skill to ~/.claude/skills/
4. `bun run check` before commit

## Structure

```
src/cli/        # commands
src/dashboard/  # TUI (opentui)
src/core/       # state, tmux, workspace
skills/         # orchestrator skill
```

## Key Files

- `~/orange/workspaces/` — worktree pool
- `~/orange/tasks/<project>/<branch>/` — TASK.md + history.jsonl
- tmux: `<project>/<branch>`

## Status

```
pending → working → reviewing → reviewed → done
                              ↘ stuck
                 ↘ failed (crashed/errored)
cancelled (from any active state)
```

## Rules

- No `any`
- Commits: `type(scope): msg`
- Just run `git commit` — pre-commit hook runs `bun run check` (tsc + tests)
- Don't run tests twice (no need for `bun run check` before commit)
- **Specs sync**: whenever you add, change, or delete a function/command/keybinding, update the corresponding spec in `specs/` to match. Specs are the source of truth for design — keep them accurate.

## Testing

- Bun test runner, colocated unit tests (`*.test.ts`)
- Dependency injection for mocking (tmux, git, clock)

## Parallel Agents

- Add specific files only (no `git add -A`)
- No destructive git (`reset --hard`, `checkout .`, `clean -fd`)
