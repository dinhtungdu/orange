# Workspace Pool

Git worktrees managed as a reusable pool.

## Initialization

```bash
orange workspace init orange
# Creates ~/orange/workspaces/orange--1, orange--2 (based on pool_size)
```

Each workspace is a git worktree of the source repo:
```bash
git -C /path/to/source worktree add ~/orange/workspaces/orange--1 main
```

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
    // Clean workspace
    execSync(`git -C ${workspacePath} checkout main && git -C ${workspacePath} clean -fd`);

    const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    pool.workspaces[workspace].status = 'available';
    pool.workspaces[workspace].task = null;
    fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
  } finally {
    await release();
  }

  // Auto-spawn next pending task for this project
  await spawnNextPending(project);
}

async function spawnNextPending(project: string): Promise<void> {
  const pending = await getTasksByStatus(project, 'pending');
  if (pending.length > 0) {
    await spawnTask(pending[0].id);  // FIFO
  }
}
```

## Notes

- Pool size per project (default: 2)
- Acquired on `spawn`, released on `complete`/`cancel`/`merge`
- **Reused, not deleted** - branch reset on acquire
- Lock file prevents race conditions

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
