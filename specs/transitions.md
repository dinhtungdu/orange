# Deterministic State Transitions

Autonomous state advancement with deterministic gating. The orchestrator owns the state machine — agents produce artifacts and signal intent, the orchestrator validates and executes transitions.

## Principles

1. **Agents write artifacts, orchestrator gates transitions** — agents never decide their own fate
2. **Artifact-gated** — transitions require specific sections in TASK.md before they're allowed
3. **Two advancement paths** — CLI commands (synchronous, agent-initiated) and exit monitoring (asynchronous, orchestrator-initiated)
4. **Deterministic parsing** — orchestrator reads TASK.md sections, doesn't trust agent claims

## Transition Map

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

## Artifact Gates

Certain transitions require artifacts to exist in TASK.md before they're allowed. The orchestrator parses the markdown body — it doesn't trust that the agent "said" it wrote something.

| Transition | Required Artifact | Validation |
|------------|-------------------|------------|
| `working → agent-review` | `## Handoff` section | Section exists and is non-empty |
| `agent-review → reviewing` | `## Review` with PASS | Section exists, verdict line contains `PASS` |
| `agent-review → working` | `## Review` with FAIL | Section exists, verdict line contains `FAIL` |
| `agent-review → stuck` | `## Review` with FAIL | Section exists, verdict line contains `FAIL` (round ≥ 2) |

All other transitions have no artifact gate (they're gated by status alone).

### Artifact Parsing

Parse TASK.md body (below frontmatter) for sections:

```typescript
interface TaskArtifacts {
  hasHandoff: boolean;      // ## Handoff section exists and non-empty
  hasReview: boolean;       // ## Review section exists and non-empty
  reviewVerdict: "pass" | "fail" | null;  // extracted from ## Review
}
```

**Verdict extraction**: Scan `## Review` section for first line matching `/\b(PASS|FAIL)\b/i`. This is the verdict. If no match, verdict is `null` (treated as incomplete review).

### Gate Enforcement

Validation runs in two places:

1. **CLI commands** (`orange task update --status`, `orange task complete`) — validate before writing status
2. **Exit monitoring** (dashboard health check) — validate before auto-advancing

On validation failure:
- CLI: print error, exit non-zero (agent sees the error, can fix and retry)
- Exit monitoring: treat as crash (no artifact = agent didn't finish properly)

## Agent API

Agents use these constrained commands. The general `--status` flag is still available but validated.

### Worker Commands

```bash
# Done implementing — triggers review
orange task update --status agent-review
# Equivalent shorthand:
orange task complete [task_id]

# Need user input
orange task update --status clarification
```

Worker prompt enforces: write `## Handoff` before setting `agent-review`.

### Review Agent Commands

```bash
# Review passed
orange task update --status reviewing

# Review failed (round < 2 — worker will be respawned)
orange task update --status working

# Review failed (round ≥ 2 — terminal)
orange task update --status stuck
```

Review agent prompt enforces: write `## Review` with verdict before setting status.

### Validation on CLI

When `orange task update --status <new>` is called:

```
1. Load task, get current status
2. Check transition is in ALLOWED_TRANSITIONS[current]
3. If artifact gate exists for this transition:
   a. Parse TASK.md body
   b. Check required section exists
   c. For review transitions: check verdict matches
4. If validation fails → error message, exit 1
5. If validation passes → apply transition, trigger side effects
```

## Exit Monitoring

Dashboard health check (30s poll) detects when agent processes die. When a tmux session is gone but the task is in an active state, the orchestrator reads TASK.md and applies deterministic rules.

### Detection

Already implemented in `captureOutputs()`:
- `tmux list-sessions` → compare against tasks with `tmux_session` set
- Session gone + task in active state → dead session detected

### Auto-Advance Rules

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

**Status: `clarification`**
```
No auto-advance. Mark dead in UI.
User must respawn manually (agent was waiting for input).
```

**Status: `reviewing`**
```
No auto-advance. Mark dead in UI.
Human review is needed — agent just assists.
```

**Status: `stuck`**
```
No auto-advance. Mark dead in UI.
Already terminal-ish — needs human intervention.
```

### Auto-Advance Execution

When exit monitoring decides to auto-advance:

```
1. Parse TASK.md, validate artifacts
2. Update task status (same as CLI path)
3. Log history event: { type: "auto.advanced", from, to, reason }
4. Spawn next agent if needed (review agent or worker)
5. Clear dead session marker
```

This reuses the same transition logic as CLI commands — validation, side effects, history logging.

## Crash Tracking

New field in TASK.md frontmatter:

```yaml
crash_count: 0    # reset on each successful status transition
```

**Increment**: when agent process exits without producing required artifacts.

**Reset**: on any successful status transition (the agent did its job).

**Threshold**: 2 crashes in same status → auto-transition to `stuck`.

### History Event

```jsonl
{"type": "agent.crashed", "timestamp": "...", "status": "working", "crash_count": 1, "reason": "process exited without ## Handoff"}
```

## State-Specific Agent Prompts

Each state has a focused prompt. Agents receive only the instructions relevant to their current role — no ambiguity about what to do or what artifacts to produce.

### Worker Prompt (working)

```
You are implementing a task.

Task: {summary}
Branch: {branch}

Instructions:
1. Read TASK.md for requirements (## Context, ## Notes)
2. Implement, test, commit
3. When done, write ## Handoff to TASK.md:
   DONE: what you completed
   REMAINING: what's left (if any)
   DECISIONS: choices you made and why
   UNCERTAIN: open questions
4. Run: orange task update --status agent-review

Rules:
- Do NOT push to remote
- Do NOT set --status reviewing (always use agent-review)
- You MUST write ## Handoff before setting status
  (the command will fail if ## Handoff is missing)
```

### Worker Respawn Prompt (working, review_round > 0)

```
You are fixing issues found in review.

Task: {summary}
Branch: {branch}
Review round: {review_round}

Instructions:
1. Read ## Review in TASK.md — it contains specific feedback
2. Fix each issue raised
3. Update ## Handoff with what you changed
4. Run: orange task update --status agent-review

Rules:
- Do NOT push to remote
- Do NOT set --status reviewing (always use agent-review)
- You MUST write ## Handoff before setting status
  (the command will fail if ## Handoff is missing)
```

### Review Agent Prompt (agent-review)

```
You are reviewing implementation quality.

Task: {summary}
Branch: {branch}
Review round: {review_round} of 2

Instructions:
1. Read TASK.md for requirements (summary, ## Context)
2. Read ## Handoff for what was done and any uncertainties
3. Review: git diff origin/HEAD...HEAD
4. Write ## Review to TASK.md:
   - Start with verdict: PASS or FAIL
   - List specific issues (if FAIL)
   - Note what was done well
5. Set status:
   - PASS: orange task update --status reviewing
   - FAIL: orange task update --status {working|stuck based on round}

Rules:
- You MUST write ## Review with a PASS or FAIL verdict before setting status
  (the command will fail if ## Review is missing or has no verdict)
- Do NOT post comments to GitHub
- Save ALL feedback to TASK.md only
```

### Clarification Prompt (clarification)

```
You are waiting for user input on this task.

Task: {summary}
Branch: {branch}

The task requirements are unclear. Write ## Questions to TASK.md with
2-3 specific questions, then wait for the user to attach and discuss.

After discussion:
1. Update task summary: orange task update --summary "..."
2. Document approach in ## Notes
3. Resume: orange task update --status working
```

### Stuck Respawn Prompt (stuck)

```
You are resuming a stuck task.

Task: {summary}
Branch: {branch}
Review round: {review_round}

This task was stuck — either review failed twice or crashes occurred.
Read ## Review and ## Handoff for context on what went wrong.

Instructions:
1. Read TASK.md thoroughly
2. Address the issues that caused stuck state
3. Write ## Handoff with what you changed
4. Run: orange task update --status agent-review
```

## Implementation

### Changes by File

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

**`src/core/agent.ts`**
- Replace `buildAgentPrompt` with state-specific prompt builders
- Each prompt tells the agent exactly what artifacts to write
- Include "(the command will fail if X is missing)" to set expectations

**`src/dashboard/state.ts`**
- `captureOutputs()` → rename to `healthCheck()` or extend
- On dead session detection: call `autoAdvance(task)` instead of just marking dead
- `autoAdvance(task)`:
  1. Parse TASK.md artifacts
  2. Apply exit monitoring rules (from table above)
  3. If auto-advancing: transition + spawn
  4. If crash: increment crash_count, save, check threshold

### Migration

`crash_count` defaults to 0 if missing — existing tasks work without changes.

Transition validation is additive — existing tasks in legal states are unaffected. Tasks in illegal states (shouldn't exist) would need manual status fix.

## Sequence Diagram

### Happy Path (fully autonomous)

```
Worker spawns (working)
    │
    ├── implements code
    ├── writes ## Handoff
    ├── calls: orange task update --status agent-review
    │     └── CLI validates ## Handoff exists ✓
    │     └── CLI transitions working → agent-review
    │     └── CLI spawns review agent
    │
Review agent spawns (agent-review)
    │
    ├── reviews diff
    ├── writes ## Review (PASS)
    ├── calls: orange task update --status reviewing
    │     └── CLI validates ## Review with PASS ✓
    │     └── CLI transitions agent-review → reviewing
    │
Task is now reviewing — human takes over
```

### Exit Without Signal (auto-advance)

```
Worker spawns (working)
    │
    ├── implements code
    ├── writes ## Handoff
    ├── process exits (crash, timeout, whatever)
    │
Dashboard health check (30s)
    │
    ├── detects dead session
    ├── reads TASK.md → finds ## Handoff ✓
    ├── auto-transitions working → agent-review
    ├── spawns review agent
    │
Review agent runs normally...
```

### Exit Without Artifact (crash)

```
Worker spawns (working)
    │
    ├── starts implementing
    ├── process crashes mid-work (no ## Handoff)
    │
Dashboard health check (30s)
    │
    ├── detects dead session
    ├── reads TASK.md → no ## Handoff
    ├── increments crash_count (1)
    ├── marks dead in UI (user sees ✗)
    │
User presses Enter → respawn
    │
Worker respawns, reads ## Handoff (from previous session if any)
    │
    ├── continues work...
```

### Double Crash (stuck)

```
Worker crashes twice without ## Handoff
    │
Dashboard detects second crash
    ├── crash_count reaches 2
    ├── auto-transitions working → stuck
    ├── user notified via dashboard
```
