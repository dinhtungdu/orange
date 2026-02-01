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

1. **Read** `TASK.md` — description in frontmatter, context in body
2. **Check status** — behavior depends on current status (see Respawn Behavior)
3. **Handle branch** — if `orange-tasks/<id>`, rename to meaningful name
4. **Evaluate clarity** — vague? Add `## Questions`, set `--status clarification`, wait
5. **Implement** — read project rules, code, test, commit
6. **Self-review** — use `/code-review` skill, fix issues (max 2 attempts)
7. **Complete** — `--status reviewing` (passed) or `--status stuck` (gave up)

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

### Clarification

When task is vague or scope expands mid-work:

```bash
# Add questions to TASK.md body, then:
orange task update --status clarification
# Wait for user to attach and discuss
# After resolved:
orange task update --status working
```

**Mid-work discovery:** If you find the task requires more than expected (DB schema change, affects multiple modules), stop and clarify before proceeding.

### Interactive Session

If TASK.md body is empty (no description):

1. Ask user what to work on
2. Rename branch: `git branch -m orange-tasks/<id> <meaningful-name>`
3. Update task: `orange task update --branch --description "..."`
4. Proceed with normal workflow

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

---

## Orchestrator Mode

### Workflow

1. **Understand** — clarify ambiguous requests
2. **Break down** — independent, parallel tasks
3. **Create** — `orange task create` for each (pass `--harness` to identify yourself)
4. **Monitor** — `orange task list`
5. **Notify** — when tasks reach `reviewing`

### Task Design

- Independent (no dependencies between parallel tasks)
- Atomic (one clear objective)
- Clear description (enough for autonomous work)

### Passing Context

```bash
orange task create add-login "Implement login" --harness pi --context - << 'EOF'
## Notes
- Use AuthService in src/services/auth.ts
EOF
```

### Handling Issues

| Issue | Action |
|-------|--------|
| Session died (✗) | `orange task respawn <id>` |
| Task stuck | `orange task attach <id>` and help, or cancel |
| Needs PR | `orange task create-pr <id>` |

---

## Commands

```bash
# Dashboard
orange [--all] [--project <name>]

# Task lifecycle
orange task create [branch] [description] [--harness <name>] [--context -] [--no-spawn] [--status pending|reviewing] [--project <name>]
orange task spawn <task_id>
orange task respawn <task_id>
orange task attach <task_id>
orange task cancel <task_id> [--yes]
orange task delete <task_id> [--yes]  # done/cancelled only

# Task updates (task_id optional if in workspace)
orange task update [task_id] [--status <status>] [--branch [name]] [--description <text>]
  # --branch (no value): sync task to current git branch
  # --branch <name>: checkout existing or rename current

# Review & merge
orange task create-pr <task_id>
orange task merge <task_id> [--local]

# List
orange task list [--status <status>] [--all]
```

### Create Flags

| Flag | Purpose |
|------|---------|
| `--harness <name>` | Agent to use (pi/claude/opencode/codex) — always pass as orchestrator |
| `--context -` | Read context from stdin → `## Context` in body |
| `--no-spawn` | Create without starting agent |
| `--status reviewing` | For existing work, skip agent spawn |
| `--project <name>` | Explicit project (otherwise inferred from cwd) |

---

## Status

| Status | Meaning |
|--------|---------|
| `pending` | Created, not spawned |
| `clarification` | Waiting for user input |
| `working` | Actively implementing |
| `reviewing` | Done, awaiting human review/merge |
| `stuck` | Gave up after 2 attempts |
| `done` | Merged |
| `cancelled` | Cancelled or errored |

### Transitions

```
pending → working ⇄ clarification → reviewing → done
                 ↘ stuck                    ↗
Any active → cancelled
```
