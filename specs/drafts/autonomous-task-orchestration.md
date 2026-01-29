# Autonomous Task Orchestration (DRAFT)

> **Status**: Draft — capturing ideas from Beads + Ralph study

## Problem

Support fully autonomous agent swarms with no human in loop. Agents need to:
1. Break down big tasks into smaller ones
2. Handle dependencies between tasks
3. Execute in parallel where possible
4. Re-evaluate plan as codebase changes

## Core Ideas

### From Beads: Dependency DAG

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
    (t.blockedBy ?? []).every(id => getTask(id).status === 'done')
  )
}
```

### From Ralph: Self-Executing Graph

When agent finishes:
1. Merge to base branch
2. Status → `done`
3. Check what's now unblocked
4. Spawn those tasks
5. Exit

No central orchestrator babysitting. Graph self-executes.

### Key Insight: Every Agent is an Orchestrator

No special role. Any agent can:
- Work directly (small task)
- Break down → create tasks with `blockedBy` → spawn → let graph self-execute

Same pattern, recursive at any depth.

## Branch Model

```
main
└── feature-oauth        ← human merges when done
    ├── task-1 branch    ← agent merges here
    ├── task-2 branch    ← agent merges here
    └── task-3 branch    ← agent merges here
```

Sub-tasks branch from parent's branch, merge back to parent's branch.

When agent creates sub-tasks:
```bash
orange task create subtask-1 --base $(current_branch) --blocked-by ...
```

## CLI Extensions

```bash
orange task create setup-db "create schema"
orange task create add-api "endpoints" --blocked-by <setup-db-id>
orange task list --ready  # only unblocked pending tasks
```

## Execution Modes

Two valid modes for different use cases:

### Parallel Mode (Speed)

Execute dependency graph with max concurrency:

```bash
orange run --parallel
```

- Plan is static, created upfront
- Tasks independent within dependency constraints
- Multiple agents run simultaneously
- Good when: plan is clear, speed matters

### Sequential Mode (Correctness)

One task at a time, reassess after each (Ralph loop):

```bash
orange run --sequential
```

Each iteration:
1. Re-read codebase state
2. Re-evaluate: "what's most important NOW?"
3. Execute one task
4. Repeat

- Plan evolves as code changes
- Previous tasks might invalidate later ones
- New urgent tasks might emerge
- Good when: exploratory, correctness matters, "run while you sleep"

### Why Sequential Matters

Ralph's insight: after each task, the world changed. The plan made before might be wrong now.

```
task-1 done
  → code changed
  → re-read specs + src
  → re-evaluate what's next
  → maybe task-2 no longer needed
  → maybe new task-5 is urgent
```

Parallel mode assumes static plan. Sequential mode assumes evolving plan.

## What We Don't Need

From Beads:
- Hash IDs (no multi-writer conflict)
- JSONL/git sync (SQLite sufficient)
- Molecules/wisps (overkill)
- Compaction (tasks are small)

From Ralph:
- External bash loop (agents spawn dependents on exit)
- Subagents (each task is real agent with own session)
- specs/ files (TASK.md + codebase is enough)
- IMPLEMENTATION_PLAN.md (dependency graph is the plan)

## What We Keep

From Beads:
- `blockedBy` field
- `getReadyTasks()` query
- Ready front pattern

From Ralph:
- Any agent can break down and spawn
- Self-executing graph
- Context refresh between tasks (each agent = fresh session)
- Sequential reassessment mode

From Orange (already have):
- Worktree isolation
- Feature branch model
- Agents self-merge to base branch
- TASK.md for context survival
- Persistent tmux sessions

## Other Small Ideas

**1. Session handoff format**
Structured notes in TASK.md:
```
COMPLETED: X
IN PROGRESS: Y  
NEXT: Z
BLOCKER: (if any)
```

**2. `--json` on everything**
Consistent JSON output for programmatic use.

**3. Stale detection**
Detect stuck tasks (working for N hours with no git activity).

**4. Close reason**
```typescript
interface Task {
  closeReason?: string  // "completed" | "cancelled" | "duplicate"
}
```

## Ralph ↔ Orange Mapping

| Ralph | Orange |
|-------|--------|
| `IMPLEMENTATION_PLAN.md` | Task DB (`orange task list`) |
| Plan loop → generates plan | Planning mode → creates tasks with dependencies |
| Build loop → picks task, implements | Agent works in worktree |
| "Update IMPLEMENTATION_PLAN.md with findings" | `orange task create` for discovered work |
| "Keep plan current with learnings" | Update task status, create sub-tasks if needed |

The task DB *is* the implementation plan — queryable, with dependency tracking.

Agent behavior (add to orchestrator skill):
- Create tasks for discovered work
- Update own task status throughout operation
- Break down into sub-tasks when stuck

## Open Questions

- Schema: `blocked_by TEXT` column (JSON array) or separate table?
- How does sequential mode decide "what's most important"? Agent reads specs? Human provides goal?
- Auto-spawn on completion: in CLI post-hook or agent responsibility?
