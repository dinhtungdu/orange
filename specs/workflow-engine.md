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
    respawn_prompt: worker_respawn
  agent-review:
    terminal: false
    respawn_prompt: reviewer
  reviewing:
    terminal: false
  stuck:
    terminal: false
    respawn_prompt: stuck_fix
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
    hooks: []                 # pending has no session or workspace

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

  # reviewing → done is triggered by the merge command, which handles
  # the actual merge logic (PR check, local merge, push) before calling
  # engine.transition(). The engine only runs post-merge cleanup hooks.
  - from: reviewing
    to: done
    hooks:
      - action: release_workspace
      - action: delete_remote_branch
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

  worker_respawn: |
    # Resuming Task: {summary}

    Project: {project}
    Branch: {branch}
    Status: {status}
    Review round: {review_round}

    Read ## Handoff in TASK.md first — it has structured state from the previous session.

    Continue implementation:
    1. Read TASK.md for context and previous progress
    2. Pick up where the last session left off
    3. Write ## Handoff with updated progress
    4. orange task update --status agent-review

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

## Principles

### Hook Idempotency

All hooks are idempotent. They silently succeed when there's nothing to do:

- `kill_session` — no-op if no tmux session exists
- `release_workspace` — no-op if no workspace is bound
- `acquire_workspace` — error only if pool exhausted (not if already bound)
- `spawn_next` — no-op if no pending tasks

This means transition definitions don't need to track whether a session/workspace exists — they declare intent, and the executor handles the no-op case.

### release_workspace Never Auto-Spawns

`release_workspace` only releases. It never triggers spawning the next pending task. Auto-spawning is always an explicit `spawn_next` hook. This makes the behavior visible in the workflow definition — you can see exactly which transitions spawn the next task.

Current code default (`releaseWorkspace(deps, workspace)` auto-spawns) must change: the engine always calls `releaseWorkspace(deps, workspace, false)` and adds `spawn_next` as a separate hook where needed.

## Task Creation

Task creation is **outside the workflow** — it's a CLI/dashboard operation that produces a task in an initial state. The workflow takes over from there.

Creation sets the initial status based on CLI flags:

| Flag | Initial Status | What Happens |
|------|---------------|--------------|
| (default) | `pending` | Task created, engine transitions `pending → working` on spawn |
| `--status clarification` | `clarification` | Auto-set when summary is empty |
| `--status agent-review` | `agent-review` | For PR review tasks (spawns review agent) |
| `--status reviewing` | `reviewing` | For existing work, no agent spawn |

The spawn command (`orange task spawn`) triggers the appropriate `pending → *` transition. For `--status agent-review`/`reviewing`, the task enters the state directly (no transition from pending).

## Respawn

Respawn is **not a transition** — the task stays in the same status. It re-runs `spawn_agent` for the current state when a session has died and the user manually respawns.

Each state can define a `respawn_prompt` in its state config:

```yaml
states:
  working:
    terminal: false
    respawn_prompt: worker_respawn   # used on manual respawn
  agent-review:
    terminal: false
    respawn_prompt: reviewer         # re-run review agent
  stuck:
    terminal: false
    respawn_prompt: stuck_fix
```

States without `respawn_prompt` cannot be respawned (e.g., `pending`, `reviewing`).

### Respawn Logic

```
1. Check state has respawn_prompt — error if not
2. Check task has workspace — error if not
3. Check tmux session is dead — error if alive
4. Look up respawn_prompt in workflow prompts section
5. Determine harness: use task.harness (for worker states) or task.review_harness (for review states)
6. Spawn agent with the prompt
7. Log history event: agent.respawned
```

The engine provides:

```typescript
interface WorkflowEngine {
  /** Respawn agent in current state. Not a transition. */
  respawn(task: Task, deps: Deps): Promise<void>;
}
```

### Respawn Prompt Selection

The `worker_respawn` prompt covers both fresh crashes (review_round = 0) and post-review crashes (review_round > 0). It tells the agent to read `## Handoff` and `## Review` if present. The prompt has access to `{review_round}` for context.

For `working` with `review_round > 0`: the respawn prompt includes round info, and `## Review` from the previous round is still in TASK.md. The agent reads it and knows to fix those issues.

## The `when` Clause

`when` serves two different purposes depending on context:

### On CLI Transitions: Guard

When an agent calls `orange task update --status X`, the engine finds transitions from current → X. If a matching transition has a `when` clause, it acts as a **guard**: the condition must be true, otherwise the transition is rejected.

```
Agent calls --status working (from agent-review)
  → Engine finds agent-review → working with when: "review_round < 2"
  → If review_round >= 2, transition is rejected
  → Agent gets error: "Transition not allowed: review_round >= 2"
```

If no transitions from current → X exist (with or without `when`), that's an illegal transition error.

If multiple transitions from current → X exist with different `when` clauses, exactly one must pass. Zero passing → guard failure. Multiple passing → ambiguous (validation error at workflow load time should prevent this).

### On Exit Monitoring: Disambiguator

`then_when` in exit monitoring rules picks a target status based on conditions:

```yaml
then_when:
  - when: "review_round < 2"
    then: working
  - when: "review_round >= 2"
    then: stuck
```

The exit monitor evaluates each `when` clause to determine which target status to advance to. Exactly one must match. This then triggers the full transition (with gates and hooks) for that target.

## The Merge Command

`reviewing → done` is special. The merge command (`orange task merge`) handles complex pre-transition logic that doesn't fit into hooks:

1. Check if PR exists and is already merged on GitHub
2. If PR merged → skip local merge
3. If no PR or `--local` → local merge (ff or merge strategy)
4. Push default branch to remote

After the merge logic succeeds, the command calls `engine.transition(task, "done")` which runs the post-merge hooks: `release_workspace`, `delete_remote_branch`, `spawn_next`.

The merge command is the **caller** of the engine, not a hook. This keeps merge logic (which has conditional branches, user flags, error handling) out of the declarative hook system.

Similarly, `orange task create-pr` handles PR creation (push branch, `gh pr create`, store URL) as a command, not a transition.

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
| `release_workspace` | — | Unbind worktree, reset to default branch. Never auto-spawns. |
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
2. Evaluate when clause (if defined) — reject if false
3. Write new status to TASK.md
4. Execute hooks in array order (each idempotent)
5. Log history event
```

Hook failure after status write: log error, mark task for attention. Don't roll back status — TASK.md is already updated.

### Future Actions

| Action | Description |
|--------|-------------|
| `notify` | Send notification (desktop, webhook) |
| `run_command` | Arbitrary shell command |
| `set_field` | Update frontmatter field |

## Conditional Transitions

When multiple transitions share the same `from → to` pair, `when` disambiguates. When a single transition has `when`, it acts as a guard (see [The `when` Clause](#the-when-clause)).

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
2. Evaluate `when` clauses
3. Exactly one must pass. Zero → rejected (guard failure or no valid transition). Multiple → ambiguous (workflow validation error).

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
3. Evaluate when clauses — reject if guard fails
4. Validate gate (if present) — reject if artifact missing
5. Write status
6. Execute hooks (idempotent, in order)
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
  then: agent-review          # auto-advance via engine.transition()
```

- `has_artifact` / `no_artifact` — check TASK.md content
- `then` — target status (triggers full transition via `engine.transition()`, including gates and hooks)
- `then_when` — conditional target (evaluates when clauses to pick target, then triggers full transition)
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

## Dashboard and Custom Workflows

The dashboard reads available transitions from the workflow to determine which keybindings are valid for a task's current state.

### Keybinding Adaptation

```typescript
// Check if a transition exists before showing a key
const canMerge = engine.hasTransition(task.status, "done");
const canCancel = engine.hasTransition(task.status, "cancelled");
const canSpawn = task.status === "pending";  // spawn triggers pending → working
```

Custom workflows that remove states (e.g., no `reviewing`) change which keys appear in the footer. The dashboard doesn't hardcode state names for keybinding visibility — it queries the workflow.

**Fixed keybindings** (always available regardless of workflow):
- `j/k` navigation, `q` quit, `f` filter, `c` create, `w` workspace view, `y` copy ID

**Workflow-dependent keybindings:**
- `m` merge: shown when transition to `done` exists from current state
- `x` cancel: shown when transition to `cancelled` exists from current state
- `p` PR: shown for tasks with workspace (workflow-independent, GitHub integration)
- `Enter` spawn/attach/respawn: shown based on task state + session existence

## Workflow Validation

On load, validate:

1. All `to` targets in transitions exist in `states`
2. All `from` sources exist in `states`
3. No transitions from terminal states
4. All `prompt` references in `spawn_agent` hooks exist in `prompts`
5. All `respawn_prompt` references in states exist in `prompts`
6. All `then` targets in exit monitoring rules exist in `states`
7. No ambiguous transitions: for each `from + to` pair, `when` clauses must be mutually exclusive
8. `when` expressions parse correctly
9. Exit monitoring `then_when` clauses must be exhaustive (cover all cases)

Fail loudly on invalid workflow — don't silently ignore errors.

## Engine Interface

```typescript
interface WorkflowEngine {
  /** Load and validate workflow for a project */
  loadWorkflow(projectName: string): Promise<Workflow>;

  /** Attempt a transition. Validates when/gate, writes status, runs hooks. */
  transition(task: Task, to: TaskStatus, deps: Deps): Promise<TransitionResult>;

  /** Check if a transition from the given status exists in the workflow. */
  hasTransition(from: TaskStatus, to: TaskStatus): boolean;

  /** Respawn agent in current state. Not a transition. */
  respawn(task: Task, deps: Deps): Promise<void>;

  /** Apply exit monitoring rules for a dead session. */
  handleDeadSession(task: Task, deps: Deps): Promise<void>;

  /** Generate prompt for a state's agent. */
  buildPrompt(task: Task, promptKey: string): string;
}

interface TransitionResult {
  success: boolean;
  error?: string;            // gate failure, guard failure, illegal transition
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
- State-specific prompts including respawn prompts

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
    respawn_prompt: worker
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
      - action: delete_remote_branch
      - action: spawn_next

  - from: pending
    to: cancelled
    hooks: []
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
2. Create `src/core/engine.ts` — `transition()`, `respawn()`, `handleDeadSession()`, `buildPrompt()`
3. Refactor `task.ts` update command → call `engine.transition()`
4. Refactor `spawn.ts` → `acquire_workspace` and `spawn_agent` become hook executors
5. Refactor `state.ts` health check → call `engine.handleDeadSession()`
6. Refactor `agent.ts` → prompts loaded from workflow definition
7. Change `releaseWorkspace()` default to never auto-spawn; add explicit `spawn_next` hook
8. Ship `default.yml` that encodes current behavior — zero behavior change

### Backward Compatibility

- Existing tasks without `workflow` field use `default` workflow
- `crash_count` defaults to 0 if missing in frontmatter
- All current CLI commands work unchanged — engine is internal
