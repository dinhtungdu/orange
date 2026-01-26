# Agent Lifecycle

## 1. Spawn

```bash
# orange task spawn <id>

# 1. Acquire workspace from pool
workspace=$(acquire_workspace $project)  # e.g., orange--1

# 2. Reset workspace to base branch + create task branch
cd $workspace
git fetch origin
git checkout $default_branch
git reset --hard origin/$default_branch
git checkout -b $branch

# 3. Create tmux session for task
session_name="$project/$branch"
tmux new-session -d -s "$session_name" -c "$workspace" \
  "claude --prompt '$AGENT_PROMPT'"

# 4. Update task metadata
# - TASK.md: workspace, tmux_session
# - history.jsonl: agent.spawned event
```

Writes `.orange-task` file in workspace with task ID for hook.

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
4. Self-review using Task tool:
   - Spawn subagent with: subagent_type="Explore" or custom reviewer
   - Prompt: "Review changes on this branch. Check: tests pass, no bugs, code style, matches requirements."
5. If review finds issues → fix them → re-review
6. Max 3 review attempts. If still failing, mark as stuck.
7. Before stopping, write outcome to .orange-task:
   - Passed: echo '{"id":"$TASK_ID","outcome":"passed"}' > .orange-task
   - Stuck: echo '{"id":"$TASK_ID","outcome":"stuck","reason":"..."}' > .orange-task
8. Only stop when review passes OR you're stuck.

Do not stop until review passes or you've exhausted attempts.
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

Benefits:
- Agent keeps full context across fix iterations
- No external review orchestration
- Agent responsible for own quality

## 4. Completion Hook

Agent writes outcome before stopping:

```bash
# Agent writes to .orange-task before exiting
echo '{"id":"abc123","outcome":"passed"}' > .orange-task
# or
echo '{"id":"abc123","outcome":"stuck","reason":"failed 3 review attempts"}' > .orange-task
```

Claude's stop hook notifies orange:

```bash
# ~/.claude/hooks/stop.sh
#!/bin/bash
if [[ -f .orange-task ]]; then
  TASK_ID=$(jq -r .id .orange-task)
  OUTCOME=$(jq -r .outcome .orange-task)
  if [[ "$OUTCOME" == "passed" ]]; then
    orange task complete "$TASK_ID"
  else
    orange task stuck "$TASK_ID"
  fi
fi
```

`orange task complete` → status = `needs_human` (◉ ready)
`orange task stuck` → status = `stuck` (⚠ needs help)

## 5. Human Review

1. Dashboard shows task with ◉ (needs attention)
2. Human attaches to task session (`Enter` in dashboard or `tmux attach -t orange/dark-mode`)
3. Reviews changes, interacts with agent if needed
4. Two options:
   - **Local merge**: `m` in dashboard → merges to main, releases workspace, kills session
   - **PR workflow**: agent/human runs `gh pr create`, merge on GitHub, then `m` to cleanup
5. Workspace returned to pool, session killed, ready for next task
