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
- `status` in frontmatter — current state (check if respawned)
- Body — context, questions, notes (free-form, you control this)

If description is empty → **interactive session** (see below).

### 2. Check If Respawned

If status is `clarification`, `working`, or `stuck`, you're resuming a previous session.

**Read `## Notes` section** for handoff context:
```markdown
## Notes

COMPLETED: Implemented login form
IN PROGRESS: Adding validation
NEXT: Connect to AuthService
BLOCKER: None
```

**On respawn, say:**
> "I'm resuming this task. Based on my notes, I completed X and was working on Y. Should I continue from there, or has something changed?"

### 3. Evaluate Clarity

**Clear task** → proceed to implementation

**Vague task** → enter clarification:
1. Add `## Questions` section to TASK.md body
2. `orange task update --status clarification`
3. **Say to user:**
   > "I have some questions before I start. I've added them to TASK.md. Let me know your thoughts, and I'll update my notes and proceed."
4. Wait for user responses

**After user answers:**
1. Update `## Notes` with clarified requirements
2. **Say:** "Thanks, I've captured the requirements. Proceeding with implementation."
3. `orange task update --status working`
4. Continue to implementation

### 4. Implement

1. Read project rules (AGENTS.md, CLAUDE.md, etc.)
2. Implement the task
3. Run tests and lint
4. Commit with descriptive messages, keep atomic

**Scope changes mid-work**: If task is larger than expected:
1. Stop implementation
2. Add findings to `## Questions` in TASK.md
3. `orange task update --status clarification`
4. **Say:**
   > "I discovered this is more complex than expected. [Explain findings]. I've added questions to TASK.md. How would you like me to proceed?"

### 5. Self-Review

1. Review changes using /code-review skill
2. Fix issues, re-review (max 2 attempts)

### 6. Complete

- **Passed**: `orange task update --status reviewing`
- **Stuck**: `orange task update --status stuck`

**On stuck, say:**
> "I've attempted this twice but can't resolve [specific issue]. The task is marked as stuck. You can attach to help me, or cancel and retry with different approach."

### Worker Rules

- Do not push or merge to main — orchestrator handles this
- Update status via CLI before stopping
- Always update `## Notes` before session ends

---

## Conversations

### Interactive Session (No Description)

When TASK.md body is empty, you're in interactive mode.

**Say:**
> "This is an interactive session — no task defined yet. What would you like to work on?"

**After user describes work:**
1. Clarify if needed
2. Update task:
   ```bash
   git branch -m orange-tasks/<id> <meaningful-name>
   orange task update --branch --description "Clear description"
   ```
3. **Say:** "Got it. I've set up the task as [description]. Starting implementation."
4. Follow normal workflow

### User Attaches During Clarification

User attached to your session while you're waiting.

**Say:**
> "I'm waiting on clarification for this task. Here are my questions: [list from ## Questions]. What are your thoughts?"

### User Attaches During Work

**Say:**
> "I'm currently working on [current task]. [Brief status]. Do you have questions or want to discuss something?"

### User Provides Feedback During Review

If user finds issues after you've set `status=reviewing`:

1. **Listen to feedback**
2. **Say:** "I'll fix that. Updating status back to working."
3. `orange task update --status working`
4. Fix the issues
5. Re-run self-review
6. `orange task update --status reviewing`

### User Helps With Stuck Task

If user attaches to a stuck task:

**Say:**
> "I got stuck on [specific issue]. I tried [approaches]. Where I need help: [specific question]."

**After user helps:**
1. `orange task update --status working`
2. Implement the fix
3. Continue normal workflow

### User Changes Requirements

If user says "actually, do X instead" or "never mind, change to Y":

1. **Acknowledge:** "Got it, changing direction."
2. Update `## Notes` with the pivot
3. If branch name no longer fits:
   ```bash
   git branch -m old-name new-name
   orange task update --branch --description "New description"
   ```
4. Continue with new requirements

### User Says "Looks Good" / "Proceed"

This signals clarification is resolved:
1. Update `## Notes` with final requirements
2. `orange task update --status working`
3. **Say:** "Great, proceeding with implementation."

---

## Session Handoff

**Always update `## Notes` before stopping:**
```markdown
## Notes

COMPLETED: Implemented login form, added validation
IN PROGRESS: Connecting to AuthService
NEXT: Add error handling, write tests
BLOCKER: None (or describe blocker)
```

This helps you or another agent resume correctly.

---

## Branch Naming

If branch is `orange-tasks/<id>` (auto-generated):
```bash
git branch -m orange-tasks/<id> <meaningful-name>
orange task update --branch
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
| Task stuck | Attach, help agent, or cancel |
| Pool exhausted | Wait for task to complete, or increase pool_size |
| Orphaned workspaces | `orange workspace gc` |

### Dependent Tasks (Current)

For sequential work (B depends on A):
1. Create and spawn A
2. Wait for A to reach `reviewing` or `done`
3. Then create B

### Dependent Tasks (Future: Phase 1)

When `--blocked-by` is available:
```bash
orange task create db-schema "Create tables"
orange task create api-endpoints "Add REST API" --blocked-by <db-task-id>
orange task create ui-components "Build UI" --blocked-by <api-task-id>
```
Tasks auto-spawn when dependencies complete.

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

| Status | Meaning | Agent Action |
|--------|---------|--------------|
| `pending` | Created, not spawned | Wait for spawn |
| `clarification` | Waiting for user input | Answer questions when user attaches |
| `working` | Actively implementing | Continue work |
| `reviewing` | Self-review passed | Wait for human review |
| `reviewed` | Human approved | Wait for merge |
| `stuck` | Gave up after 2 attempts | Wait for help or cancel |
| `done` | Merged | Nothing (terminal) |
| `failed` | Errored | Nothing (terminal) |
| `cancelled` | User cancelled | Nothing (terminal) |
