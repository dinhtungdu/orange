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

# 3. Write .orange-task file for hook integration
echo '{"id":"$TASK_ID"}' > .orange-task

# 4. Create tmux session with output logging
session_name="$project/$branch"
log_file="~/orange/tasks/$project/$branch/output.log"
tmux new-session -d -s "$session_name" -c "$workspace" \
  "script -q -a $log_file bash -c 'claude --prompt \"$AGENT_PROMPT\"; exec $SHELL'"

# 5. Update task metadata
# - TASK.md: workspace, tmux_session
# - history.jsonl: agent.spawned event
```

**Shell fallback:** When agent exits, drops to user's shell (via `exec $SHELL`) so humans can review output and run commands. Output captured to `output.log` for later review.

## 2. Agent Prompt

Injected via `--prompt`:

```
You are working on: $description

Project: $project
Branch: $branch
Worktree: $worktree

Instructions:
1. Read CLAUDE.md for project context
2. Implement the task
3. Run tests and lint
4. Self-review by spawning a review subagent:
   claude --print --prompt "Review the changes in this branch..."
5. If review finds issues → fix them → re-review
6. Max 3 review attempts. If still failing, mark as stuck.
7. Before stopping, write outcome to .orange-task:
   - Passed: {"id":"$TASK_ID","outcome":"passed"}
   - Stuck: {"id":"$TASK_ID","outcome":"stuck","reason":"..."}
8. Only stop when review passes OR you're stuck.

Important:
- Commit changes with descriptive messages
- Do not push - merge handled by orchestrator
- Write .orange-task BEFORE stopping so hook can read outcome
```

## 3. Self-Review Loop

Agent handles review internally:

```
┌──────────────────────────────────────────────────┐
│                  Agent Session                   │
│                                                  │
│  implement → spawn review subagent → feedback    │
│                                         ↓        │
│                                   pass? ─────→ stop
│                                         ↓        │
│                                   fail + <3      │
│                                         ↓        │
│                                   fix → re-review│
│                                         ↓        │
│                                   fail + ≥3      │
│                                         ↓        │
│                                   stop (stuck)   │
└──────────────────────────────────────────────────┘
```

## 4. Completion Hook

Agent writes outcome before stopping:

```bash
echo '{"id":"abc123","outcome":"passed"}' > .orange-task
```

Claude's stop hook notifies orange:

```bash
# ~/.claude/hooks/stop.sh
if [[ -f .orange-task ]]; then
  TASK_ID=$(grep -o '"id":"[^"]*"' .orange-task | cut -d'"' -f4)
  OUTCOME=$(grep -o '"outcome":"[^"]*"' .orange-task | cut -d'"' -f4)

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

## 6. Output Logging

All terminal output captured to `~/orange/tasks/<project>/<branch>/output.log`:
- Uses `script` command for full terminal capture
- Persists after session ends
- View with `orange task log <id>` or `l` in dashboard
