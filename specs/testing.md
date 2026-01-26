# Testing

## Setup

- **Runtime:** Bun
- **Test runner:** Bun's built-in test runner
- **Location:** Unit tests colocated (`*.test.ts`), integration tests in `src/__tests__/`

```bash
bun test              # run all
bun test --watch      # watch mode
bun test --coverage   # coverage report
bun run check         # tsc + tests (run before commit)
```

**package.json:**
```json
{
  "scripts": {
    "test": "bun test",
    "test:watch": "bun test --watch",
    "test:coverage": "bun test --coverage",
    "check": "tsc --noEmit && bun test"
  }
}
```

## Strategy

### 1. Dependency Injection

Design for testability—inject dependencies, don't hardcode.

```typescript
// src/core/types.ts
export interface TmuxExecutor {
  newSession(name: string, cwd: string, command: string): Promise<void>;
  killSession(name: string): Promise<void>;
  sessionExists(name: string): Promise<boolean>;
  capturePane(session: string, lines: number): Promise<string>;
}

export interface GitExecutor {
  fetch(cwd: string): Promise<void>;
  checkout(cwd: string, branch: string): Promise<void>;
  resetHard(cwd: string, ref: string): Promise<void>;
  createBranch(cwd: string, branch: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Deps {
  tmux: TmuxExecutor;
  git: GitExecutor;
  clock: Clock;
  dataDir: string;  // ~/orange or temp dir for tests
}
```

Swap real implementations for mocks in tests:

```typescript
// Production
const app = new Orange({ tmux: new RealTmux(), git: new RealGit(), ... });

// Test
const app = new Orange({ tmux: new MockTmux(), git: new MockGit(), ... });
```

### 2. Test Categories

| Type | What | How |
|------|------|-----|
| Unit | Individual functions, classes | Mock all deps, fast |
| Integration | Multi-component flows | Temp dirs, mock tmux/git |

### 3. Key Scenarios to Cover

- Task lifecycle: create → spawn → complete → merge
- Task lifecycle: create → spawn → stuck → cancel
- Workspace pool: acquire, release, exhaustion
- Concurrent operations: locking, race conditions
- State persistence: history.jsonl events, index.db rebuild
- Error handling: invalid states, missing files

### 4. Test Isolation

- Each test uses fresh temp directory for `dataDir`
- Cleanup in `afterEach`
- No shared mutable state between tests

## Example Test

```typescript
// src/core/workspace.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { WorkspacePool } from './workspace';
import { MockGit } from '../__tests__/mocks/git';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('WorkspacePool', () => {
  let dataDir: string;
  let pool: WorkspacePool;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'orange-test-'));
    pool = new WorkspacePool({ dataDir, git: new MockGit() });
    await pool.init('test', { poolSize: 2, repoPath: '/repo' });
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true });
  });

  it('acquires available workspace', async () => {
    const ws = await pool.acquire('test');
    expect(ws.name).toMatch(/^test--\d+$/);
  });

  it('throws when pool exhausted', async () => {
    await pool.acquire('test');
    await pool.acquire('test');
    expect(pool.acquire('test')).rejects.toThrow('No available workspace');
  });

  it('releases workspace back to pool', async () => {
    const ws = await pool.acquire('test');
    expect(pool.availableCount('test')).toBe(1);

    await pool.release(ws.name);
    expect(pool.availableCount('test')).toBe(2);
  });
});
```
