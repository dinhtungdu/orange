# Flows

End-to-end workflows in Orange.

## Status Reference

| Status | Description |
|--------|-------------|
| `pending` | Created, not spawned |
| `clarification` | Agent waiting for user input |
| `working` | Agent actively working |
| `reviewing` | Self-review passed, awaiting human review/merge |
| `stuck` | Agent gave up after max attempts |
| `done` | Merged/completed |
| `cancelled` | User cancelled or errored |

## 1. Orchestrator Flow

User requests work → orchestrator clarifies → plans → agents execute in parallel.

```
User in terminal: "Add auth with login, logout, password reset"
    ↓
Clarify ambiguities (ask questions if needed)
    ↓
Build plan for each task (concise but actionable)
    ↓
Creates tasks with plan in context:
    - add-login "Implement login form" --context "## Plan\n1. Create LoginForm component\n2. ..."
    - add-logout "Implement logout" --context "## Plan\n1. Add logout button\n2. ..."
    - password-reset "Add password reset flow" --context "## Plan\n1. Create ResetForm\n2. ..."
    ↓
Agents spawn in parallel worktrees
    ↓
Monitor: orange task list
    ↓
Tasks reach reviewing → notify user
```

**Orchestrator responsibilities:**
- Clarify ambiguous requests before proceeding
- Build actionable plan for each task (worker executes from TASK.md)
- Break into independent, parallel tasks
- Pass plan as context to agents
- Monitor progress
- Notify user when tasks need attention

## 2. Worker Flow

Agent receives task → evaluates → implements → self-reviews → completes.

```
Spawn with TASK.md
    ↓
Read task summary + context
    ↓
Evaluate clarity ─── empty/vague? ──→ Clarification Flow
    ↓ clear
No ## Context? ─── yes ──→ Document plan in ## Notes
    ↓
Read project rules (AGENTS.md, etc.)
    ↓
Implement (code, test, commit)
    ↓
Scope expands? ─── yes ──→ Clarification Flow
    ↓ no
Self-review (max 2 attempts)
    ↓
┌─────────┴─────────┐
Pass               Fail
↓                   ↓
reviewing          stuck
```

**Status transitions:**
- `pending` → `working` (on spawn with summary)
- `pending` → `clarification` (on spawn without summary)
- `working` → `reviewing` (self-review passed)
- `working` → `stuck` (gave up)

## 3. Clarification Flow

Agent encounters ambiguity → asks questions → waits for user → continues.

```
Empty/vague summary OR scope expands mid-work
    ↓
Add ## Questions to TASK.md body
(e.g., "What would you like to work on?")
    ↓
orange task update --status clarification
    ↓
Agent waits in session
    ↓
User attaches (dashboard Enter key)
    ↓
Discussion in session
    ↓
Update summary and/or ## Notes with clarified requirements
    ↓
orange task update --summary "..." --status working
    ↓
Continue implementation
```

**Triggers:**
- Empty summary (no requirements)
- Ambiguous requirements
- Missing context
- Multiple valid interpretations
- Discovered scope larger than expected

**Status transitions:**
- `pending` → `clarification` (empty summary)
- `working` → `clarification` (agent asks)
- `clarification` → `working` (user answers)

## 4. Review & Merge Flow

Task ready for review → human reviews → merges.

```
Task status: reviewing
    ↓
Dashboard shows task
    ↓
Human attaches (Enter) to review changes
    ↓
Satisfied? ─── no ──→ Discuss with agent, iterate
    ↓ yes
Either:
    - Create PR (p key) → merge on GitHub later
    - Merge directly (m key)
    ↓
Cleanup: release workspace, kill session, delete remote branch
    ↓
Status: done
```

**Status transitions:**
- `reviewing` → `done` (merged)

## 5. Respawn Flow

Session dies unexpectedly → human respawns → agent continues.

```
Dashboard shows ✗ (crashed session)
    ↓
Human presses Enter
    ↓
Respawn in existing workspace
    ↓
Agent reads TASK.md, checks status
    ↓
┌──────────────────────┬────────────────┬──────────────┐
reviewing              stuck/working     clarification
↓                      ↓                 ↓
Stop (nothing to do)   Continue work     Wait for user
```

**Session states:**
- ● active (tmux alive)
- ✗ crashed (tmux died, task active)
- ○ inactive (no session expected)

## 6. PR Flow

Integration with GitHub via `gh` CLI.

### Create PR

```
Task status: reviewing
    ↓
Create PR (p key or orange task create-pr)
    ↓
Push branch to remote
    ↓
Create PR:
    - Title: task summary
    - Body: summary + context + repo template
    ↓
Store PR URL in task
```

### Merge with PR

```
Task has PR
    ↓
Merge (m key)
    ↓
Check PR status on GitHub
    ↓
┌─────────────┬─────────────┬──────────────┐
Merged        Open          Closed
↓             ↓             ↓
Skip local    Error         Error
merge         (merge on GH) (closed w/o merge)
    ↓
Cleanup (release workspace, delete remote branch)
    ↓
Status: done
```

### Auto-Merge Detection

Dashboard polls PR status. When PR merged externally, auto-triggers cleanup.

## 7. Cancel Flow

User cancels active task.

```
Task active (pending/clarification/working/reviewing/stuck)
    ↓
Cancel (x key or orange task cancel)
    ↓
Confirm prompt
    ↓
Kill tmux session (if exists)
    ↓
Release workspace (if bound)
    ↓
Status: cancelled
```

## 8. Reactivate Flow

Revive cancelled task.

```
Task status: cancelled
    ↓
Enter key in dashboard
    ↓
Spawn agent (acquires workspace, creates session)
    ↓
Status: working (or clarification if empty summary)
```

## Status State Machine

```
          ┌──────────────────────────────────────────┐
          │                                          │
          ▼                                          │
      pending ──────────────────────────────────► cancelled
          │                                          ▲
          ├───────────► clarification                │
          ▼                   ↕                      │
      working ◄───────────────┘                      │
          │                                          │
          ├──────────────────────────────────────────┤
          ▼                                          │
       stuck                                         │
          │                                          │
          │              reviewing ──────────────────┤
          │                    │
          │                    ▼
          └──────────────►   done
```

## Future: Delegation Flow (Phase 2)

Worker breaks down large task into sub-tasks.

```
Worker on large task (working)
    ↓
Creates sub-tasks with dependencies
    ↓
orange task update --status delegated
    ↓
Workspace released, session killed
    ↓
Sub-tasks auto-spawn (respecting blocked_by)
    ↓
Sub-tasks complete
    ↓
Parent auto-completes (status: done)
```

See [drafts/autonomous-task-orchestration.md](./drafts/autonomous-task-orchestration.md).
