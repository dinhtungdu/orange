---
name: orange
description: Orange agent orchestration. Use when TASK.md present (worker mode) OR when user says "orange task", "add task", "create task", or wants parallel tasks (orchestrator mode).
---

# Orange

Your mode depends on context:

- **TASK.md exists** → Worker (implement the task)
- **No TASK.md** → Orchestrator (create/manage tasks)

---

## Worker Mode

### Workflow

1. **Read** `TASK.md` — summary in frontmatter, context in body
2. **Check status** — behavior depends on current status (see Respawn Behavior)
3. **Handle branch** — if `orange-tasks/<id>`, rename to meaningful name
4. **Evaluate clarity** — empty/vague? Add `## Questions`, set `--status clarification`, wait
5. **Plan** — if no `## Context`, document approach in `## Notes` before coding
6. **Implement** — read project rules, code, test, commit
7. **Self-review** — use `/code-review` skill, fix issues (max 2 attempts)
8. **Complete** — `--status reviewing` (passed) or `--status stuck` (gave up)

### Respawn Behavior

When resuming (session restarted), check TASK.md status first:

| Status | Action |
|--------|--------|
| `reviewing` | Stop — nothing to do |
| `working` | Continue implementation |
| `stuck` | Continue implementation |
| `clarification` | Wait for user input |

### Branch Rename

If branch is auto-generated (`orange-tasks/<id>`):

```bash
# Rename to meaningful name based on task
git branch -m orange-tasks/abc123 fix-login-redirect
# Sync task metadata to new branch
orange task update --branch
```

### Planning (No Context)

When task has summary but no `## Context`, document your approach before coding:

```markdown
## Notes

PLAN: <your implementation approach>
TOUCHING: <files/areas affected>
```

This helps with review prep and session handoff.

### Clarification

When summary is empty, vague, or scope expands mid-work:

```bash
# Add questions to TASK.md body (e.g., "What would you like to work on?")
orange task update --status clarification
# Wait for user to attach and discuss
# After resolved, update summary and notes:
orange task update --summary "..." --status working
```

**Mid-work discovery:** If you find the task requires more than expected (DB schema change, affects multiple modules), stop and clarify before proceeding.

### Session Handoff

Always update `## Notes` before stopping:

```markdown
## Notes

COMPLETED: X
IN PROGRESS: Y
NEXT: Z
BLOCKER: (if any)
```

### Rules

- Don't push or merge — human handles that
- Update status via CLI before stopping
- Use `/code-review` skill for self-review
- `## Context` is read-only (orchestrator-provided)

---

## Orchestrator Mode

### Workflow

1. **Clarify** — ask questions if user request is ambiguous
2. **Plan** — break down into actionable steps (concise but clear)
3. **Create** — `orange task create` for each, with plan in context:
   ```bash
   cat << 'EOF' | orange task create fix-auth "Fix auth redirect" --harness pi --context -
   ## Plan
   1. Check AuthService.redirect()
   2. Add returnUrl param
   3. Update LoginPage to pass returnUrl
   EOF
   ```
4. **Monitor** — `orange task list`
5. **Notify** — when tasks reach `reviewing`

### Task Design

- Independent (no dependencies between parallel tasks)
- Atomic (one clear objective)
- Clear summary + plan (worker executes from TASK.md, must know what to do)

### Passing Context

```bash
cat << 'EOF' | orange task create add-login "Implement login" --harness pi --context -
## Notes
- Use AuthService in src/services/auth.ts
EOF
```

### Inspecting Tasks

Use `orange task show <id>` to see task details, plan, notes, and history. Useful when:
- A task failed and you need to understand what was tried
- Planning an alternative approach for a similar problem
- Reviewing what context was provided to a worker

### Handling Issues

| Issue | Action |
|-------|--------|
| Session died (✗) | `orange task respawn <id>` |
| Task stuck | `orange task show <id>` to review, then attach or create new task with different approach |
| Needs PR | `orange task create-pr <id>` |

---

## Commands

```bash
# Dashboard
orange [--all] [--project <name>]

# Task lifecycle
orange task create [branch] [summary] [--harness <name>] [--context -] [--no-spawn] [--status pending|clarification|reviewing] [--project <name>]
orange task spawn <task_id>
orange task respawn <task_id>
orange task attach <task_id>
orange task cancel <task_id> [--yes]
orange task delete <task_id> [--yes]  # done/cancelled only

# Task updates (task_id optional if in workspace)
orange task update [task_id] [--status <status>] [--branch [name]] [--summary <text>]
  # --branch (no value): sync task to current git branch
  # --branch <name>: checkout existing or rename current
  # --summary: update frontmatter summary

# Review & merge
orange task create-pr <task_id>
orange task merge <task_id> [--local]

# Inspect
orange task show <task_id>          # Show details, TASK.md content, history

# List
orange task list [--status <status>] [--all]
```

### Create Flags

| Flag | Purpose |
|------|---------|
| `--harness <name>` | Agent to use (pi/claude/opencode/codex) — always pass as orchestrator |
| `--context -` | Read context from stdin → `## Context` in body (read-only for agent) |
| `--no-spawn` | Create without starting agent |
| `--status clarification` | For empty summary (auto-set when summary omitted) |
| `--status reviewing` | For existing work, skip agent spawn |
| `--project <name>` | Explicit project (otherwise inferred from cwd) |

---

## Status

| Status | Meaning |
|--------|---------|
| `pending` | Created, not spawned |
| `clarification` | Waiting for user input (empty/vague summary, or scope change) |
| `working` | Actively implementing |
| `reviewing` | Done, awaiting human review/merge |
| `stuck` | Gave up after 2 attempts |
| `done` | Merged |
| `cancelled` | Cancelled or errored |

### Transitions

```
pending → working (with summary)
pending → clarification (empty summary)
working ⇄ clarification
working → reviewing | stuck
Any active → cancelled
reviewing → done
```
