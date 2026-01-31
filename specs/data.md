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
            ├── TASK.md           # Description, metadata (frontmatter)
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
status: working
description: Implement dark mode for dashboard
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

Agent working notes, discoveries, session handoff...
```

**Structure:**
- **Frontmatter**: Metadata including `description` (short, CLI-controlled)
- **Body**: Free-form content (agent-controlled)

**Body sections** (all optional):
- `## Context` — Implementation context from `--context -`
- `## Questions` — Agent's clarifying questions
- `## Notes` — Working notes, session handoff

### Session Handoff Format

For autonomous agents, structured notes in body:

```markdown
## Notes

COMPLETED: X
IN PROGRESS: Y
NEXT: Z
BLOCKER: (if any)
```

### Interactive Session (Empty Description)

When created without a description, `description` frontmatter is empty. Agent spawns with no initial prompt (interactive mode). Agent follows worker skill to discuss with user, then update via `orange task update --description`.

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
| `clarification` | Agent waiting for user input (vague task or scope change) |
| `working` | Agent actively working (includes self-review) |
| `reviewing` | Self-review passed, awaiting human review |
| `reviewed` | Human approved, ready to merge |
| `stuck` | Agent gave up after max review attempts |
| `done` | Merged/completed |
| `failed` | Agent crashed or errored |
| `cancelled` | User cancelled |

### Clarification Flow

```
pending → working → clarification → working → ...
              ↑___________↓
```

Agent enters `clarification` when:
1. **Task is vague** — unclear requirements before starting
2. **Scope expands** — discovers complexity mid-work

Agent writes questions to `## Questions` section, runs `orange task update --status clarification`, then waits in session. User attaches to tmux session, discusses with agent. Agent updates TASK.md body with refined spec, runs `orange task update --status working`.
