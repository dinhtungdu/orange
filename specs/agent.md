# Agent Lifecycle

## 1. Spawn

1. Acquire workspace from pool
2. Fetch latest; checkout existing branch (local or remote) or create new from `origin/<default_branch>`
3. Symlink `TASK.md` from task dir to worktree
4. Setup harness-specific files (see [harness.md](./harness.md))
5. Add harness files to git exclude
6. Create tmux session running agent with prompt (harness-specific command)
7. Update task: status → `working`, set workspace + tmux_session, log events

On spawn failure, release workspace to prevent leaks.

See [harness.md](./harness.md) for spawn commands per harness.

## 2. Agent Prompt

The spawn prompt is minimal:
- Task description and branch name
- Reference to orange-worker skill for workflow instructions

The orange-worker skill (installed via `orange install`) contains:
- Clarity evaluation
- Clarification flow
- Self-review loop
- Status update commands

### Clarity Evaluation

Before starting work, agent evaluates if the task is clear enough to implement:

1. **Clear task** → proceed to implementation
2. **Vague task** → enter clarification mode:
   - Add `## Questions` section to TASK.md body with specific questions
   - Run `orange task update --status clarification`
   - Wait in session for user to attach and discuss
   - After discussion, update TASK.md body with refined requirements
   - Run `orange task update --status working`, proceed

Triggers for clarification:
- Ambiguous requirements ("improve performance" — which part?)
- Missing context ("fix the bug" — which bug?)
- Multiple valid interpretations
- Scope seems larger than typical task

### Interactive Session (No Description)

When task has no description (empty TASK.md body):
- Agent spawns with **no prompt** (interactive mode)
- Harness opens directly: `pi` instead of `pi "prompt"`
- Agent reads AGENTS.md instruction to discuss with user, then update TASK.md body
- Then proceed with normal workflow

### Auto-Generated Branch Names

When no branch name provided, defaults to `orange-tasks/<id>`. Agent reads AGENTS.md instruction to rename based on task description:
1. `git branch -m orange-tasks/<id> <meaningful-name>`
2. `orange task update --branch`

## 3. Respawn Prompt

For dead sessions reusing existing workspace:
- Check TASK.md status first
- If already `reviewing` → stop (nothing to do)
- If `stuck` or `working` → continue implementation
- If `clarification` → wait for user input
- Uses reduced permissions where supported (see [harness.md](./harness.md))

## 4. Scope Changes Mid-Work

If agent discovers task is larger or different than expected while working:

1. Stop current implementation
2. Add findings to `## Questions` section in TASK.md body:
   ```markdown
   ## Questions
   
   - [ ] Discovered this requires DB schema change — proceed?
   - [ ] This affects 3 other modules — should I update all or just the main one?
   ```
3. Run `orange task update --status clarification`
4. Wait for user input
5. After discussion, update TASK.md body, run `orange task update --status working`, continue

This prevents agents from going down wrong paths or expanding scope unilaterally.

## 5. Self-Review Loop

```
implement → /code-review → feedback
                              ↓
                        pass? ────→ stop (passed)
                              ↓
                        fail + <2 → fix → re-review
                              ↓
                        fail + ≥2 → stop (stuck)
```

## 6. Completion

Agent updates status via CLI before stopping:
- `orange task update --status reviewing` — self-review passed
- `orange task update --status stuck` — gave up after max attempts

TASK.md is the source of truth. Dashboard watches for changes.

## 7. Human Review

1. Dashboard shows task needing attention
2. Human options:
   - `Enter` — attach to session (if still active)
3. Review changes, interact with agent if needed
4. Merge options:
   - `m` in dashboard → merges to main, releases workspace, kills session
   - PR workflow: merge on GitHub, then `m` to cleanup

## 8. Logging

Agent conversation logs are available by attaching to the tmux session directly.
