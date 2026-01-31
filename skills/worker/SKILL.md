---
name: orange-worker
description: Workflow for Orange worker agents. Read this skill when working on an Orange task (TASK.md present in worktree).
---

# Orange Worker

You are a worker agent in the Orange orchestration system. Follow this workflow for all tasks.

## 1. Read Task

Read `TASK.md` in your worktree:
- `description` in frontmatter — what to do
- Body — context, questions, notes (free-form, you control this)

If description is empty, you're in an **interactive session** — see below.

## 2. Evaluate Clarity

Before starting work, evaluate if the task is clear enough:

**Clear task** → proceed to step 3

**Vague task** → enter clarification:
1. Add `## Questions` section to TASK.md body
2. Run `orange task update --status clarification`
3. Wait for user to attach and discuss
4. After discussion:
   - Update `## Notes` in body with clarified requirements
   - Optionally update description: `orange task update --description "refined description"`
5. Run `orange task update --status working`
6. Proceed to step 3

Triggers for clarification:
- Ambiguous requirements ("improve performance" — which part?)
- Missing context ("fix the bug" — which bug?)
- Multiple valid interpretations
- Scope seems larger than typical task

## 3. Implement

1. Read project rules (AGENTS.md, CLAUDE.md, etc.)
2. Implement the task
3. Run tests and lint
4. Commit with descriptive messages, keep commits atomic

**Scope changes mid-work**: If you discover the task is larger or different than expected:
1. Stop current implementation
2. Add findings to `## Questions` section in TASK.md body
3. Run `orange task update --status clarification`
4. Wait for user input
5. After discussion, update body and continue

## 4. Self-Review

1. Review your changes using /code-review skill
2. If review finds issues, fix and re-review
3. Max 2 review attempts

## 5. Complete

When done:
- **Passed review**: `orange task update --status reviewing`
- **Stuck (after 2 failed reviews)**: `orange task update --status stuck`

## Rules

- Do not push — orchestrator handles merge
- Do not merge to main — orchestrator handles this
- Update status via CLI before stopping

## Interactive Sessions

When TASK.md body is empty:
1. Ask user what they want to work on
2. Once understood, update task:
   ```bash
   orange task update --branch <meaningful-name> --description "Task description"
   ```
3. Follow normal workflow (evaluate clarity → implement → review)

## Branch Naming

If branch is `orange-tasks/<id>` (auto-generated):
1. Rename to meaningful name based on task:
   ```bash
   git branch -m orange-tasks/<id> <meaningful-name>
   orange task update --branch
   ```

## Session Handoff

If you need to stop mid-work (crash recovery, handoff), update `## Notes` in TASK.md body:

```markdown
## Notes

COMPLETED: Implemented login form component
IN PROGRESS: Adding validation
NEXT: Connect to AuthService
BLOCKER: None
```

This helps you or another agent resume work.

## Status Reference

| Status | Meaning |
|--------|---------|
| `working` | You are actively working |
| `clarification` | Waiting for user input |
| `reviewing` | Done, awaiting human review |
| `stuck` | Gave up after max review attempts |
