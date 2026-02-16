---
name: orange
description: Orange agent orchestration. Use when TASK.md present (worker mode) OR when user says "orange task", "add task", "create task", "review PR", "pr-review", "review my PRs", or wants parallel tasks (orchestrator mode).
---

# Orange

Your mode depends on context:

- **TASK.md exists** → Worker (implement the task)
- **No TASK.md** → Orchestrator (create/manage tasks)

---

## Worker Mode

Core workflow is in the spawn prompt. This section covers details.

**Critical: Do NOT push to remote (no `git push`). Human handles all pushes and merges.**

### Clarification

When summary is empty, vague, or scope expands mid-work:

```bash
# Add questions to TASK.md body
orange task update --status clarification
# Wait for user to attach and discuss
# After resolved:
orange task update --summary "..." --status working
```

Triggers: empty summary, ambiguous requirements, scope larger than expected.

### Session Handoff

Write `## Handoff` to TASK.md before stopping (before `--status agent-review`):

```markdown
## Handoff

DONE: OAuth callback handler, token storage in keychain
REMAINING: Refresh token rotation, logout flow
DECISIONS: Using JWT for stateless auth (avoid DB session lookups)
UNCERTAIN: Should tokens expire on password change?
```

**Fields** (all optional, include what's relevant):
- **DONE** — What's completed this session
- **REMAINING** — What's left to do
- **DECISIONS** — Choices made and why (prevents next session from re-deciding)
- **UNCERTAIN** — Open questions, unknowns, things that need human input

On respawn, read `## Handoff` first — it's the structured state from the previous session.

### Rules

- Don't push or merge — human handles that
- `## Context` is read-only (orchestrator-provided)
- Don't assume scope — clarify if unclear

---

## Review Agent Mode

Core workflow is in the spawn prompt. This section covers details.

### Review Section Format

```markdown
## Review

**Verdict: PASS** or **Verdict: FAIL**

### <topic>
<specific feedback with file paths, line numbers>

### <topic>
...
```

### Rules

- Do NOT modify any code — review only
- Do NOT post comments or reviews to GitHub (no `gh pr review`, no `gh pr comment`)
- ALWAYS write `## Review` to TASK.md before setting status — no exceptions
- Read `## Handoff` — check UNCERTAIN items for correctness risks, verify DECISIONS are sound
- Write actionable feedback (specific files, line numbers, what's wrong)
- Even for PASS, include positive notes and minor suggestions
- Save ALL feedback to TASK.md only — human will review and post to GitHub if needed

---

## Orchestrator Mode

### Workflow

1. **Refine** — don't accept vague requests. Ask 2-3 clarifying questions about scope, edge cases, and acceptance criteria. Don't plan or create tasks until answers are clear. Wait for user responses before proceeding.
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
- Never create tasks from vague requests — refine first
- **Always pass context** — pipe the plan via `--context -`. Workers only see TASK.md.
- **Summarize the plan** — derive a concise summary that tells the worker exactly what to do. Bad: `"Fix auth"`. Good: `"Fix auth redirect to preserve returnUrl after login"`.
- **Branch name format** — all lowercase, no spaces, use hyphens (e.g. `fix-auth-redirect`)

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

### Creating PR Review Tasks

When user asks to review PRs (e.g., "review my PRs", "review PR #123", "pr-review the auth branch"):

**Single PR:**
```bash
orange task create feature-branch "PR review: <brief description>" --status agent-review
```

**Batch — review PRs assigned to user:**
1. List PRs needing review: `gh pr list --reviewer @me --json number,title,headRefName`
2. Create a pr-review task for each:
   ```bash
   orange task create <branch> "PR review: <PR title>" --status agent-review --harness claude
   ```

This spawns a review agent per PR — no worker involved. Review agents check out branches, review diffs, and write feedback to TASK.md. User reviews the `## Review` summaries later.

**Note:** PR review tasks are distinct from the agent-review status used in the normal worker flow. PR review = reviewing someone else's code. Agent-review = reviewing the worker's own output.

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
orange task create [branch] [summary] [--harness <name>] [--context -] [--no-spawn] [--status pending|clarification|agent-review|reviewing] [--project <name>]
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
| `--status agent-review` | Trigger review agent (e.g., review coworker's PR) |
| `--status reviewing` | For existing work, skip agent spawn |
| `--project <name>` | Explicit project (otherwise inferred from cwd) |

---

## Status

| Status | Meaning |
|--------|---------|
| `pending` | Created, not spawned |
| `clarification` | Waiting for user input (empty/vague summary, or scope change) |
| `working` | Actively implementing |
| `agent-review` | Review agent evaluating work |
| `reviewing` | Agent review passed, awaiting human review/merge |
| `stuck` | Failed after 2 review rounds |
| `done` | Merged |
| `cancelled` | Cancelled or errored |

### Transitions

```
pending → working (with summary)
pending → clarification (empty summary)
working ⇄ clarification
working → agent-review (implementation done)
agent-review → reviewing (review passed)
agent-review → working (review failed)
agent-review → stuck (round 2 failed, auto-spawns interactive agent)
stuck → reviewing (human fixed interactively)
Any active → cancelled
reviewing → done
```
