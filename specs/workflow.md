# Workflow

Deterministic state machine driving task lifecycle. Agents write artifacts, the engine validates and gates transitions. No agent decides its own fate.

Statuses defined in [data.md](./data.md#status).

## State Machine

```
        pending ──────────────────────────────────► cancelled
            │                                          ▲
            ▼                                          │
        planning ──────► clarification                 │
            │                  ↕                       │
            ▼           ◄──────┘                       │
        working ◄──────── reviewing                    │
            │                │                         │
            ├──► agent-review┤                         │
            │        │       ▼                         │
            │        ▼      done                       │
            │      stuck ─────────────────────────────►┘
            └────────┘
```

## Transitions

Each transition has optional gates (artifact requirements) and hooks (side effects).

| From | To | Gate | Hooks |
|------|----|------|-------|
| pending | planning | — | acquire_workspace, spawn_agent(worker) |
| pending | cancelled | — | — |
| planning | working | ## Plan valid | — |
| planning | clarification | — | — |
| planning | cancelled | — | kill_session, release_workspace |
| clarification | planning | — | — |
| clarification | cancelled | — | kill_session, release_workspace |
| working | agent-review | ## Handoff valid | kill_session, spawn_agent(reviewer), increment review_round |
| working | clarification | — | — |
| working | stuck | — | — |
| working | cancelled | — | kill_session, release_workspace |
| agent-review | reviewing | ## Review, Verdict: PASS | kill_session |
| agent-review | working | ## Review, Verdict: FAIL, round < 2 | kill_session, spawn_agent(worker_fix) |
| agent-review | stuck | ## Review, Verdict: FAIL, round ≥ 2 | kill_session |
| agent-review | cancelled | — | kill_session, release_workspace |
| reviewing | working | — | spawn_agent(worker_fix) |
| reviewing | done | — | release_workspace, delete_remote_branch, spawn_next |
| reviewing | cancelled | — | kill_session, release_workspace |
| stuck | working | — | spawn_agent(stuck_fix) |
| stuck | cancelled | — | kill_session, release_workspace |

Any transition not in this map is rejected.

**Note:** `planning → working` has no hooks — the same agent session continues. The agent plans, transitions to working, then implements. One spawn, one session, two phases.

## Artifact Gates

Gates validate TASK.md content before allowing a transition.

**## Plan gate** (planning → working):
- Section `## Plan` exists
- At least one field present: line matching `^(APPROACH|TOUCHING):` with content after the colon

**## Handoff gate** (working → agent-review):
- Section `## Handoff` exists
- At least one field present: line matching `^(DONE|REMAINING|DECISIONS|UNCERTAIN):` with content after the colon

**## Review gate** (agent-review → reviewing / working / stuck):
- Section `## Review` exists
- First non-empty line is `Verdict: PASS` or `Verdict: FAIL` (case-insensitive)
- Verdict must match the target: PASS for → reviewing, FAIL for → working or → stuck

See [data.md](./data.md) for artifact format details.

## Hooks

| Hook | What it does |
|------|--------------|
| acquire_workspace | Bind worktree from pool to task |
| release_workspace | Unbind worktree, reset to default branch. Never auto-spawns. |
| spawn_agent | Create tmux window, run agent with prompt |
| kill_session | Kill tmux session |
| spawn_next | Pop next pending task for project, spawn it |
| delete_remote_branch | Remove remote branch after merge |

Hooks execute in array order. All idempotent — silently succeed when nothing to do.

Hook failure after status write: log error, mark task for attention. Don't roll back.

### spawn_agent

| Detail | Value |
|--------|-------|
| Harness | `task.harness` for workers, `task.review_harness` for reviewers |
| Tmux windows | Named per role: `worker`, `review-1`, `worker-2`, `review-2` |
| Session naming | `<project>/<branch>` |

Windows kept open — history preserved for debugging.

## Transition Execution

```
1. Validate transition exists in map
2. Evaluate condition (e.g., review_round < 2) — reject if false
3. Validate artifact gate — reject if invalid
4. Write new status to TASK.md
5. Execute hooks in order
6. Reset crash_count to 0
7. Log history event
```

`crash_count` resets after all side effects complete, not before.

## Exit Monitoring

Dashboard health check (30s poll) detects dead agent sessions and applies deterministic rules.

### Detection

Compare `tmux list-sessions` against tasks with active `tmux_session`. Session gone + task in active status = dead session.

### Auto-Advance Rules

**planning:**
- Has valid ## Plan → advance to working
- No plan → crash (increment crash_count)
  - crash_count ≥ 2 → advance to stuck
  - else → mark crashed in UI, user can respawn

**working:**
- Has valid ## Handoff → advance to agent-review (spawn reviewer)
- No handoff → crash (increment crash_count)
  - crash_count ≥ 2 → advance to stuck
  - else → mark crashed in UI, user can respawn

**agent-review:**
- ## Review with Verdict: PASS → advance to reviewing
- ## Review with Verdict: FAIL + round < 2 → advance to working (spawn worker)
- ## Review with Verdict: FAIL + round ≥ 2 → advance to stuck
- No verdict → crash (increment crash_count)
  - crash_count ≥ 2 → advance to stuck
  - else → mark crashed, auto-respawn reviewer

**clarification, reviewing, stuck:** Mark crashed in UI. No auto-advance — requires human.

### Idempotency

Auto-advance checks current status before acting. If a CLI command already transitioned the task, auto-advance is a no-op.

## Crash Tracking

`crash_count` in TASK.md frontmatter (see [data.md](./data.md#frontmatter-schema)).

- **Increment:** agent process exits without producing required artifacts
- **Reset:** on any successful status transition, after all hooks complete
- **Threshold:** 2 crashes in same status → auto-advance to stuck

## Review Rounds

- `review_round` starts at 0, incremented on each reviewer spawn
- Round 1: review fails → worker respawned → fixes → agent-review again
- Round 2: review fails → stuck
- Max 4 agent sessions per task: worker → reviewer → worker → reviewer

## Agent Prompts

Each `spawn_agent` hook uses a prompt template. Variables: `{summary}`, `{project}`, `{branch}`, `{review_round}`, `{status}`.

### Worker (pending → planning → working)

Single agent session covering both planning and implementation phases.

```
# Task: {summary}

Project: {project}
Branch: {branch}

Phase 1 — Plan:
1. Read TASK.md — summary in frontmatter, context in body
2. If branch is orange-tasks/<id>, rename it and run: orange task update --branch
3. If requirements unclear: add ## Questions, set --status clarification, wait
4. Write ## Plan to TASK.md (APPROACH + TOUCHING, optional RISKS)
5. orange task update --status working

Phase 2 — Implement:
6. Read project rules (AGENTS.md, etc.)
7. Implement according to ## Plan, test, commit
8. Write ## Handoff (at least one of DONE/REMAINING/DECISIONS/UNCERTAIN)
9. orange task update --status agent-review

Do NOT push to remote.
Do NOT set --status reviewing — always use agent-review.
```

### Worker Respawn (crashed session)

```
# Resuming: {summary}

Project: {project}
Branch: {branch}
Status: {status}
Review round: {review_round}

Read TASK.md — check ## Plan and ## Handoff for previous progress.

If status is planning:
  1. Write ## Plan if not yet written
  2. orange task update --status working
  3. Continue to implementation

If status is working:
  1. Pick up where last session left off
  2. Write updated ## Handoff
  3. orange task update --status agent-review

Do NOT push to remote.
```

### Worker Fix (review failed)

```
# Fixing: {summary}

Project: {project}
Branch: {branch}
Review round: {review_round}

1. Read ## Review — specific feedback to address
2. Fix each issue
3. Write updated ## Handoff
4. orange task update --status agent-review

Do NOT push to remote.
```

### Reviewer (working → agent-review)

```
# Review: {summary}

Project: {project}
Branch: {branch}
Review round: {review_round} of 2

1. Read TASK.md for requirements, ## Plan for approach, ## Handoff for state
2. Review diff: git diff origin/HEAD...HEAD
3. Check UNCERTAIN items for correctness risks
4. Write ## Review to TASK.md:
   - First line must be: "Verdict: PASS" or "Verdict: FAIL"
   - Then detailed, actionable feedback
5. Set status:
   - PASS → orange task update --status reviewing
   - FAIL, round < 2 → orange task update --status working
   - FAIL, round ≥ 2 → orange task update --status stuck

Do NOT post to GitHub. All feedback goes in TASK.md only.
The command rejects if ## Review is missing or has no verdict line.
```

### Clarification (requirements unclear)

```
# Task: {summary}

Project: {project}
Branch: {branch}

Requirements unclear. Write ## Questions to TASK.md with 2-3 specific questions.
Run: orange task update --status clarification
Wait for user to attach and discuss.

After discussion:
1. orange task update --summary "..."
2. Write ## Plan (APPROACH + TOUCHING)
3. orange task update --status working
```

### Stuck Fix (respawn from stuck)

```
# Stuck: {summary}

Project: {project}
Branch: {branch}
Review round: {review_round}

Task stuck — review failed twice or repeated crashes.
Read ## Review, ## Plan, and ## Handoff for what went wrong.

1. Address the root issues
2. Write updated ## Handoff
3. orange task update --status agent-review
```

## Orchestrator

The orchestrator is a skill (not a module) that runs in the user's terminal. It decomposes work — it does not plan implementation.

1. Refines vague requests — asks clarifying questions, waits for answers
2. Breaks work into independent, parallel tasks with clear summaries
3. Creates tasks with optional `--context` for requirements and constraints
4. Monitors progress via `orange task list`

Each task's agent handles its own planning in the `planning` phase. The orchestrator's value is scoping and decomposition, not implementation design.
