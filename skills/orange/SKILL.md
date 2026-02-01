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
2. **Check status** — if `clarification`/`working`/`stuck`, you're resuming (read `## Notes`)
3. **Evaluate clarity** — vague? Add `## Questions`, set `--status clarification`, wait
4. **Implement** — read project rules, code, test, commit
5. **Self-review** — review the code, fix issues (max 2 attempts)
6. **Complete** — `--status reviewing` (passed) or `--status stuck` (gave up)

### Clarification

When task is vague or scope expands:

```bash
# Add questions to TASK.md body, then:
orange task update --status clarification
# Wait for user to attach and discuss
# After resolved:
orange task update --status working
```

### Interactive Session

If TASK.md body is empty:

1. Ask user what to work on
2. Update task: `orange task update --branch <name> --description "..."`
3. Proceed with normal workflow

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

---

## Orchestrator Mode

### Workflow

1. **Understand** — clarify ambiguous requests
2. **Break down** — independent, parallel tasks
3. **Create** — `orange task create` for each
4. **Monitor** — `orange task list`
5. **Notify** — when tasks reach `reviewing`

### Task Design

- Independent (no dependencies between parallel tasks)
- Atomic (one clear objective)
- Clear description (enough for autonomous work)

### Passing Context

```bash
orange task create add-login "Implement login" --context - << 'EOF'
## Notes
- Use AuthService in src/services/auth.ts
EOF
```

### Handling Issues

| Issue            | Action                     |
| ---------------- | -------------------------- |
| Session died (✗) | `orange task respawn <id>` |
| Task stuck       | Attach and help, or cancel |

---

## Commands

```bash
orange task create [branch] [description] [--harness claude] [--context -]
orange task list [--status <status>]
orange task update [--status <status>] [--branch [name]] [--description <text>]
orange task spawn <task_id>
orange task respawn <task_id>
orange task cancel <task_id>
orange task merge <task_id>
```

## Status

| Status          | Meaning                           |
| --------------- | --------------------------------- |
| `pending`       | Created, not spawned              |
| `clarification` | Waiting for user input            |
| `working`       | Actively implementing             |
| `reviewing`     | Done, awaiting human review/merge |
| `stuck`         | Gave up after 2 attempts          |
| `done`          | Merged                            |
| `cancelled`     | Cancelled or errored              |
