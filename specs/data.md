# Data & Storage

All data in `~/orange/`.

```
~/orange/
├── projects.json           # Project registry
├── orange.log              # Structured log (rotated at 10MB)
├── workspaces/             # Worktree pool (reused)
│   ├── orange--1/
│   ├── orange--2/
│   ├── coffee--1/
│   └── .pool.json          # Pool state
└── tasks/                  # Task folders (source of truth)
    └── <project>/
        └── <task_id>/          # Directory named by task ID (not branch)
            ├── TASK.md           # Summary, metadata (frontmatter)
            └── history.jsonl     # Event log
```

## projects.json

```json
[
  {
    "name": "orange",
    "path": "/Users/tung/workspace/orange",
    "default_branch": "main",
    "pool_size": 2
  }
]
```

## Task ID

21-character alphanumeric string (nanoid with `[0-9A-Za-z]` alphabet). No hyphens or special characters — IDs are safe to use as CLI positional arguments.

## TASK.md

Human-readable task file with YAML frontmatter:

```markdown
---
id: abc123
project: orange
branch: dark-mode
harness: pi
review_harness: claude
status: working
review_round: 0
summary: Implement dark mode for dashboard
workspace: orange--1
tmux_session: orange/dark-mode
created_at: 2024-01-15T10:00:00Z
updated_at: 2024-01-15T10:30:00Z
---

## Context

Implementation notes from orchestrator...

## Questions

- [ ] Should this apply to all workspaces or just active ones?

## Notes

PLAN: Use CSS custom properties for theme switching
TOUCHING: src/dashboard/styles.ts, src/dashboard/view.ts

## Handoff

DONE: Theme data structure, CSS variable injection
REMAINING: Persist preference to config, keyboard shortcut toggle
DECISIONS: CSS custom properties over Lipgloss styles (works with all TUI components)
UNCERTAIN: Should theme apply to agent terminal output too?
```

**Structure:**
- **Frontmatter**: Metadata including `summary` (short one-liner, CLI-controlled)
- **Body**: Sections with different ownership

**Body sections** (all optional):
- `## Context` — Implementation context from `--context -` (orchestrator-controlled, read-only for agent)
- `## Questions` — Agent's clarifying questions (agent-controlled)
- `## Notes` — Working notes, plan (agent-controlled)
- `## Handoff` — Structured session state: done/remaining/decisions/uncertain (agent-controlled, written before stopping)
- `## Review` — Agent review summary (written by review agent during `agent-review`)

### Notes Format

For autonomous agents, working notes in body:

```markdown
## Notes

PLAN: <implementation approach, if no ## Context provided>
TOUCHING: <files/areas affected>
```

- **PLAN/TOUCHING**: Written before implementation when no `## Context` provided

### Handoff Format

Agents write a `## Handoff` section before stopping (status change to `agent-review`, or session death/respawn). This is the structured state that lets the next session pick up accurately.

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
- **DECISIONS** — Choices made and why (critical for next session)
- **UNCERTAIN** — Open questions, unknowns, things that need human input

The `DECISIONS` and `UNCERTAIN` fields are where handoff quality lives — they prevent the next session from re-making decisions or confidently continuing from wrong assumptions.

### Empty Summary

When created without a summary, task starts with `clarification` status. Agent writes "What would you like to work on?" in `## Questions`, waits for user to attach and discuss. After discussion, agent updates summary via `orange task update --summary "..."` and proceeds.

### Auto-Generated Branch Names

When created without a branch name, branch defaults to `orange-tasks/<id>`. Agent follows worker skill to rename branch based on task, then runs `orange task update --branch` to sync.

## Harness

The `harness` field specifies which coding agent runs the task (`pi`, `opencode`, `claude`, `codex`). See [harness.md](./harness.md) for details.

## history.jsonl

Append-only event log:

```jsonl
{"type":"task.created","timestamp":"...","task_id":"abc123","project":"orange","branch":"dark-mode"}
{"type":"agent.spawned","timestamp":"...","workspace":"orange--1","tmux_session":"orange/dark-mode"}
{"type":"status.changed","timestamp":"...","from":"pending","to":"working"}
{"type":"task.merged","timestamp":"...","commit":"abc123"}
```

## Task Status

| Status | Description |
|--------|-------------|
| `pending` | Created, not yet spawned |
| `clarification` | Agent waiting for user input (empty/vague summary, or scope change) |
| `working` | Agent actively implementing |
| `agent-review` | Review agent evaluating work |
| `reviewing` | Agent review passed, awaiting human review/merge |
| `stuck` | Failed after 2 review rounds or 2 crashes in review |
| `done` | Merged/completed |
| `cancelled` | User cancelled or errored |

### Clarification Flow

```
pending → clarification → working → ...
               ↑______________↓
```

Agent enters `clarification` when:
1. **Empty summary** — no requirements provided
2. **Vague summary** — unclear requirements before starting
3. **Scope expands** — discovers complexity mid-work

Agent writes questions to `## Questions` section, runs `orange task update --status clarification`, then waits in session. User attaches to tmux session, discusses with agent. Agent updates summary and/or `## Notes` with refined spec, runs `orange task update --status working`.
