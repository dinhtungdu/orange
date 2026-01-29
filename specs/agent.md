# Agent Lifecycle

## 1. Spawn

1. Acquire workspace from pool
2. Fetch latest; checkout existing branch (local or remote) or create new from `origin/<default_branch>`
3. Symlink `TASK.md` from task dir to worktree
4. Create `.orange-outcome` in task dir, symlink to worktree
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
- If already `passed` → write `reviewing` and stop
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

## 5. Completion (Harness-Agnostic)

Agent writes outcome to `.orange-outcome` before stopping:
- `{"id":"...","outcome":"passed"}`
- `{"id":"...","outcome":"stuck","reason":"..."}`
- `{"id":"...","outcome":"reviewing"}`

The `.orange-outcome` file is symlinked from the task dir (`~/orange/tasks/<project>/<branch>/.orange-outcome`). This means:
- Outcome persists even if workspace is released
- Dashboard watches task dir and detects outcome changes
- Works with any harness (Claude Code, pi, Cursor, etc.) — no stop hook required

**Status transitions:**
- `passed` or `reviewing` → status = `reviewing`
- `stuck` → status = `stuck`

**Optional hook (Claude Code):** For immediate feedback, Claude Code's stop hook can still call `orange task complete/stuck`, but it's no longer required — dashboard polling handles it.

## 6. Human Review

1. Dashboard shows task needing attention
2. Human options:
   - `Enter` — attach to session (if still active)
3. Review changes, interact with agent if needed
4. Merge options:
   - `m` in dashboard → merges to main, releases workspace, kills session
   - PR workflow: merge on GitHub, then `m` to cleanup

## 7. Logging

Agent conversation logs are available by attaching to the tmux session directly.
