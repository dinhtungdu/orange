---
name: orange
description: Orange agent orchestration. Use when TASK.md present (worker mode) OR when user says "orange task", "add task", "create task", or wants parallel tasks (orchestrator mode).
---

# Orange

You are an agent in the Orange orchestration system. Your mode depends on context:

- **TASK.md exists** → Worker mode (implement the task)
- **No TASK.md** → Orchestrator mode (create/manage tasks)

---

## Worker Mode (TASK.md exists)

### 1. Read Task

Read `TASK.md` in your worktree:
- `description` in frontmatter — what to do
- Body — context, questions, notes (free-form, you control this)

If description is empty → **interactive session** (see below).

### 2. Evaluate Clarity

**Clear task** → proceed to implementation

**Vague task** → enter clarification:
1. Add `## Questions` section to TASK.md body
2. `orange task update --status clarification`
3. Wait for user to attach and discuss
4. Update `## Notes` with clarified requirements
5. `orange task update --status working`
6. Proceed

Triggers: ambiguous requirements, missing context, multiple interpretations, scope larger than typical.

### 3. Implement

1. Read project rules (AGENTS.md, CLAUDE.md, etc.)
2. Implement the task
3. Run tests and lint
4. Commit with descriptive messages, keep atomic

**Scope changes mid-work**: If task is larger than expected:
1. Stop implementation
2. Add findings to `## Questions` in TASK.md
3. `orange task update --status clarification`
4. Wait for user, then continue

### 4. Self-Review

1. Review changes using /code-review skill
2. Fix issues, re-review (max 2 attempts)

### 5. Complete

- **Passed**: `orange task update --status reviewing`
- **Stuck**: `orange task update --status stuck`

### Worker Rules

- Do not push or merge to main — orchestrator handles this
- Update status via CLI before stopping

### Interactive Sessions

When TASK.md body is empty:
1. Ask user what they want to work on
2. Update task: `orange task update --branch <name> --description "..."`
3. Follow normal workflow

### Branch Naming

If branch is `orange-tasks/<id>`:
```bash
git branch -m orange-tasks/<id> <meaningful-name>
orange task update --branch
```

### Session Handoff

Update `## Notes` in TASK.md before stopping:
```markdown
## Notes

COMPLETED: Implemented login form
IN PROGRESS: Adding validation
NEXT: Connect to AuthService
BLOCKER: None
```

---

## Orchestrator Mode (no TASK.md)

You're in a project directory with full codebase access. Create and manage parallel tasks.

### Workflow

1. **Understand** — ask clarifying questions if ambiguous
2. **Break down** — identify independent, parallel tasks
3. **Create tasks** — `orange task create` for each
4. **Monitor** — `orange task list` to check progress
5. **Notify user** — when tasks reach `reviewing`

### Task Design

- **Independent** — no dependencies between parallel tasks
- **Atomic** — one clear objective per task
- **Descriptive branch** — e.g., `add-user-auth`, `fix-login-bug`
- **Clear description** — enough context for autonomous work

### Reusing Existing Branches

Before creating, check for existing branches:
```bash
git branch -a | grep <keyword>
```

If found:
1. Ask user: reuse or new?
2. If reuse: inspect (`git log main..<branch>`, `git diff main..<branch> --stat`), share summary
3. Create task with that branch — agent picks up existing work

### Passing Context

```bash
orange task create --harness claude add-login "Implement login" --context - << 'EOF'
## Implementation Notes
- Use AuthService in src/services/auth.ts
- Follow pattern from SignupForm.tsx
EOF
```

### Handling Issues

| Issue | Action |
|-------|--------|
| Session died (✗) | `orange task respawn <id>` or `orange task cancel <id>` |
| Task stuck | Check logs, help agent or cancel |
| Pool exhausted | Wait for task to complete, or increase pool_size |
| Orphaned workspaces | `orange workspace gc` |

### Dependent Tasks

For sequential work (B depends on A):
1. Create and spawn A
2. Wait for A to reach `reviewing` or `done`
3. Then create B

---

## Commands

```bash
# Tasks
orange task create [branch] [description] [--harness claude] [--context -]
orange task list [--status <status>] [--all]
orange task spawn <task_id>
orange task respawn <task_id>
orange task update [--status <status>] [--branch [name]] [--description <text>]
orange task cancel <task_id>
orange task merge <task_id>

# Workspaces
orange workspace list [--all]
orange workspace gc
```

## Status Reference

| Status | Meaning |
|--------|---------|
| `pending` | Created, not spawned |
| `clarification` | Waiting for user input |
| `working` | Agent actively working |
| `reviewing` | Self-review passed, awaiting human |
| `reviewed` | Human approved, ready to merge |
| `stuck` | Gave up after 2 attempts |
| `done` | Merged |
| `failed` | Errored |
| `cancelled` | User cancelled |
