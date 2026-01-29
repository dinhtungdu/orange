# Dependency DAG for Task Orchestration (DRAFT)

> **Status**: Draft — not implementing now, capturing ideas from Beads study

## Problem

Orchestrator agent needs to coordinate multiple tasks with dependencies. Task 2 can't start until Task 1 completes.

## Proposed Solution

Minimal addition to task model:

```typescript
interface Task {
  // existing fields...
  blockedBy?: string[]  // task IDs that must complete first
}
```

Ready front query:

```typescript
function getReadyTasks(tasks: Task[]): Task[] {
  return tasks.filter(t => 
    t.status === 'pending' && 
    (t.blockedBy ?? []).every(id => 
      tasks.find(b => b.id === id)?.status === 'done'
    )
  )
}
```

## CLI Extensions

```bash
orange create "Setup auth" --project foo
orange create "Add endpoints" --project foo --blocked-by <task-id>
orange list --ready  # only shows unblocked pending tasks
```

## Orchestrator Pattern

```
Orchestrator Agent
    ↓ creates tasks with dependencies
    ↓ monitors status
    ↓ starts ready tasks
    ↓ creates follow-up tasks as needed
```

Graph lives in orchestrator's behavior, not shared infrastructure. Each task stays isolated.

## What We Learned from Beads

**Worth stealing**:
- `blockedBy` field
- `getReadyTasks()` query
- "Ready front" pattern — dependency DAG determines what's workable

**Not needed**:
- Hash IDs (no multi-writer conflict in our model)
- JSONL/git sync (SQLite sufficient, single machine)
- Molecules/wisps (overkill for our use case)
- Compaction (tasks are small)
- Shared mutable state across agents (worktree isolation sidesteps this)

## Key Insight

> If an issue needs multiple agents, the issue is too big — break it down.

Good issue decomposition eliminates the coordination problem Beads solves with infrastructure. Orange model: human or orchestrator breaks work into right-sized chunks, each chunk = 1 agent = 1 worktree.

## Other Ideas from Beads

**1. Session handoff format**
Structured notes in TASK.md:
```
COMPLETED: X
IN PROGRESS: Y  
NEXT: Z
BLOCKER: (if any)
```
Survives context loss. Could formalize as TASK.md template.

**2. `--json` on everything**
Every command outputs JSON for programmatic use. Orange has this partially — worth being consistent across all commands.

**3. Stale detection**
`bd doctor` finds orphaned/stale issues. Orange could detect stuck tasks (working for N hours with no git activity).

**4. Close reason**
```typescript
interface Task {
  closeReason?: string  // "completed" | "cancelled" | "duplicate" | ...
}
```
Useful for post-mortems, understanding failure patterns.

## Open Questions

- Schema change: add `blocked_by TEXT` column (JSON array) or separate table?
- Transitive blocking through parent-child relationships?
- How does orchestrator agent get created/managed?
