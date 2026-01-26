# Logging

Structured logging for debugging and observability. Debug logs separate from user-facing output.

## Design Goals

1. **Separate from user output** - `console.log` for user-facing, logger for debugging
2. **Single log file** - Easy to tail and search
3. **Structured format** - JSON lines for parsing
4. **Contextual** - Component, task, and operation context
5. **Log levels** - Filter noise during normal operation
6. **Testable** - Injected via Deps, mockable

## Log Location

```
~/orange/orange.log         # Main log file
~/orange/orange.log.1       # Rotated (when > 10MB)
```

## Log Format

JSON Lines format for easy parsing:

```jsonl
{"ts":"2024-01-15T10:00:00.123Z","level":"info","component":"cli","msg":"Command start","command":"task spawn","args":["abc123"]}
{"ts":"2024-01-15T10:00:00.150Z","level":"debug","component":"workspace","msg":"Acquiring workspace","project":"coffee","available":2}
{"ts":"2024-01-15T10:00:00.200Z","level":"info","component":"tmux","msg":"Creating session","session":"coffee/login-fix"}
{"ts":"2024-01-15T10:00:05.000Z","level":"error","component":"git","msg":"Failed to fetch","error":"Connection refused","project":"coffee"}
```

## Log Levels

| Level | When to Use |
|-------|-------------|
| `error` | Operation failed, needs attention |
| `warn` | Unexpected but recoverable |
| `info` | Key operations (spawn, merge, status change) |
| `debug` | Detailed flow (function entry/exit, state) |

Default level: `info` (configurable via `ORANGE_LOG_LEVEL` env var)

## Components

Each module logs with its own tag:

| Module | Tag | What it logs |
|--------|-----|--------------|
| index.ts | `cli` | Command invocation, exit |
| task.ts | `task` | Create, spawn, complete, merge, cancel |
| workspace.ts | `workspace` | Acquire, release, init |
| tmux.ts | `tmux` | Session create/kill |
| git.ts | `git` | Commands executed |
| db.ts | `db` | Queries, rebuild |
| spawn.ts | `spawn` | Agent spawn lifecycle |
| dashboard | `dashboard` | Key operations, errors |

## Interface

```typescript
// src/core/logger.ts

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  [key: string]: unknown;
}

export interface Logger {
  error(msg: string, context?: Record<string, unknown>): void;
  warn(msg: string, context?: Record<string, unknown>): void;
  info(msg: string, context?: Record<string, unknown>): void;
  debug(msg: string, context?: Record<string, unknown>): void;
  child(component: string): Logger;
}
```

## Integration with Deps

Add to `src/core/types.ts`:

```typescript
export interface Deps {
  tmux: TmuxExecutor;
  git: GitExecutor;
  clock: Clock;
  logger: Logger;  // Add logger
  dataDir: string;
}
```

Update `src/core/deps.ts`:

```typescript
export function createDeps(): Deps {
  const dataDir = join(homedir(), "orange");
  return {
    tmux: createTmux(),
    git: createGit(),
    clock: createClock(),
    logger: createLogger({ dataDir }),
    dataDir,
  };
}
```

## Usage Pattern

```typescript
// In workspace.ts
export async function acquireWorkspace(deps: Deps, projectName: string, task: string): Promise<string> {
  const log = deps.logger.child('workspace');

  log.debug('Acquiring workspace', { project: projectName, task });

  // ... existing code ...

  log.info('Workspace acquired', { workspace: name, project: projectName });
  return name;
}
```

## Testing

Mock logger collects entries for assertions:

```typescript
// src/core/logger.ts (MockLogger class)
export class MockLogger implements Logger {
  entries: LogEntry[] = [];
  private component: string;

  constructor(component = 'test') {
    this.component = component;
  }

  private log(level: LogLevel, msg: string, ctx?: Record<string, unknown>) {
    this.entries.push({
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...ctx
    });
  }

  error(msg: string, ctx?: Record<string, unknown>) { this.log('error', msg, ctx); }
  warn(msg: string, ctx?: Record<string, unknown>) { this.log('warn', msg, ctx); }
  info(msg: string, ctx?: Record<string, unknown>) { this.log('info', msg, ctx); }
  debug(msg: string, ctx?: Record<string, unknown>) { this.log('debug', msg, ctx); }

  child(component: string): Logger {
    const child = new MockLogger(component);
    child.entries = this.entries;  // Share entries array
    return child;
  }

  // Test helpers
  clear() { this.entries = []; }
  has(level: LogLevel, msgSubstr: string): boolean {
    return this.entries.some(e => e.level === level && e.msg.includes(msgSubstr));
  }
}
```

## CLI Commands

```bash
# Tail the log (real-time)
orange log

# Filter by level
orange log --level error
orange log --level debug

# Filter by component
orange log --component workspace

# Search
orange log --grep "Failed"

# Last N lines
orange log --lines 100
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORANGE_LOG_LEVEL` | `info` | Minimum level to log |

## What to Log

### info level (default)
- CLI command start/end
- Task status changes
- Workspace acquire/release
- tmux session create/kill

### debug level
- Function entry with parameters
- State before/after operations
- Decision points
- git commands executed

### error level
- All caught exceptions with context
- Operation failures

### warn level
- Recoverable issues (e.g., session already gone when killing)

## Example: Spawning a Task

```jsonl
{"ts":"...","level":"info","component":"cli","msg":"Command start","command":"task","subcommand":"spawn","args":["abc123"]}
{"ts":"...","level":"debug","component":"spawn","msg":"Loading task","taskId":"abc123"}
{"ts":"...","level":"debug","component":"workspace","msg":"Acquiring workspace","project":"coffee"}
{"ts":"...","level":"debug","component":"workspace","msg":"Lock acquired"}
{"ts":"...","level":"info","component":"workspace","msg":"Workspace acquired","workspace":"coffee--1"}
{"ts":"...","level":"debug","component":"git","msg":"Executing","cmd":"fetch","cwd":"/Users/.../coffee--1"}
{"ts":"...","level":"debug","component":"git","msg":"Executing","cmd":"checkout main"}
{"ts":"...","level":"debug","component":"git","msg":"Executing","cmd":"reset --hard origin/main"}
{"ts":"...","level":"debug","component":"git","msg":"Executing","cmd":"checkout -b fix-login"}
{"ts":"...","level":"info","component":"tmux","msg":"Creating session","session":"coffee/fix-login"}
{"ts":"...","level":"info","component":"spawn","msg":"Task spawned","taskId":"abc123","workspace":"coffee--1","session":"coffee/fix-login"}
{"ts":"...","level":"info","component":"cli","msg":"Command end","exitCode":0,"durationMs":1850}
```
