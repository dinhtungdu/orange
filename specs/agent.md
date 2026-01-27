# Agent Lifecycle

## 1. Spawn

```bash
# orange task spawn <id>

# 1. Acquire workspace from pool
workspace=$(acquire_workspace $project)  # e.g., orange--1

# 2. Fetch and create task branch from origin
cd $workspace
git fetch origin
git checkout -b $branch origin/$default_branch

# 3. Symlink TASK.md from task dir to worktree
# 4. Write .orange-outcome file for hook integration
echo '{"id":"$TASK_ID"}' > .orange-outcome
# 5. Add TASK.md and .orange-outcome to .git/info/exclude

# 6. Create tmux session
session_name="$project/$branch"
tmux new-session -d -s "$session_name" -c "$workspace" \
  "claude --dangerously-skip-permissions \"$AGENT_PROMPT\""

# 7. Update task metadata
# - TASK.md: workspace, tmux_session, status → working
# - history.jsonl: agent.spawned, status.changed events
```

## 2. Agent Prompt

Injected as first argument to `claude --dangerously-skip-permissions`:

```
# Task: $description

Project: $project
Branch: $branch

## Workflow

1. Read TASK.md for task description and implementation context
2. Read CLAUDE.md for project conventions
3. Implement the task
4. Run tests and lint
5. Self-review using /code-review skill
6. If review finds issues, fix and re-review (max 2 attempts)
7. Write outcome to .orange-outcome before stopping

## Rules

- Commit with descriptive messages, keep commits atomic
- Do not push - orchestrator handles merge
- Write .orange-outcome BEFORE stopping so hook can read it

## Outcome Format

Write to .orange-outcome:
- Passed: {"id":"$TASK_ID","outcome":"passed"}
- Stuck (after 2 failed reviews): {"id":"$TASK_ID","outcome":"stuck","reason":"..."}
```

**Respawn prompt** (for dead sessions) checks `.orange-outcome` first — if already passed, writes `needs_human` and stops immediately. Otherwise continues implementation. Uses `--permission-mode acceptEdits` instead of `--dangerously-skip-permissions`.

## 3. Self-Review Loop

Agent handles review internally:

```
┌──────────────────────────────────────────────────┐
│                  Agent Session                   │
│                                                  │
│  implement → /code-review skill → feedback       │
│                                         ↓        │
│                                   pass? ─────→ stop
│                                         ↓        │
│                                   fail + <2      │
│                                         ↓        │
│                                   fix → re-review│
│                                         ↓        │
│                                   fail + ≥2      │
│                                         ↓        │
│                                   stop (stuck)   │
└──────────────────────────────────────────────────┘
```

## 4. Completion Hook

Agent writes outcome before stopping:

```bash
echo '{"id":"abc123","outcome":"passed"}' > .orange-outcome
```

Supported outcomes: `passed`, `stuck`, `needs_human`

Claude's stop hook notifies orange:

```bash
# ~/.claude/hooks/stop.sh
if [[ -f .orange-outcome ]]; then
  TASK_ID=$(jq -r .id .orange-outcome)
  OUTCOME=$(jq -r .outcome .orange-outcome)

  if [[ "$OUTCOME" == "passed" ]]; then
    orange task complete "$TASK_ID"
  else
    orange task stuck "$TASK_ID"
  fi
fi
```

- `orange task complete` → status = `needs_human` (◉ ready)
- `orange task stuck` → status = `stuck` (⚠ needs help)

## 5. Human Review

1. Dashboard shows task needing attention
2. Human options:
   - `Enter` - attach to session (if still active)
   - `l` - view output log (if session died or completed)
3. Reviews changes, interacts with agent if needed
4. Merge options:
   - `m` in dashboard → merges to main, releases workspace, kills session
   - PR workflow: merge on GitHub, then `m` to cleanup
5. Workspace returned to pool, session killed

## 6. Logging

Agent conversation logs read from Claude's session files (`~/.claude/projects/*/sessions/`). On merge/cancel, log is snapshotted to `~/orange/tasks/<project>/<branch>/log.txt` so it survives workspace reuse. View with `orange task log <id>` or `l` in dashboard.
