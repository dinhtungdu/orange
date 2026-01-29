# Workspace Pool

Git worktrees managed as a reusable pool.

## Initialization

**Explicit:** `orange workspace init` creates worktrees based on `pool_size`.

**Lazy (automatic):** Worktrees created on-demand when spawning if none available.

Each workspace is a git worktree created with detached HEAD at `origin/<default_branch>`. Detached because git doesn't allow the same branch checked out in multiple worktrees.

Harness-specific setup happens at spawn time (not worktree creation) based on task's harness. See [harness.md](./harness.md) for details.

## Pool State

```
~/orange/workspaces/
├── orange--1/           # bound to: orange/dark-mode
├── orange--2/           # available
├── coffee--1/           # bound to: coffee/login-fix
└── .pool.json
```

`.pool.json`:
```json
{
  "workspaces": {
    "orange--1": {"status": "bound", "task": "orange/dark-mode"},
    "orange--2": {"status": "available"},
    "coffee--1": {"status": "bound", "task": "coffee/login-fix"}
  }
}
```

## Acquisition

1. Lock pool file
2. Find first available workspace for project
3. If none available and under pool_size, create new worktree
4. Mark as bound
5. Release lock

Throws if pool exhausted.

## Release

1. Lock pool file
2. Fail if workspace has uncommitted changes
3. Fetch latest, reset to `origin/<default_branch>`, clean untracked files
4. Remove `.orange-outcome` and `TASK.md` symlink (excluded from git, so `git clean` doesn't remove them)
5. Mark as available
6. Release lock
7. Auto-spawn next pending task for the project (FIFO)

## Notes

- Pool size per project (default: 2)
- Acquired on spawn, released on merge/cancel
- **Reused, not deleted** — branch reset on release
- File lock prevents race conditions
- Naming convention: `<project>--<number>`

## tmux Abstraction

Interface for session management:
- `newSession(name, cwd, command)` — create detached session
- `killSession(name)` — destroy session
- `sessionExists(name)` — check if alive
- `capturePane(session, lines)` — capture terminal output
- `isAvailable()` — check if tmux is installed

Session naming: `<project>/<branch>`

Mock implementation for testing (no real tmux needed).
