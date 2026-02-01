# Flows

End-to-end workflows in Orange.

## Status Reference

| Status | Description |
|--------|-------------|
| `pending` | Created, not spawned |
| `clarification` | Agent waiting for user input |
| `working` | Agent actively working |
| `reviewing` | Self-review passed, awaiting human |
| `reviewed` | Human approved, ready to merge |
| `stuck` | Agent gave up after max attempts |
| `done` | Merged/completed |
| `failed` | Errored |
| `cancelled` | User cancelled |

## 1. Orchestrator Flow

User requests work → orchestrator breaks down → agents execute in parallel.

```
User in terminal: "Add auth with login, logout, password reset"
    ↓
Orchestrator analyzes codebase
    ↓
Creates tasks:
    - add-login "Implement login form"
    - add-logout "Implement logout"
    - password-reset "Add password reset flow"
    ↓
Agents spawn in parallel worktrees
    ↓
Monitor: orange task list
    ↓
Tasks reach reviewing → notify user
```

**Orchestrator responsibilities:**
- Understand user request
- Break into independent, parallel tasks
- Pass context to agents
- Monitor progress
- Notify user when tasks need attention

## 2. Worker Flow

Agent receives task → evaluates → implements → self-reviews → completes.

```
Spawn with TASK.md
    ↓
Read task description + context
    ↓
Evaluate clarity ─── vague? ──→ Clarification Flow
    ↓ clear
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
- `pending` → `working` (on spawn)
- `working` → `reviewing` (self-review passed)
- `working` → `stuck` (gave up)

## 3. Clarification Flow

Agent encounters ambiguity → asks questions → waits for user → continues.

```
Agent finds task vague OR scope expands mid-work
    ↓
Add ## Questions to TASK.md body
    ↓
orange task update --status clarification
    ↓
Agent waits in session
    ↓
User attaches (dashboard Enter key)
    ↓
Discussion in session
    ↓
Update ## Notes with clarified requirements
    ↓
orange task update --status working
    ↓
Continue implementation
```

**Triggers:**
- Ambiguous requirements
- Missing context
- Multiple valid interpretations
- Discovered scope larger than expected

**Status transitions:**
- `working` → `clarification` (agent asks)
- `clarification` → `working` (user answers)

## 4. Interactive Session Flow

Task created without description → agent spawns in interactive mode.

```
orange task create (no description)
    ↓
Agent spawns with no prompt
    ↓
User attaches to session
    ↓
User describes work
    ↓
Agent updates task:
    - Rename branch to meaningful name
    - Set description
    ↓
Normal Worker Flow
```

**Use cases:**
- Exploratory work
- Requirements emerge during conversation
- Pair programming with agent

## 5. Review & Merge Flow

Task ready for review → human reviews → approves → merges.

```
Task status: reviewing
    ↓
Dashboard shows task
    ↓
Human attaches (Enter) to review changes
    ↓
Satisfied? ─── no ──→ Discuss with agent, iterate
    ↓ yes
Approve (a key)
    ↓
Status: reviewed
    ↓
Push + create PR (if gh available)
    ↓
Merge:
    - GitHub: merge PR on GitHub
    - Local: merge (m key)
    ↓
Cleanup: release workspace, kill session, delete remote branch
    ↓
Status: done
```

**Status transitions:**
- `reviewing` → `reviewed` (human approves)
- `reviewed` → `reviewing` (unapprove, undo)
- `reviewed` → `done` (merged)

## 6. Respawn Flow

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

## 7. PR Flow

Integration with GitHub via `gh` CLI.

### Create PR

```
Task status: reviewed
    ↓
Create PR (p key or orange task create-pr)
    ↓
Push branch to remote
    ↓
Create PR:
    - Title: task description first line
    - Body: description + context + repo template
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

## 8. Cancel Flow

User cancels active task.

```
Task active (pending/clarification/working/reviewing/reviewed/stuck)
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

## 9. Reactivate Flow

Revive cancelled or failed task.

```
Task status: cancelled or failed
    ↓
Enter key in dashboard
    ↓
Spawn agent (acquires workspace, creates session)
    ↓
Status: working
```

## Status State Machine

```
          ┌──────────────────────────────────────────┐
          │                                          │
          ▼                                          │
      pending ──────────────────────────────────► cancelled
          │                                          ▲
          ▼                                          │
      working ◄────────► clarification               │
          │                    │                     │
          ├────────────────────┤                     │
          ▼                    ▼                     │
       stuck              reviewing ─────────────────┤
          │                    │                     │
          ▼                    ▼                     │
       failed             reviewed ──────────────────┤
                               │
                               ▼
                             done
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
