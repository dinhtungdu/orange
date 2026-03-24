# Workspace

Isolated environment for a task. Manages the worktree pool: allocate, release, reuse.

## Pool

Git worktrees, one per active task. Naming: `<project>--<n>`.

### Initialization

**Lazy** (default): worktrees created on-demand at first spawn.
**Explicit**: `orange workspace init` pre-creates based on `pool_size`.

Each worktree: detached HEAD at `origin/<default_branch>`. Detached because git doesn't allow the same branch in multiple worktrees.

### Acquisition

1. Lock pool file
2. Find available workspace for project
3. If none and under pool_size, create new worktree
4. Mark as bound to task
5. Release lock

Throws if pool exhausted.

### Release

1. Lock pool file
2. Fail if uncommitted changes
3. Fetch, reset to `origin/<default_branch>`, clean untracked
4. Remove TASK.md symlink
5. Mark as available
6. Release lock

Release never auto-spawns. The [spawn_next hook](./workflow.md#hooks) handles that explicitly.

### Configuration

- Pool size per project (default: 2)
- Acquired on spawn, released on merge/cancel
- Reused, not deleted
