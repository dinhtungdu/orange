# Workflow Engine

> **Future spec — not yet implemented.** Current transitions are hardcoded in TypeScript. See [flows.md](../flows.md) for current behavior and [agent.md](../agent.md) for prompt templates.

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
  # Prompts are defined here in the YAML workflow but are documented
  # in agent.md for the current hardcoded implementation.
  worker: |
    ...
  worker_respawn: |
    ...
  worker_fix: |
    ...
  reviewer: |
    ...
  clarification: |
    ...
  stuck_fix: |
    ...
```

## Expression Language

Minimal — only frontmatter field comparisons:

```
<field> <op> <value>
```

- `field`: any numeric frontmatter field (`review_round`, `crash_count`)
- `op`: `<`, `>`, `<=`, `>=`, `==`, `!=`
- `value`: integer literal

Evaluated against task frontmatter at transition time.

### The `when` Clause

`when` serves two different purposes depending on context:

**On CLI Transitions: Guard** — When an agent calls `orange task update --status X`, the engine finds transitions from current → X. If a matching transition has a `when` clause, it acts as a guard: the condition must be true, otherwise the transition is rejected.

**On Exit Monitoring: Disambiguator** — `then_when` in exit monitoring rules picks a target status based on conditions.

If multiple transitions from current → X exist with different `when` clauses, exactly one must pass. Zero passing → guard failure. Multiple passing → ambiguous (validation error at workflow load time should prevent this).

## Hook Vocabulary

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

### Hook Principles

- All hooks are idempotent. They silently succeed when there's nothing to do.
- `release_workspace` only releases. It never triggers spawning the next pending task. Auto-spawning is always an explicit `spawn_next` hook.

### Execution Order

```
1. Validate gate (if defined)
2. Evaluate when clause (if defined) — reject if false
3. Write new status to TASK.md
4. Execute hooks in array order (each idempotent)
5. Log history event
```

Hook failure after status write: log error, mark task for attention. Don't roll back status.

### Future Actions

| Action | Description |
|--------|-------------|
| `notify` | Send notification (desktop, webhook) |
| `run_command` | Arbitrary shell command |
| `set_field` | Update frontmatter field |

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

## Respawn

Respawn is **not a transition** — the task stays in the same status. It re-runs `spawn_agent` for the current state when a session has died and the user manually respawns.

Each state can define a `respawn_prompt` in its state config. States without `respawn_prompt` cannot be respawned.

## Dashboard and Custom Workflows

The dashboard reads available transitions from the workflow to determine which keybindings are valid for a task's current state.

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
9. Exit monitoring `then_when` clauses must be exhaustive

Fail loudly on invalid workflow.

## Engine Interface

```typescript
interface WorkflowEngine {
  loadWorkflow(projectName: string): Promise<Workflow>;
  transition(task: Task, to: TaskStatus, deps: Deps): Promise<TransitionResult>;
  hasTransition(from: TaskStatus, to: TaskStatus): boolean;
  respawn(task: Task, deps: Deps): Promise<void>;
  handleDeadSession(task: Task, deps: Deps): Promise<void>;
  buildPrompt(task: Task, promptKey: string): string;
}

interface TransitionResult {
  success: boolean;
  error?: string;
  hooksExecuted: string[];
  hookErrors: string[];
}
```

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
