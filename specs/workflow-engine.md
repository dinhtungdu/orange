# Workflow Engine

Configurable state machine that drives task lifecycle. Replaces hardcoded transitions with declarative workflow definitions.

Three layers:

1. **Workflow definition** — states, transitions, gates, hooks
2. **Agent protocol** — derived from workflow: what agents write, what they call
3. **Engine** — executes transitions, validates gates, runs hooks

## Workflow Definition

### Location

```
~/orange/workflows/
├── default.yml     # built-in Orange workflow (ships with install)
└── <name>.yml      # user-defined workflows
```

Per-project override in `projects.json`:

```json
{
  "name": "coffee",
  "path": "/Users/tung/workspace/coffee",
  "default_branch": "main",
  "pool_size": 2,
  "workflow": "minimal"
}
```

Missing `workflow` field → `default`. Unknown name → error on task create.

### Schema

```yaml
name: default
version: 1

states:
  pending:
    terminal: false
  clarification:
    terminal: false
  working:
    terminal: false
  agent-review:
    terminal: false
  reviewing:
    terminal: false
  stuck:
    terminal: false
  done:
    terminal: true
  cancelled:
    terminal: true

transitions:
  - from: pending
    to: working
    hooks:
      - action: acquire_workspace
      - action: spawn_agent
        prompt: worker
        harness: task         # use task.harness
        permissions: full

  - from: pending
    to: clarification
    hooks:
      - action: acquire_workspace
      - action: spawn_agent
        prompt: clarification
        harness: task
        permissions: full

  - from: pending
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace

  - from: clarification
    to: working
    hooks: []

  - from: clarification
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace

  - from: working
    to: agent-review
    gate:
      section: "## Handoff"
      required: true
    hooks:
      - action: kill_session
      - action: spawn_agent
        prompt: reviewer
        harness: review       # use task.review_harness
        permissions: reduced
        increment: review_round

  - from: working
    to: clarification
    hooks: []

  - from: working
    to: stuck
    hooks: []

  - from: working
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace

  - from: agent-review
    to: reviewing
    gate:
      section: "## Review"
      verdict: PASS
    hooks:
      - action: kill_session

  - from: agent-review
    to: working
    gate:
      section: "## Review"
      verdict: FAIL
    when: "review_round < 2"
    hooks:
      - action: kill_session
      - action: spawn_agent
        prompt: worker_fix
        harness: task
        permissions: full

  - from: agent-review
    to: stuck
    gate:
      section: "## Review"
      verdict: FAIL
    when: "review_round >= 2"
    hooks:
      - action: kill_session

  - from: agent-review
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace

  - from: reviewing
    to: done
    hooks:
      - action: release_workspace
      - action: spawn_next

  - from: reviewing
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace

  - from: stuck
    to: working
    hooks:
      - action: spawn_agent
        prompt: stuck_fix
        harness: task
        permissions: full

  - from: stuck
    to: agent-review
    hooks:
      - action: spawn_agent
        prompt: reviewer
        harness: review
        permissions: reduced
        increment: review_round

  - from: stuck
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace

exit_monitoring:
  poll_interval: 30

  rules:
    - status: working
      has_artifact:
        section: "## Handoff"
      then: agent-review

    - status: working
      no_artifact: true
      action: crash
      stuck_after: 2

    - status: agent-review
      has_artifact:
        section: "## Review"
        verdict: PASS
      then: reviewing

    - status: agent-review
      has_artifact:
        section: "## Review"
        verdict: FAIL
      then_when:
        - when: "review_round < 2"
          then: working
        - when: "review_round >= 2"
          then: stuck

    - status: agent-review
      no_artifact: true
      action: crash
      stuck_after: 2

    - status: clarification
      action: mark_dead

    - status: reviewing
      action: mark_dead

    - status: stuck
      action: mark_dead

prompts:
  worker: |
    # Task: {summary}

    Project: {project}
    Branch: {branch}

    Steps:
    1. Read TASK.md — summary in frontmatter, context in body
    2. If branch is orange-tasks/<id>, rename: git branch -m <old> <meaningful-name> && orange task update --branch
    3. If empty/vague summary: add ## Questions to TASK.md, set --status clarification, wait
    4. If no ## Context: document plan in ## Notes before coding
    5. Read project rules (AGENTS.md, etc.), implement, test, commit
    6. Write ## Handoff to TASK.md (DONE/REMAINING/DECISIONS/UNCERTAIN)
    7. orange task update --status agent-review (triggers review agent)

    IMPORTANT:
    - Do NOT push to remote (no git push) — human handles that
    - Do NOT set --status reviewing directly — always use agent-review
    - ALWAYS write ## Handoff to TASK.md before setting --status agent-review
      (the command will fail if ## Handoff is missing)

    Read the orange skill for full details.

  worker_fix: |
    # Fixing Issues: {summary}

    Project: {project}
    Branch: {branch}
    Review round: {review_round}

    Steps:
    1. Read ## Review in TASK.md — it contains specific feedback
    2. Fix each issue raised
    3. Update ## Handoff with what you changed
    4. orange task update --status agent-review

    IMPORTANT:
    - Do NOT push to remote (no git push) — human handles that
    - Do NOT set --status reviewing directly — always use agent-review
    - ALWAYS write ## Handoff to TASK.md before setting --status agent-review
      (the command will fail if ## Handoff is missing)

    Read the orange skill for full details.

  reviewer: |
    # Review Task: {summary}

    Project: {project}
    Branch: {branch}
    Review round: {review_round} of 2

    You MUST write a ## Review section to TASK.md body BEFORE setting status.

    Steps:
    1. Read TASK.md for requirements and ## Handoff for implementation state
    2. Review diff: git diff origin/HEAD...HEAD
    3. Check ## Handoff UNCERTAIN items — flag any that affect correctness
    4. Write ## Review to TASK.md with verdict (PASS/FAIL) and specific feedback
    5. Then set status based on verdict and round

    IMPORTANT:
    - Do NOT post comments or reviews to GitHub
    - Do NOT set status without writing ## Review first
      (the command will fail if ## Review is missing)
    - Save ALL feedback to TASK.md only

    Read the orange skill for detailed review agent instructions.

  clarification: |
    # Task: {summary}

    Project: {project}
    Branch: {branch}

    The task requirements are unclear. Write ## Questions to TASK.md with
    2-3 specific questions, then wait for the user to attach and discuss.

    After discussion:
    1. Update task summary: orange task update --summary "..."
    2. Document approach in ## Notes
    3. Resume: orange task update --status working

  stuck_fix: |
    # Resuming Stuck Task: {summary}

    Project: {project}
    Branch: {branch}
    Review round: {review_round}

    This task was stuck — either review failed twice or crashes occurred.
    Read ## Review and ## Handoff for context on what went wrong.

    Steps:
    1. Read TASK.md thoroughly
    2. Address the issues that caused stuck state
    3. Write ## Handoff with what you changed
    4. orange task update --status agent-review
```

## Gates

Artifact gates validate TASK.md content before allowing a transition.

### Gate Schema

```yaml
gate:
  section: "## Handoff"       # markdown section must exist and be non-empty
  required: true               # section must have content (not just the heading)
```

```yaml
gate:
  section: "## Review"
  verdict: PASS                # first line matching /\b(PASS|FAIL)\b/i must match
```

### Gate Validation

```typescript
interface Gate {
  section: string;             // e.g., "## Handoff", "## Review"
  required?: boolean;          // section must be non-empty
  verdict?: "PASS" | "FAIL";  // scan section for verdict line
}

function validateGate(gate: Gate, taskBody: string): { valid: boolean; error?: string }
```

**Parsing**: split body by `## ` headings, find matching section, check content.

**Verdict extraction**: scan section lines for first match of `/\b(PASS|FAIL)\b/i`.

### Gate Enforcement Points

1. **CLI** (`orange task update --status`) — validate before writing. Fail → error message, exit 1. Agent sees error, can fix and retry.
2. **Exit monitoring** — validate before auto-advancing. Fail → treat as crash.

## Hooks

Declarative side effects on transitions. Executed in order after gate validation passes and status is written.

### Action Vocabulary

| Action | Params | What |
|--------|--------|------|
| `acquire_workspace` | — | Bind worktree to task |
| `release_workspace` | — | Unbind worktree, reset to default branch |
| `spawn_agent` | `prompt`, `harness`, `permissions`, `increment?` | Create tmux session/window, run harness |
| `kill_session` | — | Kill tmux session |
| `spawn_next` | — | Pop next pending task for project, spawn it |
| `push_branch` | — | Push task branch to remote |
| `create_pr` | — | Push + `gh pr create` |
| `delete_remote_branch` | — | Remove remote branch |

### spawn_agent Params

| Param | Type | Description |
|-------|------|-------------|
| `prompt` | string | Key into `prompts` section of workflow |
| `harness` | `"task"` \| `"review"` | Use `task.harness` or `task.review_harness` |
| `permissions` | `"full"` \| `"reduced"` | Maps to harness `spawnCommand` or `respawnCommand` |
| `increment` | string? | Frontmatter field to increment before spawn (e.g., `review_round`) |

### Execution Order

```
1. Validate gate (if defined)
2. Write new status to TASK.md
3. Execute hooks in array order
4. Log history event
```

Hook failure after status write: log error, mark task for attention. Don't roll back status — TASK.md is already updated. Idempotent hooks preferred.

### Future Actions

| Action | Description |
|--------|-------------|
| `notify` | Send notification (desktop, webhook) |
| `run_command` | Arbitrary shell command |
| `set_field` | Update frontmatter field |

## Conditional Transitions

When multiple transitions share the same `from → to` pair, `when` disambiguates.

```yaml
when: "review_round < 2"
```

### Expression Language

Minimal — only frontmatter field comparisons:

```
<field> <op> <value>
```

- `field`: any numeric frontmatter field (`review_round`, `crash_count`)
- `op`: `<`, `>`, `<=`, `>=`, `==`, `!=`
- `value`: integer literal

Evaluated against task frontmatter at transition time.

### Resolution

For a given `from → to`:
1. Collect all matching transitions
2. Filter by `when` (if present)
3. Exactly one must match. Zero → error (no valid transition). Multiple → error (ambiguous).

## Agent Protocol

The agent protocol is **derived** from the workflow definition. Agents don't know about workflows — they follow a fixed contract per state.

### What agents know

From their prompt:
1. What artifact to write (e.g., `## Handoff`, `## Review`)
2. What CLI command to call (e.g., `orange task update --status agent-review`)
3. That the command will reject if the artifact is missing

### What agents don't know

- The workflow definition
- What hooks run after their command
- Whether exit monitoring exists
- What state they'll be in after the transition

### Contract enforcement

The CLI is the enforcement boundary. When an agent calls `orange task update --status X`:

```
1. Load workflow for task's project
2. Find transition(s) from current status to X
3. Evaluate when clauses to find matching transition
4. Validate gate (if present)
5. Write status
6. Execute hooks
7. Log history
```

Agent gets success or a clear error message. No ambiguity.

### Prompt generation

The engine generates prompts from the workflow's `prompts` section with variable substitution:

| Variable | Source |
|----------|--------|
| `{summary}` | `task.summary` |
| `{project}` | `task.project` |
| `{branch}` | `task.branch` |
| `{review_round}` | `task.review_round` |
| `{status}` | `task.status` |

## Exit Monitoring

Dashboard health check (30s poll) detects dead agent processes and applies deterministic rules from the workflow.

### Detection

`tmux list-sessions` compared against tasks with `tmux_session` set. Session gone + task in active state → dead.

### Rule Evaluation

Rules in `exit_monitoring.rules` are matched by current task status:

```yaml
- status: working
  has_artifact:
    section: "## Handoff"
  then: agent-review          # auto-advance
```

- `has_artifact` / `no_artifact` — check TASK.md content
- `then` — target status (triggers full transition with hooks)
- `then_when` — conditional target (evaluates when clauses)
- `action: crash` — increment `crash_count`, check `stuck_after` threshold
- `action: mark_dead` — no auto-advance, show ✗ in dashboard

### Crash Tracking

```yaml
crash_count: 0    # in TASK.md frontmatter, reset on successful transition
```

When `action: crash`:
1. Increment `crash_count`
2. If `crash_count >= stuck_after` → transition to `stuck`
3. Else → mark dead, user can respawn

## Workflow Validation

On load, validate:

1. All `to` targets in transitions exist in `states`
2. All `from` sources exist in `states`
3. No transitions from terminal states
4. All `prompt` references in `spawn_agent` hooks exist in `prompts`
5. All `then` targets in exit monitoring rules exist in `states`
6. No duplicate `from + to + when` combinations
7. `when` expressions parse correctly

Fail loudly on invalid workflow — don't silently ignore errors.

## Engine Interface

```typescript
interface WorkflowEngine {
  /** Load and validate workflow for a project */
  loadWorkflow(projectName: string): Promise<Workflow>;

  /** Attempt a transition. Validates gate, writes status, runs hooks. */
  transition(task: Task, to: TaskStatus, deps: Deps): Promise<TransitionResult>;

  /** Apply exit monitoring rules for a dead session. */
  handleDeadSession(task: Task, deps: Deps): Promise<void>;

  /** Generate prompt for a state's agent. */
  buildPrompt(task: Task, promptKey: string): string;
}

interface TransitionResult {
  success: boolean;
  error?: string;            // gate failure, illegal transition
  hooksExecuted: string[];   // for debugging
  hookErrors: string[];      // non-fatal hook failures
}
```

## Default Workflow

The YAML above **is** the default workflow — it encodes the current Orange behavior:

- 8 states (pending → done/cancelled)
- Worker → review → fix cycle (max 2 rounds)
- Artifact gates on Handoff and Review
- Exit monitoring with crash tracking
- State-specific prompts

Users can copy `default.yml`, modify states/transitions/prompts, save as `custom.yml`, set `"workflow": "custom"` in project config.

## Example: Minimal Workflow

No review loop, no clarification. Worker implements, human reviews.

```yaml
name: minimal
version: 1

states:
  pending:
    terminal: false
  working:
    terminal: false
  reviewing:
    terminal: false
  done:
    terminal: true
  cancelled:
    terminal: true

transitions:
  - from: pending
    to: working
    hooks:
      - action: acquire_workspace
      - action: spawn_agent
        prompt: worker
        harness: task
        permissions: full

  - from: working
    to: reviewing
    gate:
      section: "## Handoff"
      required: true
    hooks:
      - action: kill_session

  - from: reviewing
    to: done
    hooks:
      - action: release_workspace
      - action: spawn_next

  - from: pending
    to: cancelled
    hooks:
      - action: release_workspace
  - from: working
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace
  - from: reviewing
    to: cancelled
    hooks:
      - action: kill_session
      - action: release_workspace

exit_monitoring:
  poll_interval: 30
  rules:
    - status: working
      has_artifact:
        section: "## Handoff"
      then: reviewing
    - status: working
      no_artifact: true
      action: crash
      stuck_after: 2
    - status: reviewing
      action: mark_dead

prompts:
  worker: |
    # Task: {summary}

    Project: {project}
    Branch: {branch}

    Steps:
    1. Read TASK.md
    2. Implement, test, commit
    3. Write ## Handoff to TASK.md
    4. orange task update --status reviewing

    Do NOT push to remote.
```

## Migration

### From Hardcoded to Engine

Current code has transitions/hooks scattered across:
- `src/cli/commands/task.ts` — status validation, auto-spawn on `agent-review`
- `src/core/spawn.ts` — workspace acquisition, tmux session creation
- `src/dashboard/state.ts` — health check, orphan cleanup
- `src/core/agent.ts` — prompt generation

Migration path:
1. Create `src/core/workflow.ts` — load, validate, resolve transitions
2. Create `src/core/engine.ts` — `transition()`, `handleDeadSession()`, `buildPrompt()`
3. Refactor `task.ts` update command → call `engine.transition()`
4. Refactor `spawn.ts` → `acquire_workspace` and `spawn_agent` become hook executors
5. Refactor `state.ts` health check → call `engine.handleDeadSession()`
6. Refactor `agent.ts` → prompts loaded from workflow definition
7. Ship `default.yml` that encodes current behavior — zero behavior change

### Backward Compatibility

- Existing tasks without `workflow` field use `default` workflow
- `crash_count` defaults to 0 if missing in frontmatter
- All current CLI commands work unchanged — engine is internal
