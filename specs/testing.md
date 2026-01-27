# Testing

## Strategy

### Dependency Injection

All external dependencies (tmux, git, clock, logger) injected via a `Deps` container. Swap real implementations for mocks in tests.

### Test Categories

| Type | What | How |
|------|------|-----|
| Unit | Individual functions | Mock all deps, fast |
| Integration | Multi-component flows | Temp dirs, mock tmux/git |

Unit tests colocated with source. Integration tests in separate directory.

### Key Scenarios

- Task lifecycle: create → spawn → complete → merge
- Task lifecycle: create → spawn → stuck → cancel
- Workspace pool: acquire, release, exhaustion
- Concurrent operations: locking, race conditions
- State persistence: TASK.md, history.jsonl events
- Error handling: invalid states, missing files

### Test Isolation

- Each test uses fresh temp directory for data
- No shared mutable state between tests

### Mockable Interfaces

- **Git**: branch operations, fetch, merge, diff stats, commit count
- **tmux**: session lifecycle, capture output
- **Clock**: deterministic time for reproducible tests
- **Logger**: collect log entries for assertions
