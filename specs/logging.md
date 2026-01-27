# Logging

Structured logging for debugging. Separate from user-facing output.

## Design

1. **Separate from user output** — `stdout` for users, log file for debugging
2. **Single log file** — easy to tail and search
3. **Structured format** — JSON lines
4. **Contextual** — component tag per module
5. **Log levels** — filter noise
6. **Testable** — injected via deps, mockable

## Log Location

```
~/orange/orange.log         # Main log file
~/orange/orange.log.1       # Rotated (when > 10MB)
```

## Log Format

JSON Lines:
```jsonl
{"ts":"2024-01-15T10:00:00.123Z","level":"info","component":"workspace","msg":"Workspace acquired","workspace":"coffee--1"}
{"ts":"2024-01-15T10:00:05.000Z","level":"error","component":"git","msg":"Failed to fetch","error":"Connection refused"}
```

## Log Levels

| Level | When |
|-------|------|
| `error` | Operation failed, needs attention |
| `warn` | Unexpected but recoverable |
| `info` | Key operations (spawn, merge, status change) |
| `debug` | Detailed flow (function entry/exit, state) |

Default: `info`. Configurable via `ORANGE_LOG_LEVEL` env var.

## Components

| Module | Tag | What it logs |
|--------|-----|--------------|
| CLI entry | `cli` | Command invocation, exit |
| Task commands | `task` | Create, spawn, complete, merge, cancel |
| Workspace | `workspace` | Acquire, release, init |
| tmux | `tmux` | Session create/kill |
| Git | `git` | Commands executed |
| DB | `db` | Queries |
| Spawn | `spawn` | Agent spawn lifecycle |
| Dashboard | `dashboard` | Key operations, errors |

## Logger Interface

- `error(msg, context?)`, `warn(msg, context?)`, `info(msg, context?)`, `debug(msg, context?)`
- `child(component)` — create child logger with component tag

Mock logger collects entries for test assertions.

## CLI

```bash
orange log                          # Tail log
orange log --level error            # Filter by level
orange log --component workspace    # Filter by component
orange log --grep "Failed"          # Search
orange log --lines 100              # Last N lines
```
