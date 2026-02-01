# Autonomous Task Orchestration (DRAFT)

> **Status**: Draft — planning for future implementation

## Overview

Enable agents to break down large tasks into sub-tasks with dependency tracking. Self-executing task graph with automatic spawning.

## Data Model

### New Fields

| Field | Type | Description |
|-------|------|-------------|
| `blocked_by` | `string[]` | Task IDs that must complete first |
| `parent` | `string \| null` | Parent task ID (if sub-task) |
| `children` | `string[]` | Child task IDs (if delegated) |

### New Status

`delegated` — task spawned sub-tasks, waiting for them to complete.

```
pending → working → delegated → done (auto)
              ↓
          reviewing → reviewed → done
              ↓
            stuck
```

### TASK.md Examples

```yaml
# Task with dependency
---
id: def456
blocked_by: [abc123]
status: pending
---

# Parent task (delegated)
---
id: abc123
status: delegated
children: [def456, ghi789]
workspace: null
tmux_session: null
---

# Child task
---
id: def456
parent: abc123
blocked_by: []
status: working
---
```

## CLI

```bash
# Create task with dependency
orange task create oauth-api "endpoints" --blocked-by <id>

# Create task with explicit parent
orange task create oauth-db "schema" --parent <id>

# Worker delegates
orange task update --status delegated

# List ready tasks only
orange task list --ready
```

## Behaviors

### Ready Task

A task is **ready** when:
- Status is `pending`
- All `blocked_by` tasks have status `done`

### Auto-Spawn

Poll checks for ready tasks. Spawns up to available pool slots.

### Delegated Transition

When worker sets `--status delegated`:
- Release workspace
- Kill tmux session
- Task remains visible in dashboard

### Auto-Complete

Poll checks delegated tasks. When all children have status `done`, parent automatically transitions to `done`.

### Parent Auto-Linking

When creating task with `--parent`:
- Child's `parent` field set
- Parent's `children` array updated

When creating task from within a workspace (worker context):
- Parent auto-detected from current task

## Validation

On task create:
- `blocked_by` IDs must exist
- `blocked_by` must be same project (no cross-project)
- No circular dependencies

## Flows

### Phase 1: Orchestrator Creates Task Graph

```
User: "Add OAuth with DB, API, and UI"
    │
    ▼
Orchestrator creates:
    orange task create oauth-db "schema"
    orange task create oauth-api "endpoints" --blocked-by <db-id>
    orange task create oauth-ui "button" --blocked-by <api-id>
    │
    ▼
oauth-db ready (no blockers) → spawns
    │
    ▼
oauth-db done → oauth-api ready → spawns
    │
    ▼
oauth-api done → oauth-ui ready → spawns
    │
    ▼
oauth-ui done → all tasks complete
```

### Phase 2: Worker Delegation

```
Worker on "Add OAuth" (working)
    │
    ├── creates oauth-db
    ├── creates oauth-api (blocked by db)
    └── creates oauth-ui (blocked by api)
    │
    ▼
Worker runs: orange task update --status delegated
    │
    ▼
Workspace released, session killed
    │
    ▼
"Add OAuth" shows as delegated (0/3)
    │
    │   oauth-db ready → spawns
    │   oauth-db done → oauth-api ready → spawns
    │   oauth-api done → oauth-ui ready → spawns
    │   oauth-ui done
    │
    ▼
All children done → "Add OAuth" auto-completes
```

## Dashboard

Delegated tasks show progress: `delegated (2/3)`

Display options:
- Nested: children indented under parent
- Flat: parent column shows relationship

## Edge Cases

| Case | Behavior |
|------|----------|
| Child cancelled/failed | Parent stays delegated (manual intervention) |
| Parent deleted | Children continue independently |
| Nested delegation | Supported (child can delegate further) |
| Circular dependency | Error on create |
| Cross-project dependency | Error on create |
| Pool exhausted | Ready tasks wait for available slot |

## Phases

### Phase 1: Flat Dependencies (Orchestrator Only)

Orchestrator creates task graphs with sequencing. Workers implement tasks but don't break down.

- `blocked_by` field
- Ready task query
- Auto-spawn on poll
- `--blocked-by` flag
- `orange task list --ready`

### Phase 2: Worker Delegation

Workers can break down large tasks into sub-tasks. Full parent-child tracking with auto-complete.

- `parent` and `children` fields
- `delegated` status
- Auto-complete delegated parents
- `--parent` flag
- Auto-detect parent from workspace context
- Dashboard progress display
- Skill update: workers can delegate

## Future Ideas

### Execution Modes

**Sequential**: One task at a time, reassess after each completion.

**Parallel**: Execute full DAG with max concurrency.

### Hierarchical Branch Model

Sub-tasks branch from and merge to parent branch instead of main. Single PR for aggregate review.
