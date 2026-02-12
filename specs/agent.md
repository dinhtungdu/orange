# Agent Lifecycle

## 1. Spawn

1. Acquire workspace from pool
2. Fetch latest; checkout existing branch (local or remote) or create new from `origin/<default_branch>`
3. Symlink `TASK.md` from task dir to worktree
4. Setup harness-specific files (see [harness.md](./harness.md))
5. Add harness files to git exclude
6. Create tmux session running agent with prompt (harness-specific command)
7. Update task: status → `working` (or keep `clarification` if empty summary), set workspace + tmux_session, log events

On spawn failure, release workspace to prevent leaks.

See [harness.md](./harness.md) for spawn commands per harness.

## 2. Agent Prompt

The spawn prompt is minimal:
- Task summary and branch name
- Reference to orange skill for workflow instructions

The orange skill (installed via `orange install`) contains:
- Clarity evaluation
- Clarification flow
- Self-review loop
- Status update commands

### Clarity Evaluation

Before starting work, agent evaluates if the task is clear enough to implement:

1. **Clear task** → proceed to implementation
2. **Empty/vague summary** → enter clarification mode:
   - Add `## Questions` section to TASK.md body with 2-3 specific questions
   - Don't assume scope or make up requirements
   - Run `orange task update --status clarification`
   - Wait in session for user to attach and discuss
   - After discussion, update summary and/or `## Notes` with refined requirements
   - Run `orange task update --status working`, proceed

Triggers for clarification:
- Empty summary (no requirements provided)
- Ambiguous requirements ("improve performance" — which part?)
- Missing context ("fix the bug" — which bug?)
- Multiple valid interpretations
- Scope seems larger than typical task

### Planning (No Context)

When task has summary but no `## Context` (no orchestrator-provided plan), agent documents approach in `## Notes` before implementing:

```markdown
## Notes

PLAN: <implementation approach>
TOUCHING: <files/areas affected>
```

This provides:
- Review prep (know what agent decided to do)
- Handoff context (respawn knows the approach)
- Early course-correction (human can attach if plan looks wrong)

### Auto-Generated Branch Names

When no branch name provided, defaults to `orange-tasks/<id>`. Agent renames based on task:
1. `git branch -m orange-tasks/<id> <meaningful-name>`
2. `orange task update --branch`

### Prompt Templates

Each state has a focused prompt. Agents receive only the instructions relevant to their current role.

Variable substitution: `{summary}`, `{project}`, `{branch}`, `{review_round}`, `{status}`.

#### Worker Prompt (working)

```
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
```

#### Worker Respawn Prompt (working, review_round > 0)

```
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
```

#### Worker Fix Prompt (post-review fail)

```
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
```

#### Review Agent Prompt (agent-review)

```
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
```

#### Clarification Prompt

```
# Task: {summary}

Project: {project}
Branch: {branch}

The task requirements are unclear. Write ## Questions to TASK.md with
2-3 specific questions, then wait for the user to attach and discuss.

After discussion:
1. Update task summary: orange task update --summary "..."
2. Document approach in ## Notes
3. Resume: orange task update --status working
```

#### Stuck Respawn Prompt

```
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

## 3. Respawn Prompt

For dead sessions reusing existing workspace:
- Check TASK.md status first
- If already `reviewing` → stop (nothing to do)
- If `agent-review` → respawn review agent (not worker)
- If `stuck` or `working` → continue implementation
- If `working` with `review_round > 0` → read `## Review` feedback, fix issues
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

## 5. Agent Review

Review is handled by a separate review agent, not the worker. When worker finishes implementation:

1. Worker sets `orange task update --status agent-review`
2. CLI auto-spawns review agent in same tmux session (new named window)
3. Review agent uses `review_harness` (default: `claude`)

### Review Agent Behavior

```
Read diff (branch vs default branch)
    ↓
Read TASK.md (summary, context, notes)
    ↓
Use PR review toolkit if available
    ↓
Write ## Review to TASK.md
    ↓
Pass → orange task update --status reviewing
Fail → orange task update --status working (round < 2)
Fail → orange task update --status stuck (round 2)
```

### Review Rounds

- `review_round` in frontmatter tracks current round (0–2)
- Round 1: review fails → worker respawned to fix → worker sets `agent-review` again
- Round 2: review fails → `stuck`
- Max 4 agent sessions per task: worker → reviewer → worker → reviewer

### Crash Handling

- Review agent crashes in `agent-review` → respawn review agent (same round)
- 2 crashes in same round → `stuck`

### Tmux Windows

Named windows per agent session:
- `worker` — initial spawn
- `review-1` — first review
- `worker-2` — fix round
- `review-2` — second review

Windows kept open (history preserved). Named for future targeting.

## 6. Completion

Worker sets `orange task update --status agent-review` when done implementing. Review agent sets final status:
- `orange task update --status reviewing` — review passed
- `orange task update --status working` — review failed (worker will be respawned)
- `orange task update --status stuck` — review failed on round 2

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
