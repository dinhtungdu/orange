# Workspace Pool

Git worktrees managed as a reusable pool.

## Initialization

**Explicit init (optional):**
```bash
cd ~/workspace/coffee
orange workspace init
# Creates ~/orange/workspaces/coffee--1, coffee--2 (based on pool_size)
```

**Lazy init (automatic):**
Workspaces are created on-demand when `orange task spawn` is called and no workspace is available:
```bash
orange task spawn abc123
# If no workspace exists: creates coffee--1, then uses it
# If pool exhausted: creates coffee--N (up to pool_size)
```

Each workspace is a git worktree of the source repo, created with detached HEAD:
```bash
git -C /path/to/source worktree add --detach ~/orange/workspaces/coffee--1 origin/main
```

**Why detached?** Git doesn't allow the same branch to be checked out in multiple worktrees. Since the user runs `orange start` from the project directory (which has `main` checked out), we can't create worktrees that also checkout `main`. Using `--detach` at `origin/main` avoids this limitation.

On creation, each worktree also gets `.claude/settings.local.json` with agent permissions.

## Pool Status

```
~/orange/workspaces/
├── orange--1/           # bound to: orange/dark-mode
├── orange--2/           # available
├── coffee--1/           # bound to: coffee/login-fix
└── .pool.json           # pool state
```

**.pool.json:**
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

```typescript
async function acquireWorkspace(project: string): Promise<string> {
  const release = await lockfile.lock(POOL_LOCK);
  try {
    const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    const available = Object.entries(pool.workspaces)
      .find(([name, info]) => name.startsWith(project) && info.status === 'available');
    if (!available) throw new Error(`No available workspace for ${project}`);

    pool.workspaces[available[0]].status = 'bound';
    fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
    return available[0];
  } finally {
    await release();
  }
}
```

## Release

```typescript
async function releaseWorkspace(workspace: string): Promise<void> {
  const release = await lockfile.lock(POOL_LOCK);
  try {
    // Fail if workspace has uncommitted changes
    if (await git.isDirty(workspacePath)) {
      throw new Error("Workspace has uncommitted changes");
    }

    // Clean workspace - reset to origin/default_branch, clean untracked
    await git.fetch(workspacePath);
    await git.resetHard(workspacePath, `origin/${defaultBranch}`);
    await git.clean(workspacePath);

    pool.workspaces[workspace] = { status: 'available' };
  } finally {
    await release();
  }

  // Auto-spawn next pending task for this project (FIFO)
  await spawnNextPending(project);
}
```

## Notes

- Pool size per project (default: 2)
- Acquired on `spawn`, released on `complete`/`cancel`/`merge`
- **Reused, not deleted** - branch reset on acquire
- Lock file prevents race conditions
- **Lazy init** - worktrees created on first spawn, not on `orange start`

## tmux Abstraction

```typescript
interface TmuxExecutor {
  newSession(name: string, cwd: string, command: string): void;
  killSession(name: string): void;
  listSessions(): Session[];
  sessionExists(name: string): boolean;
  capturePane(session: string, lines: number): string;
  sendKeys(session: string, keys: string): void;
}

class RealTmux implements TmuxExecutor {
  newSession(name: string, cwd: string, command: string) {
    execSync(`tmux new-session -d -s "${name}" -c "${cwd}" "${command}"`);
  }
  capturePane(session: string, lines: number): string {
    return execSync(`tmux capture-pane -t "${session}" -p | tail -${lines}`).toString();
  }
  // ...
}

class MockTmux implements TmuxExecutor { /* for testing */ }
```

**Session naming convention:** `<project>/<branch>` (e.g., `orange/dark-mode`)
