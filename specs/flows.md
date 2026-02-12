# Flows

End-to-end workflows in Orange.

## Status Reference

| Status | Description |
|--------|-------------|
| `pending` | Created, not spawned |
| `clarification` | Agent waiting for user input |
| `working` | Agent actively implementing |
| `agent-review` | Review agent evaluating work |
| `reviewing` | Agent review passed, awaiting human review/merge |
| `stuck` | Failed after 2 review rounds or 2 crashes in review |
| `done` | Merged/completed |
| `cancelled` | User cancelled or errored |

## 1. Orchestrator Flow

User requests work → orchestrator clarifies → plans → agents execute in parallel.

```
User in terminal: "Add auth with login, logout, password reset"
    ↓
Refine: ask 2-3 clarifying questions about scope, edge cases,
acceptance criteria. Don't plan until answers are clear.
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
- Refine vague requests — ask questions, don't assume. Wait for answers before planning.
- Build actionable plan for each task (worker executes from TASK.md)
- Never create tasks from vague requests
- Break into independent, parallel tasks
- Pass plan as context to agents
- Monitor progress
- Notify user when tasks need attention

## 2. Worker Flow

Agent receives task → evaluates → implements → hands off to review.

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
Set --status agent-review
    ↓
(worker done — review agent auto-spawned, see Agent Review Flow)
```

**Status transitions:**
- `pending` → `working` (on spawn with summary)
- `pending` → `clarification` (on spawn without summary)
- `working` → `agent-review` (implementation done)

## 3. Agent Review Flow

Separate review agent evaluates worker's changes.

```
Worker sets --status agent-review
    ↓
CLI auto-spawns review agent
  - New agent session in same tmux session (new named window)
  - Harness: review_harness (default: claude)
  - review_round incremented
    ↓
Review agent:
  - Reads diff (branch vs default branch)
  - Reads TASK.md (summary, context, notes)
  - Uses PR review toolkit if available
  - Writes ## Review section to TASK.md
    ↓
┌─────────┴─────────┐
Pass               Fail
↓                   ↓
reviewing          working (feedback in ## Review)
                     ↓
                   Worker auto-respawned
                   (reads ## Review, fixes, sets agent-review)
                     ↓
                   Review agent spawned again (round 2)
                     ↓
                   ┌──────┴──────┐
                   Pass        Fail
                   ↓             ↓
                   reviewing    stuck
```

**Status transitions (all via CLI `orange task update --status`):**
- `working` → `agent-review` (CLI auto-spawns review agent in new window)
- `agent-review` → `reviewing` (review passed)
- `agent-review` → `working` (review failed, round < 2; CLI auto-respawns worker in new window)
- `agent-review` → `stuck` (review failed, round 2)

**Tmux windows:**
- Each agent session gets a named window: `worker`, `review-1`, `worker-2`, `review-2`
- Windows are kept open (agent process stays running but idle)
- Named windows allow future cleanup/targeting

**Crash handling:**
- Review agent crashes in `agent-review` → respawn review agent, same round
- 2 crashes in `agent-review` within same round → `stuck`

**Task frontmatter fields:**
- `review_harness`: harness for review agent (default: `claude`)
- `review_round`: current review round (0–2), incremented on each review spawn

**Review prompt:**
- Focused on diff review against TASK.md requirements
- Instructs agent to use PR review toolkit if available
- Writes `## Review` section to TASK.md with verdict + feedback
- Sets `--status reviewing` (pass) or `--status working` (fail)
- On round 2 failure, sets `--status stuck`

**Merge gate:**
- From `reviewing`: normal merge
- From any other status: force confirm — "Not reviewed. Force merge?"

## 4. Clarification Flow

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

## 5. Review & Merge Flow

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

**Merge gate:**
- From `reviewing`: normal merge
- From any other active status: force confirm — "Not reviewed. Force merge?"

**Status transitions:**
- `reviewing` → `done` (merged)

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
┌──────────────┬────────────────┬──────────────┬──────────────┐
reviewing      stuck/working     clarification   agent-review
↓              ↓                 ↓               ↓
Ready for      Continue work     Wait for user   Respawn review
human review                                     agent (same round)
```

**Session states:**
- ● active (tmux alive)
- ✗ crashed (tmux died, task active)
- ○ inactive (no session expected)

## 7. PR Flow

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

### Auto-Cancel on PR Close

Dashboard polls PR status. When PR closed without merge, auto-cancels task (kills session, releases workspace, status → `cancelled`).

## 8. Cancel Flow

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
Release workspace (if bound, no auto-spawn)
    ↓
Status: cancelled (terminal, not respawnable)
```

**Note:** Unlike merge/done, cancellation does not auto-spawn the next pending task. If you need to restart the same work, create a new task.

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
          ├──► agent-review ──► reviewing ───────────┤
          │         │               │                │
          │         ▼               ▼                │
          │       stuck           done               │
          │         ↑                                │
          │         │                                │
          └─────────┘                                │
              (review fail → fix → review again)
```

## Transition Enforcement

Autonomous state advancement with deterministic gating. Agents produce artifacts and signal intent, the orchestrator validates and executes transitions.

**Principles:**
1. Agents write artifacts, orchestrator gates transitions — agents never decide their own fate
2. Artifact-gated — transitions require specific sections in TASK.md before they're allowed
3. Two advancement paths — CLI commands (synchronous, agent-initiated) and exit monitoring (asynchronous, orchestrator-initiated)
4. Deterministic parsing — orchestrator reads TASK.md sections, doesn't trust agent claims

### Transition Map

Valid transitions. Any transition not in this map is rejected.

```
pending       → working, clarification, cancelled
clarification → working, cancelled
working       → agent-review, clarification, stuck, cancelled
agent-review  → reviewing, working, stuck, cancelled
reviewing     → done, cancelled
stuck         → working, agent-review, cancelled
done          → (terminal)
cancelled     → (terminal)
```

Enforced in `orange task update --status`. Reject with error if transition is illegal.

### Artifact Gates

Certain transitions require artifacts to exist in TASK.md before they're allowed. The orchestrator parses the markdown body — it doesn't trust that the agent "said" it wrote something.

| Transition | Required Artifact | Validation |
|------------|-------------------|------------|
| `working → agent-review` | `## Handoff` section | Section exists and is non-empty |
| `agent-review → reviewing` | `## Review` with PASS | Section exists, verdict line contains `PASS` |
| `agent-review → working` | `## Review` with FAIL | Section exists, verdict line contains `FAIL` |
| `agent-review → stuck` | `## Review` with FAIL | Section exists, verdict line contains `FAIL` (round ≥ 2) |

All other transitions have no artifact gate (they're gated by status alone).

#### Artifact Parsing

Parse TASK.md body (below frontmatter) for sections:

```typescript
interface TaskArtifacts {
  hasHandoff: boolean;      // ## Handoff section exists and non-empty
  hasReview: boolean;       // ## Review section exists and non-empty
  reviewVerdict: "pass" | "fail" | null;  // extracted from ## Review
}
```

**Verdict extraction**: Scan `## Review` section for first line matching `/\b(PASS|FAIL)\b/i`. This is the verdict. If no match, verdict is `null` (treated as incomplete review).

#### Gate Enforcement

Validation runs in two places:

1. **CLI commands** (`orange task update --status`, `orange task complete`) — validate before writing status
2. **Exit monitoring** (dashboard health check) — validate before auto-advancing

On validation failure:
- CLI: print error, exit non-zero (agent sees the error, can fix and retry)
- Exit monitoring: treat as crash (no artifact = agent didn't finish properly)

### Exit Monitoring

Dashboard health check (30s poll) detects when agent processes die. When a tmux session is gone but the task is in an active state, the orchestrator reads TASK.md and applies deterministic rules.

#### Detection

Already implemented in `captureOutputs()`:
- `tmux list-sessions` → compare against tasks with `tmux_session` set
- Session gone + task in active state → dead session detected

#### Auto-Advance Rules

When a dead session is detected for a task:

**Status: `working`**
```
Parse TASK.md:
  has ## Handoff?
    yes → auto-transition to agent-review, spawn review agent
    no  → crash
      crash_count >= 2? → transition to stuck
      else → stay working, mark dead in UI (user can respawn)
```

**Status: `agent-review`**
```
Parse TASK.md:
  has ## Review with verdict?
    PASS → auto-transition to reviewing
    FAIL + round < 2 → auto-transition to working, spawn worker
    FAIL + round >= 2 → auto-transition to stuck
    no verdict → crash
      crash_count >= 2? → transition to stuck
      else → stay agent-review, mark dead in UI, auto-respawn review agent
```

**Status: `clarification`** — No auto-advance. Mark dead in UI. User must respawn manually.

**Status: `reviewing`** — No auto-advance. Mark dead in UI. Human review needed.

**Status: `stuck`** — No auto-advance. Mark dead in UI. Needs human intervention.

#### Auto-Advance Execution

```
1. Parse TASK.md, validate artifacts
2. Update task status (same as CLI path)
3. Log history event: { type: "auto.advanced", from, to, reason }
4. Spawn next agent if needed (review agent or worker)
5. Clear dead session marker
```

Reuses the same transition logic as CLI commands — validation, side effects, history logging.

### Crash Tracking

New field in TASK.md frontmatter:

```yaml
crash_count: 0    # reset on each successful status transition
```

**Increment**: when agent process exits without producing required artifacts.

**Reset**: on any successful status transition (the agent did its job).

**Threshold**: 2 crashes in same status → auto-transition to `stuck`.

History event:
```jsonl
{"type": "agent.crashed", "timestamp": "...", "status": "working", "crash_count": 1, "reason": "process exited without ## Handoff"}
```

### Implementation

#### Changes by File

**`src/core/types.ts`**
- Add `crash_count: number` to `Task` interface

**`src/core/state.ts`**
- Add `crash_count` to TASK.md frontmatter serialization
- Default to 0 on read

**`src/core/transitions.ts`** (new)
- `ALLOWED_TRANSITIONS` map
- `ARTIFACT_GATES` map
- `validateTransition(task, newStatus): { valid: boolean; error?: string }`
- `parseTaskArtifacts(taskMdBody: string): TaskArtifacts`
- `extractReviewVerdict(reviewSection: string): "pass" | "fail" | null`

**`src/cli/commands/task.ts`**
- `updateTask`: call `validateTransition()` before applying status change
- `completeTask`: call `validateTransition()` before applying
- Reset `crash_count` to 0 on successful status transition

**`src/dashboard/state.ts`**
- `captureOutputs()` → extend with auto-advance logic
- On dead session detection: call `autoAdvance(task)` instead of just marking dead
- `autoAdvance(task)`:
  1. Parse TASK.md artifacts
  2. Apply exit monitoring rules
  3. If auto-advancing: transition + spawn
  4. If crash: increment crash_count, save, check threshold

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
