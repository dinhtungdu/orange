# Agent Lifecycle

## 1. Spawn

1. Acquire workspace from pool
2. Fetch and create task branch from `origin/<default_branch>`
3. Symlink `TASK.md` from task dir to worktree
4. Write `.orange-outcome` with task ID for hook integration
5. Add `TASK.md` and `.orange-outcome` to git exclude
6. Create tmux session running Claude with agent prompt (full permissions)
7. Update task: status → `working`, set workspace + tmux_session, log events

On spawn failure, release workspace to prevent leaks.

## 2. Agent Prompt

The prompt includes:
- Task description and branch name
- Workflow: read TASK.md → read CLAUDE.md → implement → test → self-review via `/code-review` skill
- Max 2 review attempts before marking stuck
- Must write outcome to `.orange-outcome` before stopping
- Must not push (orchestrator handles merge)

## 3. Respawn Prompt

For dead sessions reusing existing workspace:
- Check `.orange-outcome` first
- If already `passed` → write `needs_human` and stop
- If `stuck` or missing → continue implementation
- Uses reduced permissions (accept edits only, not full skip)

## 4. Self-Review Loop

```
implement → /code-review → feedback
                              ↓
                        pass? ────→ stop (passed)
                              ↓
                        fail + <2 → fix → re-review
                              ↓
                        fail + ≥2 → stop (stuck)
```

## 5. Completion Hook

Agent writes outcome to `.orange-outcome` before stopping:
- `{"id":"...","outcome":"passed"}`
- `{"id":"...","outcome":"stuck","reason":"..."}`
- `{"id":"...","outcome":"needs_human"}`

Claude's stop hook reads the file and calls:
- `orange task complete <id>` → status = `needs_human`
- `orange task stuck <id>` → status = `stuck`

## 6. Human Review

1. Dashboard shows task needing attention
2. Human options:
   - `Enter` — attach to session (if still active)
   - `l` — view conversation log (if session died or completed)
3. Review changes, interact with agent if needed
4. Merge options:
   - `m` in dashboard → merges to main, releases workspace, kills session
   - PR workflow: merge on GitHub, then `m` to cleanup

## 7. Logging

Agent conversation logs are read from Claude's session files. On merge/cancel, log is snapshotted to `log.txt` in the task dir so it survives workspace reuse. View with `orange task log <id>` or `l` in dashboard.
